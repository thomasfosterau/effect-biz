/**
 * The one way a command records a domain event: {@link record} builds the
 * event's envelope from the context and stages it into the outbox within
 * the command's unit of work, so it commits in the same batch as the
 * command's state change, or not at all.
 *
 * The envelope is filled from the context, never by the caller: the tenant
 * (`Tenancy.TenantContext`), the company when the command acts for one
 * (`Tenancy.CompanyContext`, optional), the actor's kind and id (never its
 * display name), the correlation and causation from
 * `DomainEvent.CurrentCorrelation` (an event with no correlation in context
 * correlates with itself), a fresh `eventId` from `Id.IdGenerator` and
 * `occurredAt` from `Clock`.
 *
 * Record inside the command's `UnitOfWork.transaction`, after deciding:
 * outside one, the outbox append commits at once on its own, apart from the
 * state it describes.
 *
 * See {@link record} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Actor from "./Actor.js";
import type * as BizError from "./BizError.js";
import * as DomainEvent from "./DomainEvent.js";
import * as Id from "./Id.js";
import * as Outbox from "./Outbox.js";
import * as Tenancy from "./Tenancy.js";

/** Records domain events into the outbox, within the current unit of work. */
export class EventRecorder extends Context.Service<
  EventRecorder,
  {
    /**
     * Builds the event's envelope from the context and stages it into the
     * outbox with the command's other writes; returns the envelope.
     */
    readonly record: (
      event: DomainEvent.Pending,
    ) => Effect.Effect<
      DomainEvent.Envelope,
      BizError.ValidationError | BizError.ConcurrencyConflict,
      Tenancy.TenantContext | Actor.CurrentActor
    >;
  }
>()("@effect-biz/EventRecorder/EventRecorder") {}

/** A recorder over `outbox`, with ids from `ids`. */
const recorder = (outbox: Outbox.Outbox["Service"], ids: Id.IdGenerator["Service"]) =>
  EventRecorder.of({
    record: Effect.fn("EventRecorder.record")(function* (event: DomainEvent.Pending) {
      const payload = yield* event.encoded;
      const eventId = yield* Effect.provideService(
        Id.generate(DomainEvent.EventId),
        Id.IdGenerator,
        ids,
      );
      const company = yield* Effect.serviceOption(Tenancy.CompanyContext);
      const actor = yield* Actor.current;
      const correlation = yield* Effect.service(DomainEvent.CurrentCorrelation);
      const envelope = new DomainEvent.Envelope({
        eventId,
        type: event.type,
        version: event.version,
        tenantId: yield* Tenancy.currentTenant,
        companyId: Option.map(company, (context) => context.companyId),
        aggregate: event.aggregate,
        occurredAt: yield* DateTime.now,
        actor: new DomainEvent.ActorRef({ kind: actor.kind, id: actor.id }),
        correlationId: Option.getOrElse(correlation.correlationId, () => eventId),
        causationId: correlation.causationId,
        payload,
      });
      yield* outbox.append(envelope);
      return envelope;
    }),
  });

/** An event recorder over the current `Outbox`, with ids from the current `IdGenerator`. */
export const make: Effect.Effect<EventRecorder["Service"], never, Outbox.Outbox | Id.IdGenerator> =
  Effect.map(
    Effect.all([Effect.service(Outbox.Outbox), Effect.service(Id.IdGenerator)], {
      concurrency: 1,
    }),
    ([outbox, ids]) => recorder(outbox, ids),
  );

/** The {@link EventRecorder} over the provided `Outbox` and `IdGenerator`. */
export const layer: Layer.Layer<EventRecorder, never, Outbox.Outbox | Id.IdGenerator> =
  Layer.effect(EventRecorder, make);

/**
 * Records a domain event within the current unit of work: the envelope is
 * filled from the context and staged into the outbox with the command's
 * other writes, so the event is committed exactly when they are.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Schema } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as BizError from "@thomasfosterau/effect-biz/BizError";
 * import * as DomainEvent from "@thomasfosterau/effect-biz/DomainEvent";
 * import * as EventRecorder from "@thomasfosterau/effect-biz/EventRecorder";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Outbox from "@thomasfosterau/effect-biz/Outbox";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const NoteAdded = DomainEvent.make("example.note.added", Schema.Struct({ noteId: Schema.String }));
 * const added = NoteAdded.of({ aggregate: { kind: "Note", id: "n-1", version: 1 }, payload: { noteId: "n-1" } });
 *
 * // A command that records, then breaks a rule: its event is never committed.
 * const failing = UnitOfWork.transaction(
 *   Effect.andThen(
 *     EventRecorder.record(added),
 *     Effect.fail(new BizError.BusinessRuleViolation({ code: "example.closed", reason: "closed" })),
 *   ),
 * );
 *
 * const program = Effect.gen(function* () {
 *   yield* Effect.flip(failing);
 *   const recorded = yield* DomainEvent.withCorrelation(
 *     UnitOfWork.transaction(EventRecorder.record(added)),
 *     "request-42",
 *   );
 *   const outbox = yield* Outbox.Outbox;
 *   const claims = yield* outbox.claimBatch({
 *     owner: "relay",
 *     subscriptions: [{ name: "audit", types: ["example.note.added"] }],
 *     limit: 10,
 *     leaseFor: "30 seconds",
 *   });
 *   return [claims.length, recorded.correlationId];
 * });
 *
 * const layer = EventRecorder.layer.pipe(
 *   Layer.provideMerge(Layer.mergeAll(Outbox.layerMemory, Id.layerSequential, UnitOfWork.layerMemory)),
 * );
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * const result = Effect.runSync(
 *   program.pipe(Effect.provide(layer), Tenancy.withTenant(tenant), Actor.withActor(Actor.system("example"))),
 * );
 * console.log(result); // [1, "request-42"]
 * ```
 */
export const record = (
  event: DomainEvent.Pending,
): Effect.Effect<
  DomainEvent.Envelope,
  BizError.ValidationError | BizError.ConcurrencyConflict,
  EventRecorder | Tenancy.TenantContext | Actor.CurrentActor
> => Effect.flatMap(Effect.service(EventRecorder), (service) => service.record(event));

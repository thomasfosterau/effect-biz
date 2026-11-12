/**
 * Subscribers: a named handler for a set of event types, run idempotently.
 *
 * {@link make} builds a {@link Subscriber} from its name, the event
 * definitions it handles and its handler. The dispatcher (`./Dispatcher`)
 * delivers each matching event at least once; the subscriber makes the
 * handler's effects exactly once through the {@link Inbox}, a record of the
 * (subscriber, event) pairs already handled:
 *
 * 1. it opens a `UnitOfWork.transaction`, and does nothing more when the
 *    inbox already holds the event;
 * 2. it decodes the payload through the event's schema (upcasting an older
 *    version), and runs the handler, whose writes are staged;
 * 3. it stages the inbox mark, a guarded insert, with them.
 *
 * The handler's writes and the inbox mark commit as one batch. Of two
 * deliveries of one event racing, exactly one batch commits: the other's
 * inbox guard conflicts, its command is retried from load, and it finds the
 * event handled. A side effect outside the unit of work (an email, an HTTP
 * call) is still at least once; make it idempotent with the `eventId`.
 *
 * A handler runs under the event's tenant (`Tenancy.TenantContext`), its
 * company when it has one (`Tenancy.CompanyContext`, so read it with
 * `Effect.serviceOption`, or from `event.companyId`), the system actor named
 * after the subscriber, and `DomainEvent.causedBy` the event, so the events
 * it records continue its chain. Each delivery is a span,
 * `Subscriber.handle`, with the subscriber, event id, type and correlation
 * id as attributes.
 *
 * See {@link make} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
import * as TxRef from "effect/TxRef";
import * as Actor from "./Actor.js";
import * as BizError from "./BizError.js";
import * as DomainEvent from "./DomainEvent.js";
import * as Outbox from "./Outbox.js";
import * as Tenancy from "./Tenancy.js";
import * as UnitOfWork from "./UnitOfWork.js";

/**
 * The inbox port: which events each subscriber has handled, per tenant.
 * `mark` is a guarded insert staged into the open transaction, so it
 * commits with the handler's writes.
 */
export class Inbox extends Context.Service<
  Inbox,
  {
    /** Whether the subscriber has handled the event (committed state only). */
    readonly has: (
      subscriber: string,
      eventId: DomainEvent.EventId,
    ) => Effect.Effect<boolean, never, Tenancy.TenantContext>;
    /**
     * Stages the record that the subscriber has handled the event; at commit
     * it fails the batch with `ConcurrencyConflict` when the record exists.
     */
    readonly mark: (
      subscriber: string,
      eventId: DomainEvent.EventId,
    ) => Effect.Effect<void, BizError.ConcurrencyConflict, Tenancy.TenantContext>;
  }
>()("@effect-biz/Subscriber/Inbox") {}

/** The in-memory inbox key of a handled event: its tenant, subscriber and id. */
const keyOf = (subscriber: string, eventId: DomainEvent.EventId) =>
  Effect.map(Tenancy.currentTenant, (tenantId) => `${tenantId}/${subscriber}/${eventId}`);

/** An empty in-memory inbox, its marks staged into `UnitOfWork.layerMemory`'s batches. */
export const makeInboxMemory: Effect.Effect<Inbox["Service"]> = Effect.map(
  TxRef.make(HashSet.empty<string>()),
  (handled) =>
    Inbox.of({
      has: (subscriber, eventId) =>
        Effect.flatMap(keyOf(subscriber, eventId), (key) =>
          Effect.map(TxRef.get(handled), HashSet.has(key)),
        ),
      mark: (subscriber, eventId) =>
        Effect.flatMap(keyOf(subscriber, eventId), (key) =>
          UnitOfWork.stage(
            UnitOfWork.memoryJournal,
            Effect.flatMap(
              TxRef.modify(handled, (current): [boolean, HashSet.HashSet<string>] =>
                HashSet.has(current, key) ? [false, current] : [true, HashSet.add(current, key)],
              ),
              (inserted) =>
                inserted
                  ? Effect.void
                  : Effect.fail(
                      new BizError.ConcurrencyConflict({
                        entity: "InboxEntry",
                        id: `${subscriber}/${eventId}`,
                        expected: 0,
                        actual: 1,
                      }),
                    ),
            ),
            UnitOfWork.commitMemory,
          ),
        ),
    }),
);

/** The in-memory {@link Inbox}, for tests and embedded hosts. */
export const layerInboxMemory: Layer.Layer<Inbox> = Layer.effect(Inbox, makeInboxMemory);

/**
 * A subscriber, ready for the dispatcher: its name, the event types it
 * handles, and `handle`, which runs the handler for one envelope exactly
 * once (with its services already provided) and fails with the failure's
 * tag and message only.
 */
export interface Subscriber {
  /** The subscriber's name: unique within a dispatcher, stable across deploys (the inbox key). */
  readonly name: string;
  /** The event types it handles. */
  readonly types: ReadonlyArray<string>;
  /** Handles one envelope of one of its types, idempotently. */
  readonly handle: (envelope: DomainEvent.Envelope) => Effect.Effect<void, Outbox.DeliveryError>;
}

/** What a handler runs under per event, provided by the subscriber rather than captured. */
export type PerEvent = Tenancy.TenantContext | Actor.CurrentActor;

/** The services a subscriber's construction captures: the handler's own, the inbox and the unit of work. */
export type Requirements<R> = R | Inbox | UnitOfWork.UnitOfWork;

/** The context keys never taken from a subscriber's construction: each event brings its own. */
const perEventKeys = [
  Tenancy.TenantContext,
  Tenancy.CompanyContext,
  Actor.CurrentActor,
  DomainEvent.CurrentCorrelation,
  Tracer.ParentSpan,
] as const;

/** The context `envelope` is handled under: its tenant, its company (when it has one) and `actor`. */
const perEvent = (
  envelope: DomainEvent.Envelope,
  actor: Actor.Actor,
): Context.Context<PerEvent> => {
  const base = Context.make(Tenancy.TenantContext, { tenantId: envelope.tenantId }).pipe(
    Context.add(Actor.CurrentActor, actor),
  );
  return Option.match(envelope.companyId, {
    onNone: () => base,
    onSome: (companyId) => Context.add(base, Tenancy.CompanyContext, { companyId }),
  });
};

/** The not-yet-handled envelope's decoding through the definition of its type. */
const decodeFor = <const Ds extends ReadonlyArray<DomainEvent.Any>>(
  name: string,
  events: Ds,
  envelope: DomainEvent.Envelope,
): Effect.Effect<DomainEvent.EventOf<Ds[number]>, BizError.ValidationError> =>
  Effect.flatMap(
    Effect.fromOption(
      Arr.findFirst(events, (event) => event.type === envelope.type),
      () =>
        new BizError.ValidationError({
          issues: [
            new BizError.Issue({
              path: ["type"],
              message: `${name} does not handle ${envelope.type}`,
            }),
          ],
        }),
    ),
    (definition: Ds[number]) => definition.decode(envelope),
  );

/** A failure as a delivery stores it: its tag and message; a defect as `"Defect"` and its name. */
export const deliveryError = <E>(cause: Cause.Cause<E>): Outbox.DeliveryError =>
  Result.match(Cause.findError(cause), {
    onSuccess: (error) =>
      new Outbox.DeliveryError({
        tag: P.hasProperty(error, "_tag") && P.isString(error._tag) ? error._tag : "Error",
        message: P.hasProperty(error, "message") && P.isString(error.message) ? error.message : "",
      }),
    onFailure: () =>
      new Outbox.DeliveryError({
        tag: "Defect",
        message: Result.match(Cause.findDefect(cause), {
          onSuccess: (defect) =>
            P.hasProperty(defect, "name") && P.isString(defect.name) ? defect.name : "unknown",
          onFailure: () => "unknown",
        }),
      }),
  });

/**
 * Builds a subscriber: `name` (unique within the dispatcher, and stable,
 * since the inbox records handled events under it), the event definitions
 * it handles, and the handler for their decoded events. The effect captures
 * the handler's services (less the tenant and actor, provided per event)
 * with the `Inbox` and `UnitOfWork`; provide them where the dispatcher is
 * built.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Ref, Schema } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Dispatcher from "@thomasfosterau/effect-biz/Dispatcher";
 * import * as DomainEvent from "@thomasfosterau/effect-biz/DomainEvent";
 * import * as EventRecorder from "@thomasfosterau/effect-biz/EventRecorder";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Outbox from "@thomasfosterau/effect-biz/Outbox";
 * import * as Subscriber from "@thomasfosterau/effect-biz/Subscriber";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const NoteAdded = DomainEvent.make("example.note.added", Schema.Struct({ text: Schema.String }));
 *
 * const program = Effect.gen(function* () {
 *   const seen = yield* Ref.make<ReadonlyArray<string>>([]);
 *   const auditLog = yield* Subscriber.make("example.audit-log", [NoteAdded], (event) =>
 *     Ref.update(seen, (texts) => [...texts, event.payload.text]),
 *   );
 *   const dispatcher = yield* Dispatcher.make([auditLog]);
 *   yield* UnitOfWork.transaction(
 *     EventRecorder.record(
 *       NoteAdded.of({ aggregate: { kind: "Note", id: "n-1", version: 1 }, payload: { text: "hello" } }),
 *     ),
 *   ).pipe(Tenancy.withTenant(Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab")));
 *   yield* dispatcher.drain;
 *   yield* dispatcher.drain; // nothing left to deliver
 *   return yield* Ref.get(seen);
 * });
 *
 * const layer = EventRecorder.layer.pipe(
 *   Layer.provideMerge(
 *     Layer.mergeAll(Outbox.layerMemory, Subscriber.layerInboxMemory, Id.layerSequential, UnitOfWork.layerMemory),
 *   ),
 * );
 * const seen = Effect.runSync(program.pipe(Effect.provide(layer), Actor.withActor(Actor.system("example"))));
 * console.log(seen); // ["hello"]
 * ```
 */
export const make = <const Ds extends ReadonlyArray<DomainEvent.Any>, E, R = never>(
  name: string,
  events: Ds,
  handler: (event: DomainEvent.EventOf<Ds[number]>) => Effect.Effect<void, E, R | PerEvent>,
): Effect.Effect<Subscriber, never, Requirements<R>> =>
  Effect.map(Effect.context<Requirements<R>>(), (captured) => {
    // The captured services less the per-event ones, still typed as captured: an event's own
    // tenant, company, actor, correlation and parent span always win.
    const kept = Context.makeUnsafe<Requirements<R>>(
      Context.omit(...perEventKeys)(captured).mapUnsafe,
    );
    const actor = Actor.system(name);
    const handleOnce = (envelope: DomainEvent.Envelope) =>
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        if (yield* inbox.has(name, envelope.eventId)) {
          return;
        }
        yield* handler(yield* decodeFor(name, events, envelope));
        yield* inbox.mark(name, envelope.eventId);
      });
    return {
      name,
      types: Arr.map(events, (event) => event.type),
      handle: (envelope) =>
        UnitOfWork.transaction(handleOnce(envelope)).pipe(
          DomainEvent.causedBy(envelope),
          Effect.withSpan("Subscriber.handle", {
            attributes: {
              subscriber: name,
              "event.id": envelope.eventId,
              "event.type": envelope.type,
              "event.correlation_id": envelope.correlationId,
            },
          }),
          Effect.updateContext((current: Context.Context<never>) =>
            Context.merge(Context.merge(current, kept), perEvent(envelope, actor)),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(deliveryError(cause)),
          ),
        ),
    };
  });

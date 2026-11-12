/**
 * Domain events: what a command records as having happened, defined once
 * per type and version, and carried in a JSON-safe {@link Envelope}.
 *
 * A module defines each event with {@link make} (`"sales.order.confirmed"`,
 * version 1, and the payload's `Schema`), builds one inside a command with
 * the definition's `of`, and records it through `./EventRecorder`, which
 * fills the envelope from the context (tenant, company, actor, correlation,
 * a fresh `eventId` and the `Clock`'s time) and stages it into the outbox
 * with the command's other writes. Subscribers (`./Subscriber`) decode the
 * payload back through the same schema.
 *
 * **Evolving an event.** Within a version only additive changes are
 * allowed: a new optional field, or a new member of a lenient enumeration;
 * a reader of the version ignores fields it does not know. Anything else
 * (renaming, removing or retyping a field, making one required) is a new
 * version, defined with {@link evolve} from the previous one and an
 * upcaster, so an envelope stored at the old version still decodes as the
 * new one. Deploy a subscriber that reads a version before the producer
 * that records it: an envelope at a version newer than the subscriber's
 * definition does not decode.
 *
 * **Correlation.** {@link CurrentCorrelation} carries the correlation and
 * causation ids through the Effect context. A host sets the correlation id
 * of a request with {@link withCorrelation}; without one, an event
 * correlates with itself. A subscriber handles each event under
 * {@link causedBy} it, so every event it records carries the same
 * correlation id and the handled event's id as its causation: a chain
 * (order → reservation → shipment → invoice request) shares one
 * correlation id.
 *
 * An envelope carries ids only: the actor's id and kind (never its display
 * name), the tenant, company and aggregate ids. Personal data belongs in no
 * envelope field outside the payload, and a payload that carries any is the
 * defining module's to annotate.
 *
 * See {@link make} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Actor from "./Actor.js";
import * as BizError from "./BizError.js";
import * as Id from "./Id.js";
import * as Tenancy from "./Tenancy.js";

/** The id of a recorded event: a UUIDv7, so ids sort by recording. */
export const EventId = Id.make("EventId");

/** A recorded event's id. */
export type EventId = typeof EventId.Type;

/** A version of an event type: 1 for the first, one more for each breaking change. */
export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** A version of an event type. */
export type Version = typeof Version.Type;

/**
 * The aggregate an event is about: its kind, its id and the version it was
 * stored at by the command that recorded the event. Events of one aggregate
 * are delivered to each subscriber in the order they were recorded.
 */
export class AggregateRef extends Schema.Class<AggregateRef, { readonly brand: unique symbol }>(
  "@effect-biz/DomainEvent/AggregateRef",
)({
  /** The aggregate's kind, e.g. `"SalesOrder"`. */
  kind: Schema.NonEmptyString,
  /** The aggregate's id. */
  id: Schema.NonEmptyString,
  /** The aggregate's version once the recording command committed. */
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** Who recorded an event: the actor's kind and id, never its display name. */
export class ActorRef extends Schema.Class<ActorRef, { readonly brand: unique symbol }>(
  "@effect-biz/DomainEvent/ActorRef",
)({
  /** What kind of principal acted. */
  kind: Actor.ActorKind,
  /** The host's id for the principal. */
  id: Schema.NonEmptyString,
}) {}

/**
 * A recorded event as the outbox stores it: its identity, where and when it
 * happened, who acted, how it correlates, and its payload, encoded as JSON
 * by its definition's schema. Its encoded form ({@link EnvelopeFromJson}) is
 * JSON-safe, so a SQL outbox persists it as one text column.
 */
export class Envelope extends Schema.Class<Envelope, { readonly brand: unique symbol }>(
  "@effect-biz/DomainEvent/Envelope",
)({
  /** The event's own id. */
  eventId: EventId,
  /** The event type, e.g. `"sales.order.confirmed"`. */
  type: Schema.NonEmptyString,
  /** The version of the type the payload was encoded at. */
  version: Version,
  /** The tenant it happened in. */
  tenantId: Tenancy.TenantId,
  /** The company the recording command acted for, when it acted for one. */
  companyId: Schema.OptionFromNullOr(Tenancy.CompanyId),
  /** The aggregate it is about. */
  aggregate: AggregateRef,
  /** When it was recorded, from `Clock`. */
  occurredAt: Schema.DateTimeUtcFromString,
  /** Who acted: the actor's kind and id. */
  actor: ActorRef,
  /** The id every event of one chain shares: the first event's id, or the host's request id. */
  correlationId: Schema.NonEmptyString,
  /** The id of the event (or the host's command) that caused this one; `None` for the first. */
  causationId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  /** The payload, encoded as JSON by the definition's schema at `version`. */
  payload: Schema.Json,
}) {}

/** An envelope encoded as one JSON string, and decoded back: how a SQL outbox stores it. */
export const EnvelopeFromJson = Schema.fromJsonString(Envelope);

/** An envelope, as {@link EnvelopeFromJson} decodes it. */
export type EnvelopeFromJson = typeof EnvelopeFromJson.Type;

/**
 * A decoded event, as a subscriber's handler receives it: the envelope's
 * fields, with the type narrowed to the definition's and the payload decoded
 * (and upcast to the definition's version) by its schema.
 */
export interface Event<T extends string, A> {
  /** The event's own id. */
  readonly eventId: EventId;
  /** The event type. */
  readonly type: T;
  /** The version the payload was recorded at (the payload itself is at the definition's). */
  readonly version: Version;
  /** The tenant it happened in. */
  readonly tenantId: Tenancy.TenantId;
  /** The company the recording command acted for, when it acted for one. */
  readonly companyId: Option.Option<Tenancy.CompanyId>;
  /** The aggregate it is about. */
  readonly aggregate: AggregateRef;
  /** When it was recorded. */
  readonly occurredAt: Envelope["occurredAt"];
  /** Who acted. */
  readonly actor: ActorRef;
  /** The id every event of one chain shares. */
  readonly correlationId: string;
  /** The id of what caused it. */
  readonly causationId: Option.Option<string>;
  /** The decoded payload. */
  readonly payload: A;
}

/** An event built inside a command, not yet recorded: `./EventRecorder` adds its envelope. */
export interface Pending {
  /** The event type. */
  readonly type: string;
  /** The version its payload is encoded at. */
  readonly version: Version;
  /** The aggregate it is about. */
  readonly aggregate: AggregateRef;
  /** The payload encoded as JSON by the definition's schema; a `ValidationError` when it does not encode. */
  readonly encoded: Effect.Effect<Schema.Json, BizError.ValidationError>;
}

/** What {@link DomainEvent.of} takes: the aggregate (kind, id, version) and the payload. */
export interface Input<A> {
  /** The aggregate the event is about, at the version the command stores it at. */
  readonly aggregate: {
    readonly kind: string;
    readonly id: string;
    readonly version: number;
  };
  /** The payload, of the definition's type. */
  readonly payload: A;
}

/**
 * The definition of one version of an event type: its name, its version,
 * the payload's schema, and how to build, encode and decode one.
 */
export interface DomainEvent<T extends string, A, I> {
  /** The event type, e.g. `"sales.order.confirmed"`. */
  readonly type: T;
  /** The version this definition reads and writes. */
  readonly version: Version;
  /** The payload's schema at this version. */
  readonly payload: Schema.Codec<A, I>;
  /** An event of this type about `aggregate`, ready to record. */
  readonly of: (input: Input<A>) => Pending;
  /**
   * Decodes a stored envelope of this type: a payload stored at this version
   * through the schema, one stored at an earlier version through that
   * version's schema and the upcasters since. A newer version, another
   * type or a payload the schema refuses is a `ValidationError`.
   */
  readonly decode: (envelope: Envelope) => Effect.Effect<EventOf<this>, BizError.ValidationError>;
  /** Decodes a payload stored at `version` (at most this one), upcasting it to this version. */
  readonly decodePayload: (
    version: number,
    payload: Schema.Json,
  ) => Effect.Effect<A, BizError.ValidationError>;
}

/** Any event definition, as a subscriber lists them. */
export type Any = DomainEvent<string, any, any>;

/** The decoded event a definition yields, distributed over a union of definitions. */
export type EventOf<D> = D extends DomainEvent<infer T, infer A, infer _I> ? Event<T, A> : never;

/** A `ValidationError` for one path of a stored envelope. */
const invalid = (path: ReadonlyArray<string>, message: string): BizError.ValidationError =>
  new BizError.ValidationError({ issues: [new BizError.Issue({ path, message })] });

/** A definition from its payload decoder: the rest is the same for every version. */
const define = <T extends string, A, I>(
  type: T,
  version: Version,
  payload: Schema.Codec<A, I>,
  decodePayload: DomainEvent<T, A, I>["decodePayload"],
): DomainEvent<T, A, I> => {
  const json = Schema.toCodecJson(payload);
  const encode = Schema.encodeEffect(json);
  return {
    type,
    version,
    payload,
    of: ({ aggregate, payload: value }) => ({
      type,
      version,
      aggregate: new AggregateRef(aggregate),
      encoded: Effect.mapError(encode(value), BizError.fromSchemaError),
    }),
    decodePayload,
    decode: (envelope) =>
      envelope.type === type
        ? Effect.map(decodePayload(envelope.version, envelope.payload), (decoded) => ({
            eventId: envelope.eventId,
            type,
            version: envelope.version,
            tenantId: envelope.tenantId,
            companyId: envelope.companyId,
            aggregate: envelope.aggregate,
            occurredAt: envelope.occurredAt,
            actor: envelope.actor,
            correlationId: envelope.correlationId,
            causationId: envelope.causationId,
            payload: decoded,
          }))
        : Effect.fail(invalid(["type"], `Expected ${type}, got ${envelope.type}`)),
  };
};

/** Decodes a JSON payload at exactly `version` through `json`, refusing any other version. */
const decodeAt =
  <A, I>(type: string, version: Version, payload: Schema.Codec<A, I>) =>
  (stored: number, value: Schema.Json): Effect.Effect<A, BizError.ValidationError> =>
    stored === version
      ? Effect.mapError(
          Schema.decodeEffect(Schema.toCodecJson(payload))(value),
          BizError.fromSchemaError,
        )
      : Effect.fail(invalid(["version"], `${type} v${stored} is not readable as v${version}`));

/**
 * Defines version 1 of an event type: its name (`"<module>.<aggregate>.<what
 * happened>"`, in the past tense) and its payload's schema, which must encode
 * to JSON. The payload holds the facts a subscriber needs, by id; never a
 * copy of personal data it can load.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Schema } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as DomainEvent from "@thomasfosterau/effect-biz/DomainEvent";
 * import * as EventRecorder from "@thomasfosterau/effect-biz/EventRecorder";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Outbox from "@thomasfosterau/effect-biz/Outbox";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const OrderConfirmed = DomainEvent.make(
 *   "sales.order.confirmed",
 *   Schema.Struct({ orderId: Schema.String, lines: Schema.Int }),
 * );
 *
 * // Inside a command: stage the event with the command's other writes.
 * const confirm = (orderId: string) =>
 *   UnitOfWork.transaction(
 *     EventRecorder.record(
 *       OrderConfirmed.of({
 *         aggregate: { kind: "SalesOrder", id: orderId, version: 2 },
 *         payload: { orderId, lines: 3 },
 *       }),
 *     ),
 *   );
 *
 * const layer = EventRecorder.layer.pipe(
 *   Layer.provideMerge(Layer.mergeAll(Outbox.layerMemory, Id.layerSequential, UnitOfWork.layerMemory)),
 * );
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * const envelope = Effect.runSync(
 *   confirm("o-1").pipe(
 *     Effect.provide(layer),
 *     Tenancy.withTenant(tenant),
 *     Actor.withActor(Actor.system("example")),
 *   ),
 * );
 * console.log(envelope.type, envelope.version, envelope.payload); // "sales.order.confirmed" 1 { orderId: "o-1", lines: 3 }
 * console.log(envelope.correlationId === envelope.eventId); // true: the first event of its chain
 * ```
 */
export const make = <const T extends string, A, I>(
  type: T,
  payload: Schema.Codec<A, I>,
): DomainEvent<T, A, I> => define(type, 1, payload, decodeAt(type, 1, payload));

/**
 * Defines the next version of an event type, for a change that is not
 * additive: the new payload schema, and the upcaster from the previous
 * version's payload. An envelope stored at any earlier version decodes
 * through its own version's schema and every upcaster since.
 */
export const evolve = <const T extends string, P, PI, A, I>(
  previous: DomainEvent<T, P, PI>,
  payload: Schema.Codec<A, I>,
  upcast: (previous: P) => A,
): DomainEvent<T, A, I> => {
  const version = previous.version + 1;
  const current = decodeAt(previous.type, version, payload);
  return define(previous.type, version, payload, (stored, value) =>
    stored < version
      ? Effect.map(previous.decodePayload(stored, value), upcast)
      : current(stored, value),
  );
};

/** The correlation and causation ids the events recorded in this context carry. */
export interface Correlation {
  /** The chain's correlation id; when `None`, an event correlates with itself. */
  readonly correlationId: Option.Option<string>;
  /** What caused the events recorded here: an event's id, or the host's command id. */
  readonly causationId: Option.Option<string>;
}

/**
 * The correlation of the events recorded in this context: none by default,
 * set by {@link withCorrelation} (a host's request) and by {@link causedBy}
 * (a subscriber handling an event).
 */
export const CurrentCorrelation: Context.Reference<Correlation> = Context.Reference<Correlation>(
  "@effect-biz/DomainEvent/CurrentCorrelation",
  { defaultValue: () => ({ correlationId: Option.none(), causationId: Option.none() }) },
);

/**
 * Runs an effect with a correlation id, such as the host's request id: every
 * event it records, and every event recorded in reaction, carries it.
 */
export const withCorrelation: {
  (correlationId: string): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(self: Effect.Effect<A, E, R>, correlationId: string): Effect.Effect<A, E, R>;
} = dual(
  2,
  <A, E, R>(self: Effect.Effect<A, E, R>, correlationId: string): Effect.Effect<A, E, R> =>
    Effect.provideService(self, CurrentCorrelation, {
      correlationId: Option.some(correlationId),
      causationId: Option.none(),
    }),
);

/**
 * Runs an effect as the reaction to `envelope`: the events it records share
 * the envelope's correlation id and name the envelope's event as their
 * cause. Every subscriber's handler runs under it.
 */
export const causedBy: {
  (envelope: Envelope): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(self: Effect.Effect<A, E, R>, envelope: Envelope): Effect.Effect<A, E, R>;
} = dual(2, <A, E, R>(self: Effect.Effect<A, E, R>, envelope: Envelope): Effect.Effect<A, E, R> =>
  Effect.provideService(self, CurrentCorrelation, {
    correlationId: Option.some(envelope.correlationId),
    causationId: Option.some(envelope.eventId),
  }),
);

/**
 * The transactional outbox: where a command's recorded events wait, in the
 * same batch as its state change, until the dispatcher delivers them.
 *
 * {@link Outbox} is the port. `append` is staged through `./UnitOfWork`
 * like any repository write, so an event lands exactly when the command's
 * batch commits (and never when it fails). The other operations are the
 * relay's, and run across tenants: one relay serves one database.
 *
 * **Deliveries, not entries, carry the state.** Each appended entry is
 * delivered to every subscriber whose types it matches, and each (entry,
 * subscriber) pair is a {@link Delivery} with its own status (`pending`,
 * `dispatched`, `failed` awaiting a retry, `dead`), attempt count and
 * lease, so one subscriber failing never holds back another. A subscriber
 * registered later is delivered every entry the outbox still holds.
 *
 * **Leases, not locks** (#128: D1 has neither row locks nor `SKIP
 * LOCKED`). {@link Outbox.claimBatch} takes, in one atomic step, deliveries
 * that are due (pending, or failed with its retry time reached) and whose
 * lease is absent or expired, and leases them to the claiming owner until
 * `now + leaseFor`, counting an attempt. A relay that dies mid-delivery
 * loses nothing: its lease expires and another relay claims the delivery
 * again, so delivery is at least once (a subscriber's inbox makes its
 * effects exactly once).
 *
 * **Ordering per aggregate.** For each subscriber, a claim takes only the
 * first unsettled delivery of each aggregate (by append order), and skips
 * the aggregate while that delivery is leased or waiting for its retry: an
 * aggregate's later event is never delivered to a subscriber before the
 * earlier one is dispatched or dead.
 *
 * {@link layerMemory} is the in-memory implementation; the SQL one lives in
 * the `-sql` package and runs the same contract (`./testing`).
 *
 * See {@link layerMemory} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as TxRef from "effect/TxRef";
import type * as BizError from "./BizError.js";
import * as DomainEvent from "./DomainEvent.js";
import type * as Tenancy from "./Tenancy.js";
import * as UnitOfWork from "./UnitOfWork.js";

/** The state of one delivery: due, done, waiting for a retry, or given up. */
export const DeliveryStatus = Schema.Literals(["pending", "dispatched", "failed", "dead"]);

/** One of the delivery states. */
export type DeliveryStatus = typeof DeliveryStatus.Type;

/**
 * Why a delivery failed: the failure's tag and message, nothing else. A
 * `BizError`'s message carries no personal data; a defect is stored as
 * `"Defect"` with its error's name only.
 */
export class DeliveryError extends Schema.Class<DeliveryError, { readonly brand: unique symbol }>(
  "@effect-biz/Outbox/DeliveryError",
)({
  /** The failure's `_tag`, `"Defect"` for a defect. */
  tag: Schema.String,
  /** The failure's message. */
  message: Schema.String,
}) {}

/**
 * The delivery of one outbox entry to one subscriber: its status, how many
 * times it has been claimed, its lease and its retry time.
 */
export class Delivery extends Schema.Class<Delivery, { readonly brand: unique symbol }>(
  "@effect-biz/Outbox/Delivery",
)({
  /** The entry's position in the outbox, from 1 in append order. */
  sequence: Schema.Int,
  /** The subscriber it is for. */
  subscriber: Schema.NonEmptyString,
  /** Its state. */
  status: DeliveryStatus,
  /** How many times it has been claimed. */
  attempts: Schema.Int,
  /** The relay holding its lease, while it is leased. */
  leaseOwner: Schema.OptionFromNullOr(Schema.String),
  /** When its lease expires, while it is leased. */
  leaseUntil: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  /** When a failed delivery is due again. */
  retryAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  /** The last failure, once it has failed. */
  lastError: Schema.OptionFromNullOr(DeliveryError),
}) {}

/** A claimed delivery: the entry and subscriber, the lease's owner, the attempt it is. */
export class Claim extends Schema.Class<Claim, { readonly brand: unique symbol }>(
  "@effect-biz/Outbox/Claim",
)({
  /** The entry's position in the outbox. */
  sequence: Schema.Int,
  /** The subscriber to deliver it to. */
  subscriber: Schema.NonEmptyString,
  /** The relay the lease belongs to. */
  owner: Schema.String,
  /** Which attempt this is, from 1. */
  attempts: Schema.Int,
  /** The recorded event. */
  envelope: DomainEvent.Envelope,
}) {}

/** A delivery given up on: the event, the subscriber, the attempts made and the last failure. */
export class DeadLetter extends Schema.Class<DeadLetter, { readonly brand: unique symbol }>(
  "@effect-biz/Outbox/DeadLetter",
)({
  /** The entry's position in the outbox. */
  sequence: Schema.Int,
  /** The subscriber that could not handle it. */
  subscriber: Schema.NonEmptyString,
  /** How many times it was claimed. */
  attempts: Schema.Int,
  /** The last failure. */
  error: DeliveryError,
  /** The recorded event. */
  envelope: DomainEvent.Envelope,
}) {}

/** A subscriber as a claim sees it: its name and the event types it handles. */
export interface Subscription {
  /** The subscriber's name, unique within the dispatcher. */
  readonly name: string;
  /** The event types it handles. */
  readonly types: ReadonlyArray<string>;
}

/** What {@link Outbox.claimBatch} takes. */
export interface ClaimRequest {
  /** The claiming relay, which the leases are recorded under. */
  readonly owner: string;
  /** The subscribers to claim deliveries for. */
  readonly subscriptions: ReadonlyArray<Subscription>;
  /** The most deliveries to claim, oldest entries first. */
  readonly limit: number;
  /** How long each lease lasts. */
  readonly leaseFor: Duration.Input;
}

/** The outbox port: the recorder's `append` and the relay's claim and settle operations. */
export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * Stages an entry into the open `UnitOfWork.transaction`'s batch (or
     * appends it at once outside one): it lands only if the batch commits.
     */
    readonly append: (
      envelope: DomainEvent.Envelope,
    ) => Effect.Effect<void, BizError.ConcurrencyConflict, Tenancy.TenantContext>;
    /**
     * Leases due deliveries to `owner`, atomically: at most one per
     * subscriber and aggregate, oldest first, each counting an attempt.
     */
    readonly claimBatch: (
      request: ClaimRequest,
    ) => Effect.Effect<ReadonlyArray<Claim>, BizError.Unavailable>;
    /** Settles a claimed delivery as dispatched; a no-op once its lease is another owner's. */
    readonly markDispatched: (claim: Claim) => Effect.Effect<void, BizError.Unavailable>;
    /**
     * Settles a claimed delivery as failed with `error`: due again at
     * `retryAt` when it is `Some`, dead when it is `None`. A no-op once its
     * lease is another owner's.
     */
    readonly markFailed: (
      claim: Claim,
      error: DeliveryError,
      retryAt: Option.Option<DateTime.Utc>,
    ) => Effect.Effect<void, BizError.Unavailable>;
    /** The dead deliveries, oldest entry first. */
    readonly deadLetters: Effect.Effect<ReadonlyArray<DeadLetter>, BizError.Unavailable>;
  }
>()("@effect-biz/Outbox/Outbox") {}

/** One appended event and its position. */
interface Entry {
  readonly sequence: number;
  readonly envelope: DomainEvent.Envelope;
}

/** The in-memory outbox: its entries and the deliveries claimed so far. */
interface State {
  readonly entries: ReadonlyArray<Entry>;
  /** By {@link deliveryKey}; a delivery never claimed is absent (pending, no attempt). */
  readonly deliveries: HashMap.HashMap<string, Delivery>;
}

const deliveryKey = (sequence: number, subscriber: string): string => `${sequence}/${subscriber}`;

/** The aggregate an entry is about, across tenants. */
const aggregateKey = ({ envelope }: Entry): string =>
  `${envelope.tenantId}/${envelope.aggregate.kind}/${envelope.aggregate.id}`;

const deliveryOf = (state: State, sequence: number, subscriber: string): Delivery =>
  Option.getOrElse(
    HashMap.get(state.deliveries, deliveryKey(sequence, subscriber)),
    () =>
      new Delivery({
        sequence,
        subscriber,
        status: "pending",
        attempts: 0,
        leaseOwner: Option.none(),
        leaseUntil: Option.none(),
        retryAt: Option.none(),
        lastError: Option.none(),
      }),
  );

const isSettled = (delivery: Delivery): boolean =>
  delivery.status === "dispatched" || delivery.status === "dead";

const notAfter = (at: Option.Option<DateTime.Utc>, now: DateTime.Utc): boolean =>
  Option.match(at, {
    onNone: () => true,
    onSome: (time) => DateTime.isLessThanOrEqualTo(time, now),
  });

/** Whether an unsettled delivery can be claimed now: its retry is due and its lease absent or expired. */
const isDue = (delivery: Delivery, now: DateTime.Utc): boolean =>
  notAfter(delivery.retryAt, now) && notAfter(delivery.leaseUntil, now);

interface Candidate {
  readonly entry: Entry;
  readonly delivery: Delivery;
}

interface Scan {
  readonly blocked: HashSet.HashSet<string>;
  readonly due: ReadonlyArray<Candidate>;
}

/**
 * The due deliveries for one subscriber: per aggregate, its first unsettled
 * delivery, only if that one is due.
 */
const dueFor = (state: State, subscription: Subscription, now: DateTime.Utc) =>
  Arr.reduce(
    state.entries,
    { blocked: HashSet.empty<string>(), due: [] },
    (scan: Scan, entry): Scan => {
      const key = aggregateKey(entry);
      if (
        !Arr.contains(subscription.types, entry.envelope.type) ||
        HashSet.has(scan.blocked, key)
      ) {
        return scan;
      }
      const delivery = deliveryOf(state, entry.sequence, subscription.name);
      if (isSettled(delivery)) {
        return scan;
      }
      return {
        blocked: HashSet.add(scan.blocked, key),
        due: isDue(delivery, now) ? Arr.append(scan.due, { entry, delivery }) : scan.due,
      };
    },
  ).due;

const bySequence = Order.mapInput(Order.Number, (candidate: Candidate) => candidate.entry.sequence);

/** Claims in memory: what {@link Outbox.claimBatch} returns, and the state with the leases taken. */
const claimIn = (
  state: State,
  request: ClaimRequest,
  now: DateTime.Utc,
): [ReadonlyArray<Claim>, State] => {
  const leaseUntil = DateTime.addDuration(now, request.leaseFor);
  const chosen = Arr.take(
    Arr.sort(
      Arr.flatMap(request.subscriptions, (subscription) => dueFor(state, subscription, now)),
      bySequence,
    ),
    Math.max(0, request.limit),
  );
  const leased = Arr.map(
    chosen,
    ({ entry, delivery }) =>
      [
        entry,
        new Delivery({
          sequence: delivery.sequence,
          subscriber: delivery.subscriber,
          status: delivery.status,
          attempts: delivery.attempts + 1,
          leaseOwner: Option.some(request.owner),
          leaseUntil: Option.some(leaseUntil),
          retryAt: delivery.retryAt,
          lastError: delivery.lastError,
        }),
      ] as const,
  );
  const claims = Arr.map(
    leased,
    ([entry, delivery]) =>
      new Claim({
        sequence: entry.sequence,
        subscriber: delivery.subscriber,
        owner: request.owner,
        attempts: delivery.attempts,
        envelope: entry.envelope,
      }),
  );
  const deliveries = Arr.reduce(leased, state.deliveries, (all, [entry, delivery]) =>
    HashMap.set(all, deliveryKey(entry.sequence, delivery.subscriber), delivery),
  );
  return [claims, { entries: state.entries, deliveries }];
};

/** Settles a claimed delivery, unless its lease is no longer the claim's. */
const settle = (state: State, claim: Claim, settled: (delivery: Delivery) => Delivery): State => {
  const key = deliveryKey(claim.sequence, claim.subscriber);
  return Option.match(HashMap.get(state.deliveries, key), {
    onNone: () => state,
    onSome: (delivery) =>
      Option.contains(delivery.leaseOwner, claim.owner)
        ? {
            entries: state.entries,
            deliveries: HashMap.set(state.deliveries, key, settled(delivery)),
          }
        : state,
  });
};

/** The delivery with another status, retry time and error, its lease released. */
const released = (
  delivery: Delivery,
  status: DeliveryStatus,
  retryAt: Option.Option<DateTime.Utc>,
  lastError: Option.Option<DeliveryError>,
): Delivery =>
  new Delivery({
    sequence: delivery.sequence,
    subscriber: delivery.subscriber,
    status,
    attempts: delivery.attempts,
    leaseOwner: Option.none(),
    leaseUntil: Option.none(),
    retryAt,
    lastError,
  });

/** The dead letters of the in-memory state, oldest entry first. */
const deadIn = (state: State): ReadonlyArray<DeadLetter> => {
  const dead = Arr.filter(
    HashMap.toValues(state.deliveries),
    (delivery) => delivery.status === "dead",
  );
  return Arr.flatMap(state.entries, (entry) =>
    Arr.flatMap(
      Arr.filter(dead, (delivery) => delivery.sequence === entry.sequence),
      (delivery: Delivery) =>
        Arr.fromOption(
          Option.map(
            delivery.lastError,
            (error: DeliveryError) =>
              new DeadLetter({
                sequence: entry.sequence,
                subscriber: delivery.subscriber,
                attempts: delivery.attempts,
                error,
                envelope: entry.envelope,
              }),
          ),
        ),
    ),
  );
};

/** An empty in-memory outbox. */
export const makeMemory: Effect.Effect<Outbox["Service"]> = Effect.map(
  TxRef.make<State>({ entries: [], deliveries: HashMap.empty() }),
  (state) =>
    Outbox.of({
      append: (envelope) =>
        UnitOfWork.stage(
          UnitOfWork.memoryJournal,
          TxRef.update(state, (current) => ({
            entries: Arr.append(current.entries, {
              sequence: current.entries.length + 1,
              envelope,
            }),
            deliveries: current.deliveries,
          })),
          UnitOfWork.commitMemory,
        ),
      claimBatch: (request) =>
        Effect.flatMap(DateTime.now, (now) =>
          TxRef.modify(state, (current) => claimIn(current, request, now)),
        ),
      markDispatched: (claim) =>
        TxRef.update(state, (current) =>
          settle(current, claim, (delivery) =>
            released(delivery, "dispatched", Option.none(), delivery.lastError),
          ),
        ),
      markFailed: (claim, error, retryAt) =>
        TxRef.update(state, (current) =>
          settle(current, claim, (delivery) =>
            released(
              delivery,
              Option.isSome(retryAt) ? "failed" : "dead",
              retryAt,
              Option.some(error),
            ),
          ),
        ),
      deadLetters: Effect.map(TxRef.get(state), deadIn),
    }),
);

/**
 * The in-memory {@link Outbox}, for tests and embedded hosts: its appends
 * are staged into `UnitOfWork.layerMemory`'s batches, so they commit in the
 * same `Effect.tx` as the command's other in-memory writes.
 *
 * @example
 * ```ts
 * import { DateTime, Duration, Effect, Option } from "effect";
 * import * as DomainEvent from "@thomasfosterau/effect-biz/DomainEvent";
 * import * as Outbox from "@thomasfosterau/effect-biz/Outbox";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 *
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 *
 * const program = Effect.gen(function* () {
 *   const outbox = yield* Outbox.Outbox;
 *   const envelope = new DomainEvent.Envelope({
 *     eventId: DomainEvent.EventId.make("00000000-0000-7000-8000-000000000001"),
 *     type: "example.note.added",
 *     version: 1,
 *     tenantId: tenant,
 *     companyId: Option.none(),
 *     aggregate: new DomainEvent.AggregateRef({ kind: "Note", id: "n-1", version: 1 }),
 *     occurredAt: DateTime.makeUnsafe(0),
 *     actor: new DomainEvent.ActorRef({ kind: "system", id: "example" }),
 *     correlationId: "00000000-0000-7000-8000-000000000001",
 *     causationId: Option.none(),
 *     payload: { text: "hello" },
 *   });
 *   yield* outbox.append(envelope).pipe(Tenancy.withTenant(tenant));
 *   const subscriptions = [{ name: "audit-log", types: ["example.note.added"] }];
 *   const request = { owner: "relay-1", subscriptions, limit: 10, leaseFor: Duration.seconds(30) };
 *   const [claim] = yield* outbox.claimBatch(request);
 *   const again = yield* outbox.claimBatch(request); // leased: nothing more to claim
 *   return [claim?.attempts, again.length];
 * });
 *
 * console.log(Effect.runSync(program.pipe(Effect.provide(Outbox.layerMemory)))); // [1, 0]
 * ```
 */
export const layerMemory: Layer.Layer<Outbox> = Layer.effect(Outbox, makeMemory);

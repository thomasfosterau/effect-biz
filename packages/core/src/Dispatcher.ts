/**
 * The dispatcher: the relay that claims outbox deliveries and hands them to
 * their subscribers, retrying with exponential backoff and dead-lettering
 * what never succeeds.
 *
 * {@link Dispatcher.runOnce} is one round: it claims a batch from the
 * `Outbox` (at most one delivery per subscriber and aggregate, each leased
 * to this dispatcher), runs each through its `Subscriber.handle`, up to
 * `concurrency` at once, and settles it:
 *
 * - **handled**: `markDispatched`;
 * - **failed, attempts left**: `markFailed` with a retry time, `now` plus
 *   the `backoff` schedule's delay for that attempt (exponential from 1
 *   second by default), stepped from `Clock`'s time; until then the
 *   delivery, and the later events of its aggregate for that subscriber,
 *   wait, while every other aggregate and every other subscriber proceeds;
 * - **failed on the last attempt** (`maxAttempts`, 5 by default, or the
 *   schedule ends): `markFailed` with no retry time, which dead-letters it
 *   with the failure's tag and message; the aggregate's later events then
 *   flow again.
 *
 * {@link Dispatcher.drain} repeats rounds until one claims nothing (a
 * retry not yet due stays for a later drain). {@link layer} runs `drain`
 * every `pollInterval` on a scoped relay fiber (`Effect.forkScoped`), which
 * the layer's scope interrupts; {@link layerOnDemand} runs no relay, for a
 * host that drives `runOnce` / `drain` itself (a cron or queue trigger) and
 * for tests. A delivery interrupted mid-handler is neither dispatched nor
 * failed: its lease expires and it is claimed again.
 *
 * Every round is a span, `Dispatcher.runOnce`, and each delivery a child
 * span, `Subscriber.handle`.
 *
 * See {@link make} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import type * as BizError from "./BizError.js";
import * as Outbox from "./Outbox.js";
import type * as Subscriber from "./Subscriber.js";

/** How a dispatcher claims, leases, retries and polls. */
export interface Options {
  /** The name its leases are recorded under; a fresh random one by default. */
  readonly owner?: string;
  /** The most deliveries one round claims. Default 100. */
  readonly batchSize?: number;
  /** How many deliveries (each a different subscriber or aggregate) run at once. Default 8. */
  readonly concurrency?: number;
  /** How long a claimed delivery is leased: longer than a handler takes. Default 30 seconds. */
  readonly leaseFor?: Duration.Input;
  /** How many attempts a delivery gets before it is dead-lettered. Default 5. */
  readonly maxAttempts?: number;
  /**
   * The delay before each retry: the schedule's delay at that attempt, from
   * a fresh start (so bound it by attempts, not elapsed time). A schedule
   * that ends dead-letters at once. Default `Schedule.exponential("1 second")`.
   */
  readonly backoff?: Schedule.Schedule<unknown>;
  /** How long {@link layer}'s relay waits after a drain that found nothing more. Default 1 second. */
  readonly pollInterval?: Duration.Input;
}

/** What a round (or a drain) did: how many deliveries it claimed, and how each ended. */
export interface Report {
  /** Deliveries claimed. */
  readonly claimed: number;
  /** Handled and settled as dispatched. */
  readonly dispatched: number;
  /** Failed, with a retry scheduled. */
  readonly retried: number;
  /** Failed on their last attempt, and dead-lettered. */
  readonly dead: number;
}

/** The relay's operations: one round, or rounds until nothing is due. */
export class Dispatcher extends Context.Service<
  Dispatcher,
  {
    /** Claims one batch and delivers it. */
    readonly runOnce: Effect.Effect<Report, BizError.Unavailable>;
    /** Runs rounds until one claims nothing; the sum of their reports. */
    readonly drain: Effect.Effect<Report, BizError.Unavailable>;
  }
>()("@effect-biz/Dispatcher/Dispatcher") {}

const none: Report = { claimed: 0, dispatched: 0, retried: 0, dead: 0 };

const sum = (left: Report, right: Report): Report => ({
  claimed: left.claimed + right.claimed,
  dispatched: left.dispatched + right.dispatched,
  retried: left.retried + right.retried,
  dead: left.dead + right.dead,
});

/** How one delivery ended. */
type Outcome = "dispatched" | "retried" | "dead";

const reportOf = (outcomes: ReadonlyArray<Outcome>): Report => ({
  claimed: outcomes.length,
  dispatched: Arr.filter(outcomes, (outcome) => outcome === "dispatched").length,
  retried: Arr.filter(outcomes, (outcome) => outcome === "retried").length,
  dead: Arr.filter(outcomes, (outcome) => outcome === "dead").length,
});

/**
 * The delay before the retry after failed attempt `attempt`: the schedule's
 * `attempt`-th delay, or `None` when it ends first.
 */
const delayAt = (
  schedule: Schedule.Schedule<unknown>,
  attempt: number,
  now: number,
): Effect.Effect<Option.Option<Duration.Duration>> =>
  Effect.flatMap(Schedule.toStep(schedule), (step) =>
    Effect.forEach(Arr.range(1, Math.max(1, attempt)), () => step(now, undefined), {
      concurrency: 1,
    }).pipe(
      Effect.map((steps) => Option.map(Arr.last(steps), ([, delay]) => delay)),
      Pull.catchDone(() => Effect.succeed(Option.none<Duration.Duration>())),
    ),
  );

/** The settled options, with their defaults. */
interface Settings {
  readonly owner: string;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly leaseFor: Duration.Input;
  readonly maxAttempts: number;
  readonly backoff: Schedule.Schedule<unknown>;
}

const settingsOf = (options: Options): Effect.Effect<Settings> =>
  Effect.map(
    Option.match(Option.fromUndefinedOr(options.owner), {
      onNone: () => Effect.map(Random.nextInt, (n) => `dispatcher-${Math.abs(n).toString(36)}`),
      onSome: Effect.succeed,
    }),
    (owner) => ({
      owner,
      batchSize: options.batchSize ?? 100,
      concurrency: options.concurrency ?? 8,
      leaseFor: options.leaseFor ?? "30 seconds",
      maxAttempts: options.maxAttempts ?? 5,
      backoff: options.backoff ?? Schedule.exponential("1 second"),
    }),
  );

/** The retry time after a failed claim, or `None` to dead-letter it. */
const retryAtOf = (settings: Settings, claim: Outbox.Claim) =>
  claim.attempts >= settings.maxAttempts
    ? Effect.succeed(Option.none<DateTime.Utc>())
    : Effect.flatMap(DateTime.now, (now) =>
        Effect.map(
          delayAt(settings.backoff, claim.attempts, DateTime.toEpochMillis(now)),
          (delay) => Option.map(delay, (duration) => DateTime.addDuration(now, duration)),
        ),
      );

/**
 * A dispatcher for `subscribers` over the current `Outbox`, with no relay of
 * its own: call `runOnce` or `drain`. Each subscriber's name must be unique
 * among them.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Ref, Schedule, Schema } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as BizError from "@thomasfosterau/effect-biz/BizError";
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
 *   const handled = yield* Ref.make(0);
 *   const counter = yield* Subscriber.make("example.counter", [NoteAdded], () => Ref.update(handled, (n) => n + 1));
 *   const broken = yield* Subscriber.make("example.broken", [NoteAdded], () =>
 *     Effect.fail(new BizError.Unavailable({ service: "mailer" })),
 *   );
 *   // Retry at once, three attempts in all.
 *   const dispatcher = yield* Dispatcher.make([counter, broken], { maxAttempts: 3, backoff: Schedule.spaced(0) });
 *   yield* UnitOfWork.transaction(
 *     EventRecorder.record(NoteAdded.of({ aggregate: { kind: "Note", id: "n-1", version: 1 }, payload: { text: "hi" } })),
 *   ).pipe(Tenancy.withTenant(Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab")));
 *   const report = yield* dispatcher.drain;
 *   const [dead] = yield* Effect.flatMap(Effect.service(Outbox.Outbox), (outbox) => outbox.deadLetters);
 *   return [report, yield* Ref.get(handled), dead?.subscriber, dead?.error.tag];
 * });
 *
 * const layer = EventRecorder.layer.pipe(
 *   Layer.provideMerge(
 *     Layer.mergeAll(Outbox.layerMemory, Subscriber.layerInboxMemory, Id.layerSequential, UnitOfWork.layerMemory),
 *   ),
 * );
 * console.log(Effect.runSync(program.pipe(Effect.provide(layer), Actor.withActor(Actor.system("example")))));
 * // [{ claimed: 4, dispatched: 1, retried: 2, dead: 1 }, 1, "example.broken", "Unavailable"]
 * ```
 */
export const make = (
  subscribers: ReadonlyArray<Subscriber.Subscriber>,
  options: Options = {},
): Effect.Effect<Dispatcher["Service"], never, Outbox.Outbox> =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.Outbox;
    const settings = yield* settingsOf(options);
    const subscriptions = Arr.map(subscribers, ({ name, types }) => ({ name, types }));
    const deliver = (claim: Outbox.Claim): Effect.Effect<Outcome, BizError.Unavailable> =>
      Option.match(
        Arr.findFirst(subscribers, (subscriber) => subscriber.name === claim.subscriber),
        {
          // Never: a claim names one of the subscriptions it was made for.
          onNone: () => Effect.succeed<Outcome>("retried"),
          onSome: (subscriber) =>
            Effect.matchEffect(subscriber.handle(claim.envelope), {
              onSuccess: () => Effect.as(outbox.markDispatched(claim), "dispatched" as const),
              onFailure: (error) =>
                Effect.flatMap(retryAtOf(settings, claim), (retryAt) =>
                  Effect.as(
                    outbox.markFailed(claim, error, retryAt),
                    Option.isSome(retryAt) ? ("retried" as const) : ("dead" as const),
                  ),
                ),
            }),
        },
      );
    const runOnce = outbox
      .claimBatch({
        owner: settings.owner,
        subscriptions,
        limit: settings.batchSize,
        leaseFor: settings.leaseFor,
      })
      .pipe(
        Effect.flatMap((claims) =>
          Effect.forEach(claims, deliver, { concurrency: settings.concurrency }),
        ),
        Effect.map(reportOf),
        Effect.withSpan("Dispatcher.runOnce", { attributes: { owner: settings.owner } }),
      );
    const drainFrom = (total: Report): Effect.Effect<Report, BizError.Unavailable> =>
      Effect.flatMap(runOnce, (round) =>
        round.claimed === 0 ? Effect.succeed(total) : drainFrom(sum(total, round)),
      );
    return Dispatcher.of({ runOnce, drain: Effect.suspend(() => drainFrom(none)) });
  });

/**
 * The {@link Dispatcher} for the subscribers `subscribers` builds (one
 * `Effect.all` of their `Subscriber.make`s), with no relay: the host (a cron or queue trigger) or the test calls `runOnce` or
 * `drain`.
 */
export const layerOnDemand = <R>(
  subscribers: Effect.Effect<ReadonlyArray<Subscriber.Subscriber>, never, R>,
  options: Options = {},
): Layer.Layer<Dispatcher, never, Outbox.Outbox | R> =>
  Layer.effect(
    Dispatcher,
    Effect.flatMap(subscribers, (built) => make(built, options)),
  );

/**
 * The {@link Dispatcher} for the subscribers `subscribers` builds (one
 * `Effect.all` of their `Subscriber.make`s), with its relay running: a fiber, forked into the layer's scope, that drains every
 * `pollInterval` (1 second by default) until the scope closes. A failed
 * round (the outbox unavailable) is logged by its tag and the relay goes on.
 */
export const layer = <R>(
  subscribers: Effect.Effect<ReadonlyArray<Subscriber.Subscriber>, never, R>,
  options: Options = {},
): Layer.Layer<Dispatcher, never, Outbox.Outbox | R> =>
  Layer.effect(
    Dispatcher,
    Effect.tap(
      Effect.flatMap(subscribers, (built) => make(built, options)),
      (dispatcher) =>
        dispatcher.drain.pipe(
          Effect.catchTag("Unavailable", (error) =>
            Effect.logWarning("Dispatcher round failed").pipe(
              Effect.annotateLogs({ error: error._tag, service: error.service }),
            ),
          ),
          Effect.andThen(Effect.sleep(options.pollInterval ?? "1 second")),
          Effect.forever,
          Effect.forkScoped,
        ),
    ),
  );

/** Runs one round of the current {@link Dispatcher}. */
export const runOnce: Effect.Effect<Report, BizError.Unavailable, Dispatcher> = Effect.flatMap(
  Effect.service(Dispatcher),
  (dispatcher) => dispatcher.runOnce,
);

/** Drains the current {@link Dispatcher}: rounds until one claims nothing. */
export const drain: Effect.Effect<Report, BizError.Unavailable, Dispatcher> = Effect.flatMap(
  Effect.service(Dispatcher),
  (dispatcher) => dispatcher.drain,
);

/** One delivery's retry delay under the default backoff, for docs and tests: `attempt` seconds doubled. */
export const defaultBackoff: Schedule.Schedule<Duration.Duration> =
  Schedule.exponential("1 second");

/**
 * The unit of work: the transaction boundary of a command, shaped for
 * databases without interactive transactions (Cloudflare D1, #128).
 *
 * Every command is **load → decide (pure) → commit one batch**. Inside
 * {@link transaction}, a repository's writes are not applied: each is
 * *staged* (with {@link stage}) as a version-guarded write into the
 * transaction's {@link Journal}, and when the command succeeds the unit of
 * work commits every staged write as one atomic batch. A guard that fails at
 * commit (another command committed first) aborts the whole batch with
 * nothing applied, and the command is retried from its load step with
 * bounded exponential backoff, ending in `ConcurrencyConflict` after the
 * last attempt. A command that fails, or is interrupted, before its commit
 * leaves every store untouched: its staged writes are dropped.
 *
 * - **The service wraps its command**, never the caller; a repository never
 *   opens a transaction itself.
 * - **Nested calls join** the outermost transaction, which alone commits and
 *   retries.
 * - **No read-your-writes.** Reads inside a transaction see committed state,
 *   not the writes staged so far: decide from what you loaded.
 * - **Outside a transaction**, a staged write commits at once as its own
 *   one-write batch.
 *
 * {@link layerMemory} is the in-memory implementation: its writes are
 * transactional effects over `TxRef`s ({@link MemoryWrite}, staged by
 * `./Memory`), committed together in one `Effect.tx`. A SQL layer builds its
 * own with {@link makeJournal} and {@link make}, over its own write type.
 *
 * See {@link transaction} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as BizError from "./BizError.js";

/** The unit of work a service wraps each of its commands in. */
export class UnitOfWork extends Context.Service<
  UnitOfWork,
  {
    /**
     * Runs `effect` as one transaction: its staged writes commit as one
     * batch when it succeeds, and it is retried from the start when that
     * batch hits a version conflict. Inside another transaction it joins
     * that one instead.
     */
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BizError.ConcurrencyConflict, R>;
  }
>()("@effect-biz/UnitOfWork/UnitOfWork") {}

/**
 * Runs a command as one transaction of the current {@link UnitOfWork}:
 * load → decide → stage inside `effect`, then one atomic, version-guarded
 * commit, retried from the load step on a conflict.
 *
 * @example
 * ```ts
 * import { Context, Effect, Layer, Struct } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Memory from "@thomasfosterau/effect-biz/Memory";
 * import type * as Repository from "@thomasfosterau/effect-biz/Repository";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * interface Ticket {
 *   readonly id: string;
 *   readonly status: string;
 *   readonly audit: Audit.AuditFields;
 * }
 *
 * class Tickets extends Context.Service<Tickets, Repository.Port<Ticket, string>>()(
 *   "example/Tickets",
 * ) {}
 *
 * const ticketsMemory = Layer.effect(
 *   Tickets,
 *   Effect.map(Memory.makeStore<string, Ticket>(), (store) =>
 *     Memory.repository(store, {
 *       entity: "Ticket",
 *       withAudit: (ticket, audit) => ({ ...Struct.omit(ticket, ["audit"]), audit }),
 *       searchable: [],
 *     }),
 *   ),
 * );
 *
 * // A command: load both tickets, decide, stage two writes; one batch commits them.
 * const merge = (from: string, into: string) =>
 *   UnitOfWork.transaction(
 *     Effect.gen(function* () {
 *       const tickets = yield* Tickets;
 *       const source = yield* tickets.get(from);
 *       const target = yield* tickets.get(into);
 *       yield* tickets.update({ ...source, status: "merged" });
 *       yield* tickets.update({ ...target, status: "open" });
 *     }),
 *   );
 *
 * const program = Effect.gen(function* () {
 *   const tickets = yield* Tickets;
 *   const audit = yield* Audit.created;
 *   yield* tickets.insert({ id: "a", status: "open", audit });
 *   yield* tickets.insert({ id: "b", status: "waiting", audit });
 *   yield* merge("a", "b");
 *   return [(yield* tickets.get("a")).status, (yield* tickets.get("b")).status];
 * });
 *
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * const statuses = Effect.runSync(
 *   program.pipe(
 *     Effect.provide(Layer.merge(ticketsMemory, UnitOfWork.layerMemory)),
 *     Tenancy.withTenant(tenant),
 *     Actor.withActor(Actor.system("example")),
 *   ),
 * );
 * console.log(statuses); // ["merged", "open"]
 * ```
 */
export const transaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BizError.ConcurrencyConflict, R | UnitOfWork> =>
  Effect.flatMap(Effect.service(UnitOfWork), (unitOfWork) => unitOfWork.transaction(effect));

/**
 * Where a transaction collects its staged writes of type `W`: a reference
 * that holds the open transaction's buffer, and is empty outside one. An
 * implementation declares one, once, at module level, with
 * {@link makeJournal}.
 */
export interface Journal<W> {
  /** The open transaction's buffer of staged writes, or none outside a transaction. */
  readonly current: Context.Reference<Option.Option<Ref.Ref<ReadonlyArray<W>>>>;
}

/** A journal of writes `W`, under a key unique to the implementation that declares it. */
export const makeJournal = <W>(key: string): Journal<W> => ({
  current: Context.Reference<Option.Option<Ref.Ref<ReadonlyArray<W>>>>(key, {
    defaultValue: Option.none,
  }),
});

/**
 * Stages a write: appends it to the open transaction's buffer, or, outside
 * any transaction, commits it at once as a batch of one with `commit`.
 */
export const stage = <W, E, R>(
  journal: Journal<W>,
  write: W,
  commit: (writes: ReadonlyArray<W>) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.flatMap(
    Effect.service(journal.current),
    Option.match({
      onNone: () => commit([write]),
      onSome: (buffer) => Ref.update(buffer, Arr.append(write)),
    }),
  );

/** How a unit of work retries a command whose commit conflicted. */
export interface Options {
  /** How many times the command runs at most, the first included. Default 5. */
  readonly attempts?: number;
  /** The delay before the first retry, doubled (with jitter) before each next one. Default 10 ms. */
  readonly backoff?: Duration.Input;
}

/** A commit's conflict, kept apart from a conflict the command's own body fails with. */
class CommitConflict {
  readonly _tag = "CommitConflict";
  readonly conflict: BizError.ConcurrencyConflict;
  constructor(conflict: BizError.ConcurrencyConflict) {
    this.conflict = conflict;
  }
}

const isCommitConflict = (error: unknown): error is CommitConflict =>
  error instanceof CommitConflict;

/**
 * A unit of work over `journal`: {@link UnitOfWork.transaction} opens a fresh
 * buffer, runs the command with it, and hands the staged writes to `commit`,
 * which must apply all of them or none and fail with `ConcurrencyConflict`
 * when a guard does not hold. The commit is uninterruptible. Only a
 * conflicting commit is retried, never a failure of the command itself (a
 * `ConcurrencyConflict` the command raises, such as a stale version it was
 * given, is returned as it is).
 */
export const make = <W>(
  journal: Journal<W>,
  commit: (writes: ReadonlyArray<W>) => Effect.Effect<void, BizError.ConcurrencyConflict>,
  options: Options = {},
): UnitOfWork["Service"] => {
  const schedule = Schedule.exponential(options.backoff ?? "10 millis").pipe(
    Schedule.jittered,
    Schedule.upTo({ times: Math.max(0, (options.attempts ?? 5) - 1) }),
  );
  const attempt = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | CommitConflict, R> =>
    Effect.flatMap(Ref.make<ReadonlyArray<W>>([]), (buffer) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.tap(
          restore(Effect.provideService(effect, journal.current, Option.some(buffer))),
          () =>
            Effect.flatMap(Ref.get(buffer), (writes) =>
              Effect.mapError(commit(writes), (conflict) => new CommitConflict(conflict)),
            ),
        ),
      ),
    );
  const outermost = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | BizError.ConcurrencyConflict, R> =>
    Effect.retry(attempt(effect), { schedule, while: isCommitConflict }).pipe(
      Effect.mapError((error) => (isCommitConflict(error) ? error.conflict : error)),
    );
  return UnitOfWork.of({
    transaction: (effect) =>
      Effect.flatMap(Effect.service(journal.current), (open) =>
        Option.isSome(open) ? effect : outermost(effect),
      ),
  });
};

/**
 * A staged in-memory write: a transactional effect over `TxRef`s that
 * checks its own guard and applies its change, failing with
 * `ConcurrencyConflict` (and so aborting the batch) when the guard does not
 * hold. `./Memory` builds them.
 */
export type MemoryWrite = Effect.Effect<void, BizError.ConcurrencyConflict>;

/** The in-memory journal `./Memory` stages its writes into. */
export const memoryJournal: Journal<MemoryWrite> = makeJournal<MemoryWrite>(
  "@effect-biz/UnitOfWork/memoryJournal",
);

/**
 * Commits in-memory writes as one batch: all of them in one `Effect.tx`,
 * so a failing guard rolls back every write before it, in every store.
 */
export const commitMemory = (
  writes: ReadonlyArray<MemoryWrite>,
): Effect.Effect<void, BizError.ConcurrencyConflict> =>
  Effect.tx(Effect.forEach(writes, (write) => write, { concurrency: 1, discard: true }));

/** An in-memory unit of work, with its retry tuned by `options`. */
export const makeMemory = (options?: Options): UnitOfWork["Service"] =>
  make(memoryJournal, commitMemory, options);

/**
 * The in-memory {@link UnitOfWork}, for tests and embedded hosts: it commits
 * the writes `./Memory` stages, across every store, in one `Effect.tx`, and
 * retries a conflicting command up to 5 times from 10 ms of backoff.
 */
export const layerMemory: Layer.Layer<UnitOfWork> = Layer.succeed(UnitOfWork, makeMemory());

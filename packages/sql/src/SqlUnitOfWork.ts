/**
 * The SQL unit of work: core's `UnitOfWork` over `effect/sql`, committing
 * each command's staged writes as one atomic batch of version-guarded
 * statements, on Postgres, SQLite and Cloudflare D1 (#128).
 *
 * There are no interactive transactions. A command loads (plain reads,
 * outside any SQL transaction), decides purely, and *stages* its writes
 * ({@link Write}s, through {@link stage}) into core's `UnitOfWork.Journal`;
 * when the command succeeds the unit of work commits the batch:
 *
 * - **Postgres and SQLite** ({@link layer}): one `sql.withTransaction` that
 *   runs the statements in order and counts the rows each guarded one
 *   returns (`RETURNING id`). A guard that is unmet fails the transaction, so
 *   it rolls back and the commit fails with `ConcurrencyConflict`.
 * - **D1** ({@link layer} with a {@link Batch}, or {@link layerBatch}): one
 *   atomic `batch()`. A batch cannot read a statement's row count between
 *   statements, so each guarded statement is followed by a *guard
 *   statement* that raises when unmet (`SELECT CASE WHEN changes() = 1 THEN
 *   1 ELSE json_extract('{}', '$effect-biz-guard:<n>') END`): the bad JSON
 *   path is an error, the error aborts and rolls back the whole batch, and
 *   its message names the guard that failed.
 *
 * Retries (from the load step, with backoff), joining of nested transactions
 * and interruption are core's `UnitOfWork.make`; a nested transaction joins
 * the outer one, with no savepoint. A database failure (a `SqlError`) is a
 * defect: the repository port and `UnitOfWork.make`'s commit have no error
 * channel for one.
 *
 * Row-level security (#38) will set the tenant inside the commit; this
 * module has no hook for it yet.
 *
 * See {@link layer} for an example.
 *
 * @module
 */

import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as Dialect from "./Dialect.js";

/**
 * What a guarded write must achieve at commit: the number of rows its
 * statement must write (and return), and the conflict to fail with when it
 * does not.
 */
export interface Guard {
  /** The rows the statement must write: 1 for a version-guarded update or an insert. */
  readonly rows: number;
  /**
   * The conflict the commit fails with when the guard is unmet: an effect,
   * run after the batch has rolled back, so it can read the version the
   * store holds now.
   */
  readonly conflict: Effect.Effect<BizError.ConcurrencyConflict>;
}

/**
 * One staged write: a statement and, for a version-guarded one, its
 * {@link Guard}. A guarded statement returns one row per row it writes
 * (`RETURNING id`), and is shaped so that it writes nothing when the guard
 * does not hold (`WHERE … AND version = ?`, `ON CONFLICT (id) DO NOTHING`).
 */
export interface Write {
  /** The statement to run at commit. */
  readonly statement: Statement.Statement<object>;
  /** Its guard; `None` for a write that cannot conflict (an append). */
  readonly guard: Option.Option<Guard>;
}

/** A write guarded on the rows its statement returns (1 unless `rows` says otherwise). */
export const guarded = (
  statement: Statement.Statement<object>,
  guard: {
    readonly rows?: number;
    readonly conflict: Effect.Effect<BizError.ConcurrencyConflict>;
  },
): Write => ({
  statement,
  guard: Option.some({ rows: guard.rows ?? 1, conflict: guard.conflict }),
});

/** A write with no guard, such as an append to an outbox. */
export const unguarded = (statement: Statement.Statement<object>): Write => ({
  statement,
  guard: Option.none(),
});

/** The journal SQL writes are staged into: the open transaction's buffer, empty outside one. */
export const journal: UnitOfWork.Journal<Write> = UnitOfWork.makeJournal<Write>(
  "@effect-biz/sql/SqlUnitOfWork/journal",
);

/**
 * How the batch is committed: the service {@link layer} provides beside the
 * `UnitOfWork`, which a repository captures when it is built, so a write
 * staged outside any transaction commits at once as a batch of one.
 */
export class Committer extends Context.Service<
  Committer,
  {
    /** Commits `writes` as one atomic batch, or fails with `ConcurrencyConflict` and applies none. */
    readonly commit: (
      writes: ReadonlyArray<Write>,
    ) => Effect.Effect<void, BizError.ConcurrencyConflict>;
  }
>()("@effect-biz/sql/SqlUnitOfWork/Committer") {}

/**
 * Stages a write into the open `UnitOfWork.transaction`, or, outside one,
 * commits it at once with `committer` as a batch of one.
 */
export const stage = (
  committer: Committer["Service"],
  write: Write,
): Effect.Effect<void, BizError.ConcurrencyConflict> =>
  UnitOfWork.stage(journal, write, committer.commit);

/**
 * A client's atomic batch: runs the statements in order as one unit, all or
 * none, failing with the first statement's error. Cloudflare D1's
 * `D1Client.batch` is one (`Batch.of({ run: d1.batch })`); this package
 * imports no D1 client, so a D1 host provides it.
 */
export class Batch extends Context.Service<
  Batch,
  {
    /** Runs the statements as one atomic batch. */
    readonly run: (
      statements: ReadonlyArray<Statement.Statement<object>>,
    ) => Effect.Effect<ReadonlyArray<ReadonlyArray<object>>, SqlError.SqlError>;
  }
>()("@effect-biz/sql/SqlUnitOfWork/Batch") {}

/** Raised while {@link layer} is built on D1 without a {@link Batch} to commit with. */
export class BatchRequired extends Schema.TaggedError<
  BatchRequired,
  { readonly brand: unique symbol }
>()("BatchRequired", {
  /** The dialect that has no interactive transactions. */
  dialect: Dialect.Name,
}) {
  /** A message built from the dialect. */
  override get message(): string {
    return `The ${this.dialect} dialect has no interactive transactions: provide a SqlUnitOfWork.Batch`;
  }
}

/** A guard found unmet inside the transaction, which fails it so it rolls back. */
class Unmet {
  readonly _tag = "Unmet";
  readonly guard: Guard;
  constructor(guard: Guard) {
    this.guard = guard;
  }
}

/** Fails with the guard's conflict, read after the rollback. */
const conflictOf = (guard: Guard): Effect.Effect<never, BizError.ConcurrencyConflict> =>
  Effect.flatMap(guard.conflict, Effect.fail);

/** Checks a guarded statement's returned rows against its guard. */
const check = (write: Write, rows: ReadonlyArray<object>): Effect.Effect<void, Unmet> =>
  Option.match(write.guard, {
    onNone: () => Effect.void,
    onSome: (guard) => (rows.length === guard.rows ? Effect.void : Effect.fail(new Unmet(guard))),
  });

/**
 * The commit on a client with transactions (Postgres, SQLite): every
 * statement in order inside one `withTransaction`, each guard checked on the
 * rows its statement returned; an unmet guard rolls the transaction back.
 */
const transactional =
  (sql: SqlClient.SqlClient): Committer["Service"]["commit"] =>
  (writes) =>
    Arr.isReadonlyArrayEmpty(writes)
      ? Effect.void
      : sql
          .withTransaction(
            Effect.forEach(
              writes,
              (write) => Effect.flatMap(write.statement, (rows) => check(write, rows)),
              { concurrency: 1, discard: true },
            ),
          )
          .pipe(
            Effect.catchTags({
              SqlError: (error) => Effect.die(error),
              Unmet: (unmet) => conflictOf(unmet.guard),
            }),
          );

/** The JSON path a guard statement raises with: it names the write, so the error says which guard failed. */
const markerOf = (index: number): string => `$effect-biz-guard:${index}`;

const markerPattern = /\$effect-biz-guard:(\d+)/;

/** What a driver's error may carry: a message, and a cause with one. */
const Described = Schema.Struct({
  message: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

/** The message texts of a failed batch: the error's, its reason's, and its cause's, two levels deep. */
const messagesOf = (error: SqlError.SqlError): ReadonlyArray<string> =>
  Option.match(Schema.decodeUnknownOption(Described)(error.reason.cause), {
    onNone: () => [error.message],
    onSome: (cause) =>
      Arr.getSomes([
        Option.some(error.message),
        Option.fromNullishOr(cause.message),
        Option.fromNullishOr(cause.cause?.message),
      ]),
  });

/** The index of the write whose guard raised, when the batch failed on one. */
const failedGuard = (error: SqlError.SqlError): Option.Option<number> =>
  Arr.findFirst(messagesOf(error), (message) => markerPattern.test(message)).pipe(
    Option.flatMap((message) => Option.fromNullishOr(markerPattern.exec(message)?.[1])),
    Option.map(Number),
  );

/**
 * The guard statement that follows a guarded write in a batch: it raises
 * (a bad JSON path, which names the write) unless the write changed exactly
 * `rows` rows. `changes()` is the row count of the most recent
 * `INSERT` / `UPDATE` / `DELETE` on the connection, which in a batch is the
 * write just before it.
 */
const guardStatement = (
  sql: SqlClient.SqlClient,
  index: number,
  rows: number,
): Statement.Statement<object> =>
  sql`SELECT CASE WHEN changes() = ${rows} THEN 1 ELSE json_extract('{}', ${markerOf(index)}) END AS guard`;

/**
 * The commit over a {@link Batch} (D1): each guarded statement followed by
 * its {@link guardStatement}, all in one atomic batch; a guard that raises
 * aborts the batch, and the error names the write whose conflict it is.
 */
const batched =
  (sql: SqlClient.SqlClient, batch: Batch["Service"]): Committer["Service"]["commit"] =>
  (writes) =>
    Arr.isReadonlyArrayEmpty(writes)
      ? Effect.void
      : batch
          .run(
            Arr.flatMap(writes, (write, index) =>
              Option.match(write.guard, {
                onNone: () => [write.statement],
                onSome: (guard) => [write.statement, guardStatement(sql, index, guard.rows)],
              }),
            ),
          )
          .pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (error) =>
              Option.match(
                Option.flatMap(failedGuard(error), (index) =>
                  Option.flatMap(Arr.get(writes, index), (write) => write.guard),
                ),
                {
                  onNone: () => Effect.die(error),
                  onSome: conflictOf,
                },
              ),
            ),
          );

/** The unit of work and committer for a commit function. */
const contextOf = (
  commit: Committer["Service"]["commit"],
  options?: UnitOfWork.Options,
): Context.Context<UnitOfWork.UnitOfWork | Committer> =>
  Context.make(Committer, Committer.of({ commit })).pipe(
    Context.add(UnitOfWork.UnitOfWork, UnitOfWork.make(journal, commit, options)),
  );

/**
 * The SQL `UnitOfWork` (and its {@link Committer}) for the current dialect:
 * on Postgres and SQLite each batch commits in one `withTransaction`; on D1,
 * which has none, through the {@link Batch} the host provides (building the
 * layer without one fails with {@link BatchRequired}). `options` tunes the
 * retry, as `UnitOfWork.make`'s.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Option } from "effect";
 * import { SqlClient } from "effect/sql";
 * import * as BizError from "@thomasfosterau/effect-biz/BizError";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 * import * as SqlUnitOfWork from "@thomasfosterau/effect-biz-sql/SqlUnitOfWork";
 * import * as Testing from "@thomasfosterau/effect-biz-sql/testing";
 *
 * const program = Effect.gen(function* () {
 *   const sql = yield* SqlClient.SqlClient;
 *   const committer = yield* SqlUnitOfWork.Committer;
 *   yield* sql`CREATE TABLE counters (id TEXT PRIMARY KEY, version INTEGER NOT NULL)`;
 *   yield* sql`INSERT INTO counters (id, version) VALUES ('a', 1)`;
 *   // A version-guarded bump: it must write exactly one row.
 *   const bump = (from: number) =>
 *     SqlUnitOfWork.stage(
 *       committer,
 *       SqlUnitOfWork.guarded(
 *         sql`UPDATE counters SET version = version + 1 WHERE id = 'a' AND version = ${from} RETURNING id`,
 *         {
 *           conflict: Effect.succeed(
 *             new BizError.ConcurrencyConflict({ entity: "Counter", id: "a", expected: from, actual: from + 1 }),
 *           ),
 *         },
 *       ),
 *     );
 *   // Two bumps from version 1 in one command: the second guard fails, so neither applies.
 *   const conflict = yield* Effect.flip(UnitOfWork.transaction(Effect.andThen(bump(1), bump(1))));
 *   const rows = yield* sql<{ version: number }>`SELECT version FROM counters`;
 *   return [conflict._tag, rows[0]?.version];
 * });
 *
 * const layer = SqlUnitOfWork.layer({ attempts: 2 }).pipe(Layer.provideMerge(Testing.layerSqlite));
 * Effect.runPromise(program.pipe(Effect.provide(layer))).then(console.log); // ["ConcurrencyConflict", 1]
 * ```
 */
export const layer = (
  options?: UnitOfWork.Options,
): Layer.Layer<
  UnitOfWork.UnitOfWork | Committer,
  BatchRequired,
  SqlClient.SqlClient | Dialect.Dialect
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const commit = yield* Effect.flatten(
        Dialect.match({
          postgres: () => Effect.succeed(transactional(sql)),
          sqlite: () => Effect.succeed(transactional(sql)),
          d1: () =>
            Effect.flatMap(
              Effect.serviceOption(Batch),
              Option.match({
                onNone: () => Effect.fail(new BatchRequired({ dialect: "d1" })),
                onSome: (batch) => Effect.succeed(batched(sql, batch)),
              }),
            ),
        }),
      );
      return contextOf(commit, options);
    }),
  );

/**
 * The SQL `UnitOfWork` committing every batch through the provided
 * {@link Batch}, on any dialect: what {@link layer} builds on D1, stated
 * explicitly. A test runs D1's guard statements on SQLite with it and
 * `./testing`'s `layerBatch`.
 */
export const layerBatch = (
  options?: UnitOfWork.Options,
): Layer.Layer<UnitOfWork.UnitOfWork | Committer, never, SqlClient.SqlClient | Batch> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const batch = yield* Batch;
      return contextOf(batched(sql, batch), options);
    }),
  );

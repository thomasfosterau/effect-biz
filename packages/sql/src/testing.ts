/**
 * Test databases for unit suites: an in-memory SQLite database per layer
 * build, with its {@link Dialect.Dialect}, and {@link layerBatch}, which runs
 * D1's batch commit on it.
 *
 * This subpath imports the optional peer `@effect/sql-sqlite-node` (which runs
 * on `node:sqlite`, so Node 22.13 or later, with no native build); nothing
 * else in the package does. Postgres suites use `./testing.postgres`.
 *
 * See {@link layerSqlite} for an example.
 *
 * @module
 */

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Dialect from "./Dialect.js";
import * as SqlUnitOfWork from "./SqlUnitOfWork.js";

/**
 * A fresh, empty in-memory SQLite database (`:memory:`) as the `SqlClient`,
 * with the `sqlite` {@link Dialect.Dialect}. Each build of the layer is its own
 * database, so a suite built per test (`layer(Testing.layerSqlite, {
 * buildPerTest: true })`) starts every case empty.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { SqlClient } from "effect/sql";
 * import * as Testing from "@thomasfosterau/effect-biz-sql/testing";
 *
 * const program = Effect.gen(function* () {
 *   const sql = yield* SqlClient.SqlClient;
 *   yield* sql`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)`;
 *   yield* sql`INSERT INTO notes ${sql.insert({ id: "a", body: "hello" })}`;
 *   return yield* sql`SELECT body FROM notes`;
 * });
 *
 * Effect.runPromise(program.pipe(Effect.provide(Testing.layerSqlite))).then(console.log);
 * // [ { body: "hello" } ]
 * ```
 */
export const layerSqlite: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | Dialect.Dialect,
  SqlError.SqlError | Dialect.UnsupportedDialect
> = Dialect.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

/**
 * A `SqlUnitOfWork.Batch` with D1's semantics over a client that has
 * transactions: the statements run in order inside one `withTransaction`,
 * and the first that fails rolls back every one before it. D1 has no
 * in-process test database, and its SQL is SQLite's, so a suite runs D1's
 * batch commit (`SqlUnitOfWork.layerBatch`, its raising guard statements
 * included) on {@link layerSqlite} with this.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { SqlClient } from "effect/sql";
 * import * as SqlUnitOfWork from "@thomasfosterau/effect-biz-sql/SqlUnitOfWork";
 * import * as Testing from "@thomasfosterau/effect-biz-sql/testing";
 *
 * const program = Effect.gen(function* () {
 *   const sql = yield* SqlClient.SqlClient;
 *   const batch = yield* SqlUnitOfWork.Batch;
 *   yield* sql`CREATE TABLE notes (id TEXT PRIMARY KEY)`;
 *   // The second insert fails, so the batch applies neither.
 *   yield* Effect.ignore(
 *     batch.run([sql`INSERT INTO notes (id) VALUES ('a')`, sql`INSERT INTO notes (id) VALUES ('a')`]),
 *   );
 *   return yield* sql`SELECT id FROM notes`;
 * });
 *
 * const layer = Testing.layerBatch.pipe(Layer.provideMerge(Testing.layerSqlite));
 * Effect.runPromise(program.pipe(Effect.provide(layer))).then(console.log); // []
 * ```
 */
export const layerBatch: Layer.Layer<SqlUnitOfWork.Batch, never, SqlClient.SqlClient> =
  Layer.effect(
    SqlUnitOfWork.Batch,
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) =>
      SqlUnitOfWork.Batch.of({
        run: (statements) =>
          sql.withTransaction(
            Effect.forEach(statements, (statement) => statement, { concurrency: 1 }),
          ),
      }),
    ),
  );

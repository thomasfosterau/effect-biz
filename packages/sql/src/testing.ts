/**
 * Test databases for unit suites: an in-memory SQLite database per layer
 * build, with its {@link Dialect.Dialect}.
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
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Dialect from "./Dialect.js";

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

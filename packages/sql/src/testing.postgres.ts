/**
 * The Postgres test database for opt-in suites: the database named by the
 * `EFFECT_BIZ_PG_URL` environment variable, with its {@link Dialect.Dialect}.
 *
 * This subpath imports the optional peer `@effect/sql-pg`; nothing else in
 * the package does. A Postgres suite skips itself when {@link urlVariable} is
 * unset (see the example on {@link layerPostgres}), so the unit run needs no
 * database; the opt-in CI job sets it (#21).
 * The suite owns the database's contents: use a scratch database, never one
 * holding data.
 *
 * See {@link layerPostgres} for an example.
 *
 * @module
 */

import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Dialect from "./Dialect.js";

/** The environment variable holding the Postgres test database's connection URL. */
export const urlVariable = "EFFECT_BIZ_PG_URL";

/**
 * The Postgres database at {@link urlVariable} as the `SqlClient`, with the
 * `postgres` {@link Dialect.Dialect}. The URL is read through `Config` as a
 * `Redacted`, so it never reaches a log line; building the layer fails with a
 * `ConfigError` when it is unset.
 *
 * @example
 * A suite that runs on Postgres when the variable is set and skips itself
 * otherwise (it is not run here: it needs a test runner and a database).
 *
 * ```ts skip-type-checking
 * import { layer } from "@effect/vitest";
 * import { Config, Effect, Layer, Option } from "effect";
 * import * as Dialect from "@thomasfosterau/effect-biz-sql/Dialect";
 * import * as Testing from "@thomasfosterau/effect-biz-sql/testing";
 * import * as TestingPostgres from "@thomasfosterau/effect-biz-sql/testing.postgres";
 *
 * // Postgres when EFFECT_BIZ_PG_URL is set, else in-memory SQLite.
 * const database = Layer.unwrap(
 *   Effect.map(Config.option(Config.Redacted(TestingPostgres.urlVariable)), (url) =>
 *     Option.isSome(url) ? TestingPostgres.layerPostgres : Testing.layerSqlite,
 *   ),
 * );
 *
 * layer(database)("on Postgres", (it) => {
 *   it.effect("…", (ctx) =>
 *     Effect.gen(function* () {
 *       if ((yield* Dialect.current).name !== "postgres") yield* Effect.sync(() => ctx.skip());
 *       // …
 *     }),
 *   );
 * });
 * ```
 */
export const layerPostgres: Layer.Layer<
  SqlClient.SqlClient | PgClient.PgClient | Dialect.Dialect,
  Config.ConfigError | SqlError.SqlError | Dialect.UnsupportedDialect
> = Dialect.layer.pipe(
  Layer.provideMerge(PgClient.layerConfig({ url: Config.Redacted(urlVariable) })),
);

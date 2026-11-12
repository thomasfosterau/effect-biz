import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Dialect from "../src/Dialect.ts";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";
import * as Testing from "../src/testing.ts";
import * as TestingPostgres from "../src/testing.postgres.ts";
import { suites } from "./suite.ts";

/**
 * Opt-in (#21): the scratch database named by EFFECT_BIZ_PG_URL when it is
 * set; otherwise the in-memory SQLite one, on which every case skips itself.
 * Built once per suite, so the cases share the tables: each writes under
 * tenants of its own.
 */
const database: Layer.Layer<
  SqlClient.SqlClient | Dialect.Dialect,
  Config.ConfigError | SqlError.SqlError | Dialect.UnsupportedDialect
> = Layer.unwrap(
  Effect.map(
    Config.option(Config.Redacted(TestingPostgres.urlVariable)),
    (
      url,
    ): Layer.Layer<
      SqlClient.SqlClient | Dialect.Dialect,
      Config.ConfigError | SqlError.SqlError | Dialect.UnsupportedDialect
    > => (Option.isSome(url) ? TestingPostgres.layerPostgres : Testing.layerSqlite),
  ),
);

suites({
  name: "Postgres",
  database: SqlUnitOfWork.layer().pipe(Layer.provideMerge(database)),
  buildPerTest: false,
  guard: (ctx) =>
    Effect.flatMap(Dialect.current, (dialect) =>
      dialect.name === "postgres"
        ? Effect.void
        : Effect.sync(() => ctx.skip(`${TestingPostgres.urlVariable} is not set`)),
    ),
});

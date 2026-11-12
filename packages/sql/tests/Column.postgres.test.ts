import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Dialect from "../src/Dialect.ts";
import * as Testing from "../src/testing.ts";
import * as TestingPostgres from "../src/testing.postgres.ts";
import { createTable, roundTrips } from "./sample.ts";

/**
 * Opt-in (#21): the scratch database named by EFFECT_BIZ_PG_URL when it is
 * set; otherwise the in-memory SQLite one, on which every case skips itself.
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

/** Skips the case unless it runs on Postgres. */
const onPostgres = (ctx: { readonly skip: (note?: string) => void }) =>
  Effect.flatMap(Dialect.current, (dialect) =>
    dialect.name === "postgres"
      ? Effect.void
      : Effect.sync(() => ctx.skip(`${TestingPostgres.urlVariable} is not set`)),
  );

layer(database)("the sample table on Postgres", (it) => {
  it.effect("round-trips a decimal, a timestamp, JSON, branded ids and every Some", (ctx) =>
    Effect.gen(function* () {
      yield* onPostgres(ctx);
      yield* createTable;
      const { written, read } = yield* roundTrips.full;
      expect(Eq.equals(read, written), "read back equals written").toBe(true);
    }),
  );

  it.effect("round-trips every None as NULL", (ctx) =>
    Effect.gen(function* () {
      yield* onPostgres(ctx);
      yield* createTable;
      const { written, read } = yield* roundTrips.empty;
      expect(Eq.equals(read, written), "read back equals written").toBe(true);
    }),
  );

  it.effect("stores numeric, timestamptz and jsonb", (ctx) =>
    Effect.gen(function* () {
      yield* onPostgres(ctx);
      yield* createTable;
      yield* roundTrips.full;
      const sql = yield* SqlClient.SqlClient;
      const rows =
        yield* sql`SELECT amount::text AS amount, pg_typeof(occurred_at)::text AS occurred, payload->>'reference' AS reference, jsonb_typeof(payload) AS payload FROM sample`;
      expect(rows).toEqual([
        {
          amount: "12345678901234567890.123456789",
          occurred: "timestamp with time zone",
          reference: "INV-1",
          payload: "object",
        },
      ]);
    }),
  );
});

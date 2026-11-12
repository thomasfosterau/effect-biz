import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as SqlClient from "effect/sql/SqlClient";
import * as Column from "../src/Column.ts";
import * as Testing from "../src/testing.ts";
import { createTable, roundTrips } from "./sample.ts";

layer(Testing.layerSqlite, { buildPerTest: true })("the sample table on SQLite", (it) => {
  it.effect("takes the current dialect's codecs", () =>
    Effect.gen(function* () {
      const columns = yield* Column.columns;
      expect(columns.dialect).toBe("sqlite");
    }),
  );

  it.effect("round-trips a decimal, a timestamp, JSON, branded ids and every Some", () =>
    Effect.gen(function* () {
      yield* createTable;
      const { written, read } = yield* roundTrips.full;
      expect(Eq.equals(read, written), "read back equals written").toBe(true);
      // The comparison is by value: a different decimal is not equal.
      expect(Eq.equals(read, { ...written, amount: Decimal.make("1") })).toBe(false);
    }),
  );

  it.effect("round-trips every None as NULL", () =>
    Effect.gen(function* () {
      yield* createTable;
      const { written, read } = yield* roundTrips.empty;
      expect(Eq.equals(read, written), "read back equals written").toBe(true);
    }),
  );

  it.effect("stores decimals, instants and JSON as text, and None as NULL", () =>
    Effect.gen(function* () {
      yield* createTable;
      yield* roundTrips.full;
      yield* roundTrips.empty;
      const sql = yield* SqlClient.SqlClient;
      const rows =
        yield* sql`SELECT amount, discount, occurred_at, payload, tags, company_id FROM sample ORDER BY id`;
      expect(rows).toEqual([
        {
          amount: "12345678901234567890.123456789",
          discount: "-0.0000000000000000001",
          occurred_at: "2026-11-12T03:04:05.678Z",
          payload:
            '{"reference":"INV-1","lines":[{"quantity":"1.5","at":"2026-11-12T03:04:05.678Z"}],"note":"a note"}',
          tags: '["a","b"]',
          company_id: "0190a6e4-1c2d-7abc-8def-0000000000c1",
        },
        {
          amount: "12345678901234567890.123456789",
          discount: null,
          occurred_at: "2026-11-12T03:04:05.678Z",
          payload: '{"reference":"","lines":[],"note":null}',
          tags: null,
          company_id: null,
        },
      ]);
    }),
  );
});

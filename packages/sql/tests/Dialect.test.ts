import { describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Dialect from "../src/Dialect.ts";
import * as Testing from "../src/testing.ts";

/** A MySQL statement compiler: only its dialect matters here. */
const mysql = Statement.makeCompiler({
  dialect: "mysql",
  placeholder: () => "?",
  onIdentifier: (value) => `\`${value}\``,
  onRecordUpdate: () => ["", []],
  onCustom: () => ["", []],
});

/** A client that compiles with `compiler` and reports `driver`; it never connects. */
const clientOf = (compiler: Statement.Compiler, driver: string) =>
  SqlClient.make({
    acquirer: Effect.die("no connection"),
    compiler,
    driver,
    spanAttributes: [],
  });

layer(Reactivity.layer)("Dialect.fromClient", (it) => {
  it.effect("reads postgres from a Postgres compiler", () =>
    Effect.gen(function* () {
      const sql = yield* clientOf(PgClient.makeCompiler(), "pg");
      expect(Dialect.fromClient(sql)).toStrictEqual(Result.succeed("postgres"));
    }),
  );

  it.effect("reads d1 from a SQLite compiler whose driver is d1", () =>
    Effect.gen(function* () {
      const sql = yield* clientOf(Statement.makeCompilerSqlite(), "d1");
      expect(Dialect.fromClient(sql)).toStrictEqual(Result.succeed("d1"));
    }),
  );

  it.effect("reads sqlite from any other SQLite driver", () =>
    Effect.gen(function* () {
      const sql = yield* clientOf(Statement.makeCompilerSqlite(), "libsql");
      expect(Dialect.fromClient(sql)).toStrictEqual(Result.succeed("sqlite"));
    }),
  );

  it.effect("refuses another dialect", () =>
    Effect.gen(function* () {
      const sql = yield* clientOf(mysql, "mysql2");
      const result = Dialect.fromClient(sql);
      expect(result).toStrictEqual(
        Result.fail(new Dialect.UnsupportedDialect({ dialect: "mysql" })),
      );
      expect(Result.isFailure(result) && result.failure.message).toBe(
        "The mysql dialect is not supported: use Postgres, SQLite or D1",
      );
    }),
  );

  it.effect("fails the layer for another dialect", () =>
    Effect.gen(function* () {
      const sql = yield* clientOf(mysql, "mysql2");
      const exit = yield* Effect.exit(
        Layer.build(
          Dialect.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
        ).pipe(Effect.scoped),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

layer(Testing.layerSqlite)("Dialect.layer over the SQLite test database", (it) => {
  it.effect("derives sqlite", () =>
    Effect.gen(function* () {
      const dialect = yield* Dialect.current;
      expect(dialect).toStrictEqual(Dialect.info("sqlite"));
      expect(yield* Dialect.match({ postgres: () => 1, sqlite: () => 2, d1: () => 3 })).toBe(2);
    }),
  );
});

layer(Dialect.layerAs("d1"))("Dialect.layerAs", (it) => {
  it.effect("states the dialect", () =>
    Effect.gen(function* () {
      const dialect = yield* Dialect.current;
      expect(dialect.name).toBe("d1");
      expect(dialect.interactiveTransactions).toBe(false);
    }),
  );
});

describe("Dialect.info", () => {
  it("gives Postgres its own column types and row locks", () => {
    expect(Dialect.info("postgres")).toStrictEqual({
      name: "postgres",
      idType: "uuid",
      decimalType: "numeric",
      timestampType: "timestamptz",
      jsonType: "jsonb",
      interactiveTransactions: true,
      rowLocks: true,
    });
  });

  it("stores everything as text on SQLite and D1, and D1 has no interactive transactions", () => {
    const { name: _sqlite, ...sqlite } = Dialect.info("sqlite");
    const { name: _d1, ...d1 } = Dialect.info("d1");
    expect({ ...sqlite, interactiveTransactions: false }).toStrictEqual(d1);
    expect(sqlite.interactiveTransactions).toBe(true);
    expect(d1.decimalType).toBe("text");
  });
});

/**
 * The SQL dialect a repository layer runs on: `postgres`, `sqlite` or `d1`.
 *
 * Almost every statement effect-biz writes is the same on all three (the
 * `ON CONFLICT … DO UPDATE` upsert, `RETURNING`, `?`-free tagged-template
 * parameters). The {@link Dialect} service carries the few facts that differ
 * (the column types of an id, a decimal, a timestamp and a JSON value, whether the
 * database has interactive transactions or row locks), so a layer branches
 * on the dialect in one place instead of on a driver name.
 *
 * {@link layer} derives it from the provided `SqlClient`: the client's
 * statement compiler tells Postgres from SQLite, and the client's `driver`
 * tells Cloudflare D1 (`"d1"`) from any other SQLite. A client that compiles
 * another dialect (MySQL, SQL Server, ClickHouse) is an
 * {@link UnsupportedDialect}. {@link layerAs} states a dialect explicitly
 * instead, for a host whose client reports no `driver` (effect before 4.0.6).
 *
 * See {@link layer} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The name of a supported dialect. */
export const Name = Schema.Literals(["postgres", "sqlite", "d1"]);

/** The name of a supported dialect. */
export type Name = typeof Name.Type;

/** What differs between the dialects: the facts a SQL layer branches on. */
export interface Info {
  /** The dialect's name. */
  readonly name: Name;
  /** The column type of a branded id: `uuid` on Postgres, `text` on SQLite and D1. */
  readonly idType: "uuid" | "text";
  /** The column type of an exact decimal: `numeric` on Postgres, `text` on SQLite and D1. */
  readonly decimalType: "numeric" | "text";
  /** The column type of an instant: `timestamptz` on Postgres, ISO-8601 `text` on SQLite and D1. */
  readonly timestampType: "timestamptz" | "text";
  /** The column type of a JSON value: `jsonb` on Postgres, `text` on SQLite and D1. */
  readonly jsonType: "jsonb" | "text";
  /**
   * Whether a transaction can interleave reads and writes on one connection.
   * D1 has none (only an atomic batch), which is why every command commits one
   * batch of version-guarded writes on every dialect (#128).
   */
  readonly interactiveTransactions: boolean;
  /** Whether `SELECT … FOR UPDATE` exists. Only Postgres has it; no effect-biz command relies on it. */
  readonly rowLocks: boolean;
}

/** What each dialect is. */
const infos = {
  postgres: {
    name: "postgres",
    idType: "uuid",
    decimalType: "numeric",
    timestampType: "timestamptz",
    jsonType: "jsonb",
    interactiveTransactions: true,
    rowLocks: true,
  },
  sqlite: {
    name: "sqlite",
    idType: "text",
    decimalType: "text",
    timestampType: "text",
    jsonType: "text",
    interactiveTransactions: true,
    rowLocks: false,
  },
  d1: {
    name: "d1",
    idType: "text",
    decimalType: "text",
    timestampType: "text",
    jsonType: "text",
    interactiveTransactions: false,
    rowLocks: false,
  },
} satisfies { readonly [K in Name]: Info };

/** What the named dialect is. */
export const info = (name: Name): Info => infos[name];

/** The dialect a repository layer runs on. Provide {@link layer} (derived from the `SqlClient`) or {@link layerAs}. */
export class Dialect extends Context.Service<Dialect, Info>()("@effect-biz/sql/Dialect/Dialect") {}

/** Raised when the provided `SqlClient` compiles a dialect effect-biz does not support. */
export class UnsupportedDialect extends Schema.TaggedError<
  UnsupportedDialect,
  { readonly brand: unique symbol }
>()("UnsupportedDialect", {
  /** The statement compiler's dialect (`"mysql"`, `"mssql"`, `"clickhouse"`). */
  dialect: Schema.String,
}) {
  /** A message built from the dialect and the driver. */
  override get message(): string {
    return `The ${this.dialect} dialect is not supported: use Postgres, SQLite or D1`;
  }
}

/**
 * The dialect of a `SqlClient`: `postgres` for a client that compiles
 * Postgres (pg, PGlite), `d1` for a SQLite-compiling client whose `driver`
 * is `"d1"`, `sqlite` for any other SQLite-compiling one (node, libSQL,
 * wasm, Bun), and an {@link UnsupportedDialect} for anything else.
 */
export const fromClient = (sql: SqlClient.SqlClient): Result.Result<Name, UnsupportedDialect> => {
  // A client built by effect before 4.0.6 has no `driver` (typed `string`
  // since): it reads as `sqlite`, and a D1 host states `d1` with `layerAs`.
  const driver = sql.driver;
  const named = (name: Name): Result.Result<Name, UnsupportedDialect> => Result.succeed(name);
  const unsupported = (dialect: string): Result.Result<Name, UnsupportedDialect> =>
    Result.fail(new UnsupportedDialect({ dialect }));
  return sql.onDialect({
    pg: () => named("postgres"),
    sqlite: () => named(driver === "d1" ? "d1" : "sqlite"),
    mysql: () => unsupported("mysql"),
    mssql: () => unsupported("mssql"),
    clickhouse: () => unsupported("clickhouse"),
  });
};

/**
 * The {@link Dialect} of the provided `SqlClient` (see {@link fromClient}),
 * failing with {@link UnsupportedDialect} while the layer is built.
 *
 * @example
 * ```ts
 * import { SqliteClient } from "@effect/sql-sqlite-node";
 * import { Effect, Layer } from "effect";
 * import * as Dialect from "@thomasfosterau/effect-biz-sql/Dialect";
 *
 * const program = Effect.gen(function* () {
 *   const dialect = yield* Dialect.Dialect;
 *   return `${dialect.name}: decimals are ${dialect.decimalType}`;
 * });
 *
 * const layer = Dialect.layer.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })));
 *
 * Effect.runPromise(program.pipe(Effect.provide(layer))).then(console.log); // "sqlite: decimals are text"
 * ```
 */
export const layer: Layer.Layer<Dialect, UnsupportedDialect, SqlClient.SqlClient> = Layer.effect(
  Dialect,
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
    Effect.map(Effect.fromResult(fromClient(sql)), info),
  ),
);

/** The named {@link Dialect}, stated rather than derived: for a client that reports no `driver`. */
export const layerAs = (name: Name): Layer.Layer<Dialect> => Layer.succeed(Dialect, info(name));

/** The current dialect's {@link Info}. */
export const current: Effect.Effect<Info, never, Dialect> = Effect.service(Dialect);

/** Picks the case of the current dialect: the one place a SQL layer branches on it. */
export const match = <A>(cases: {
  readonly postgres: () => A;
  readonly sqlite: () => A;
  readonly d1: () => A;
}): Effect.Effect<A, never, Dialect> => Effect.map(current, (dialect) => cases[dialect.name]());

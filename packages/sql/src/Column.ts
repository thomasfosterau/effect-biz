/**
 * The column codecs every effect-biz SQL row schema is built from: each one
 * a `Schema` whose Type is the domain value and whose Encoded form is what
 * the dialect's driver binds and returns.
 *
 * | Value | Domain type | Postgres column | SQLite / D1 column | Codec |
 * | --- | --- | --- | --- | --- |
 * | Exact decimal | `BigDecimal` | `numeric` | `text` | {@link decimal} |
 * | Instant | `DateTime.Utc` | `timestamptz` | ISO-8601 `text` | {@link timestamp} |
 * | JSON value | the schema's Type | `jsonb` | `text` | {@link json} |
 * | Branded id | `Id.make(kind)` | `uuid` | `text` | {@link id} |
 * | Optional value | `Option` | `NULL` when `None` | `NULL` when `None` | {@link nullable} |
 *
 * The decimal and id codecs are the same on every dialect; the timestamp and
 * JSON codecs differ, because the Postgres client returns a `timestamptz` as a
 * `Date` and a `jsonb` already parsed. {@link make} gathers the codecs of one
 * dialect, and {@link columns} those of the current {@link Dialect.Dialect}.
 *
 * See {@link make} for an example.
 *
 * @module
 */

import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Id from "@thomasfosterau/effect-biz/Id";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Dialect from "./Dialect.js";

/**
 * An exact decimal, stored as `numeric` (Postgres) or `text` (SQLite, D1):
 * core's `Decimal` codec, which reads the canonical decimal string both
 * drivers return and writes one back (never an exponent, never a `number`).
 * A SQLite column holding decimals is declared `TEXT`, never `NUMERIC` or
 * `REAL`, whose affinity would turn the text into a float.
 */
export const decimal = Decimal.Decimal;

/** The codec of a branded id of `kind` (core's `Id.make`): a lower-case UUIDv7, stored as `uuid` or `text`. */
export const id = Id.make;

/** An optional value: `None` is SQL `NULL`, `Some` the value's own encoding. */
export const nullable = <S extends Schema.Top>(schema: S): Schema.OptionFromNullOr<S> =>
  Schema.OptionFromNullOr(schema);

/**
 * An instant (`DateTime.Utc`): a `timestamptz` on Postgres (the client reads
 * and binds a `Date`), ISO-8601 text on SQLite and D1 (`toISOString`, so
 * millisecond precision with a `Z`, which sorts as text in time order).
 */
export const timestamp = (dialect: Dialect.Name): Schema.Codec<DateTime.Utc, Date | string> =>
  dialect === "postgres" ? Schema.DateTimeUtcFromDate : Schema.DateTimeUtcFromString;

/**
 * Postgres `jsonb`: the client reads it already parsed and binds a string as
 * an untyped parameter that Postgres parses into the column, so this reads a
 * JSON value and writes its JSON text.
 */
const jsonb = <A, I>(schema: Schema.Codec<A, I>): Schema.Codec<A, Schema.Json> => {
  const value = Schema.toCodecJson(schema);
  const text = Schema.fromJsonString(value);
  return Schema.Json.pipe(
    Schema.decodeTo(
      Schema.toType(schema),
      SchemaTransformation.transformEffect({
        decode: (parsed: Schema.Json) => SchemaParser.decodeEffect(value)(parsed),
        encode: (decoded: A) => SchemaParser.encodeEffect(text)(decoded),
      }),
    ),
  );
};

/**
 * A JSON value of `schema`, stored as `jsonb` (Postgres) or JSON text
 * (SQLite, D1). The value is written through the schema's JSON encoding
 * (`Schema.toCodecJson`), so a `DateTime` or a `BigDecimal` inside it is
 * stored as its string.
 */
export const json = <A, I>(
  dialect: Dialect.Name,
  schema: Schema.Codec<A, I>,
): Schema.Codec<A, Schema.Json> =>
  dialect === "postgres" ? jsonb(schema) : Schema.fromJsonString(Schema.toCodecJson(schema));

/** The column codecs of one dialect. */
export interface Columns {
  /** The dialect these codecs are for. */
  readonly dialect: Dialect.Name;
  /** An exact decimal ({@link decimal}). */
  readonly decimal: typeof decimal;
  /** A branded id ({@link id}). */
  readonly id: typeof id;
  /** An optional value ({@link nullable}). */
  readonly nullable: typeof nullable;
  /** An instant ({@link timestamp}). */
  readonly timestamp: Schema.Codec<DateTime.Utc, Date | string>;
  /** A JSON value of a schema ({@link json}). */
  readonly json: <A, I>(schema: Schema.Codec<A, I>) => Schema.Codec<A, Schema.Json>;
}

/**
 * The column codecs of a dialect, to build a table's row schema from.
 *
 * @example
 * ```ts
 * import { BigDecimal, DateTime, Option, Schema } from "effect";
 * import * as Column from "@thomasfosterau/effect-biz-sql/Column";
 *
 * const columns = Column.make("sqlite");
 * const Row = Schema.Struct({
 *   amount: columns.decimal,
 *   postedAt: columns.timestamp,
 *   tags: columns.json(Schema.Array(Schema.String)),
 *   memo: columns.nullable(Schema.String),
 * }).pipe(Schema.encodeKeys({ postedAt: "posted_at" }));
 *
 * const encoded = Schema.encodeSync(Row)({
 *   amount: BigDecimal.fromStringUnsafe("12.50"),
 *   postedAt: DateTime.makeUnsafe("2026-11-12T00:00:00Z"),
 *   tags: ["rent"],
 *   memo: Option.none(),
 * });
 *
 * console.log(encoded);
 * // { amount: "12.5", posted_at: "2026-11-12T00:00:00.000Z", tags: '["rent"]', memo: null }
 * ```
 */
export const make = (dialect: Dialect.Name): Columns => ({
  dialect,
  decimal,
  id,
  nullable,
  timestamp: timestamp(dialect),
  json: (schema) => json(dialect, schema),
});

/** The column codecs of the current {@link Dialect.Dialect}. */
export const columns: Effect.Effect<Columns, never, Dialect.Dialect> = Effect.map(
  Dialect.current,
  (dialect) => make(dialect.name),
);

/**
 * The sample business table every dialect's round-trip suite writes and reads
 * back: one column of each codec in `./Column`, plus the tenancy, version and
 * audit columns every business table carries.
 */
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Column from "../src/Column.ts";
import * as Dialect from "../src/Dialect.ts";

/** A JSON payload with nested values that have no JSON type of their own. */
const Payload = Schema.Struct({
  reference: Schema.String,
  lines: Schema.Array(
    Schema.Struct({ quantity: Decimal.Decimal, at: Schema.DateTimeUtcFromString }),
  ),
  note: Schema.OptionFromNullOr(Schema.String),
});

/** The sample row's fields on a dialect. */
const fieldsOf = (columns: Column.Columns) =>
  Schema.Struct({
    id: columns.id("SampleId"),
    tenantId: Tenancy.TenantId,
    companyId: columns.nullable(Tenancy.CompanyId),
    amount: columns.decimal,
    discount: columns.nullable(columns.decimal),
    occurredAt: columns.timestamp,
    dueAt: columns.nullable(columns.timestamp),
    payload: columns.json(Payload),
    tags: columns.nullable(columns.json(Schema.Array(Schema.String))),
    memo: columns.nullable(Schema.String),
    version: Audit.Version,
    createdAt: columns.timestamp,
    createdBy: Schema.NonEmptyString,
    updatedAt: columns.timestamp,
    updatedBy: Schema.NonEmptyString,
    archivedAt: columns.nullable(columns.timestamp),
  });

/** The sample row's schema on a dialect: camelCase fields over snake_case columns. */
const rowOf = (columns: Column.Columns) =>
  fieldsOf(columns).pipe(
    Schema.encodeKeys({
      tenantId: "tenant_id",
      companyId: "company_id",
      occurredAt: "occurred_at",
      dueAt: "due_at",
      createdAt: "created_at",
      createdBy: "created_by",
      updatedAt: "updated_at",
      updatedBy: "updated_by",
      archivedAt: "archived_at",
    }),
  );

/** The sample table's DDL on a dialect, from the dialect's column types. */
const ddl = (dialect: Dialect.Info): string => `CREATE TABLE sample (
  id ${dialect.idType} PRIMARY KEY,
  tenant_id ${dialect.idType} NOT NULL,
  company_id ${dialect.idType},
  amount ${dialect.decimalType} NOT NULL,
  discount ${dialect.decimalType},
  occurred_at ${dialect.timestampType} NOT NULL,
  due_at ${dialect.timestampType},
  payload ${dialect.jsonType} NOT NULL,
  tags ${dialect.jsonType},
  memo text,
  version integer NOT NULL,
  created_at ${dialect.timestampType} NOT NULL,
  created_by text NOT NULL,
  updated_at ${dialect.timestampType} NOT NULL,
  updated_by text NOT NULL,
  archived_at ${dialect.timestampType}
)`;

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");
const company = Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0000000000c1");
const at = DateTime.makeUnsafe("2026-11-12T03:04:05.678Z");

/** A row with every optional column set. */
const full = {
  tenantId: tenant,
  companyId: Option.some(company),
  // More digits than a double holds, and a scale an exponent would mangle.
  amount: Decimal.make("12345678901234567890.123456789"),
  discount: Option.some(Decimal.make("-0.0000000000000000001")),
  occurredAt: at,
  dueAt: Option.some(DateTime.makeUnsafe("2027-01-31T00:00:00.000Z")),
  payload: {
    reference: "INV-1",
    lines: [{ quantity: Decimal.make("1.5"), at }],
    note: Option.some("a note"),
  },
  tags: Option.some(["a", "b"]),
  memo: Option.some("memo"),
  version: 1,
  createdAt: at,
  createdBy: "user-1",
  updatedAt: at,
  updatedBy: "user-1",
  archivedAt: Option.some(at),
};

/** A row with every optional column `None` (SQL `NULL`). */
const empty = {
  ...full,
  companyId: Option.none(),
  discount: Option.none(),
  dueAt: Option.none(),
  payload: { reference: "", lines: [], note: Option.none() },
  tags: Option.none(),
  memo: Option.none(),
  archivedAt: Option.none(),
};

/** (Re)creates the empty sample table on the current dialect. */
export const createTable = Effect.flatMap(
  Effect.all([Effect.service(SqlClient.SqlClient), Dialect.current], { concurrency: 1 }),
  ([sql, dialect]) =>
    Effect.andThen(sql.unsafe("DROP TABLE IF EXISTS sample"), sql.unsafe(ddl(dialect))),
);

/**
 * Writes the row with id `id` to the sample table through the row schema and
 * reads it back through the same schema.
 */
const roundTrip = (id: string, row: typeof full | typeof empty) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* Dialect.current;
    const columns = Column.make(dialect.name);
    const Id = fieldsOf(columns).fields.id;
    const Row = rowOf(columns);
    const insert = SqlSchema.void({
      Request: Row,
      execute: (encoded) => sql`INSERT INTO sample ${sql.insert(encoded)}`,
    });
    const load = SqlSchema.findOne({
      Request: Id,
      Result: Row,
      execute: (key) => sql`SELECT * FROM sample WHERE id = ${key}`,
    });
    const written: typeof Row.Type = { ...row, id: Id.make(id) };
    yield* insert(written);
    const read = yield* load(written.id);
    return { written, read };
  });

/** Writes and reads back a row with every column set, then one with every optional column `NULL`. */
export const roundTrips = {
  full: roundTrip("0190a6e4-1c2d-7abc-8def-000000000001", full),
  empty: roundTrip("0190a6e4-1c2d-7abc-8def-000000000002", empty),
};

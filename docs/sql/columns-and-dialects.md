# Columns and dialects

How an effect-biz SQL repository layer lays out its tables and reads and writes their columns, on the three production-grade dialects: **Postgres**, **SQLite** (tests, embedded hosts) and **Cloudflare D1** (#128). The repository conventions themselves (the port, version-guarded writes, keyset paging) are core's: see [repositories](../core/repositories.md) and [the unit of work](../core/unit-of-work.md).

## `SqlClient` comes from `effect`

In Effect 4, `SqlClient`, `Statement`, `SqlSchema` and `Migrator` live in `effect` itself (`effect/sql`, or `effect/sql/SqlClient` per module); there is no separate `@effect/sql` package. Only the database clients are their own packages (`@effect/sql-pg`, `@effect/sql-d1`, `@effect/sql-libsql`, `@effect/sql-sqlite-node`, …). A host provides one; every effect-biz SQL layer requires only `SqlClient.SqlClient` and `Dialect.Dialect`.

## The dialect

`Dialect.layer` derives the dialect from the provided client: its statement compiler says Postgres or SQLite, and a SQLite-compiling client whose `driver` is `"d1"` is D1. Any other compiler (MySQL, SQL Server, ClickHouse) fails the layer with `UnsupportedDialect`. A client built by `effect` before 4.0.6 has no `driver`, so D1 reads as `sqlite` there; such a host states it with `Dialect.layerAs("d1")`.

|  | Postgres | SQLite | D1 |
| --- | --- | --- | --- |
| Driver (`SqlClient.driver`) | `pg`, `pglite` | `sqlite-node`, `libsql`, `sqlite-wasm`, … | `d1` |
| Branded id | `uuid` | `text` | `text` |
| Exact decimal | `numeric` | `text` | `text` |
| Instant | `timestamptz` | ISO-8601 `text` | ISO-8601 `text` |
| JSON | `jsonb` | `text` | `text` |
| `RETURNING` | yes | yes (3.35+) | yes |
| Upsert | `INSERT … ON CONFLICT (…) DO UPDATE SET … = excluded.…` | the same | the same |
| Reading a JSON field | `payload->>'key'` | `payload->>'key'` (3.38+) or `json_extract(payload, '$.key')` | the same as SQLite |
| Interactive transactions | yes | yes | **no**: one atomic `batch` |
| Row locks (`FOR UPDATE`) | yes | no | no |

Because D1 has neither row locks nor interactive transactions, no command relies on them on any dialect: each one loads, decides, and commits one atomic batch of version-guarded writes (`UPDATE … WHERE id = ? AND version = ?`), retried from the load on a conflict. `Dialect.Info.interactiveTransactions` and `rowLocks` exist so a layer can assert that, not so it can branch on it. Branch with `Dialect.match` only where the SQL text itself differs.

```ts
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import * as Dialect from "@thomasfosterau/effect-biz-sql/Dialect";

const jsonField = Dialect.match({
  postgres: () => "payload->>'reference'",
  sqlite: () => "json_extract(payload, '$.reference')",
  d1: () => "json_extract(payload, '$.reference')",
});

const layer = Dialect.layer.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })));

Effect.runPromise(jsonField.pipe(Effect.provide(layer))).then(console.log); // "json_extract(payload, '$.reference')"
```

## Table conventions

- **snake_case columns** (`tenant_id`, `occurred_at`); the row schema keeps the entity's camelCase fields and renames them with `Schema.encodeKeys`, so a layer never depends on the client's name transforms (`transformResultNames` is the host's setting).
- **`tenant_id` on every business table**, and **`company_id`** on every table whose rows belong to a company; every query filters by the current tenant (#38 builds the helpers).
- **`version`** (`integer`, 1 on insert, guarded on every write) and the **audit columns** matching core's `Audit.AuditFields`: `created_at`, `created_by`, `updated_at`, `updated_by`, `archived_at` (`NULL` while active).
- **Ids are the entity's UUIDv7** (core's `Id.make`), the primary key, never a database sequence.
- **No `REAL` / `double precision` for money or quantities**; a SQLite decimal column is `TEXT` (a `NUMERIC` affinity would turn the text into a float).

## The column codecs (`./Column`)

Each codec is a `Schema` whose Type is the domain value and whose Encoded form is what the driver binds and returns. `Column.make(dialect)` gathers one dialect's codecs; `Column.columns` reads the current `Dialect`.

| Codec | Type | Encoded on Postgres | Encoded on SQLite / D1 |
| --- | --- | --- | --- |
| `decimal` | `BigDecimal` | canonical decimal text, bound untyped into `numeric` | canonical decimal text |
| `timestamp` | `DateTime.Utc` | a `Date` (the client reads and binds `timestamptz` as one) | `toISOString` text (millisecond precision, `Z`), which sorts as text in time order |
| `json(schema)` | the schema's Type | read: the parsed `jsonb`; written: JSON text, which Postgres parses into the column | JSON text |
| `id(kind)` | the branded id | lower-case UUID text | lower-case UUID text |
| `nullable(codec)` | `Option` of the codec's Type | `NULL` for `None` | `NULL` for `None` |

`json` writes the schema's JSON encoding (`Schema.toCodecJson`), so a `BigDecimal` or a `DateTime` inside a JSON value is stored as its string, never as a JSON number. On Postgres the JSON codec is deliberately asymmetric at the `Schema` level (it reads a parsed value and writes text), which is exactly the round trip through the database.

A row schema and a round trip on the in-memory SQLite test database:

```ts
import { BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as Column from "@thomasfosterau/effect-biz-sql/Column";
import * as Dialect from "@thomasfosterau/effect-biz-sql/Dialect";
import * as Testing from "@thomasfosterau/effect-biz-sql/testing";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dialect = yield* Dialect.current;
  const columns = Column.make(dialect.name);
  const Row = Schema.Struct({
    id: columns.id("EntryId"),
    tenantId: Tenancy.TenantId,
    amount: columns.decimal,
    postedAt: columns.timestamp,
    lines: columns.json(
      Schema.Array(Schema.Struct({ account: Schema.String, amount: columns.decimal })),
    ),
    memo: columns.nullable(Schema.String),
  }).pipe(Schema.encodeKeys({ tenantId: "tenant_id", postedAt: "posted_at" }));

  yield* sql.unsafe(`CREATE TABLE entries (
    id ${dialect.idType} PRIMARY KEY,
    tenant_id ${dialect.idType} NOT NULL,
    amount ${dialect.decimalType} NOT NULL,
    posted_at ${dialect.timestampType} NOT NULL,
    lines ${dialect.jsonType} NOT NULL,
    memo text
  )`);

  const insert = SqlSchema.void({
    Request: Row,
    execute: (row) => sql`INSERT INTO entries ${sql.insert(row)}`,
  });
  yield* insert({
    id: Schema.decodeSync(columns.id("EntryId"))("0190a6e4-1c2d-7abc-8def-000000000001"),
    tenantId: Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1"),
    amount: BigDecimal.fromStringUnsafe("100.10"),
    postedAt: DateTime.makeUnsafe("2026-11-12T00:00:00Z"),
    lines: [{ account: "1-1000", amount: BigDecimal.fromStringUnsafe("100.10") }],
    memo: Option.none(),
  });

  const stored = yield* sql`SELECT amount, posted_at, lines, memo FROM entries`;
  return stored;
});

Effect.runPromise(program.pipe(Effect.provide(Testing.layerSqlite))).then(console.log);
// [ { amount: "100.1", posted_at: "2026-11-12T00:00:00.000Z", lines: '[{"account":"1-1000","amount":"100.1"}]', memo: null } ]
```

## Testing

- **Unit suites run on SQLite in-process**: `Testing.layerSqlite` (`./testing`) is a fresh `:memory:` database with its `Dialect`; build it per test (`layer(Testing.layerSqlite, { buildPerTest: true })`) for an empty database each case. It runs on `node:sqlite` (Node 22.13+), so nothing is compiled at install.
- **Postgres suites are opt-in**: `TestingPostgres.layerPostgres` (`./testing.postgres`) connects to the scratch database at `EFFECT_BIZ_PG_URL` (read through `Config` as a `Redacted`). A suite falls back to SQLite when the variable is unset and skips its Postgres cases; the example on `layerPostgres` shows the pattern, and the opt-in CI job is #21.
- **D1 has no in-process test database.** Its SQL is SQLite's, so the SQLite suites cover the statements; `Dialect.layerAs("d1")` exercises a layer's D1 branch.

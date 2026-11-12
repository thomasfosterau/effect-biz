# @thomasfosterau/effect-biz-sql

The SQL foundation every domain package's `effect/sql` repository layer builds on: the `Dialect` service and the column codecs, on Postgres, SQLite and Cloudflare D1, with in-process test databases. Peers: `effect` (`SqlClient` lives in it, `effect/sql`: there is no separate `@effect/sql` package), and the optional `@effect/sql-sqlite-node` and `@effect/sql-pg` (for `./testing` and `./testing.postgres` only). The guide is [`docs/sql/columns-and-dialects.md`](../../docs/sql/columns-and-dialects.md).

## Boundary

Imports only core (`@thomasfosterau/effect-biz`, through its published `exports`, so its `dist/`); core never imports this package (`.fallowrc.json`'s `sql` zone). No ERP domain vocabulary: no table here names a party, an order or a ledger. A domain package's SQL layer imports this package; this package imports no domain package.

Planned here, each its own slice: the migrator (#37), tenant scoping (#38), the unit of work and repository helpers over SQL (#39), and the SQL outbox, inbox and sequences (#40).

## Invariants

- **Every layer requires only `SqlClient.SqlClient` and `Dialect.Dialect`.** No module but `./testing` (SQLite) and `./testing.postgres` (Postgres) imports a client package, so the main entry points work with whichever client the host provides (D1, libSQL, PGlite, …) and an optional peer is needed only for the testing subpath that names it.
- **The dialect is derived, not configured.** `Dialect.layer` reads the client's statement compiler (`pg` → `postgres`, `sqlite` → `sqlite`) and its `driver` (`"d1"` → `d1`); any other compiler is `UnsupportedDialect`, raised while the layer is built. `Dialect.layerAs` states the dialect only for a client that reports no `driver` (effect before 4.0.6). The `effect` peer stays `^4.0.0`: below 4.0.6 D1 reads as `sqlite`, which `layerAs("d1")` corrects.
- **One statement shape for every dialect.** Commands are load → decide → one atomic batch of version-guarded writes (#128), so nothing relies on row locks, `SELECT … FOR UPDATE`, savepoints or an interactive transaction, which D1 lacks. `Dialect.match` branches only where the SQL text differs (a JSON operator, a column type).
- **Column conventions.** snake_case column names, mapped to the entity's camelCase fields with `Schema.encodeKeys` in the row schema (never the client's `transformResultNames`, which is the host's); `tenant_id` on every business table and `company_id` on every company-owned one; `version` plus the audit columns `created_at`, `created_by`, `updated_at`, `updated_by`, `archived_at`, matching core's `Audit.AuditFields`; the id (a UUIDv7 from core's `IdGenerator`) is the primary key.
- **Column types per dialect** (`Dialect.Info`): ids `uuid` / `text`; decimals `numeric` / `text` (never `REAL`, `double precision` or a SQLite `NUMERIC` affinity); instants `timestamptz` / ISO-8601 text; JSON `jsonb` / text.
- **A row crosses the boundary through `Schema`.** A SQL layer decodes every row with a schema built from `./Column` (through `SqlSchema`) and encodes every written value the same way; it never reads a column as a bare `unknown`.
- **The codecs** (`./Column`): `decimal` is core's `Decimal` (canonical decimal text on every dialect; a JavaScript `number` never reaches a monetary column); `timestamp` is `DateTimeUtcFromDate` on Postgres (the client returns and binds `timestamptz` as a `Date`) and `DateTimeUtcFromString` elsewhere; `json(schema)` goes through `Schema.toCodecJson(schema)`, as JSON text on SQLite / D1 and, on Postgres, reading the parsed `jsonb` and writing JSON text (bound untyped, so Postgres parses it into the column); `id` is core's `Id.make`; `nullable` is `Schema.OptionFromNullOr` (`None` is SQL `NULL`).
- **Tests are hermetic.** Unit suites run on `Testing.layerSqlite` (a fresh `:memory:` database per build, on `node:sqlite`, so no native build); the Postgres suites (`tests/*.postgres.test.ts`) fall back to SQLite and skip their cases unless `EFFECT_BIZ_PG_URL` is set (the opt-in CI job is #21). Every codec round-trips the sample table (`tests/sample.ts`) on both.

## Terms

- **Dialect** — `postgres`, `sqlite` or `d1`: the `Dialect.Dialect` service's `Info` (`name`, the column types, `interactiveTransactions`, `rowLocks`).
- **Driver** — `SqlClient.driver`, the client package's name without `@effect/sql-` (`"pg"`, `"sqlite-node"`, `"d1"`); it tells D1 apart from other SQLite clients, which share a compiler.
- **Column codec** — a `Schema` from `./Column` whose Type is the domain value and whose Encoded form is what the dialect's driver binds and returns.
- **Business table** — a table holding a domain package's entities: it carries `tenant_id`, `version` and the audit columns.

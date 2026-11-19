# @thomasfosterau/effect-biz-sql

The SQL foundation for domain packages' `effect/sql` repository layers: the `Dialect` service, the column codecs, the SQL unit of work (`./SqlUnitOfWork`) and the repository helper (`./SqlRepository`), on Postgres, SQLite and Cloudflare D1. Guides: [`docs/sql/`](../../docs/sql/).

## Boundary

Imports only core; core never imports this package. No ERP domain vocabulary. Only `./testing` (SQLite) and `./testing.postgres` import a client package (optional peers); everything else works with whichever `SqlClient` the host provides.

## Invariants

- **Private until the owner publishes it** (`"private": true`, no changesets). Never remove `private` in a feature PR ([PUBLISHING.md → A new package](../../docs/PUBLISHING.md#a-new-package)).
- **Every layer requires only `SqlClient` and `Dialect`**, plus this package's `SqlUnitOfWork.Committer` and, on D1, the `SqlUnitOfWork.Batch` port the host fills.
- **The dialect is derived**: `Dialect.layer` reads the client's compiler and `driver` (`"d1"`); `Dialect.layerAs` states it for a client without `driver`.
- **One statement shape for every dialect**: no row locks, `SELECT … FOR UPDATE`, savepoints or interactive transactions, which D1 lacks. `Dialect.match` branches only where SQL text differs.
- **Columns**: snake_case (mapped with `Schema.encodeKeys` or `SqlRepository.make`'s column map, never the client's name transforms); `tenant_id` on every business table, `company_id` on company-owned ones; `version` and the audit columns; the UUIDv7 id as primary key. Decimals are `numeric` / text, never a float type.
- **Rows cross the boundary through `Schema`** built from `./Column`; a JavaScript `number` never reaches a monetary column.
- **A commit is one atomic batch of guarded statements.** Postgres and SQLite run it in one `withTransaction`, counting each guarded statement's returned rows; D1 runs it as one `Batch` with a guard statement after each guarded write that raises when `changes()` is wrong. A nested transaction joins the outer one. A `SqlError` or an undecodable stored row is a defect.
- **A repository is `SqlRepository.make`, or follows it**: every read filters by the tenant; every write decides against a fresh read for its precise error, then stages one guarded `INSERT … ON CONFLICT DO NOTHING RETURNING id` or `UPDATE … WHERE … AND version = ? RETURNING id`.
- **`find` agrees with core's `Query.run`** and shares its cursors; only `filterable` fields may be filtered or sorted. The suites check every case against `Query.run`.
- **Tests are hermetic**: SQLite in memory (`node:sqlite`); the Postgres suites skip unless `EFFECT_BIZ_PG_URL` is set; D1's batch commit is exercised on SQLite (`Testing.layerBatch`).

## Terms

- **Driver** — `SqlClient.driver` (`"pg"`, `"sqlite-node"`, `"d1"`); it tells D1 from other SQLite clients.
- **Write / guard** — a statement staged into the journal, and the rows it must write for the batch to commit (`SqlUnitOfWork.guarded`; `unguarded` for an append).
- **Allow-list** — `SqlRepository.make`'s `filterable`: the fields `find` may use, each with its `Kind`.

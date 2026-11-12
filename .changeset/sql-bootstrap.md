---
"@thomasfosterau/effect-biz-sql": minor
---

Add `@thomasfosterau/effect-biz-sql`, the SQL foundation of the domain packages' `effect/sql` repository layers (#36). `./Dialect` derives the `Dialect` service (`postgres`, `sqlite` or `d1`, with the column types, interactive transactions and row locks that differ) from the provided `SqlClient` (`layer`, `fromClient`; D1 by its `"d1"` driver), or states it (`layerAs`), with `match` and `UnsupportedDialect`. `./Column` holds the dialect-aware column codecs: `decimal` (core's `Decimal`, `numeric` / `text`), `timestamp` (`DateTime.Utc` as `timestamptz` / ISO text), `json` (`jsonb` / text), `id` (core's branded ids) and `nullable` (`Option` as `NULL`), gathered by `make` and `columns`. `./testing` provides an in-memory SQLite database (`layerSqlite`, optional peer `@effect/sql-sqlite-node`) and `./testing.postgres` the opt-in Postgres one at `EFFECT_BIZ_PG_URL` (`layerPostgres`, optional peer `@effect/sql-pg`).

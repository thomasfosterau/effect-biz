# @thomasfosterau/effect-biz-sql

**Disclaimer:** This is an experiment. Don't use it in production.

**Not published yet.** The package is `"private": true` until its npm bootstrap and trusted publisher exist; removing `private` (with its first changeset) is the owner's step ([PUBLISHING.md](https://github.com/thomasfosterau/effect-biz/blob/trunk/PUBLISHING.md#a-new-package)).

The SQL foundation of the effect-biz package family: the `Dialect` service (`postgres`, `sqlite` or `d1`, derived from the `SqlClient` you provide) and the column codecs (decimals, timestamps, JSON, branded ids, nullable `Option`s) every domain package's `effect/sql` repository layer is built from, plus in-process test databases.

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz @thomasfosterau/effect-biz-sql
```

`effect` is a peer (`^4.0.0`): your application owns the single copy, and `SqlClient` comes from it (`effect/sql`). Bring the client for your database: `@effect/sql-pg`, `@effect/sql-d1`, `@effect/sql-libsql`, `@effect/sql-sqlite-node`, …. Two are optional peers (`^4.0.0`): `@effect/sql-sqlite-node` for `./testing` (it runs on `node:sqlite`, so Node 22.13 or later, with no native build) and `@effect/sql-pg` for `./testing.postgres`.

## Example

```ts
import { BigDecimal, DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import * as Column from "@thomasfosterau/effect-biz-sql/Column";
import * as Testing from "@thomasfosterau/effect-biz-sql/testing";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* Column.columns; // the codecs of the current dialect
  const Row = Schema.Struct({ amount: columns.decimal, postedAt: columns.timestamp }).pipe(
    Schema.encodeKeys({ postedAt: "posted_at" }),
  );

  yield* sql`CREATE TABLE entries (amount TEXT NOT NULL, posted_at TEXT NOT NULL)`;
  yield* SqlSchema.void({
    Request: Row,
    execute: (row) => sql`INSERT INTO entries ${sql.insert(row)}`,
  })({
    amount: BigDecimal.fromStringUnsafe("12345678901234567890.01"),
    postedAt: DateTime.makeUnsafe("2026-11-12T00:00:00Z"),
  });
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Row,
    execute: () => sql`SELECT * FROM entries`,
  })(undefined);
  return rows.map((row) => BigDecimal.format(row.amount));
});

Effect.runPromise(program.pipe(Effect.provide(Testing.layerSqlite))).then(console.log); // ["12345678901234567890.01"]
```

## Entry points

The column conventions and the dialect notes are in the guide [`docs/sql/columns-and-dialects.md`](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/sql/columns-and-dialects.md).

| Subpath | Purpose |
| --- | --- |
| `./Dialect` | The `Dialect` service: `postgres`, `sqlite` or `d1` and the facts that differ (column types, interactive transactions, row locks), derived from the `SqlClient` (`layer`, `fromClient`) or stated (`layerAs`); `match`; `UnsupportedDialect`. |
| `./Column` | The column codecs: `decimal`, `timestamp`, `json`, `id`, `nullable`, gathered per dialect by `make` and `columns`. |
| `./testing` | `layerSqlite`: a fresh in-memory SQLite database with its `Dialect`, for unit suites. Needs the optional peer `@effect/sql-sqlite-node`. |
| `./testing.postgres` | `layerPostgres`: the scratch Postgres database at `EFFECT_BIZ_PG_URL`, for opt-in suites. Needs the optional peer `@effect/sql-pg`. |

## Links

- [effect-biz](https://github.com/thomasfosterau/effect-biz): the package family, its roadmap and the core's repository and unit-of-work conventions.
- [Effect SQL](https://effect.website): `SqlClient`, `SqlSchema` and the clients.

## License

MIT © Thomas Foster

# Repositories and the unit of work over SQL

How a domain package's SQL repository layer is built with `./SqlRepository`, and how `./SqlUnitOfWork` commits each command's writes, on Postgres, SQLite and Cloudflare D1 (#39). The conventions are core's: [repositories, queries and paging](../core/repositories.md) and [the unit of work](../core/unit-of-work.md). The column layout and codecs are in [columns and dialects](columns-and-dialects.md).

## No interactive transactions

D1 has neither interactive transactions nor row locks (#128), so no command relies on them on any dialect. A command is **load → decide (pure) → commit one batch of version-guarded writes**:

1. It loads with plain reads, outside any SQL transaction (a read never sees the writes staged so far).
2. It decides, and each repository write decides eagerly against a fresh read, so a stale version, a used id or a wrong state fails at once with its own error (`ConcurrencyConflict`, `AlreadyExists`, `NotFound`, `InvalidTransition`).
3. Each write is _staged_: a statement and its **guard**, the number of rows it must write. An update is `UPDATE … SET …, version = version + 1 WHERE tenant_id = ? AND id = ? AND version = ? RETURNING id`; an insert is `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id`; each must write one row.
4. When the command succeeds, core's `UnitOfWork.make` hands the batch to the commit. A guard that is unmet means another command committed first: the whole batch rolls back and the command is retried from its load step (jittered backoff, 5 attempts from 10 ms by default), ending in `ConcurrencyConflict`. Its `actual` is read after the rollback.

Retrying, nesting and interruption are core's: a nested `UnitOfWork.transaction` joins the outer one (there are no savepoints), a command that fails or is interrupted before its commit applies nothing, and outside any transaction a write commits at once as a batch of one.

## The commit per dialect

|  | Postgres, SQLite | D1 |
| --- | --- | --- |
| Layer | `SqlUnitOfWork.layer()` | `SqlUnitOfWork.layer()` with a `SqlUnitOfWork.Batch` provided, or `layerBatch()` |
| Atomic unit | one `sql.withTransaction` | one `D1Client.batch()` |
| Guard check | the rows each guarded statement returns (`RETURNING id`), counted between statements | a _guard statement_ after each guarded write, which raises when unmet |
| Unmet guard | the transaction fails, so it rolls back | the raise aborts the batch, so it rolls back |

On Postgres, the guard sits in the write's own `WHERE`: a concurrent writer's update blocks on the row lock, then re-evaluates `version = ?`, matches nothing and returns no row, so the check is race-free under `READ COMMITTED`.

### The D1 guard statement

A D1 batch runs its statements in order, in one SQLite transaction, and rolls all of them back when one fails; but it returns their results only at the end, so the commit cannot count a statement's rows before running the next. Instead each guarded write is followed by:

```sql
SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{}', '$effect-biz-guard:3') END AS guard
```

- `changes()` is the number of rows the most recent `INSERT`, `UPDATE` or `DELETE` on the connection wrote: the guarded write just before it (a `SELECT` does not reset it). `1` is the guard's `rows`, and `3` the write's index in the batch.
- `json_extract` with a path that does not start `$.` raises (`bad JSON path: '$effect-biz-guard:3'`). `CASE` evaluates the branch only when the guard is unmet, so a met guard raises nothing.
- The raise aborts and rolls back the batch, and its message names the write: the commit reads the index back from the `SqlError` (its message, or its cause's) and fails with that write's conflict. A batch error without the marker is a defect, like every other database failure.

This package imports no D1 client. A D1 host provides `SqlUnitOfWork.Batch` from `@effect/sql-d1`'s client, whose `batch` has the shape `Batch.run` takes:

```ts skip-type-checking
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer } from "effect";
import * as Dialect from "@thomasfosterau/effect-biz-sql/Dialect";
import * as SqlUnitOfWork from "@thomasfosterau/effect-biz-sql/SqlUnitOfWork";

const batch = Layer.effect(
  SqlUnitOfWork.Batch,
  Effect.map(Effect.service(D1Client.D1Client), (d1) => SqlUnitOfWork.Batch.of({ run: d1.batch })),
);

// `layer` reads the dialect (`d1`) and commits through the batch; without one it fails with `BatchRequired`.
const unitOfWork = SqlUnitOfWork.layer().pipe(
  Layer.provide(Layer.merge(Dialect.layer, batch)),
  Layer.provide(D1Client.layer({ db: env.DB })),
);
```

**What was exercised.** A real D1 batch cannot run in-process. D1's SQL is SQLite's, so the suites run D1's commit, guard statements included, on in-memory SQLite: `Testing.layerBatch` is a `Batch` with D1's semantics (in order, all or none, failing with the first error) over a client with transactions, and `SqlUnitOfWork.layerBatch` commits through it. Core's repository and unit-of-work contracts and the conflict and rollback cases pass that way, as they do on SQLite's and Postgres's transactional commit. What remains unverified until a Worker test runs it (#21) is D1's own error text carrying the marker; it reports SQLite's message (`D1_ERROR: … SQLITE_ERROR`), and the commit searches the error's cause for it.

A guarded write staged by a domain package's own statement follows the same rule: it writes nothing when its guard does not hold, and returns one row per row it writes.

```ts
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
import * as SqlUnitOfWork from "@thomasfosterau/effect-biz-sql/SqlUnitOfWork";
import * as Testing from "@thomasfosterau/effect-biz-sql/testing";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const committer = yield* SqlUnitOfWork.Committer;
  yield* sql`CREATE TABLE counters (id TEXT PRIMARY KEY, version INTEGER NOT NULL)`;
  yield* sql`INSERT INTO counters (id, version) VALUES ('a', 1)`;
  const bump = (from: number) =>
    SqlUnitOfWork.stage(
      committer,
      SqlUnitOfWork.guarded(
        sql`UPDATE counters SET version = version + 1 WHERE id = 'a' AND version = ${from} RETURNING id`,
        {
          conflict: Effect.succeed(
            new BizError.ConcurrencyConflict({
              entity: "Counter",
              id: "a",
              expected: from,
              actual: from + 1,
            }),
          ),
        },
      ),
    );
  // One command, two bumps from version 1: the second guard raises, the batch rolls back.
  const conflict = yield* Effect.flip(UnitOfWork.transaction(Effect.andThen(bump(1), bump(1))));
  const rows = yield* sql<{ version: number }>`SELECT version FROM counters`;
  return [conflict._tag, rows[0]?.version];
});

// D1's batch commit, on SQLite.
const layer = SqlUnitOfWork.layerBatch({ attempts: 1 }).pipe(
  Layer.provideMerge(Testing.layerBatch),
  Layer.provideMerge(Testing.layerSqlite),
);
Effect.runPromise(program.pipe(Effect.provide(layer))).then(console.log); // ["ConcurrencyConflict", 1]
```

## A repository (`SqlRepository.make`)

`make` builds the whole `Repository.Port<A, I>` over one table: `table`, `entity` (the kind errors name), `id` (core's `Id.make` codec), `fields` (the domain fields' codecs from `./Column`, for the current dialect), `make` (the entity of a decoded row) and `withAudit` (as `Memory.repository`'s; the entity type is inferred from it, so type its parameters and result), plus the allow-lists. It requires `SqlClient`, `Dialect` and the `SqlUnitOfWork.Committer`, which `SqlUnitOfWork.layer` provides beside the `UnitOfWork`.

- **The table**: `id` (the primary key), `tenant_id`, one column per field (the field in snake_case, or `columns`' name for it), `version` and the audit columns. The migrator is #37; until it lands a suite creates its tables itself.
- **Reads** (`get`, `getMany`, `find`) read committed rows, always filtered by the `TenantContext`'s `tenant_id`, each decoded through `Schema`: the fields' codecs, the id's codec and the audit columns' (`Column.timestamp`, `nullable`). An id that is not one (`Schema.is(id)` fails) is `NotFound` without a query.
- **Writes** decide against a fresh read and stamp the audit fields with `Audit.next` (`update` keeps the stored creation and archive fields), then stage their guarded statement.
- **Failures.** A `SqlError`, or a stored row that does not decode, is a defect: the port has no error channel for either.

```ts
import { Effect, Layer, Schema, Struct } from "effect";
import { SqlClient } from "effect/sql";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
import * as SqlRepository from "@thomasfosterau/effect-biz-sql/SqlRepository";
import * as SqlUnitOfWork from "@thomasfosterau/effect-biz-sql/SqlUnitOfWork";
import * as Testing from "@thomasfosterau/effect-biz-sql/testing";

const ItemId = Id.make("ItemId");

class Item extends Schema.Class<Item>("example/Item")({
  id: ItemId,
  name: Schema.String,
  price: Decimal.Decimal,
  audit: Audit.AuditFields,
}) {}

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE items (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, unit_price TEXT NOT NULL,
    version INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, archived_at TEXT
  )`;
  const items = yield* SqlRepository.make({
    table: "items",
    entity: "Item",
    id: ItemId,
    fields: (columns) => ({ name: Schema.String, price: columns.decimal }),
    columns: { price: "unit_price" },
    make: (row) => new Item(row),
    withAudit: (item: Item, audit: Audit.AuditFields): Item =>
      new Item({ ...Struct.omit(item, ["audit"]), audit }),
    filterable: { name: "text", price: "decimal" },
    searchable: ["name"],
  });
  const audit = yield* Audit.created;
  const bolt = new Item({
    id: yield* Id.generate(ItemId),
    name: "Bolt",
    price: Decimal.make("0.25"),
    audit,
  });
  const nut = new Item({
    id: yield* Id.generate(ItemId),
    name: "Nut",
    price: Decimal.make("0.10"),
    audit,
  });
  // One command, one batch: both inserts commit together.
  yield* UnitOfWork.transaction(Effect.andThen(items.insert(bolt), items.insert(nut)));
  const repriced = yield* items.update(
    new Item({ ...Struct.omit(bolt, ["price"]), price: Decimal.make("0.30") }),
  );
  const stale = yield* Effect.flip(items.update(bolt)); // still at version 1
  const cheapest = yield* items.find({ sort: [{ field: "price" }] }, { limit: 1 });
  return [repriced.audit.version, stale._tag, cheapest.items.map((item) => item.name)];
});

const layer = SqlUnitOfWork.layer().pipe(
  Layer.provideMerge(Layer.merge(Testing.layerSqlite, Id.layer)),
);
const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
Effect.runPromise(
  program.pipe(
    Effect.provide(layer),
    Tenancy.withTenant(tenant),
    Actor.withActor(Actor.system("example")),
  ),
).then(console.log); // [2, "ConcurrencyConflict", ["Nut"]]
```

## Queries in SQL

`find` translates core's `Query` into one `SELECT … WHERE … ORDER BY … LIMIT limit + 1` (the extra row says whether a next page exists), and agrees with `Query.run`, core's pure interpreter; the suites compare the two page by page on every dialect.

- **The allow-list.** `filterable` maps each field `find` may filter (`eq`, `in`, `range`) or sort by to how its column compares; the id is always allowed. A field off the list is a `ValidationError` at its path (`["eq", "code"]`, `["range", "weight"]`, `["sort", 0, "field"]`), as is a value its codec cannot encode.

  | Kind | Compares as | Postgres | SQLite, D1 |
  | --- | --- | --- | --- |
  | `text` | code points (as `Query.run`'s `Order.String`) | `col COLLATE "C"` | `col` (binary) |
  | `id` | the UUID text | `uuid` | `text` |
  | `number`, `boolean` | the value | the column | the column |
  | `timestamp` | the instant | `timestamptz` | ISO-8601 text, which sorts in time order |
  | `decimal` | the number | `numeric` | `CAST(col AS REAL)` in a range or a sort; `eq` / `in` compare the canonical text, exactly |

  A SQLite decimal is text, so a range or a sort on one compares it as `REAL`, exact to 15 significant digits; Postgres's `numeric` is exact.

- **Values** are bound through the field's own codec (`Column.decimal` writes canonical text, `Column.timestamp` a `Date` or ISO text), so a filter compares what the column stores.
- **`in`** with no values matches nothing (`1 = 0`), as in `Query.run`.
- **`search`** is a case-insensitive substring of any `searchable` column: `col ILIKE ? ESCAPE '\'` on Postgres, `lower(col) LIKE ? ESCAPE '\'` on SQLite and D1, with `%`, `_` and `\` in the needle escaped. A blank search matches everything; a non-blank one over no searchable column matches nothing. SQLite's `lower` folds ASCII only, so a non-ASCII search there is case-sensitive.
- **`archived`**: `archived_at IS NULL` (the default), `IS NOT NULL` (`"only"`) or nothing (`"include"`).
- **The order** is the sort keys, each `ASC` / `DESC`, then `id ASC`: total and stable, as in memory.

## Keyset paging

A page continues strictly after the cursor's position, in the expanded `OR` form, which holds for mixed directions on every dialect:

```sql
-- sort: price desc, name asc; then the id
WHERE … AND (
     price < :price
  OR (price = :price AND name COLLATE "C" > :name)
  OR (price = :price AND name COLLATE "C" = :name AND id > :id)
)
ORDER BY price DESC, name COLLATE "C" ASC, id ASC
LIMIT :limit + 1
```

A cursor's key that is `None` (a field the item lacked, which sorts first) is before every value: every row is after it ascending, none descending, and none equals it.

**Cursors are core's.** A position is decoded with `Page.decodeCursor` against `Query.sortKey(query)`, and the next cursor encoded with `Page.encodeCursor` from the last item's sort-key values and id, exactly as `Query.run` does. So a cursor from the in-memory store continues a SQL `find` and the reverse (the suites check both), a cursor for another sort is a `ValidationError` on `["cursor"]`, and so is one whose keys the sort's codecs cannot encode.

## Row-level security

Tenant scoping in the database (#38) will set the tenant inside the commit, as the batch's first statement (`set_config('app.tenant_id', …, true)` on Postgres); this slice has no hook for it, and every statement here filters by `tenant_id` itself.

## Testing

A domain package's SQL repository passes core's contracts the way the sample `widgets` table in this package's `tests/` does: `Testing.repositoryContract` and `Testing.unitOfWorkContract` over `SqlRepository.make`, on `Testing.layerSqlite` built per test (`excludeTestServices`, since the retry cases sleep), on D1's batch commit (`SqlUnitOfWork.layerBatch` with `Testing.layerBatch`), and on Postgres when `EFFECT_BIZ_PG_URL` is set. Core's `Company` runs the repository contract the same way, its nested values (`registrations`, `fiscalYearStart`, `rounding`) as JSON columns.

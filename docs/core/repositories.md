# Repositories, queries and paging

How every domain package persists its entities: a repository port per entity, an in-memory layer for tests built on `./Memory`, a SQL layer for production, and one contract suite (`./testing`) both must pass. See also [tenancy, companies and actors](tenancy.md) and [identifiers and errors](ids-and-errors.md).

## The port (`./Repository`)

`./Repository` holds conventions and helper types, not a base class. A domain package declares its own `Context.Service` whose shape is `Repository.Port<A, I>` (plus any methods of its own):

| Method | Does | Fails with |
| --- | --- | --- |
| `get(id)` | The tenant's entity, archived or not. | `NotFound` |
| `getMany(ids)` | The tenant's entities with these ids, in the order asked, each once; unknown ids are left out. | never |
| `find(query, request?)` | One page of the tenant's entities matching a `Query`. | `ValidationError` (a bad cursor or limit) |
| `insert(entity)` | Stores a new entity at version 1. | `AlreadyExists`, `ConcurrencyConflict` (not version 1) |
| `update(entity)` | Replaces the entity stored at `entity.audit.version`; returns it at the next version. | `NotFound`, `ConcurrencyConflict` |
| `archive(id, version)` / `restore(id, version)` | Sets / clears `audit.archivedAt`, at the next version. | `NotFound`, `ConcurrencyConflict`, `InvalidTransition` |

A hard delete (`Repository.Deletable`) is added only where the domain allows one.

- **Tenant-scoped.** Every method requires `Tenancy.TenantContext` and reads and writes only that tenant's rows: another tenant's entity is `NotFound`, never `Forbidden`.
- **Audited.** Every entity carries `audit: Audit.AuditFields` (`createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `version`, `archivedAt`): the times come from `Clock` as `DateTime.Utc`, the actors are `CurrentActor` ids (never display names). A command builds a new entity's fields with `Audit.created`; `update`, `archive` and `restore` move them on themselves (`Audit.next`), so they also require the `CurrentActor`. `update` keeps the stored creation and archive fields, whatever the caller passes.
- **Version-guarded.** Of two writes from the same version exactly one succeeds; the other fails with `ConcurrencyConflict`, which `BizError.isRetryable` says to retry from the load step. Every write is load → decide (pure) → commit one atomic, version-guarded batch, so it works on Cloudflare D1 (no row locks, no interactive transactions) as on Postgres (#128).
- **Archived, not deleted.** `get` still finds an archived entity; `find` hides it unless the query asks. Archiving an archived entity, or restoring an active one, is `InvalidTransition`.

## Queries (`./Query`)

A `Query<A>` is typed over the entity's fields:

- `eq` / `in` on any scalar field (string, number, boolean, `DateTime.Utc`, `BigDecimal`);
- `range` (`gt`, `gte`, `lt`, `lte`) on an ordered one (any of those but a boolean);
- `search`, a text hint: a case-insensitive substring of the repository's searchable fields in memory, full-text search where a SQL layer has it;
- `archived`: `"exclude"` (the default), `"include"` or `"only"`;
- `sort`: fields and directions, always followed by the id, so the order is total and stable.

`Query.run` is the pure interpreter the in-memory layer uses; a SQL layer turns the same spec into `WHERE` / `ORDER BY`.

## Paging (`./Page`)

`find` returns a `Page<A>`: `items` and `nextCursor` (`None` on the last page). Paging is keyset paging: the cursor encodes the last item's sort-key values and id (base64url JSON, opaque to the caller), and the next page starts strictly after it. So a row inserted between two pages never repeats or hides a row that existed when the first page was read. A malformed cursor, or one made for another sort, is a `ValidationError`. `limit` defaults to 50 and is capped at 500; below 1 or not an integer is a `ValidationError`.

```ts
import { Context, Effect, Layer, Option, Struct } from "effect";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as Memory from "@thomasfosterau/effect-biz/Memory";
import type * as Repository from "@thomasfosterau/effect-biz/Repository";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";

interface Contact {
  readonly id: string;
  readonly name: string;
  readonly audit: Audit.AuditFields;
}

class Contacts extends Context.Service<Contacts, Repository.Port<Contact, string>>()(
  "example/Contacts",
) {}

const layerMemory = Layer.effect(
  Contacts,
  Effect.map(Memory.makeStore<string, Contact>(), (store) =>
    Memory.repository(store, {
      entity: "Contact",
      withAudit: (contact, audit) => ({ ...Struct.omit(contact, ["audit"]), audit }),
      searchable: ["name"],
    }),
  ),
);

const program = Effect.gen(function* () {
  const contacts = yield* Contacts;
  const audit = yield* Audit.created;
  for (const [n, name] of ["Ava", "Ben", "Cleo"].entries()) {
    yield* contacts.insert({ id: `00000000-0000-7000-8000-00000000000${n + 1}`, name, audit });
  }
  const byName = { sort: [{ field: "name", direction: "desc" }] } as const;
  const first = yield* contacts.find(byName, { limit: 2 });
  const cursor = yield* Effect.fromOption(first.nextCursor);
  const second = yield* contacts.find(byName, { limit: 2, cursor });
  return [...first.items, ...second.items].map((contact) => contact.name);
});

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
const names = Effect.runSync(
  program.pipe(
    Effect.provide(layerMemory),
    Tenancy.withTenant(tenant),
    Actor.withActor(Actor.system("example")),
  ),
);
console.log(names); // ["Cleo", "Ben", "Ava"]
```

## The in-memory store (`./Memory`)

`Memory.makeStore` is a tenant-partitioned `TxRef` of maps; `Memory.rows` reads the current tenant's committed rows and `Memory.put` is the one write primitive: one row, guarded by the version it must still be at (0 for an insert), staged into the open [unit of work](unit-of-work.md)'s batch or, outside one, committed at once. A batch commits in one `Effect.tx`, so of two writes from one version exactly one commits, as with a SQL layer's version-guarded batches. `Memory.makeLog` / `append` / `entries` is an append-only companion store, the shape of an outbox. `Memory.repository(store, options)` builds a whole port (`entity` names the kind in errors; `withAudit` rebuilds an entity with new audit fields; `searchable` lists the fields `search` matches). A domain package adds its own methods over the same store, as `Company.layerMemory` adds `list`.

## The contract suite (`./testing`)

`Testing.repositoryContract(subject)` returns the cases every implementation must pass: insert and get, `getMany`, version-guarded updates, two concurrent updates from one version, tenant isolation, paging stability under inserts, malformed cursors, and archive / restore. Each case is a plain `Effect` that fails with a `ContractFailure` naming the broken rule, so it runs under any test runner (the suite imports none); give each case a fresh store. With `@effect/vitest`:

```ts skip-type-checking
import { layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Layer from "effect/Layer";

layer(Layer.merge(layerMemory, Id.layerSequential), { buildPerTest: true })(
  "Contacts contract",
  (it) => {
    Arr.forEach(Testing.repositoryContract(subject), (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);
```

The subject is the port (`repository`, an effect that gets it), `make` (a fresh entity with a new id and `Audit.created` fields, not yet inserted) and `change` (an edit for `update`). Every case provides its own two tenants and actor.

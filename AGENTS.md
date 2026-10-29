# AGENTS.md

`CLAUDE.md` is a symlink to this file. This repository publishes the **`@thomasfosterau/effect-biz` package family**: modular ERP and business-process services for Effect, meant to be embedded in other applications. The plan is the roadmap epic in the issue tracker; its sub-issues are the slices.

## Architecture (owner decisions)

These were settled with the owner before any domain code was written. Changing one is an owner decision recorded on the roadmap epic, not something a PR does on its own.

- **Boundary with effect-finance.** [`thomasfosterau/effect-finance`](https://github.com/thomasfosterau/effect-finance) owns money: payments (`@thomasfosterau/effect-payments*`), the general ledger, chart of accounts, journals, invoices, bills, credit notes, AR/AP, tax and financial reports. effect-biz owns everything operational: parties, the product catalogue, sales, purchasing, inventory, manufacturing, CRM, HR, projects and payroll calculation. **Never duplicate across the two**: if effect-biz needs a monetary primitive (`Money`, `Currency`, a tax code), it imports it from effect-finance; if it is missing there, it is built there first (no interim copy here; #111).
- **Dependency direction is one-way: effect-biz → effect-finance.** effect-finance never imports effect-biz. effect-finance documents reference effect-biz master data by branded id plus a denormalised snapshot (name, address, tax id, line description), which effect-biz supplies when it hands a document over.
- **Master data lives here.** Parties (customers, suppliers, contacts, addresses) and the catalogue (products, services, units, price lists) are owned by effect-biz.
- **Persistence: ports + SQL adapter.** Each domain package defines its repositories as `Context.Service` interfaces, ships an in-memory layer for tests, and a first-party `@effect/sql` layer. **Postgres and Cloudflare D1 are both production dialects**; plain SQLite serves tests and embedded hosts. A host app may supply its own layer. Because D1 has no row locks and no interactive transactions, every command is shaped **load → decide (pure) → commit one atomic batch of version-guarded writes**, and is retried from `load` on a guard conflict; this applies on every dialect (#128). The host chooses between a shared database and one database per tenant through a `TenantDatabase` resolver (#129).
- **Tenancy: tenant + company.** Every repository call runs under a `TenantContext` (every row carries `tenant_id`); within a tenant, multiple companies (legal entities) each have their own base currency, fiscal settings, warehouses and numbering. The host app provides the context per request. effect-finance defines its own tenancy context (it cannot import this one): the host app provides both from the same ids, and the finance bridge passes them across; neither repository imports the other's.
- **Integration: domain events + transactional outbox.** A module publishes typed domain events, written to an outbox in the same transaction as its state change. Cross-module and cross-repository effects (order → invoice in effect-finance, shipment → stock movement → COGS journal) are subscribers that act idempotently. Long-running flows (approvals, procure-to-pay) run on `effect/workflow` (durable). Events can be forwarded outside the process as CloudEvents through first-party adapters (signed webhooks, Cloudflare Queues, AWS SNS/SQS, Kafka, NATS); the cloud adapters run on alchemy-run's Distilled clients, and Alchemy resources provision the infrastructure (#120).
- **Surfaces: services, JSON:API and `effect/rpc`.** Each domain package exposes Effect services and Layers, plus an optional HttpApi group in JSON:API v1.1 (built on `@thomasfosterau/effect-jsonapi`, with OpenAPI) and an RPC group a host app can mount. `@thomasfosterau/effect-biz-client` provides typed clients and legation resources for frontends; legation is an optional peer of that package only. No UI.
- **Authorisation: effect-auth.** Commands are authorised by `@thomasfosterau/effect-auth`'s `Authorizer` (actions in `"resource:action"` form, resources as `EntityRef`s, module `EntityResolver`s); effect-biz has no policy engine or RBAC of its own and does not authenticate. Tenancy is independent of effect-auth Organizations (#130).
- **Localisation: neutral core, Australia first.** The domain packages are jurisdiction-neutral and expose localisation extension points; the first locale package is Australian (ABN/ACN, addresses and states, NES leave, PAYG withholding, superannuation, Single Touch Payroll payloads).
- **Payroll: calculation and export, not lodgement.** effect-biz calculates pay runs, emits their journals to effect-finance and produces STP-ready payloads; lodging with the ATO is an adapter or the host app's job.

## Packages

| Package | Directory | Purpose / boundary |
| --- | --- | --- |
| `@thomasfosterau/effect-biz` | `packages/core` | The foundation: identifiers, tenancy context, error channel, domain events and the outbox port, repository conventions. Peer: `effect` only. No domain vocabulary. |

A new package adds a row here, a `CLAUDE.md` of its own, a `docgen.json`, its name in the `packages` list of the root `vite.config.ts`, its reference in the root `tsconfig.json`, and a `workspace:*` devDependency in the root `package.json`.

## Common pitfalls

- **Never edit a version in a `package.json`.** Every external version lives in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) under `catalog:` (peer ranges under `catalogs.peers`), and `catalogMode: strict` rejects anything else at install. After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read the comments on those entries before bumping any of the three.
- **Effect 4, pinned in lockstep with effect-finance.** Both repositories must resolve one `effect`; move the pin when effect-finance moves its.
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Layer` / `Schema` identity; the consuming app owns the singleton. The same goes for `@effect/sql*` and effect-finance's packages: peers (optional where only one subpath needs them).
- **`dist/` is the product.** Each package is a `vp pack` (tsdown) library with one ESM bundle + `.d.ts` per subpath; `exports` points at `dist/` and is also the list `vite.package.ts` derives the pack entries from. A package consumes a sibling through its `dist/`, so every task carries a `{ task: "build", from: "dependencies" }` edge.
- **One flat module per subpath.** `src/<Name>.ts` is published as `./<Name>` (`src/SalesOrder.ts` → `./SalesOrder`). A new public module is a new `exports` entry; `src/internal/**` is never exported.
- **`vp run docgen` executes your examples.** `@effect/docgen` type-checks every fenced `ts` / `typescript` block in a JSDoc comment under the native `tsc`, then runs them with `tsx`; the package READMEs (and the root README, in core's task) are run the same way through `scripts/readme-examples.ts`. An example must be complete (import everything it uses; no `declare const`), must not throw, and must be hermetic (in-memory layers, never a live database). A deliberate fragment opts out with ` ```ts skip-type-checking `.
- **`"sideEffects": false` is a claim about `dist/`.** Every emitted `.js` must be pure declarations: no top-level statements with effects.
- **No application vocabulary.** Nothing here names a consuming application's tables, plans or screens.
- **Money is exact.** Never a JavaScript `number` for a monetary amount, a unit price or a quantity that can be fractional; use the decimal and money types the foundation (or effect-finance) provides.

Package-local terms, invariants and import boundaries live in each package's `CLAUDE.md`.

## Conventions

- **Effect 4 idioms.** Services are `Context.Service` classes with explicit accessor functions; errors are `Schema.TaggedError<Self>()(tag, fields)` classes, yielded directly (`return yield* new PartyNotFound({ … })`); configuration is read through `Config`; anything crossing a boundary (a SQL row, an HTTP body, an event payload) is decoded with `Schema`.
- **Entities are `Schema.Class`es** with branded ids (`PartyId`, `SalesOrderId`); state machines are explicit (a document's status changes only through its service's commands).
- **Optional members are declared `?: T | undefined`, never bare `?: T`.** The workspace compiles with `exactOptionalPropertyTypes`.
- **Relative imports in `src/` carry `.js`** (`./Party.js`); tests import the module under test as `../src/<Module>.ts`.
- **Tests import from `vite-plus/test`**, never `vitest`, and live in `packages/<name>/tests/`. Unit tests run against the in-memory layers; SQL adapter tests run against SQLite in-process (Postgres suites are opt-in).
- **Every export is documented** with a doc comment whose first sentence says what it is for. Put an `@example` on the module's primary export, never on the module doc (the bundled `.d.ts` drops a file-level comment); the module doc points at it (`See {@link create} for an example.`).

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`.
- `vp check` — format + lint (Oxfmt + Oxlint). `vp run check` — the type gate: every package's `src` + `tests` under the Effect-patched native `tsc`. They are different commands.
- `vp run -r test:unit` — unit tests.
- `vp run -r build` — `vp pack` → every package's `dist/`.
- `vp run docgen` — every package's `@effect/docgen`: type-checks and runs each JSDoc example and README block against `dist/` (it builds first), and writes the git-ignored API reference to `packages/*/docs/`.
- `vp run test:coverage` — every package's unit suite under one Istanbul map at `coverage/coverage-final.json`.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). The sanctioned non-`vp` invocations: `pnpm install` (`--frozen-lockfile` in CI), `pnpm changeset` / `pnpm publish` on the release path.

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. `vp check`
2. `vp run check`
3. `vp run -r test:unit`
4. `vp run -r build`
5. `vp run docgen`

CI runs all five plus `pnpm audit --audit-level high`. For CI parity, start from a clean tree: `rm -rf node_modules packages/*/node_modules packages/*/dist && pnpm install --frozen-lockfile`.

## Branches and pull requests

- Branch off `main`; PR against `main`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`).
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).
- GitHub writes go to `thomasfosterau/effect-biz` only. If effect-finance needs something, say so in the PR body and on the issue; the owner files it there.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. The roadmap epic carries the plan; each domain has an epic whose sub-issues are its slices.
- The issue is the spec — read its comments; later comments override the body. Decisions recorded on the roadmap epic override anything older.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope (often: something effect-finance has to provide first), comment the evidence on the issue and stop.

## Effect

Read the installed package before writing Effect code: `node_modules/effect/dist/*.d.ts` for the API, `node_modules/effect/src` for the implementation, and `node_modules/effect/AGENTS.md` / `ai-docs/` when the pinned version ships them. Never guess at an Effect API. The pinned version is the `effect` entry of the catalog in `pnpm-workspace.yaml`.

## Agent sessions

The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts `node_modules/.bin` on PATH. It hydrates no secrets. `.claude/settings.json` also formats every file an Edit / Write touches (`vp fmt --write`).

## Documentation surfaces

The root `README.md` is the landing page; each package `README.md` is the API reference consumers read on npm; each package `CLAUDE.md` carries its boundary, invariants and terms; `CONTRIBUTING.md` carries human setup and procedures; `PUBLISHING.md` and `SECURITY.md` the release pipeline and its one-time setup. No `docs/` tree is committed (`packages/*/docs/` is git-ignored docgen output); decisions go in issue comments.

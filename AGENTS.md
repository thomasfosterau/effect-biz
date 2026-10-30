# AGENTS.md

`CLAUDE.md` is a symlink to this file. This repository publishes the **`@thomasfosterau/effect-biz` package family**: modular ERP and business-process services for Effect, including the money side (payments today), meant to be embedded in other applications. The plan is the roadmap epic in the issue tracker; its sub-issues are the slices.

## Architecture (owner decisions)

These were settled with the owner before any domain code was written. Changing one is an owner decision recorded on the roadmap epic, not something a PR does on its own.

- **effect-finance is merged into effect-biz.** (Owner decision, 2026-10-29.) The former [`thomasfosterau/effect-finance`](https://github.com/thomasfosterau/effect-finance) repository is subsumed here: its payments core lives in core (`@thomasfosterau/effect-biz/Payments*`, formerly `@thomasfosterau/effect-payments`) and its providers are `@thomasfosterau/effect-biz-payments-{stripe,paypal,airwallex}` (formerly `@thomasfosterau/effect-payments-*`, never published). The money domain it was to own (the general ledger, chart of accounts, journals, invoices, bills, credit notes, AR/AP, tax and financial reports) is built here too, as effect-biz packages, alongside the operational ones (parties, the product catalogue, sales, purchasing, inventory, manufacturing, CRM, HR, projects and payroll calculation). There is no cross-repository boundary, bridge or second tenancy context any more; a monetary primitive (`Money`, `Currency`, a tax code) lives in core and is never duplicated across packages. A bare `#N` in code or docs that came from effect-finance is written `effect-finance#N`: that history stays in its tracker.
- **Master data lives here.** Parties (customers, suppliers, contacts, addresses) and the catalogue (products, services, units, price lists) are owned by effect-biz.
- **Persistence: ports + SQL adapter.** Each domain package defines its repositories as `Context.Service` interfaces, ships an in-memory layer for tests, and a first-party `@effect/sql` layer. **Postgres and Cloudflare D1 are both production dialects**; plain SQLite serves tests and embedded hosts. A host app may supply its own layer. Because D1 has no row locks and no interactive transactions, every command is shaped **load → decide (pure) → commit one atomic batch of version-guarded writes**, and is retried from `load` on a guard conflict; this applies on every dialect (#128). The host chooses between a shared database and one database per tenant through a `TenantDatabase` resolver (#129).
- **Tenancy: tenant + company.** Every repository call runs under a `TenantContext` (every row carries `tenant_id`); within a tenant, multiple companies (legal entities) each have their own base currency, fiscal settings, warehouses and numbering. The host app provides the context per request.
- **Integration: domain events + transactional outbox.** A module publishes typed domain events, written to an outbox in the same transaction as its state change. Cross-module effects (order → invoice, shipment → stock movement → COGS journal) are subscribers that act idempotently. Long-running flows (approvals, procure-to-pay) run on `effect/workflow` (durable). Events can be forwarded outside the process as CloudEvents through first-party adapters (signed webhooks, Cloudflare Queues, AWS SNS/SQS, Kafka, NATS); the cloud adapters run on alchemy-run's Distilled clients, and Alchemy resources provision the infrastructure (#120).
- **Surfaces: services, JSON:API and `effect/rpc`.** Each domain package exposes Effect services and Layers, plus an optional HttpApi group in JSON:API v1.1 (built on `@thomasfosterau/effect-jsonapi`, with OpenAPI) and an RPC group a host app can mount. `@thomasfosterau/effect-biz-client` provides typed clients and legation resources for frontends; legation is an optional peer of that package only. No UI.
- **Authorisation: effect-auth.** Commands are authorised by `@thomasfosterau/effect-auth`'s `Authorizer` (actions in `"resource:action"` form, resources as `EntityRef`s, module `EntityResolver`s); effect-biz has no policy engine or RBAC of its own and does not authenticate. Tenancy is independent of effect-auth Organizations (#130).
- **Commercial documents.** Every document has its own currency and also records base-currency amounts at the rate captured on the document date; inventory is valued in base currency. Prices and documents are tax-inclusive or tax-exclusive per price list / document, with the rounding basis a company setting. Sales channels plug in through a `SalesChannel` port (Shopify connector first).
- **Documents and reporting.** Modules emit typed document data; `@thomasfosterau/effect-biz-documents` renders HTML/PDF from host-overridable templates. Standard reports are event-fed projections behind a typed report query API in core.
- **Privacy.** Personal data is annotated in schemas; core provides data-subject export, anonymisation with legal holds, retention schedules and a sensitive-field access log (#140). Never log or emit an annotated field.
- **Import and migration.** A core import framework plus first-party migrators (Xero, MYOB, Shopify, Odoo/ERPNext); financial history migrates into the ledger.
- **Localisation: neutral core, Australia first.** The domain packages are jurisdiction-neutral and expose localisation extension points; the first locale package is Australian (ABN/ACN, addresses and states, NES leave, PAYG withholding, superannuation, Single Touch Payroll payloads).
- **Payroll: calculation and export, not lodgement.** effect-biz calculates pay runs, emits their journals to the ledger and produces STP-ready payloads; lodging with the ATO is an adapter or the host app's job.

## Packages

| Package | Directory | Purpose / boundary |
| --- | --- | --- |
| `@thomasfosterau/effect-biz` | `packages/core` | The foundation: identifiers, tenancy context, error channel, domain events and the outbox port, repository conventions. Under `./Payments` and `./Payments.<Name>`, the vendor-neutral payments core: capability services, neutral entities, `Money`, `Page`, `IdempotencyKey`, `Stub` and the `PaymentsError` channel. Peer: `effect` only. No ERP domain vocabulary; no vendor vocabulary. |
| `@thomasfosterau/effect-biz-payments-stripe` | `packages/payments-stripe` | Stripe: the neutral capabilities as `Layer`s (`StripePayments`) over Distilled's operations (`@distilled.cloud/stripe`, a pinned dependency), plus the Stripe resource modules as a provider escape hatch: generated thin wrappers of every Distilled operation on each resource, over the same `StripeHttp` client. The `stripe` SDK is an optional peer (only the types of the SDK-based `Webhook.constructEvent*` verifier). |
| `@thomasfosterau/effect-biz-payments-paypal` | `packages/payments-paypal` | PayPal REST: `Products`, `Prices` (billing plans), `PaymentIntents` (orders), `Subscriptions`, `Refunds` as `Layer`s (`PayPalPayments`) over Distilled's operations (`@distilled.cloud/paypal`, a pinned dependency), authenticated by the package's own (internal) OAuth login. No `Customers`: PayPal has no customer resource. |
| `@thomasfosterau/effect-biz-payments-airwallex` | `packages/payments-airwallex` | Airwallex payment acceptance: `Customers`, `PaymentIntents`, `Refunds`. |

`tests/dist-consumer` (private, `@effect-biz/dist-consumer`) type-checks a consumer fixture against the emitted declarations of the payments packages; it runs in `vp run check`.

A new package adds a row here, a `CLAUDE.md` of its own, a `docgen.json`, its name in the `packages` list of the root `vite.config.ts`, its reference in the root `tsconfig.json`, and a `workspace:*` devDependency in the root `package.json`; a new payments provider also adds its `#build` edge and `paths` in `tests/dist-consumer/` (`vite.config.ts`, `tsconfig.json`).

## Common pitfalls

- **Never edit a version in a `package.json`.** Every external version lives in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) under `catalog:` (peer ranges under `catalogs.peers`), and `catalogMode: strict` rejects anything else at install. After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read the comments on those entries before bumping any of the three. Dependabot (`.github/dependabot.yml`) groups every lockstep set (`toolchain`, with `@enfect/oxlint` and `fallow`; `distilled`; `effect`; `docgen`; `changesets`; `github-actions`). By hand, because Dependabot cannot: the npm-alias entries (`vite`, which must equal `vite-plus`; `typescript` and `@typescript/native`, a pairing `@effect/tsgo` supports), the `overrides` literals, and regenerating the Stripe resource modules after a `distilled` bump. pnpm's `minimumReleaseAge` is 480 minutes (8 hours); Dependabot's `cooldown` is 1 day, its smallest unit.
- **Effect 4, pinned.** The `effect` pin in `pnpm-workspace.yaml` moves in lockstep with the consuming applications; the published peer range is `^4.0.0` (also Distilled's own peer range, which the Stripe and PayPal providers depend on).
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Layer` / `Schema` identity; the consuming app owns the singleton. The same goes for `@effect/sql*`: a peer (optional where only one subpath needs it).
- **`dist/` is the product.** Each package is a `vp pack` (tsdown) library with one ESM bundle + `.d.ts` per subpath; `exports` points at `dist/` and is also the list `vite.package.ts` derives the pack entries from. A package consumes a sibling through its `dist/`, so every task carries a `{ task: "build", from: "dependencies" }` edge.
- **One flat module per subpath.** `src/<Name>.ts` is published as `./<Name>` (`src/SalesOrder.ts` → `./SalesOrder`). A new public module is a new `exports` entry; `src/internal/**` is never exported.
- **`vp run docgen` executes your examples.** `@effect/docgen` type-checks every fenced `ts` / `typescript` block in a JSDoc comment under the native `tsc`, then runs them with `tsx`; the package READMEs (and the root README, in core's task) are run the same way through `scripts/readme-examples.ts`. An example must be complete (import everything it uses; no `declare const`), must not throw, and must be hermetic (in-memory layers, never a live database). A deliberate fragment opts out with ` ```ts skip-type-checking `.
- **`"sideEffects": false` is a claim about `dist/`.** Every emitted `.js` must be pure declarations: no top-level statements with effects.
- **No application vocabulary; no vendor vocabulary in core.** Nothing here names a consuming application's tables, plans or screens. Provider-specific shapes stay in the provider package that maps the neutral payments model onto them.
- **HTTP goes through `effect/http`.** The Airwallex client, PayPal's OAuth login, the Stripe `StripeHttp` client and the Distilled operations the providers run on require `HttpClient.HttpClient` and never touch `globalThis.fetch`; tests stub `FetchHttpClient.Fetch`. No Stripe module loads the SDK (`packages/payments-stripe/CLAUDE.md`). Every vendor seam is stubbed in tests; no test reaches a live account.
- **A secret never reaches an error message or a log line.** Vendor error bodies are mapped onto the neutral `PaymentsError` channel; the API key stays in the client.
- **The Stripe resource modules are generated.** Never hand-edit `packages/payments-stripe/src/<Resource>.ts`: `tests/resources.test.ts` fails when one differs from the generator's output. A Distilled bump (the `distilled` Dependabot group) is finished by hand: run `pnpm install`, rerun the generator, update the followed API version.
- **The root README's examples run in payments-stripe's `docgen` task** (`rootReadme: true` in its `vite.config.ts`), since they import core and the Stripe package.
- **Money is exact.** Never a JavaScript `number` for a monetary amount, a unit price or a quantity that can be fractional; use the decimal and money types the foundation provides. (The payments `Money` carries integer minor units in a `number`, as the providers' wire formats do; reconciling it with the foundation's money type is open.)

Package-local terms, invariants and import boundaries live in each package's `CLAUDE.md`.

## Conventions

- **Effect 4 idioms.** Services are `Context.Service` classes with explicit accessor functions; errors are `Schema.TaggedError<Self>()(tag, fields)` classes, yielded directly (`return yield* new PartyNotFound({ … })`); configuration is read through `Config`; anything crossing a boundary (a SQL row, an HTTP body, an event payload) is decoded with `Schema`.
- **Entities are `Schema.Class`es** with branded ids (`PartyId`, `SalesOrderId`); state machines are explicit (a document's status changes only through its service's commands).
- **Optional members are declared `?: T | undefined`, never bare `?: T`.** The workspace compiles with `exactOptionalPropertyTypes`.
- **Relative imports in `src/` carry `.js`** (`./Party.js`); tests import the module under test as `../src/<Module>.ts`.
- **Tests import from `vite-plus/test`**, never `vitest`, and live in `packages/<name>/tests/`. Unit tests run against the in-memory layers; SQL adapter tests run against SQLite in-process (Postgres suites are opt-in).
- **Every export is documented** with a doc comment whose first sentence says what it is for. Put an `@example` on the module's primary export, never on the module doc (the bundled `.d.ts` drops a file-level comment); the module doc points at it (`See {@link create} for an example.`).

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format with fixes, then lint without them, on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` / `oxlint-tsgolint` with `@effect/tsgo`.
- `vp check` — format + lint (Oxfmt + Oxlint with `@effect/tsgo`'s preset and `@enfect/oxlint`'s `recommended` Effect rules, over oxlint's `correctness`, `suspicious` and `perf` categories and the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins). Lint is type-aware through oxlint-tsgolint (`typeAware` + `typeCheck`), which reads each package's `tsconfig.json` (siblings mapped to `src/`, so it needs no build). Fix a finding in code; a rule is relaxed only in `vite.config.ts`, with its reason (and a site count for an allowance). `vp run check` — the type gate: every package's `src` + `tests` (plus payments-stripe's `examples` and `scripts`) under the Effect-patched native `tsc` (`tsconfig.check.json` where a package has a sibling, which it then reads through `dist/`), plus the dist-consumer check (which builds `dist/` and asserts the emitted types). They are different commands.
- `vp run -r test:unit` — unit tests.
- `vp run -r build` — `vp pack` → every package's `dist/`.
- `vp run --filter ./packages/payments-stripe generate:resources` (offline) — regenerate the Stripe resource modules from the installed `@distilled.cloud/stripe` and `scripts/resources.ts`; run it after a Distilled bump or a change to `scripts/`.
- `vp run docgen` — every package's `@effect/docgen`: type-checks and runs each JSDoc example and README block against `dist/` (it builds first), and writes the git-ignored API reference to `packages/*/docs/`.
- `vp run test:coverage` — every package's unit suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores.
- `fallow dead-code` / `fallow audit --base origin/main` — dead code, duplication, complexity and the package boundaries (`.fallowrc.json`: core imports no provider, a provider imports only core), and the change-set gate.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). The sanctioned non-`vp` invocations: `pnpm install` (`--frozen-lockfile` in CI), `pnpm changeset` / `pnpm publish` on the release path.

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. `vp check`
2. `vp run check`
3. `vp run -r test:unit`
4. `vp run -r build`
5. `vp run docgen`
6. `pnpm audit --audit-level high` (network)
7. `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/main` (the fallow gate below; not a CI step).

Steps 1–6 are CI's one job, in its order ([ci.yml](.github/workflows/ci.yml)). Every workflow defaults to `permissions: {}`, pins each action to a commit SHA, checks out without persisted credentials (except the Release job, whose Changesets step pushes), sets up Node as `"*"` with `check-latest` (never `latest`, which resolves to pre-releases), and never runs the Release job for Dependabot; CI needs no secret, so Dependabot PRs run it safely. `uvx zizmor --offline .github` audits the workflows (config in `.github/zizmor.yml`). For CI parity, start from a clean tree: `rm -rf node_modules packages/*/node_modules packages/*/dist && pnpm install --frozen-lockfile`.

## Branches and pull requests

- Branch off `main`; PR against `main`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`).
- **All packages version in lockstep** (one Changesets `fixed` group): a release bumps every package to the same version. Every change to a published package's behaviour carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).
- GitHub writes go to `thomasfosterau/effect-biz` only.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. The roadmap epic carries the plan; each domain has an epic whose sub-issues are its slices.
- The issue is the spec — read its comments; later comments override the body. Decisions recorded on the roadmap epic override anything older.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop.

## Effect

Read the installed package before writing Effect code: `node_modules/effect/dist/*.d.ts` for the API, `node_modules/effect/src` for the implementation, and `node_modules/effect/AGENTS.md` / `ai-docs/` when the pinned version ships them. Never guess at an Effect API. The pinned version is the `effect` entry of the catalog in `pnpm-workspace.yaml`.

## Agent sessions

The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts `node_modules/.bin` (`vp`, `fallow`, `tsx`) on PATH. It hydrates no secrets. `.claude/settings.json` also formats every file an Edit / Write touches (`vp fmt --write`), runs the fallow gate before every `git commit` / `git push` (`.claude/hooks/fallow-gate.sh`, which blocks on a `fail` verdict from `fallow audit --base origin/main` and reads the coverage map on disk, so run `vp run test:coverage` first), and enables the `@enfect/claude` plugin (Effect guidance, skills and post-write pattern checks), pinned by `ref` to a reviewed `mpsuesser/enfect` commit; moving it is a reviewed edit of that SHA.

## Documentation surfaces

The root `README.md` is the landing page; each package `README.md` is the API reference consumers read on npm; each package `CLAUDE.md` carries its boundary, invariants and terms; `CONTRIBUTING.md` carries human setup and procedures; `PUBLISHING.md` and `SECURITY.md` the release pipeline and its one-time setup. No `docs/` tree is committed (`packages/*/docs/` is git-ignored docgen output); decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/main` (the default branch here is `main`). If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. The config is `.fallowrc.json`: a new package adds a boundary zone and rule.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base origin/main` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |

# Contributing

The settled design decisions are in [architecture.md](architecture.md); each package's boundary and invariants are in its `AGENTS.md`.

## Workflow

The main branch is `trunk`. Branch off `trunk`, open a pull request into `trunk`, and squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`).

- **Open a draft PR early**, so others can see the work is taken.
- **One PR per change**, even a large one.
- **Rebase, don't merge.** Rebase onto `origin/trunk`; never merge `trunk` into your branch.
- **File issues** for bugs or improvements outside your change rather than fixing them in passing or leaving a TODO. Keep issue bodies evergreen: edit the context, findings and chosen solution in place.
- **Dependabot** keeps dependencies current; update one by hand only when your work needs it or Dependabot can't (see [Dependencies](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm; use it rather than calling them directly (`vp exec <bin>`, not `npx`). The pre-commit hook ([.vite-hooks/pre-commit](../.vite-hooks/pre-commit)) runs `vp staged` (format with fixes, then lint) and `vp run fallow:audit`.

| Command | What it does |
| --- | --- |
| `vp install` | Dependencies, git hooks, and the Effect-patched `tsc` / `oxlint` (`prepare`) |
| `vp check` | Format and lint, type-aware |
| `vp run check` | The type gate: every package, plus the dist-consumer check against the emitted declarations |
| `vp run -r test:unit` | Unit tests (SQLite in-process; Postgres suites are opt-in) |
| `vp run -r build` | `vp pack` → each package's `dist/` |
| `vp run docgen` | Type-checks and runs every JSDoc example, README block and guide block in `docs/<package>/` against `dist/` |
| `vp run ci` | Everything CI runs, in order |
| `vp test run tests/x.test.ts` | One test file, from inside its package |

[Fallow](https://docs.fallow.tools) checks module boundaries (`.fallowrc.json`: core imports no other package; the others import only core), complexity and duplication. Its findings are guidance, not dogma. The pre-commit `vp run fallow:audit` builds the coverage map and fails only on findings the change introduces against `origin/trunk`. Before deleting "unused" code, trace it: `vp exec fallow dead-code --trace <file>:<export>` (or `--trace-dependency <name>`).

## Coding guidelines

- **Effect.** Use Effect (v4) idioms throughout and prefer Effect's own modules (`Option`, `Array`, `Match`, `Schema`, `Config`, `effect/http`, `effect/sql`, …) to hand-rolled equivalents; convert existing code when you touch it, where practical. Exceptions: non-Effect APIs at the boundary (adapt them at the edge) and hot paths where measurement shows plain code is needed. Read the installed package rather than guessing an API (`node_modules/effect/`).
- **Services** are `Context.Service` classes; errors are `Schema.TaggedError` classes, yielded directly; entities are branded `Schema.Class`es; anything crossing a boundary is decoded with `Schema`.
- **Absence is `Option`**, never `T | null` / `T | undefined` (lint-enforced). An options-object member is `readonly x?: T`; an optional parameter `x?: T`. Vendor wire schemas keep native optionals and are mapped at the edge.
- **Money is exact.** Never a `number` for an amount, quantity, price or rate: use core's `Decimal`, `Quantity`, `Percentage`, `Rate` and `Money`, and round only with a `RoundingPolicy`. (The payments `Money` carries integer minor units, as provider wire formats do.)
- **Exports** follow Effect v4's layout: one PascalCase module per file (`src/Money.ts`), importable through its own subpath (`./Money`), and re-exported from `index.ts` as a namespace (`export * as Money from "./Money.js"`). Modules that need an optional peer stay subpath-only.
- **Imports**: Effect modules as namespaces by subpath, with the lint's aliases (`Arr`, `P`, `R`, `Str`, `Eq`, `Bool`). Relative imports in `src/` end in `.js`.
- **Lint** findings are fixed in code. A rule is relaxed only in `vite.config.ts`, scoped and with its reason.
- **Comments.** A file-level comment only when it gives real context, in under 50 words. Doc comments where they help someone reading IntelliSense, adding to the signature rather than restating it (docgen requires them on exports, and runs every example: make it complete and hermetic). Inline comments only for what the code can't say. Don't reference issues, PRs or CI runs in comments.
- **Tests** check logic: edge cases, regressions, complex behaviour. Don't test what the type system or a lint enforces. Use `@effect/vitest` (`it.effect`, `layer(...)`) with `describe` / `expect` from `vite-plus/test`; never run an Effect in a test body. No test reaches a live vendor account.
- **Generated code**: the Stripe resource modules are written by `vp run --filter ./packages/payments-stripe generate:resources`; never edit them by hand.

## Before pushing

Run `vp run ci`, or the gates one at a time:

1. `vp check`
2. `vp run check`
3. `vp run -r test:unit`
4. `vp run -r build`
5. `vp run docgen`
6. `pnpm audit --audit-level high` (network)

Say in the PR body which gates couldn't run. CI ([ci.yml](../.github/workflows/ci.yml)) runs `vp run ci` on Node `lts` and `latest`, with no secrets. Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Changesets

Every change to a published package's behaviour carries a changeset (`vp exec changeset`); docs-, CI- and tooling-only changes need none. A doc-comment change that reaches the emitted `.d.ts` is a `patch`. All packages version together (one `fixed` group). Never version or publish by hand: the Release workflow opens the "Version Packages" PR, the owner merges it, and the workflow publishes with `vp run release` (`vp pm publish -r`, then `changeset git-tag`; there is no publish script). `vp run release:dry-run` shows what it would publish ([PUBLISHING.md](PUBLISHING.md)).

## Dependencies

Dependabot ([dependabot.yml](../.github/dependabot.yml)) opens `@thomasfosterau/*` updates daily and every other update weekly, on Wednesday morning Melbourne time: the named runtime sets (`effect` and the like) each in one PR, and every other development dependency in the single `toolchain` group. Security updates skip the schedule and open as soon as an advisory lands, one PR each. Vite+ selects Node.js from `.node-version` and pnpm from `packageManager`; pnpm's own switching is off (`runtimeOnFail` / `pmOnFail`), so one version of each is installed and used.

Every external version is in the `pnpm-workspace.yaml` catalog. After editing it, run `vp install` and commit `pnpm-lock.yaml`. Dependabot groups the sets that must move together, but can't make these moves: make them in a PR from a new branch started from its PR's head (never push to a `dependabot/*` branch, which stops it rebasing), and Dependabot closes its own PR once yours merges.

- **Toolchain** (`vite-plus`): `vp dlx --package=vite-plus@<v> vp migrate --no-interactive` re-pins `vite` and `vitest`; drop any `minimumReleaseAgeExclude` entries it adds, and bump the Dev Container image tag. `typescript` / `@typescript/native` move only with an `@effect/tsgo` that supports them.
- **Distilled**: regenerate the Stripe resource modules (`generate:resources`) and move `stripe` and `DISTILLED_API_VERSION` to the new Stripe API version; the tests fail until all three agree.

## Adding a package

Add a row to the root README's package table, an `AGENTS.md` (and a `CLAUDE.md` holding `@AGENTS.md`), a `docgen.json`, its name in the `packages` list of the root `vite.config.ts`, its reference in the root `tsconfig.json`, and a boundary zone and rule in `.fallowrc.json`.

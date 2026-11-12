# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents.

Architecture decisions, branch model, pre-PR gates and changeset rules: [AGENTS.md](AGENTS.md) ([Architecture](AGENTS.md#architecture-owner-decisions), [Verification](AGENTS.md#verification), [Branches and pull requests](AGENTS.md#branches-and-pull-requests)).

## Setup

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

```sh
pnpm install   # dependencies, git hooks, and the Effect-patched tsc / oxlint
```

Requires Node 22+ and pnpm 11 (`corepack enable` picks up the pinned version from `packageManager`).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format with fixes, then lint without them, on staged files: type-aware autofixes never land unverified). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs `vp run ci` (steps 1–6 of the gates in [AGENTS.md → Verification](AGENTS.md#verification), in that order) on Node.js `lts` and `latest`; the required checks are its legs, `ci (node lts)` and `ci (node latest)`. Run `vp run ci` to reproduce it locally. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes to npmjs once it merges, via OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Docs to update with a change

Documentation has three homes, and a README is never one of the detailed ones. Per-export detail (the contract, errors, options) goes in the export's doc comment; cross-cutting how-to goes in a focused guide in `docs/<package>/*.md` (`docs/core`, `docs/payments-stripe`), whose `ts` blocks `vp run docgen` runs; the package `README.md` stays short (what it is, install, one example, an entry-points table, links) and links to guides by absolute GitHub URL (npm renders it out of context). Update the doc comment and the guide for any exported change, and the README only when an entry point changes; the package `AGENTS.md` for a new term or invariant; the package table in the root `README.md` (and the checklist in [AGENTS.md → Packages](AGENTS.md#packages)) for a new package.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format with fixes, then lint without them, on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` / `oxlint-tsgolint` with `@effect/tsgo`.
- `vp check` — format + lint (Oxfmt + Oxlint with `@effect/tsgo`'s preset and `@enfect/oxlint`'s `recommended` Effect rules, over oxlint's `correctness`, `suspicious` and `perf` categories and the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins). Lint is type-aware through oxlint-tsgolint (`typeAware` + `typeCheck`), which reads each package's `tsconfig.json` (siblings mapped to `src/`, so it needs no build). Fix a finding in code; a rule is relaxed only in `vite.config.ts`, with its reason (and a site count for an allowance). `vp run check` — the type gate: every package's `src` + `tests` (plus payments-stripe's `examples` and `scripts`) under the Effect-patched native `tsc` (`tsconfig.check.json` where a package has a sibling, which it then reads through `dist/`), plus the dist-consumer check (which builds `dist/` and asserts the emitted types). They are different commands.
- `vp run -r test:unit` — unit tests.
- `vp run -r build` — `vp pack` → every package's `dist/`.
- `vp run --filter ./packages/payments-stripe generate:resources` (offline) — regenerate the Stripe resource modules from the installed `@distilled.cloud/stripe` and `scripts/resources.ts`; run it after a Distilled bump or a change to `scripts/`.
- `vp run docgen` — every package's `@effect/docgen`: type-checks and runs each JSDoc example, README block and guide block (`docs/<package>/*.md`) against `dist/` (it builds first), and writes the git-ignored API reference to `packages/*/docs/`.
- `vp run test:coverage` — every package's unit suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores.
- `vp exec fallow dead-code` / `vp exec fallow audit --base origin/trunk` — dead code, duplication, complexity and the package boundaries (`.fallowrc.json`: core imports no other package, a provider and the sql package import only core), and the change-set gate.
- `pnpm changeset` — add a changeset.

For a narrower run:

```sh
vp lint                                   # oxlint
vp fmt                                    # oxfmt
vp run check                              # the whole type gate
vp run --filter ./packages/core check     # one package's type gate
vp run -r test:unit                       # unit tests
vp test run tests/index.test.ts           # single file (from inside the package)
vp run -r build                           # emit dist/
vp run docgen                             # type-check and run every JSDoc @example and README block
vp run test:coverage                      # one Istanbul map for the workspace
vp exec fallow audit --base origin/trunk  # dead code, complexity, boundaries for this change set
```

The workflow hardening rules (and the `uvx zizmor --offline .github` audit) are in [AGENTS.md → Verification](AGENTS.md#verification).

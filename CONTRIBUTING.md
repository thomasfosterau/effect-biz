# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents.

Architecture decisions, branch model, pre-PR gates and changeset rules: [AGENTS.md](AGENTS.md) ([Architecture](AGENTS.md#architecture-owner-decisions), [Verification](AGENTS.md#verification), [Branches and pull requests](AGENTS.md#branches-and-pull-requests)).

## Setup

```sh
pnpm install   # dependencies, git hooks, and the Effect-patched tsc / oxlint
```

Requires Node 22+ and pnpm 11 (`corepack enable` picks up the pinned version from `packageManager`).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format with fixes, then lint without them, on staged files: type-aware autofixes never land unverified). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one job: `vp check` (format + type-aware lint), `vp run check` (the type gate), `vp run -r test:unit`, `vp run -r build`, `vp run docgen` (type-checks and runs every JSDoc `@example` and README block against `dist/`), and `pnpm audit --audit-level high`. [release.yml](.github/workflows/release.yml) runs changesets/action on `main`: it opens the version PR while unreleased changesets exist and publishes to npmjs once it merges, via OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Docs to update with a change

The package `README.md` for any exported change (it is the API reference npm shows); the package `CLAUDE.md` for a new term or invariant; the package table in `AGENTS.md` and the root `README.md` for a new package.

## Running individual checks

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
fallow audit --base origin/main           # dead code, complexity, boundaries for this change set
```

Workflows are hardened for Dependabot PRs: `permissions: {}` by default, actions pinned to commit SHAs, no persisted checkout credentials outside the Release job, no secrets in CI, and the Release job never runs for Dependabot. `uvx zizmor --offline .github` audits them.

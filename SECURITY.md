# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-biz/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected package and version.

## Supply-chain hardening

These packages are published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** This repository is public, so trusted publishing attaches npm [provenance](https://docs.npmjs.com/generating-provenance-statements) — the statement cryptographically linking an artifact to its source commit and workflow — to every release.
- **Install scripts disabled in the release job.** The release workflow installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts` and turns off pnpm 11's verify-deps-before-run re-install, so neither a compromised (transitive) dependency's install hooks nor the workspace's own `prepare` run in the privileged publish job. CI runs the workspace's own `prepare` (the `@effect/tsgo` patch the type gate needs) but only ever holds read permissions.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for a day before pnpm will install them; Dependabot proposes updates for review with the same cooldown.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).

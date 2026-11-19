# Security

## Reporting a vulnerability

Report vulnerabilities privately with GitHub's [Report a vulnerability](https://github.com/thomasfosterau/effect-biz/security/advisories/new) form, not a public issue. Include a description, reproduction steps, and the affected package and version.

## Supply chain

- **No long-lived npm token**: releases use OIDC trusted publishing, with provenance.
- **No install scripts in the release job**, and it runs only once `.github/workflows/actions.lock` verifies every action's commit.
- **Least privilege**: workflows default to `permissions: {}`; CI holds read-only access and no secrets, so Dependabot PRs run it safely.
- **Manual approval**: publishing runs in a protected `release` environment.
- **Locked, delayed dependencies**: frozen-lockfile installs, and `minimumReleaseAge` holds new versions for 8 hours (Dependabot waits a day).

The pipeline is described in [PUBLISHING.md](PUBLISHING.md).

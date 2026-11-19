# Changesets

Every change to a published package's behaviour ships with a changeset: run `vp exec changeset`, pick the packages and the semver bump, describe the change, and commit the generated file with the PR. The `Release` workflow turns pending changesets into a "Version Packages" PR and publishes once that PR merges — see [docs/PUBLISHING.md](../docs/PUBLISHING.md).

# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): there is no `NPM_TOKEN`.

## The release flow

1. Add a changeset with your change (`vp exec changeset`).
2. On every push to `trunk`, the [Release](../.github/workflows/release.yml) workflow opens or updates the "Version Packages" PR while changesets are pending. Its version step is `changeset version && vp fmt && pnpm install --lockfile-only`; `"format": false` in `.changeset/config.json` stops Changesets running Vite+'s IDE-only `oxfmt` shim, which exits 1.
3. Merging that PR publishes the bumped packages (`pnpm -r publish`, which rewrites `workspace:` and `catalog:` specifiers), tags them and creates the GitHub releases. The repository is public, so `pnpm publish` attaches provenance under trusted publishing; no npm CLI is involved.

The release job runs only after `actions.lock` verifies, installs with `--ignore-scripts`, uses no cache, and sets `pnpm_config_verify_deps_before_run: "false"` so pnpm does not re-install with scripts.

## One-time setup

1. **Settings → Actions → General → Workflow permissions**: allow GitHub Actions to create and approve pull requests.
2. **Bootstrap each package on npm** by hand, since a trusted publisher can only be added to an existing package: from a clean `trunk`, `vp run -r build && pnpm --filter <name> publish --access public --no-git-checks`, core first. Do this before merging the first "Version Packages" PR.
3. **Configure the trusted publisher** for each package on npmjs.com: GitHub Actions, repository `thomasfosterau/effect-biz`, workflow `release.yml`, environment `release`.
4. **Protect the `release` environment** (required reviewers, `trunk` only) and **`trunk`** (pull requests and passing CI).

## A new package

A new package lands with `"private": true`, so Changesets (`privatePackages.version: false`) neither versions nor publishes it, and it carries no changeset. To ship it, the owner bootstraps it on npm and configures its trusted publisher (steps 2 and 3), then removes `private` and adds its first `minor` changeset in one PR.

## Renaming the repository

These move together: the `github.repository` guard in release.yml, the changelog `repo` in `.changeset/config.json`, each `package.json` `repository`, and the npm trusted-publisher binding.

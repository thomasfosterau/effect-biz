# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) through `vp pm publish` (pnpm): there is no `NPM_TOKEN`, no npm CLI and no publish script.

## The release flow

1. Add a changeset with your change (`vp exec changeset`).
2. On every push to `trunk`, the [Release](../.github/workflows/release.yml) workflow opens or updates the "Version Packages" PR while changesets are pending. Its version step is `changeset version && vp fmt && pnpm install --lockfile-only`; `"format": false` in `.changeset/config.json` stops Changesets running Vite+'s IDE-only `oxfmt` shim, which exits 1.
3. Merging that PR runs `vp run release` (a `vite.config.ts` task): every package's build, then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts`, which publishes each public package whose version isn't on npm yet in dependency order (pnpm rewrites `workspace:` and `catalog:` specifiers, and attaches provenance under trusted publishing since the repository is public), then `changeset git-tag`, which tags each untagged version and reports the tags to the Changesets action, which pushes them and creates the GitHub releases. A failed publish stops before tagging; a re-run publishes only what is missing.

`vp run release:dry-run` builds and lists what `vp pm publish` would publish, without publishing or tagging.

The release job runs only after `actions.lock` verifies, installs with `--ignore-scripts`, uses no cache, and sets `pnpm_config_verify_deps_before_run: "false"` so pnpm does not re-install with scripts.

## One-time setup

1. **Settings → Actions → General → Workflow permissions**: allow GitHub Actions to create and approve pull requests.
2. **Bootstrap each package on npm** by hand, since a trusted publisher can only be added to an existing package: from a clean `trunk` as `thomasfosterau`, `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`, then `git push origin --tags`. Never publish from a package directory.
3. **Configure the trusted publisher** for each package on npmjs.com: GitHub Actions, repository `thomasfosterau/effect-biz`, workflow `release.yml`, environment `release`.
4. **Protect the `release` environment** (required reviewers, `trunk` only) and **`trunk`** (pull requests and passing CI).

## A new package

A new package lands with `"private": true`, so Changesets (`privatePackages.version: false`) neither versions nor publishes it, and it carries no changeset. To ship it, the owner removes `private` and adds its first `minor` changeset in one PR; once the "Version Packages" PR that bumps it has merged, they bootstrap it from that `trunk` commit and configure its trusted publisher (steps 2 and 3) before approving the release job, which then skips what is already on npm.

## Renaming the repository

These move together: the `github.repository` guard in release.yml, the changelog `repo` in `.changeset/config.json`, each `package.json` `repository`, and the npm trusted-publisher binding.

# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline. The pipeline is copied from the effect-finance repository.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the packages and the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. (Changes that don't affect a published package — docs, CI — need no changeset.)
2. **Merge to `main`.** The [`Release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"Version Packages"** PR that applies the version bumps and rolls the changesets into each package's `CHANGELOG.md`. The version step is `changeset version && vp fmt && pnpm install --lockfile-only`, with `"format": false` in `.changeset/config.json`: Changesets 3 otherwise auto-detects the `oxfmt` binary Vite+ installs and runs it on the new changelogs, but that binary is Vite+'s IDE-only shim and exits 1 outside LSP mode. `vp fmt` formats the changelogs instead, so the Version Packages PR passes `vp check`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow builds every package and publishes the bumped ones to npm via trusted publishing (with provenance, since the repository is public), then tags the commits and creates the GitHub releases.

The publish step runs `pnpm -r publish`, which rewrites each package's `workspace:` and `catalog:` specifiers to concrete ranges and publishes; pnpm 11 performs the npm OIDC trusted-publishing exchange itself. The release job sets `pnpm_config_verify_deps_before_run: "false"`, so pnpm does not re-install with scripts (running the root `prepare`) inside the job that holds the `id-token` permission.

## Maintainer setup (one-time)

No package has been published yet.

1. **Remove the old `NPM_TOKEN` secret.** The first bootstrap's release workflow read it; nothing reads it any more.
2. **Allow Actions to open the Version Packages PR.** **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**.
3. **Bootstrap each package on npm.** A trusted publisher can only be configured on a package that already exists, so the first version of each package is published by hand from a clean checkout (`vp run -r build && pnpm --filter <name> publish --access public`, with an npm login that has publish rights on the `@thomasfosterau` scope).
4. **Configure the trusted publisher** on npmjs.com for each package → **Settings → Trusted Publisher**: provider **GitHub Actions**, repository `thomasfosterau/effect-biz`, workflow `release.yml`, environment `release`.
5. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** and restrict deployment to `main`.
6. **Protect `main`.** Require pull requests and passing CI before merge, and disallow direct pushes.

## Renaming the repository

Four things bind the release to the repository name and must move together: the fork guard `if: github.repository == 'thomasfosterau/effect-biz'` in [release.yml](./.github/workflows/release.yml), the `repo` option of the changelog generator in [.changeset/config.json](./.changeset/config.json), the `repository` URL in each `package.json`, and the trusted-publisher binding on npmjs.com.

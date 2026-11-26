# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; [docs/architecture.md](docs/architecture.md) records the owner's design decisions, and each package's `AGENTS.md` its boundary and invariants.

- **Pull requests and issues.** You may open pull requests in this repository. Work you spot outside your change goes in an issue; file it and move on. Use the GitHub MCP tools or `gh`, whichever is available.
- **Effect idioms.** Prefer Effect v4's own modules to hand-rolled code; read `node_modules/effect/` rather than guessing an API.
- **Payments are security-sensitive.** No secret (an API key, a webhook signing secret) or personal data in an error message, a log line or a test fixture, and no test against a live vendor account.
- **Money is exact.** Never a JavaScript `number` for an amount, quantity, price or rate.
- **Don't hand-edit the Stripe resource modules** (`packages/payments-stripe/src/<Resource>.ts`): they are generated, and a test fails when they differ from the generator's output.
- **`vp run docgen` runs every example**, in doc comments, READMEs and `docs/<package>/` guides, against `dist/`: each must be complete and hermetic.
- **Publish only through the Release workflow** (`vp run release`: `vp pm publish -r`, then `changeset git-tag`). Release-path registry calls go through `vp pm`, never `npm` / `pnpm` directly.
- **`"sideEffects": false`** is a claim about `dist/`: no top-level statements with effects.

## Pull requests

- **Write the PR body with the `pr` skill** from Matt Pocock's skills (`mattpocock-skills:pr`), filling in the repository's pull request template where there is one.
- **Resolve merge conflicts before you hand a PR over.** Rebase onto `origin/trunk` and push; a PR that conflicts with `trunk` isn't finished.
- **Mark the PR ready for review as soon as the initial draft is finished.** Don't wait for CI to run, for reviews, or for the owner to do it. Keep fixing CI failures and review findings on the ready PR.

## Fallow

The `fallow` agent skill is linked into `.claude/skills/` from the installed `fallow` package after `vp install`; repository-specific rules (the pre-commit audit, tracing before deleting) are in docs/CONTRIBUTING.md.

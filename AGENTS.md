# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; [docs/architecture.md](docs/architecture.md) records the owner's design decisions, and each package's `AGENTS.md` its boundary and invariants.

- **Pull requests and issues.** You may open pull requests in this repository. Work you spot outside your change goes in an issue; file it and move on. Use the GitHub MCP tools or `gh`, whichever is available.
- **Effect idioms.** Prefer Effect v4's own modules to hand-rolled code; read `node_modules/effect/` rather than guessing an API.
- **Payments are security-sensitive.** No secret (an API key, a webhook signing secret) or personal data in an error message, a log line or a test fixture, and no test against a live vendor account.
- **Money is exact.** Never a JavaScript `number` for an amount, quantity, price or rate.
- **Don't hand-edit the Stripe resource modules** (`packages/payments-stripe/src/<Resource>.ts`): they are generated, and a test fails when they differ from the generator's output.
- **`vp run docgen` runs every example**, in doc comments, READMEs and `docs/<package>/` guides, against `dist/`: each must be complete and hermetic.
- **`"sideEffects": false`** is a claim about `dist/`: no top-level statements with effects.

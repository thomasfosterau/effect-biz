# Claude Code

Only what is specific to Claude Code lives here. Everything an agent needs whatever its tool is imported below: the agent guidance and the architecture decisions ([AGENTS.md](../AGENTS.md)), setup, commands and procedures ([CONTRIBUTING.md](../CONTRIBUTING.md)) and the project overview with the package table ([README.md](../README.md)). Each package's `CLAUDE.md` is `@AGENTS.md`, importing that package's guidance.

## Hooks (`.claude/settings.json`)

- **SessionStart** (`.claude/hooks/session-start.sh`, on startup and resume). Installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; the session's network must allow `vite.plus` and `viteplus.dev`), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), and runs `vp install --frozen-lockfile`. Nothing else goes on PATH: the global `vp` delegates to each checkout's own `vite-plus` (worktrees included), fallow runs as `vp exec fallow …`, and TypeScript scripts as `vpx <file>.ts`. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets.
- **PostToolUse on Write / Edit / MultiEdit** runs `vp fmt --write` on every `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.css`, `.json` or `.md` file it touches, so an edited file is always formatted.
- **PreToolUse on Bash** runs the fallow gate (`.claude/hooks/fallow-gate.sh`) before every `git commit` / `git push`: it blocks on a `fail` verdict from `fallow audit --base origin/trunk`, run through `vp exec fallow`, and reads the coverage map on disk, so run `vp run test:coverage` first (AGENTS.md → Fallow local gate).

## Worktrees

Put worktrees under `.claude/worktrees/<name>` (one path component). The fallow gate runs only in this checkout and its `.claude/worktrees/*`: from any other tree it runs none of that tree's tooling and skips the audit with a notice. The global `vp` delegates to each worktree's own `vite-plus`, so run `vp install` in a new worktree before its gates.

## What an agent session can't run

- **The Dev Container build** (`.github/workflows/devcontainer.yml`, `vp dlx @devcontainers/cli … up`) needs Docker; leave it to CI.
- **`pnpm audit --audit-level high`** needs the npm registry's audit endpoint; where the session's network refuses it, say so in the PR body.
- **The Release workflow** (version PR, npm publish) runs only on `trunk` in GitHub Actions; never publish or version from a session.
- **Postgres SQL suites** are opt-in and need a database the session usually doesn't have; the SQLite suites run in-process.

## Keeping this file Claude-only

- Don't let fallow (`fallow setup-hooks`, `fallow hooks install --target agent --agent claude`) or any other tool append `@AGENTS.md` or agent guidance to a `CLAUDE.md`. `AGENTS.md` is already imported below, and a second copy duplicates it in context. If a regeneration rewrites `.claude/hooks/fallow-gate.sh`, re-apply the local deviations its header lists.
- General guidance goes to `AGENTS.md`, `CONTRIBUTING.md` or `README.md`, never here.

@../AGENTS.md

@../CONTRIBUTING.md

@../README.md

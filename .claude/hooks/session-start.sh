#!/usr/bin/env bash
#
# SessionStart hook: install dependencies against the lockfile and put the
# workspace's bins (`vp`, `fallow`, `tsx`, `changeset`) on PATH for the session's
# non-interactive shells.
#
# Idempotent and never fatal: a failure logs and continues, because a
# half-provisioned session is more useful than one that refused to start.
# Hydrates no secrets: nothing here needs one, and nothing here can publish.
#
# Reads only fixed paths; takes no input from repository content, issue or PR
# bodies. Revisit that note before adding any.

set -uo pipefail

log() { printf '[session-start] %s\n' "$1" >&2; }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
cd "$PROJECT_DIR" || { log "cannot cd to $PROJECT_DIR"; exit 0; }

if command -v pnpm >/dev/null 2>&1; then
  # No stdin and CI=true: pnpm must never stop at an interactive prompt here.
  CI=true pnpm install --frozen-lockfile </dev/null >&2 || log "pnpm install failed; run it by hand"
else
  log "pnpm not found; install pnpm 11 (corepack enable) and run pnpm install"
fi

# CLAUDE_ENV_FILE persists exports into every later Bash call of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export PATH="%s/node_modules/.bin:$PATH"\n' "$PROJECT_DIR" >> "$CLAUDE_ENV_FILE"
fi

exit 0

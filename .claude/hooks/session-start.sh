#!/usr/bin/env bash
#
# SessionStart hook: install a pinned Vite+, link `vp` and `vpx` onto PATH for
# the session's non-interactive shells, and install dependencies against the
# lockfile.
#
# ## Vite+ first
#
# Vite+ (`vp`) is the one tool this script guarantees; everything else is
# reached through it. The global CLI is installed at exactly the `vite-plus`
# version pinned in `pnpm-workspace.yaml`'s catalog, using the official
# installer, which takes the release from the npm registry, refuses a package
# without npm provenance and checks its SHA-512 `dist.integrity`. It installs
# under `$VP_HOME` (else `~/.local/share/vite-plus`) and touches no shell profile, so `vp` and
# `vpx` are then linked into `~/.local/bin`, which is on PATH in the session
# container (a symlink to the real binary reaches every later shell).
#
# From there:
#
# - `vp install --frozen-lockfile` installs the dependencies.
# - The global `vp` delegates development commands to the project-local
#   `vite-plus`, including inside `.claude/worktrees/*`, so each checkout runs
#   its own pinned toolchain without a shim.
# - Project tools run through Vite+: `vp exec fallow …` for fallow (the commit
#   gate does the same), `vpx <file>.ts` for TypeScript scripts. Nothing else
#   is put on PATH: no shim walks a directory tree, and nothing runs a
#   `node_modules/.bin` the session did not install.
#
# Earlier versions of this hook appended `node_modules/.bin` to PATH through
# `CLAUDE_ENV_FILE`; that file lasts only for its own session, so there is
# nothing left behind to remove.
#
# If the installer cannot run (no network to vite.plus / viteplus.dev, or the
# catalog pin cannot be read), `vp` falls back to a one-line re-exec of this
# project's own `node_modules/vite-plus/bin/vp`, and the hook says so.
#
# ## Contract
#
# Idempotent and never fatal: a failure logs and continues, because a
# half-provisioned session is more useful than one that refused to start.
# Hydrates no secrets: nothing here needs one, and nothing here can publish.
#
# Untrusted-content note: the only value read from the repository is the
# `vite-plus` catalog version, and it is used only when it is a plain
# `MAJOR.MINOR.PATCH`. Revisit this note before adding any other input from
# repository content, issue or PR bodies.

set -uo pipefail

log() { printf '[session-start] %s\n' "$1" >&2; }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
LOCAL_BIN="${HOME:-/home/vp}/.local/bin"
# The installer installs under `$VP_HOME` when it is set (the Vite+ dev
# container image sets VP_HOME=/home/vp/.vite-plus and ships the CLI there),
# else under `~/.local/share/vite-plus`. Look where it put it, or the pin check
# never matches and the hook reinstalls and falls back on every run.
VP_GLOBAL_BIN="${VP_HOME:-${HOME:-/home/vp}/.local/share/vite-plus}/bin"
SHIM_MARKER="# generated-by: .claude/hooks/session-start.sh"

mkdir -p "$LOCAL_BIN" 2>/dev/null || log "cannot create $LOCAL_BIN; continuing"

# Replace $dest with a symlink to $src unless $dest is a real file this hook
# did not make (something deliberately installed it).
link_to() {
  src="$1"
  dest="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ] \
    && ! grep -qF "$SHIM_MARKER" "$dest" 2>/dev/null; then
    return 0
  fi
  ln -sfn "$src" "$dest" 2>/dev/null || log "could not link $(basename "$dest")"
}

# ── 1. Vite+ at the catalog pin ──────────────────────────────────────────────
VP_PIN="$(sed -nE 's/^  vite-plus: "?([0-9]+\.[0-9]+\.[0-9]+)"?$/\1/p' "$PROJECT_DIR/pnpm-workspace.yaml" 2>/dev/null | head -1)"
VP_HAVE="$("$VP_GLOBAL_BIN/vp" --version 2>/dev/null | sed -nE '1s/^vp v([0-9.]+).*$/\1/p')"
if [ -z "$VP_PIN" ]; then
  log "could not read the vite-plus catalog pin; not installing Vite+"
elif [ "$VP_HAVE" != "$VP_PIN" ]; then
  log "installing Vite+ $VP_PIN (have: ${VP_HAVE:-none})…"
  if command -v curl >/dev/null 2>&1 \
    && curl -fsSL https://vite.plus | VP_VERSION="$VP_PIN" bash >/dev/null 2>&1; then
    log "Vite+ $VP_PIN installed"
  else
    log "Vite+ installer failed (is vite.plus / viteplus.dev reachable?); continuing"
  fi
fi

if [ -x "$VP_GLOBAL_BIN/vp" ]; then
  link_to "$VP_GLOBAL_BIN/vp" "$LOCAL_BIN/vp"
  link_to "$VP_GLOBAL_BIN/vpx" "$LOCAL_BIN/vpx"
else
  # Fallback: the project's own pinned copy, by its fixed path.
  log "global Vite+ unavailable; \`vp\` runs $PROJECT_DIR's node_modules copy"
  for name in vp vpx; do
    dest="$LOCAL_BIN/$name"
    if [ -e "$dest" ] && [ ! -L "$dest" ] \
      && ! grep -qF "$SHIM_MARKER" "$dest" 2>/dev/null; then
      continue
    fi
    target="$PROJECT_DIR/node_modules/vite-plus/bin/$name"
    [ "$name" = vpx ] && target="$PROJECT_DIR/node_modules/.bin/vpx"
    printf '#!/usr/bin/env bash\n%s (%s fallback)\nexec "%s" "$@"\n' \
      "$SHIM_MARKER" "$name" "$target" >"$dest.tmp" \
      && chmod +x "$dest.tmp" && mv -f "$dest.tmp" "$dest" \
      || { rm -f "$dest.tmp" 2>/dev/null; log "could not write the $name fallback"; }
  done
fi

# ── 2. Dependencies ──────────────────────────────────────────────────────────
# Unconditional: `--frozen-lockfile` is a quick no-op when in sync, and a
# prebaked container can carry a tree built from an older lockfile. No stdin
# and CI=true: the install must never stop at an interactive prompt here.
if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ]; then
  log "syncing dependencies against the lockfile…"
  # The fallback `vp` points into node_modules, which may not exist yet, so
  # only the global CLI installs; without it, pnpm does.
  if [ -x "$VP_GLOBAL_BIN/vp" ]; then
    (cd "$PROJECT_DIR" && CI=true "$VP_GLOBAL_BIN/vp" install --frozen-lockfile </dev/null >&2) \
      || log "dependency install failed; run \`vp install\` by hand"
  elif command -v corepack >/dev/null 2>&1; then
    (cd "$PROJECT_DIR" && CI=true corepack pnpm install --frozen-lockfile </dev/null >&2) \
      || log "dependency install failed; run \`pnpm install\` by hand"
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$PROJECT_DIR" && CI=true pnpm install --frozen-lockfile </dev/null >&2) \
      || log "dependency install failed; run \`pnpm install\` by hand"
  else
    log "neither Vite+ nor pnpm is available; install pnpm 11 (corepack enable) and run pnpm install"
  fi
fi

exit 0

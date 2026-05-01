#!/usr/bin/env bash
# Conductor setup script for gitops-mudflap.
#
# Wire-up: this script is dispatched from `conductor.json` at the repo root:
#   {"scripts": {"setup": "bash .conductor/setup.sh"}}
# Note: personal scripts in Conductor → Settings → Repository scripts override
# conductor.json. Clear them once for the JSON to take effect.
#
# Manual run (existing worktree that predates this script):
#   cd <worktree>
#   bash "$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')/.conductor/setup.sh"
#
# Conductor env (non-interactive shell — .zshrc is NOT sourced):
#   CONDUCTOR_ROOT_PATH       source checkout (the user's primary tree)
#   CONDUCTOR_WORKSPACE_PATH  the new worktree (cwd of this script)
#   CONDUCTOR_WORKSPACE_NAME  workspace slug
#   CONDUCTOR_PORT            base port (10 allocated: +0 through +9)

set -euo pipefail

log()  { printf "\n==> %s\n" "$*"; }
warn() { printf "WARN: %s\n" "$*" >&2; }

# --- 1. Resolve ROOT and WORK -----------------------------------------------
WORK="${CONDUCTOR_WORKSPACE_PATH:-$PWD}"
ROOT="${CONDUCTOR_ROOT_PATH:-}"

if [[ -z "$ROOT" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "$WORK" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ROOT="$(git -C "$WORK" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
  fi
fi

if [[ -z "$ROOT" || ! -d "$ROOT" ]]; then
  warn "could not resolve source checkout (CONDUCTOR_ROOT_PATH unset and not in a git worktree); aborting"
  exit 1
fi

if [[ "$ROOT" == "$WORK" ]]; then
  log "root and workspace are identical; nothing to do"
  exit 0
fi

cd "$WORK"
REPO_NAME="$(basename "$WORK")"

if [[ "$(basename "$ROOT")" != gitops* ]]; then
  warn "Source repo '$(basename "$ROOT")' does not start with 'gitops'; continuing anyway."
fi

# --- 2. PATH hardening (non-interactive shell) ------------------------------
# Conductor scripts run without .zshrc, so PATH-mutating tools (asdf, pnpm,
# deno, mise) need explicit re-export. Mirror the user's interactive PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/Library/pnpm:${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$HOME/.local/bin:$HOME/.deno/bin:$PATH"
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash 2>/dev/null || true)"

log "Setting up Conductor workspace for $REPO_NAME"
log "  root=$ROOT"
log "  work=$WORK"

# --- Helpers ----------------------------------------------------------------
# Symlink secrets so a key rotation in root immediately propagates to every
# worktree. Idempotent — skip if target exists or is already a symlink.
link_secret_if_present() {
  local rel="$1"
  local src="$ROOT/$rel"
  local dst="$WORK/$rel"
  [[ -f "$src" ]] || return 0
  [[ -e "$dst" || -L "$dst" ]] && return 0
  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  echo "  · linked $rel → $src"
}

# Copy state files (workspaces should diverge state without mutating root).
# chmod 600 to keep secrets-in-state out of group-readable mode.
copy_if_present() {
  local rel="$1"
  local src="$ROOT/$rel"
  local dst="$WORK/$rel"
  [[ -f "$src" ]] || return 0
  [[ -e "$dst" || -L "$dst" ]] && return 0
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  chmod 600 "$dst" 2>/dev/null || true
  echo "  · copied $rel"
}

# --- 3. Symlink env / secret files ------------------------------------------
log "Linking org environment files from root checkout"
shopt -s nullglob
for env_file in "$ROOT"/.env "$ROOT"/.env.*; do
  [[ -e "$env_file" ]] || continue
  env_name="$(basename "$env_file")"
  [[ "$env_name" == ".env.example" ]] && continue
  link_secret_if_present "$env_name"
done
shopt -u nullglob

# --- 4. Copy state files ----------------------------------------------------
# .vapi-state.<org>.json is tracked in git (worktrees inherit it automatically),
# but copy any untracked variants too. `npm run pull` rewrites these locally —
# copying lets a worktree experiment without touching root.
log "Copying Vapi GitOps state files from root checkout"
shopt -s nullglob
for state_file in "$ROOT"/.vapi-state*.json; do
  [[ -e "$state_file" ]] || continue
  copy_if_present "$(basename "$state_file")"
done
shopt -u nullglob

# --- 5. Optional local ignore / notes files ---------------------------------
log "Copying optional local files"
for f in \
  .vapi-ignore \
  .vapi-ignore.local \
  resources/.vapi-ignore \
  'requested improvements.md'
do
  copy_if_present "$f"
done

# --- 6. Dependencies (lockfile-aware) ---------------------------------------
install_dependencies() {
  if [[ ! -f package.json ]]; then
    warn "No package.json found; skipping dependency install."
    return 0
  fi

  if [[ -f pnpm-lock.yaml ]]; then
    if ! command -v pnpm >/dev/null 2>&1; then
      if command -v corepack >/dev/null 2>&1; then
        corepack enable
        corepack prepare pnpm@latest --activate
      else
        npm install -g pnpm
      fi
    fi
    pnpm install --frozen-lockfile
    return 0
  fi

  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
    return 0
  fi

  npm install --no-audit --no-fund
}

# Hardlink first if root has node_modules and workspace doesn't — saves the
# install entirely on a fast SSD; rsync falls back to a real copy for any
# file that differs (e.g. native binaries that vary by arch).
if [[ ! -d "$WORK/node_modules" || -z "$(ls -A "$WORK/node_modules" 2>/dev/null)" ]]; then
  if [[ -d "$ROOT/node_modules" && -n "$(ls -A "$ROOT/node_modules" 2>/dev/null)" ]]; then
    log "Hardlinking node_modules from root (instant)"
    mkdir -p "$WORK/node_modules"
    rsync -a --link-dest="$ROOT/node_modules/" "$ROOT/node_modules/" "$WORK/node_modules/"
  else
    log "Installing dependencies"
    install_dependencies
  fi
else
  log "node_modules already populated, skipping install"
fi

# --- 7. Build verification (non-fatal) --------------------------------------
# Surfaces TypeScript errors at workspace creation rather than at the first
# `npm run push`. Runs `tsc --noEmit` via the repo's "build" script.
# Non-fatal: most operational commands (pull/push/call) use tsx and do not
# require a clean `tsc --noEmit`, so a TS error shouldn't gate the workspace.
log "Verifying TypeScript build when available"
if [[ -f package.json ]] && node -e "const s=require('./package.json').scripts||{};process.exit(s.build?0:1)" 2>/dev/null; then
  if npm run build; then
    echo "  · build verification passed"
  else
    warn "build verification FAILED — workspace is still usable for npm run pull/push/call,"
    warn "but \`npm run build\` has TypeScript errors. Investigate before merging."
  fi
else
  echo "No build script found; skipping."
fi

# --- 8. Done ----------------------------------------------------------------
log "Setup complete"
cat <<'INFO'
Common commands in this workspace:
  npm run pull     # sync state from Vapi (writes .vapi-state.<org>.json)
  npm run push     # push local resources to Vapi
  npm run call     # interactive test call against an assistant or squad
  npm test         # repo tests
INFO

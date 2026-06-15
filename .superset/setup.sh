#!/usr/bin/env bash
# Superset workspace setup for gitops.
#
# Adapted from the Supacode gitops-amazon3p setup template because no canonical
# gitops Supacode script exists.
# Adapted to Superset's environment variables:
#   SUPERSET_ROOT_PATH       source checkout
#   SUPERSET_WORKSPACE_PATH  new workspace worktree
#   SUPERSET_WORKSPACE_NAME  workspace slug
#
# This repo is a Vapi GitOps CLI/state-file project. Setup keeps new workspaces
# close to the source checkout by refreshing main when safe, linking local env
# files, copying Vapi state files, bootstrapping npm dependencies, and running a
# non-fatal TypeScript build check.

set -euo pipefail

log()  { printf "\n==> %s\n" "$*"; }
warn() { printf "WARN: %s\n" "$*" >&2; }

# --- 1. Resolve ROOT and WORK -----------------------------------------------
WORK="${SUPERSET_WORKSPACE_PATH:-$PWD}"
ROOT="${SUPERSET_ROOT_PATH:-}"

if [[ -z "$ROOT" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "$WORK" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ROOT="$(git -C "$WORK" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
  fi
fi

if [[ -z "$ROOT" || ! -d "$ROOT" ]]; then
  warn "could not resolve source checkout (SUPERSET_ROOT_PATH unset and not in a git worktree); aborting"
  exit 1
fi

if [[ "$ROOT" == "$WORK" ]]; then
  log "root and workspace are identical; nothing to do"
  exit 0
fi

cd "$WORK"
REPO_NAME="$(basename "$WORK")"

# --- 2. PATH hardening (non-interactive shell — .zshrc is NOT sourced) ------
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/Library/pnpm:${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$HOME/.local/bin:$HOME/.deno/bin:$PATH"
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash 2>/dev/null || true)"

log "Setting up Superset workspace for $REPO_NAME"
log "  root=$ROOT"
log "  work=$WORK"

# --- 3. Refresh main BEFORE any file copies.
# Superset branches new workspaces off the LOCAL primary checkout's HEAD,
# which can be stale. Worktrees share .git with the primary, so a single
# fetch updates `origin/main` for both. We then:
#   3a. Fast-forward ROOT's local main (so the NEXT workspace you spin up
#       branches from fresh main, not whatever main was when root was last
#       pulled).
#   3b. Rebase THIS workspace's branch onto fresh origin/main, but only
#       when it has zero commits beyond origin/main (the "just spawned, no
#       work yet" case). If the user has already committed, leave their
#       work alone.
# All operations are non-fatal — a transient fetch failure or a
# diverged-main edge case must NOT gate workspace creation.
log "Refreshing main (root checkout + this workspace) before copying files"
if git -C "$WORK" fetch --quiet origin main 2>/dev/null; then
  # 3a. Fast-forward root's local main when safe.
  root_branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  if [[ "$root_branch" == "main" ]]; then
    if [[ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
      if git -C "$ROOT" merge --ff-only origin/main 2>/dev/null; then
        echo "  · root's main fast-forwarded to origin/main"
      else
        warn "root's main has diverged from origin/main; leaving alone"
      fi
    else
      warn "root has uncommitted changes on main; skipping ff-merge of root's main"
    fi
  else
    # Root is on a feature branch — refspec ff-update without checkout.
    # Fails (→ warn) if main is checked out in another worktree or diverged.
    if git -C "$ROOT" fetch --quiet origin main:main 2>/dev/null; then
      echo "  · root's local main fast-forwarded to origin/main (root is on $root_branch)"
    else
      warn "could not ff-update root's main (checked out elsewhere or diverged); continuing"
    fi
  fi

  # 3b. Auto-rebase this workspace if it's pristine.
  current_branch="$(git -C "$WORK" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  if [[ "$current_branch" != "main" && "$current_branch" != "HEAD" ]]; then
    ahead="$(git -C "$WORK" rev-list --count "origin/main..$current_branch" 2>/dev/null || echo 1)"
    if [[ "$ahead" == "0" ]]; then
      log "Branch '$current_branch' has no commits beyond origin/main; rebasing onto fresh origin/main"
      git -C "$WORK" rebase origin/main || warn "rebase failed — resolve manually with 'git rebase origin/main'"
    else
      echo "  · branch '$current_branch' has $ahead commit(s) beyond origin/main; leaving baseline alone"
    fi
  fi
else
  warn "git fetch origin main failed; continuing with whatever HEAD pointed at"
fi

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

# --- 4. Symlink env / secret files ------------------------------------------
log "Linking org environment files from root checkout"
shopt -s nullglob
for env_file in "$ROOT"/.env "$ROOT"/.env.*; do
  [[ -e "$env_file" ]] || continue
  env_name="$(basename "$env_file")"
  [[ "$env_name" == ".env.example" ]] && continue
  link_secret_if_present "$env_name"
done
shopt -u nullglob

# --- 5. Copy state files ----------------------------------------------------
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

# --- 6. Optional local ignore / notes files ---------------------------------
log "Copying optional local files"
for f in \
  .vapi-ignore \
  .vapi-ignore.local \
  resources/.vapi-ignore \
  'requested improvements.md'
do
  copy_if_present "$f"
done

# --- 7. Dependencies (lockfile-aware) ---------------------------------------
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

# --- 8. Build verification (non-fatal) --------------------------------------
# Surfaces TypeScript errors at workspace creation rather than at the first
# `npm run push`. Non-fatal: most operational commands (pull/push/call) use
# tsx and don't require a clean `tsc --noEmit`, so a TS error shouldn't gate
# the workspace.
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

# --- 9. Done ----------------------------------------------------------------
log "Setup complete"
cat <<'INFO'
Common commands in this workspace:
  npm run pull     # sync state from Vapi (writes .vapi-state.<org>.json)
  npm run push     # push local resources to Vapi
  npm run call     # interactive test call against an assistant or squad
  npm test         # repo tests
INFO

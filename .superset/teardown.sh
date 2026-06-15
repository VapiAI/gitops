#!/usr/bin/env bash
# Superset workspace teardown for gitops.
#
# Adapted from the Supacode gitops-amazon3p setup template because no canonical
# gitops Supacode script exists.
# Superset runs this before deleting a workspace. The script only cleans local
# workspace artifacts (caches, build outputs, .DS_Store, and bulky .context/
# files). It intentionally does not delete Vapi dashboard resources.

set -euo pipefail

# Belt-and-suspenders: non-interactive shells under Superset sometimes
# inherit a PATH without /bin or /sbin.
export PATH="/bin:/sbin:/usr/bin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin:${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"

log() { printf "\n==> %s\n" "$*"; }

# NOTE: variables named `target`, never `path`. Under zsh, $path (lowercase
# array) is tied to $PATH (scalar) — a `local path=` or `for path in` loop
# silently clobbers $PATH and the next external command fails with
# "command not found". Bash treats them as independent.
remove_target() {
  local target="$1"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "  · removing ${target#"$WORK/"}"
    rm -rf "$target"
  fi
}

WORK="${SUPERSET_WORKSPACE_PATH:-$PWD}"
NAME="${SUPERSET_WORKSPACE_NAME:-unknown}"
cd "$WORK"

# Refuse to clean unsafe paths.
if [ "$WORK" = "/" ] || [ "$WORK" = "$HOME" ]; then
  echo "Refusing to clean unsafe workspace path: $WORK" >&2
  exit 1
fi

log "Teardown cleanup for workspace: $NAME"

# --- 1. Prune .context/ — this is what survives into archived-contexts/ -----
# Keep prose (md/txt/json), drop binaries and large generated outputs.
if [ -d "$WORK/.context" ]; then
  log "Pruning .context/ generated artifacts"
  find "$WORK/.context" \
    \( -type d \( -name 'probe-out*' -o -name 'probe_out*' -o -name 'tmp' -o -name 'cache' \) -prune -exec rm -rf {} + \) -o \
    \( -type f \( \
        -name '*.wav' -o -name '*.mp3' -o -name '*.flac' -o -name '*.opus' -o \
        -name '*.mp4' -o -name '*.mov' -o -name '*.avi' -o \
        -name '*.tar.gz' -o -name '*.tgz' -o -name '*.zip' -o -name '*.7z' -o \
        -name '*.rdb' -o -name '*.dump' -o -name '*.bin' -o -name '*.log' \
    \) -delete \) -o \
    \( -type f -size +10M -not -name '*.md' -not -name '*.txt' -not -name '*.json' -delete \)
  # Drop empty dirs left behind.
  find "$WORK/.context" -type d -empty -delete 2>/dev/null || true
fi

# --- 2. Strip .DS_Store recursively -----------------------------------------
log "Removing .DS_Store"
find "$WORK" -path "$WORK/.git" -prune -o -name '.DS_Store' -type f -print -delete 2>/dev/null || true

# --- 3. Drop common build/test/cache artifacts at the worktree root ---------
# Mostly redundant (Superset deletes the worktree right after this), but
# useful when teardown.sh is invoked manually for housekeeping.
log "Removing build/test/cache artifacts"
find "$WORK" \
  -path "$WORK/.git" -prune -o \
  -type d \( -name node_modules -o -name dist -o -name build -o -name coverage \
            -o -name .nyc_output -o -name .turbo -o -name .vite -o -name .next \
            -o -name .cache -o -name __pycache__ -o -name .pytest_cache \
            -o -name target \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$WORK" -path "$WORK/.git" -prune -o -type f -name '*.tsbuildinfo' -delete 2>/dev/null || true

# --- 4. Top-level scratch ---------------------------------------------------
for target in \
  "$WORK/dump.rdb" \
  "$WORK/.tsbuildinfo"; do
  remove_target "$target"
done

# --- 5. Resource-specific cleanup -------------------------------------------
# This repo has no ngrok/docker/branch-DB-schemas keyed off $NAME, so nothing
# to do here. (If we ever add per-workspace simulation snapshots in
# .context/probe-out, section 1 already prunes them.)

log "Teardown cleanup complete"
du -sh "$WORK" 2>/dev/null || true

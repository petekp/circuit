#!/usr/bin/env bash
# sync-to-cache.sh -- Copy local plugin files to the Claude Code plugin cache
#
# Run this after making local changes to see them take effect immediately
# across all projects (after /clear). No publish or version bump needed.
#
# Usage: ./scripts/sync-to-cache.sh

set -euo pipefail

PLUGIN_ROOT="${CIRCUIT_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
CACHE_BASE="${CLAUDE_PLUGIN_CACHE_DIR:-$HOME/.claude/plugins/cache/petekp}"
MARKETPLACE_DIR="${CLAUDE_PLUGIN_MARKETPLACE_DIR:-$HOME/.claude/plugins/marketplaces/petekp}"
RSYNC_ARGS=(-a --checksum --delete --exclude '.vite/')
LIST_SURFACE_ROOTS="$PLUGIN_ROOT/scripts/runtime/bin/list-installed-surface-roots.js"

CACHE_DIRS=()
if [[ -d "${CACHE_BASE}/circuit" ]]; then
  CACHE_DIRS+=("${CACHE_BASE}/circuit")
fi

installed_surface_roots_cache=()
REPO_SURFACE_PATHS=()

load_installed_surface_roots() {
  if [[ "${#installed_surface_roots_cache[@]}" -gt 0 ]]; then
    return 0
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    installed_surface_roots_cache+=("$line")
  done < <("$NODE_BIN" "$LIST_SURFACE_ROOTS")

  if [[ "${#installed_surface_roots_cache[@]}" -eq 0 ]]; then
    printf 'ERROR: installed surface roots CLI returned no roots\n' >&2
    return 1
  fi
}

load_repo_surface_paths() {
  if [[ "${#REPO_SURFACE_PATHS[@]}" -gt 0 ]]; then
    return 0
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    REPO_SURFACE_PATHS+=("$line")
  done < <("$NODE_BIN" "$LIST_SURFACE_ROOTS" --repo-paths)

  if [[ "${#REPO_SURFACE_PATHS[@]}" -eq 0 ]]; then
    printf 'ERROR: installed surface roots CLI returned no repo paths\n' >&2
    return 1
  fi
}

array_contains() {
  local needle="$1"
  shift

  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done

  return 1
}

prune_cache_target() {
  local target="$1"
  local path
  local name

  load_installed_surface_roots || return 1

  while IFS= read -r -d '' path; do
    name="${path##*/}"
    if array_contains "$name" "${installed_surface_roots_cache[@]}"; then
      continue
    fi

    rm -rf "$path" || return 1
  done < <(find "$target" -mindepth 1 -maxdepth 1 -print0)
}

sync_installed_script_surface() {
  local target="$1"
  local rel_path
  local source_path
  local target_path

  load_repo_surface_paths || return 1

  rm -rf "$target/scripts" || return 1
  mkdir -p "$target/scripts" || return 1

  for rel_path in "${REPO_SURFACE_PATHS[@]}"; do
    if [[ "$rel_path" != scripts/* ]]; then
      continue
    fi

    source_path="$PLUGIN_ROOT/$rel_path"
    target_path="$target/$rel_path"

    if [[ -d "$source_path" ]]; then
      mkdir -p "$target_path" || return 1
      rsync "${RSYNC_ARGS[@]}" "$source_path/" "$target_path/" || return 1
      continue
    fi

    if [[ -f "$source_path" ]]; then
      mkdir -p "$(dirname "$target_path")" || return 1
      rsync "${RSYNC_ARGS[@]}" "$source_path" "$target_path" || return 1
      continue
    fi

    rm -rf "$target_path" || return 1
  done
}

sync_target() {
  local label="$1"
  local target="$2"

  if [[ ! -d "$target" ]]; then
    printf 'Skipping missing %s target at %s\n' "$label" "$target"
    return 1
  fi

  printf 'Syncing local -> %s (%s)\n' "$label" "$target"

  if [[ "$label" == "cache" ]]; then
    # Cache targets should only contain plugin-install artifacts. If a prior
    # install or sync dumped the whole repo into cache, remove that cruft so
    # Claude resolves only the plugin surface.
    prune_cache_target "$target" || return 1
  fi

  mkdir -p "$target/hooks" "$target/skills" "$target/.claude-plugin" || return 1

  # Sync hooks
  rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/hooks/" "$target/hooks/" || return 1
  chmod +x "$target/hooks/session-start.sh" || return 1

  # Sync skills and remove directories that no longer exist in source.
  rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/skills/" "$target/skills/" || return 1

  # Sync command shims and remove files that no longer exist in source.
  if [[ -d "$PLUGIN_ROOT/commands" ]]; then
    mkdir -p "$target/commands" || return 1
    rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/commands/" "$target/commands/" || return 1
  else
    rm -rf "$target/commands" || return 1
  fi

  # Sync all plugin metadata (plugin.json + marketplace.json).
  # marketplace.json controls plugin identity for namespacing; if it drifts
  # from plugin.json, Claude Code can lose the /circuit: namespace prefix.
  rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/.claude-plugin/" "$target/.claude-plugin/" || return 1

  sync_installed_script_surface "$target" || return 1

  # Sync schemas (required by bundled engine CLIs for event/state validation).
  if [[ -d "$PLUGIN_ROOT/schemas" ]]; then
    mkdir -p "$target/schemas" || return 1
    rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/schemas/" "$target/schemas/" || return 1
  else
    rm -rf "$target/schemas" || return 1
  fi

  # Sync the example config users are pointed to in the README.
  if [[ -f "$PLUGIN_ROOT/circuit.config.example.yaml" ]]; then
    rsync "${RSYNC_ARGS[@]}" \
      "$PLUGIN_ROOT/circuit.config.example.yaml" \
      "$target/circuit.config.example.yaml" || return 1
  else
    rm -f "$target/circuit.config.example.yaml" || return 1
  fi

  if [[ "$label" == "marketplace" && -d "$target/.git" ]]; then
    # Claude Code resolves marketplace skills through the git index of this
    # clone.  If the index is stale (e.g. stuck on an old commit after a major
    # refactor), new/renamed skill directories appear as "untracked" and the
    # slash-command picker silently drops them.
    #
    # Stage and commit the synced files so git status stays clean.  Do NOT
    # git-reset to origin/main -- that pulls the entire repo (tests, .claude/,
    # docs/) into the marketplace dir, which can confuse the plugin loader and
    # break namespace resolution.
    (
      cd "$target"
      if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
        git add -A && git commit -m "sync from local dev" --quiet 2>/dev/null || {
          printf 'ERROR: marketplace git commit failed (git identity may not be configured)\n' >&2
          printf 'Fix: git -C "%s" config user.name "circuit" && git -C "%s" config user.email "circuit@local"\n' "$target" "$target" >&2
          return 1
        }
      fi
    )
  fi

  return 0
}

synced_any=0
synced_cache=0

# Sync to every cached version under each name (avoids ghost-version misrouting)
for cache_dir in "${CACHE_DIRS[@]}"; do
  while IFS= read -r -d '' version_dir; do
    sync_target cache "$version_dir"
    synced_any=1
    synced_cache=1
  done < <(find "$cache_dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
done

if [[ "$synced_cache" -eq 0 ]]; then
  printf 'No cached versions found under %s/circuit\n' "$CACHE_BASE"
fi

if [[ -d "$MARKETPLACE_DIR" ]]; then
  sync_target marketplace "$MARKETPLACE_DIR"
  synced_any=1
else
  printf 'Skipping missing marketplace target at %s\n' "$MARKETPLACE_DIR"
fi

if [[ "$synced_any" -eq 0 ]]; then
  printf 'No Claude plugin targets were available.\n' >&2
  printf 'Install circuit with:\n' >&2
  printf '/plugin marketplace add petekp/circuit\n' >&2
  printf '/plugin install circuit@petekp\n' >&2
  exit 1
fi

printf 'Done. /reload-plugins to pick up changes mid-session, or /clear for a fresh start.\n'

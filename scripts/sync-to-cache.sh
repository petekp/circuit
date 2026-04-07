#!/usr/bin/env bash
# sync-to-cache.sh -- Copy local plugin files to the Claude Code plugin cache
#
# Run this after making local changes to see them take effect immediately
# across all projects (after /clear). No publish or version bump needed.
#
# Usage: ./scripts/sync-to-cache.sh

set -euo pipefail

PLUGIN_ROOT="${CIRCUIT_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CACHE_BASE="${CLAUDE_PLUGIN_CACHE_DIR:-$HOME/.claude/plugins/cache/petekp}"
MARKETPLACE_DIR="${CLAUDE_PLUGIN_MARKETPLACE_DIR:-$HOME/.claude/plugins/marketplaces/petekp}"
RSYNC_ARGS=(-a --checksum --delete)

CACHE_DIRS=()
if [[ -d "${CACHE_BASE}/circuit" ]]; then
  CACHE_DIRS+=("${CACHE_BASE}/circuit")
fi

prune_cache_target() {
  local target="$1"
  local path
  local name

  while IFS= read -r -d '' path; do
    name="${path##*/}"
    case "$name" in
      .claude-plugin|commands|hooks|schemas|scripts|skills) ;;
      *)
        rm -rf "$path" || return 1
        ;;
    esac
  done < <(find "$target" -mindepth 1 -maxdepth 1 -print0)
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

  # Sync scripts if the plugin ships them locally.
  if [[ -d "$PLUGIN_ROOT/scripts" ]]; then
    mkdir -p "$target/scripts" || return 1
    rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/scripts/" "$target/scripts/" || return 1
  else
    rm -rf "$target/scripts" || return 1
  fi

  # Sync schemas (required by bundled engine CLIs for event/state validation).
  if [[ -d "$PLUGIN_ROOT/schemas" ]]; then
    mkdir -p "$target/schemas" || return 1
    rsync "${RSYNC_ARGS[@]}" "$PLUGIN_ROOT/schemas/" "$target/schemas/" || return 1
  else
    rm -rf "$target/schemas" || return 1
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

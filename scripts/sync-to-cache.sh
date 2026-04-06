#!/usr/bin/env bash
# sync-to-cache.sh -- Copy local plugin files to the Claude Code plugin cache
#
# Run this after making local changes to see them take effect immediately
# across all projects (after /clear). No publish or version bump needed.
#
# Usage: ./scripts/sync-to-cache.sh

set -euo pipefail

PLUGIN_ROOT="${CIRCUITRY_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CACHE_DIR="${CLAUDE_PLUGIN_CACHE_DIR:-$HOME/.claude/plugins/cache/petekp/circuitry}"
MARKETPLACE_DIR="${CLAUDE_PLUGIN_MARKETPLACE_DIR:-$HOME/.claude/plugins/marketplaces/petekp}"

sync_target() {
  local label="$1"
  local target="$2"

  if [[ ! -d "$target" ]]; then
    printf 'Skipping missing %s target at %s\n' "$label" "$target"
    return 1
  fi

  printf 'Syncing local -> %s (%s)\n' "$label" "$target"

  mkdir -p "$target/hooks" "$target/skills" "$target/.claude-plugin"

  # Sync hooks
  cp "$PLUGIN_ROOT/hooks/hooks.json" "$target/hooks/hooks.json" || return 1
  cp "$PLUGIN_ROOT/hooks/session-start.sh" "$target/hooks/session-start.sh" || return 1
  chmod +x "$target/hooks/session-start.sh" || return 1

  # Sync skills and remove directories that no longer exist in source.
  rsync -a --delete "$PLUGIN_ROOT/skills/" "$target/skills/" || return 1

  # Sync plugin manifest
  cp "$PLUGIN_ROOT/.claude-plugin/plugin.json" "$target/.claude-plugin/plugin.json" || return 1

  # Sync scripts if the plugin ships them locally.
  if [[ -d "$PLUGIN_ROOT/scripts" ]]; then
    mkdir -p "$target/scripts" || return 1
    rsync -a "$PLUGIN_ROOT/scripts/" "$target/scripts/" || return 1
  fi

  # Sync schemas (required by bundled engine CLIs for event/state validation).
  if [[ -d "$PLUGIN_ROOT/schemas" ]]; then
    mkdir -p "$target/schemas" || return 1
    rsync -a "$PLUGIN_ROOT/schemas/" "$target/schemas/" || return 1
  fi

  return 0
}

synced_any=0
synced_cache=0

# Sync to every cached version (avoids ghost-version misrouting)
if [[ -d "$CACHE_DIR" ]]; then
  while IFS= read -r -d '' version_dir; do
    sync_target cache "$version_dir"
    synced_any=1
    synced_cache=1
  done < <(find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
fi

if [[ "$synced_cache" -eq 0 ]]; then
  printf 'No cached version found at %s\n' "$CACHE_DIR"
fi

if [[ -d "$MARKETPLACE_DIR" ]]; then
  sync_target marketplace "$MARKETPLACE_DIR"
  synced_any=1
else
  printf 'Skipping missing marketplace target at %s\n' "$MARKETPLACE_DIR"
fi

if [[ "$synced_any" -eq 0 ]]; then
  printf 'No Claude plugin targets were available.\n' >&2
  printf 'Install circuitry with:\n' >&2
  printf '/plugin marketplace add petekp/circuitry\n' >&2
  printf '/plugin install circuitry@petekp\n' >&2
  exit 1
fi

printf 'Done. /clear to pick up changes.\n'

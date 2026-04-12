# Circuit

## Plugin Cache Sync

After modifying any plugin file (`hooks/`, `skills/`, `scripts/`, `.claude-plugin/`), run `./scripts/sync-to-cache.sh` before finishing. Claude Code runs the cached copy at `~/.claude/plugins/cache/`, not the local repo. Without syncing, changes exist only in git.

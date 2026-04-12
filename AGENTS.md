# Circuit

## Plugin Cache Sync

After modifying any plugin file (`hooks/`, `skills/`, `scripts/`, `.Codex-plugin/`), run `./scripts/sync-to-cache.sh` before finishing. Codex runs the cached copy at `~/.Codex/plugins/cache/`, not the local repo. Without syncing, changes exist only in git.

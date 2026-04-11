#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
CLI_PATH="$PLUGIN_ROOT/scripts/runtime/bin/session-start.js"

exec "$NODE_BIN" "$CLI_PATH"

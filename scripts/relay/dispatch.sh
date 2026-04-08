#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DISPATCH_CLI="$PLUGIN_ROOT/scripts/runtime/bin/dispatch.js"
NODE_BIN="${NODE_BIN:-node}"

if [[ ! -f "$DISPATCH_CLI" ]]; then
  echo "circuit: dispatch CLI not found at $DISPATCH_CLI" >&2
  exit 1
fi

exec "$NODE_BIN" "$DISPATCH_CLI" "$@"

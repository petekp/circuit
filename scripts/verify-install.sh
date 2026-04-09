#!/usr/bin/env bash
# verify-install.sh -- Validate Circuit's shipped install surface and runtime.
#
# Usage:
#   ./scripts/verify-install.sh [--mode repo|installed]

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
VERIFY_INSTALL_CLI="$PLUGIN_ROOT/scripts/runtime/bin/verify-install.js"

MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      shift
      MODE="${1:-}"
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift || true
done

if [[ -z "$MODE" ]]; then
  if [[ -f "$PLUGIN_ROOT/CIRCUITS.md" ]]; then
    MODE="repo"
  else
    MODE="installed"
  fi
fi

if [[ "$MODE" != "repo" && "$MODE" != "installed" ]]; then
  printf 'circuit: --mode must be repo or installed\n' >&2
  exit 1
fi

printf 'Selected mode: %s\n' "$MODE"
"$NODE_BIN" "$VERIFY_INSTALL_CLI" \
  --plugin-root "$PLUGIN_ROOT" \
  --mode "$MODE"

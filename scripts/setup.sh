#!/usr/bin/env bash
# setup.sh — Initialize relay scripts in the current project
#
# Usage:
#   ./scripts/setup.sh [--target-dir <dir>]
#
# Copies relay scripts (compose-prompt.sh, update-batch.sh) into the target
# project's scripts/relay/ directory. This is needed because methods dispatch
# work via these scripts from the project root.
#
# If --target-dir is not provided, copies to the current working directory.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${PWD}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--target-dir <dir>]"
      echo ""
      echo "Copies relay scripts into <dir>/scripts/relay/"
      echo "Default <dir> is the current working directory."
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

RELAY_DIR="${TARGET_DIR}/scripts/relay"

echo "Setting up Circuit relay scripts..."
echo "  Source:  ${PLUGIN_ROOT}/scripts/relay/"
echo "  Target:  ${RELAY_DIR}/"

mkdir -p "${RELAY_DIR}"

cp "${PLUGIN_ROOT}/scripts/relay/compose-prompt.sh" "${RELAY_DIR}/compose-prompt.sh"
cp "${PLUGIN_ROOT}/scripts/relay/update-batch.sh" "${RELAY_DIR}/update-batch.sh"

chmod +x "${RELAY_DIR}/compose-prompt.sh"
chmod +x "${RELAY_DIR}/update-batch.sh"

echo ""
echo "Done. Relay scripts installed at ${RELAY_DIR}/"
echo ""
echo "Next steps:"
echo "  1. Ensure codex CLI is installed: npm install -g @openai/codex"
echo "  2. Create AGENTS.md in your project root (circuit skills will guide you)"
echo "  3. Invoke a circuit: /circuit:router <describe your task>"

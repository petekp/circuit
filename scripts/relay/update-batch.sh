#!/usr/bin/env bash
# update-batch.sh - Deterministic state mutation for workers batch.json
#
# Thin wrapper that delegates to the TypeScript engine CLI.
# All logic lives in scripts/runtime/engine/src/update-batch.ts.
#
# Usage:
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh --slice slice-001 --event attempt_started
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh --slice slice-001 --event impl_dispatched
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh --slice slice-001 --event review_clean
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh --event converge_complete
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh --validate
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh --rebuild
#
# Events:
#   attempt_started      - Record a worker attempt before dispatch
#   impl_dispatched      - Record a completed implementation report
#   review_clean         - Set slice status to "done", record verdict
#   review_rejected      - Increment review_rejections for the slice
#   converge_complete    - Set phase to "complete", converge slices to "done"
#   converge_failed      - Increment convergence_attempts
#   analytically_resolved - Slice resolved by analysis (no code change needed)
#   orchestrator_direct   - Orchestrator fixed directly (code changed, no worker)
#   add_slice             - Add a new slice (requires --task and --type)
#
# Options:
#   --slice ID         - Target slice ID (required for slice-level events)
#   --event EVENT      - State transition event (required unless --validate/--rebuild)
#   --report PATH      - Archive report file after update
#   --summary TEXT     - Brief note recorded in the slice
#   --task TEXT        - Task description (for add_slice)
#   --type TYPE        - Slice type: implement|review|converge (for add_slice)
#   --scope DIRS       - Comma-separated file_scope (optional for add_slice)
#   --skills LIST      - Comma-separated domain skills (optional for add_slice)
#   --verification CMD - Verification command; repeat to add multiple commands
#   --criteria TEXT    - Success criteria text (optional for add_slice)
#   --validate         - Check batch.json consistency, exit 0 if clean, 1 if drift
#   --rebuild          - Rebuild batch.json from <root>/plan.json + <root>/events.ndjson
#   --root DIR         - Relay state root (default: .circuitry/); derives batch.json,
#                        events.ndjson, plan.json, and archive/
#   --batch PATH       - Path to batch.json (default: <root>/batch.json). If used
#                        with --root, this overrides only batch.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec node "$PLUGIN_ROOT/scripts/runtime/bin/update-batch.js" "$@"

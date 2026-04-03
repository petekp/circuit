#!/usr/bin/env bash
# dispatch.sh — Backend-agnostic dispatch for Circuit workers
#
# Detects whether Codex CLI is available and dispatches accordingly.
# When Codex is installed, uses `codex exec --full-auto`.
# When Codex is not installed, emits an Agent tool invocation that the
# orchestrator (Claude) should execute directly.
#
# Usage:
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh --prompt <file> --output <file> [--backend codex|agent]
#
# Options:
#   --prompt FILE    — Assembled prompt file to send to the worker (required)
#   --output FILE    — Path where worker should write its last-message trace (required)
#   --backend MODE   — Force dispatch engine (optional; auto-detects if omitted)
#
#   Built-in engines:
#     codex   — Codex CLI (`codex exec --full-auto`)
#     agent   — Claude Code Agent tool (isolation: "worktree")
#
#   Custom engines:
#     Any other value is treated as a shell command. The prompt file is passed
#     as $1 and the expected output path as $2. Example:
#       --backend "gemini run"
#       --backend "claude -p"
#       --backend "./my-agent.sh"
#
# Exit codes:
#   0  — Dispatch succeeded; machine-readable JSON receipt on stdout
#   1  — Error (missing args, command not found, etc.)
#
# All backends emit a JSON receipt to stdout on success. The orchestrator
# parses this receipt to determine next steps:
#   - agent: receipt contains prompt content for an Agent tool call
#   - codex: receipt confirms dispatch and includes PID
#   - custom: receipt confirms dispatch with the command used

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
READ_CONFIG="$PLUGIN_ROOT/scripts/runtime/engine/src/cli/read-config.ts"

PROMPT=""
OUTPUT=""
BACKEND=""
CIRCUIT=""
ROLE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt)  PROMPT="$2"; shift 2 ;;
    --output)  OUTPUT="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --circuit) CIRCUIT="$2"; shift 2 ;;
    --role)    ROLE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROMPT" || -z "$OUTPUT" ]]; then
  echo "ERROR: --prompt and --output are required" >&2
  exit 1
fi

if [[ ! -f "$PROMPT" ]]; then
  echo "ERROR: prompt file not found: $PROMPT" >&2
  exit 1
fi

# Resolve dispatch engine: explicit flag > config per-circuit > config global > auto-detect
if [[ -z "$BACKEND" ]]; then
  # Check circuit.config.yaml for dispatch.per_circuit.<id> or dispatch.engine
  if [[ -n "$CIRCUIT" ]]; then
    per_circuit="$(npx tsx "$READ_CONFIG" --key "dispatch.per_circuit.$CIRCUIT" --fallback "" 2>/dev/null || true)"
    [[ -n "$per_circuit" ]] && BACKEND="$per_circuit"
  fi
  if [[ -z "$BACKEND" ]]; then
    global_engine="$(npx tsx "$READ_CONFIG" --key "dispatch.engine" --fallback "" 2>/dev/null || true)"
    [[ -n "$global_engine" && "$global_engine" != "auto" ]] && BACKEND="$global_engine"
  fi

  # Role-based backend resolution: --role flag > config roles > auto-detect
  if [[ -z "$BACKEND" && -n "$ROLE" ]]; then
    role_backend="$(npx tsx "$READ_CONFIG" --key "roles.$ROLE" --fallback "" 2>/dev/null || true)"
    [[ -n "$role_backend" ]] && BACKEND="$role_backend"
  fi
fi

# Fall back to auto-detection
if [[ -z "$BACKEND" ]]; then
  if command -v codex >/dev/null 2>&1; then
    BACKEND="codex"
  else
    BACKEND="agent"
  fi
fi

# extract_description: pull a short task description from the prompt file.
# Uses the first markdown heading (# ...) or falls back to the first non-empty line.
extract_description() {
  local file="$1"
  local heading
  heading="$(grep -m1 '^# ' "$file" 2>/dev/null | sed 's/^# //' || true)"
  if [[ -n "$heading" ]]; then
    echo "$heading"
    return
  fi
  # Fallback: first non-empty line
  grep -m1 '.' "$file" 2>/dev/null || echo "worker task"
}

# json_escape: escape a string for safe embedding in JSON.
# Handles backslashes, double quotes, newlines, tabs, and carriage returns.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

case "$BACKEND" in
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      echo "ERROR: --backend codex specified but codex CLI not found" >&2
      echo "Install with: npm install -g @openai/codex" >&2
      exit 1
    fi
    # Run codex in the background so we can capture its PID for the receipt.
    # Temporarily disable errexit so a non-zero codex exit doesn't skip our
    # error-reporting logic.
    cat "$PROMPT" | codex exec --full-auto -o "$OUTPUT" - &
    CODEX_PID=$!
    wait "$CODEX_PID" && CODEX_EXIT=0 || CODEX_EXIT=$?

    if (( CODEX_EXIT != 0 )); then
      echo "ERROR: codex exec exited with status $CODEX_EXIT" >&2
      exit 1
    fi

    ESCAPED_PROMPT="$(json_escape "$PROMPT")"
    ESCAPED_OUTPUT="$(json_escape "$OUTPUT")"

    cat <<EOF
{
  "backend": "codex",
  "status": "dispatched",
  "prompt_file": "${ESCAPED_PROMPT}",
  "output_file": "${ESCAPED_OUTPUT}",
  "pid": ${CODEX_PID}
}
EOF
    ;;

  agent)
    # Emit a structured JSON receipt the orchestrator can use directly to
    # construct an Agent tool call. No prose -- just machine-readable data.
    # Read prompt content preserving trailing newlines. Command substitution
    # strips trailing newlines, so we append a sentinel char and remove it.
    PROMPT_CONTENT="$(cat "$PROMPT"; printf x)"
    PROMPT_CONTENT="${PROMPT_CONTENT%x}"
    DESCRIPTION="$(extract_description "$PROMPT")"

    ESCAPED_PROMPT_FILE="$(json_escape "$PROMPT")"
    ESCAPED_OUTPUT_FILE="$(json_escape "$OUTPUT")"
    ESCAPED_DESCRIPTION="$(json_escape "$DESCRIPTION")"
    ESCAPED_PROMPT_CONTENT="$(json_escape "$PROMPT_CONTENT")"

    cat <<EOF
{
  "backend": "agent",
  "status": "ready",
  "prompt_file": "${ESCAPED_PROMPT_FILE}",
  "output_file": "${ESCAPED_OUTPUT_FILE}",
  "agent_params": {
    "description": "${ESCAPED_DESCRIPTION}",
    "prompt": "${ESCAPED_PROMPT_CONTENT}",
    "isolation": "worktree"
  }
}
EOF
    ;;

  *)
    # Treat any other value as a custom command.
    # The command receives the prompt file as $1 and output path as $2.
    CMD_NAME="${BACKEND%% *}"
    if ! command -v "$CMD_NAME" >/dev/null 2>&1 && [[ ! -x "$CMD_NAME" ]]; then
      echo "ERROR: custom dispatch engine not found: $CMD_NAME" >&2
      echo "Ensure the command exists and is executable." >&2
      exit 1
    fi
    $BACKEND "$PROMPT" "$OUTPUT" && CUSTOM_EXIT=0 || CUSTOM_EXIT=$?

    if (( CUSTOM_EXIT != 0 )); then
      echo "ERROR: custom backend '$BACKEND' exited with status $CUSTOM_EXIT" >&2
      exit 1
    fi

    ESCAPED_PROMPT="$(json_escape "$PROMPT")"
    ESCAPED_OUTPUT="$(json_escape "$OUTPUT")"
    ESCAPED_BACKEND="$(json_escape "$BACKEND")"

    cat <<EOF
{
  "backend": "custom",
  "command": "${ESCAPED_BACKEND}",
  "status": "dispatched",
  "prompt_file": "${ESCAPED_PROMPT}",
  "output_file": "${ESCAPED_OUTPUT}"
}
EOF
    ;;
esac

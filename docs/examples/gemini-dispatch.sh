#!/usr/bin/env bash
set -euo pipefail

# Example custom adapter wrapper for Circuit dispatch.
# Contract:
#   gemini-dispatch.sh [wrapper-flags...] PROMPT_FILE OUTPUT_FILE
#
# Circuit treats every non-built-in adapter as a wrapper executable and appends the
# prompt/output paths as the final two positional args. Adapt the final Gemini
# invocation to match the CLI you actually have installed.

MODEL="gemini-2.5-pro"

while [[ $# -gt 2 ]]; do
  case "$1" in
    --model)
      MODEL="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 [--model MODEL] PROMPT_FILE OUTPUT_FILE" >&2
  exit 1
fi

PROMPT_FILE="$1"
OUTPUT_FILE="$2"

# Example shape for CLIs that read the prompt from stdin and emit plain text to stdout.
# Replace `gemini` with the actual binary/flags used in your environment.
gemini --model "$MODEL" < "$PROMPT_FILE" > "$OUTPUT_FILE"

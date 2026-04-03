#!/usr/bin/env bash
# compose-prompt.sh — Assemble a worker prompt from header + skills + template
#
# Usage:
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh --header .circuitry/prompt-header.md --skills swift-apps,rust --out .circuitry/prompt.md
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh --header .circuitry/review-header.md --template review --out .circuitry/review-prompt.md
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh --header .circuitry/prompt-header.md --template implement --root /tmp/relay-root --out .circuitry/prompt.md
#   $CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh --header .circuitry/prompt-header.md --backend agent --out .circuitry/prompt.md
#
# Options:
#   --header FILE    — Task-specific header (required)
#   --skills LIST    — Comma-separated domain skill names (optional)
#   --circuit ID     — Circuit id for config-file skill lookup (optional, used when --skills is omitted)
#   --config FILE    — Path to circuit.config.yaml (optional, auto-discovered from ./circuit.config.yaml or ~/.claude/circuit.config.yaml)
#   --template NAME  — Template to append: implement, review, ship-review, converge (optional)
#   --root DIR       — Substitute literal {relay_root} tokens after assembly (optional unless placeholders are used)
#   --backend MODE   — Dispatch backend hint: "codex" or "agent" (optional; auto-detected if omitted)
#   --out FILE       — Output path (required)

set -euo pipefail

HEADER=""
SKILLS=""
CIRCUIT=""
CONFIG=""
TEMPLATE=""
ROOT=""
BACKEND=""
OUT=""

# Resolve SKILL_DIRS: ordered search path for domain skills.
# Domain skills (tdd, swift-apps, etc.) may live in any of these locations.
# The plugin's own skills/ dir contains circuit definitions, not domain skills,
# so ~/.claude/skills is always included as a fallback.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
READ_CONFIG="$PLUGIN_ROOT/scripts/runtime/engine/src/cli/read-config.ts"
SKILL_DIRS=()
if [[ -n "${CIRCUIT_PLUGIN_SKILL_DIR:-}" ]]; then
  SKILL_DIRS+=("$CIRCUIT_PLUGIN_SKILL_DIR")
fi
if [[ -d "$PLUGIN_ROOT/skills" ]]; then
  SKILL_DIRS+=("$PLUGIN_ROOT/skills")
fi
SKILL_DIRS+=("$HOME/.claude/skills")

# resolve_skill <name> — prints the SKILL.md path or returns 1
resolve_skill() {
  local name="$1"
  for dir in "${SKILL_DIRS[@]}"; do
    if [[ -f "$dir/$name/SKILL.md" ]]; then
      echo "$dir/$name/SKILL.md"
      return 0
    fi
  done
  return 1
}

# Resolve WORKERS_DIR: env var > script-local references/ dir >
# plugin-relative references/ dir > ~/.claude/skills
if [[ -n "${CIRCUIT_PLUGIN_WORKERS_DIR:-}" ]]; then
  WORKERS_DIR="$CIRCUIT_PLUGIN_WORKERS_DIR"
elif [[ -d "$SCRIPT_DIR/references" ]]; then
  WORKERS_DIR="$SCRIPT_DIR/references"
elif [[ -d "$PLUGIN_ROOT/skills/workers/references" ]]; then
  WORKERS_DIR="$PLUGIN_ROOT/skills/workers/references"
else
  WORKERS_DIR="$HOME/.claude/skills/workers/references"
fi

PLACEHOLDER_SOURCES=()

# Track which source files introduce placeholder tokens.
# Generalizes the old relay_root-only tracking so diagnostics can report
# which file introduced ANY unresolved placeholder.
track_placeholder_source() {
  local source_file="$1"
  local existing_source

  if [[ ! -f "$source_file" ]]; then
    return 0
  fi

  # Check if the file contains any {placeholder_name} tokens
  if ! grep -Eq '\{[a-z_][a-z0-9_.]*\}' "$source_file"; then
    return 0
  fi

  if (( ${#PLACEHOLDER_SOURCES[@]} > 0 )); then
    for existing_source in "${PLACEHOLDER_SOURCES[@]}"; do
      if [[ "$existing_source" == "$source_file" ]]; then
        return 0
      fi
    done
  fi

  PLACEHOLDER_SOURCES+=("$source_file")
}

apply_relay_root_substitution() {
  local out_file="$1"
  local relay_root="$2"
  local escaped_root
  local temp_file

  escaped_root="$(printf '%s' "$relay_root" | sed 's/[&|\\]/\\&/g')"
  temp_file="$(mktemp "${TMPDIR:-/tmp}/compose-prompt.XXXXXX")"

  sed "s|{relay_root}|$escaped_root|g" "$out_file" > "$temp_file"
  mv "$temp_file" "$out_file"
}

# Scan the assembled output for any remaining {placeholder} tokens that were
# not substituted. Skips content inside fenced code blocks (``` ... ```)
# because those may legitimately contain braces (JSON, YAML examples, etc.).
fail_if_unresolved_placeholders() {
  local out_file="$1"
  local in_fence=0
  local unresolved=()
  local line

  while IFS= read -r line; do
    # Toggle fence state on lines that start with ``` (with optional language tag)
    if [[ "$line" =~ ^'```' ]]; then
      if (( in_fence )); then
        in_fence=0
      else
        in_fence=1
      fi
      continue
    fi

    # Skip lines inside fenced code blocks
    if (( in_fence )); then
      continue
    fi

    # Match {placeholder_name} tokens (lowercase, underscores, dots, digits)
    # Uses grep -oE to extract all matches from the line
    local matches
    matches="$(echo "$line" | grep -oE '\{[a-z_][a-z0-9_.]*\}' 2>/dev/null || true)"
    if [[ -n "$matches" ]]; then
      while IFS= read -r token; do
        # Deduplicate
        local already_seen=0
        local existing
        for existing in "${unresolved[@]+"${unresolved[@]}"}"; do
          if [[ "$existing" == "$token" ]]; then
            already_seen=1
            break
          fi
        done
        if (( ! already_seen )); then
          unresolved+=("$token")
        fi
      done <<< "$matches"
    fi
  done < "$out_file"

  if (( ${#unresolved[@]} == 0 )); then
    return 0
  fi

  # Build source summary for diagnostics
  local source_file
  local source_names=()
  if (( ${#PLACEHOLDER_SOURCES[@]} > 0 )); then
    for source_file in "${PLACEHOLDER_SOURCES[@]}"; do
      local parent_dir
      parent_dir="$(basename "$(dirname "$source_file")")"
      local base
      base="$(basename "$source_file")"
      if [[ "$base" == "SKILL.md" ]]; then
        source_names+=("$parent_dir/$base")
      else
        source_names+=("$base")
      fi
    done
  fi

  local source_summary
  if [[ ${#source_names[@]} -gt 0 ]]; then
    local IFS=', '
    source_summary="${source_names[*]}"
  else
    source_summary="unknown source"
  fi

  local IFS=', '
  echo "ERROR: unresolved placeholder(s) remain in $out_file: ${unresolved[*]}; introduced by: $source_summary" >&2
  exit 1
}

append_section_file() {
  local out_file="$1"
  local section_file="$2"

  if [[ -f "$section_file" ]]; then
    track_placeholder_source "$section_file"
    printf '\n---\n' >> "$out_file"
    cat "$section_file" >> "$out_file"
  else
    echo "WARNING: file not found: $section_file" >&2
  fi
}

output_has_inline_relay() {
  local out_file="$1"

  grep -q '^### Files Changed$' "$out_file" &&
    grep -q '^### Tests Run$' "$out_file" &&
    grep -q '^### Completion Claim$' "$out_file"
}

is_blank_arg() {
  local value="$1"

  [[ -z "${value//[[:space:]]/}" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --header)   HEADER="$2"; shift 2 ;;
    --skills)   SKILLS="$2"; shift 2 ;;
    --circuit)  CIRCUIT="$2"; shift 2 ;;
    --config)   CONFIG="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    --root)     ROOT="$2"; shift 2 ;;
    --backend)  BACKEND="$2"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$HEADER" || -z "$OUT" ]]; then
  echo "ERROR: --header and --out are required" >&2
  exit 1
fi

if is_blank_arg "$HEADER"; then
  echo "ERROR: --header must be a non-empty, non-whitespace string" >&2
  exit 1
fi

if is_blank_arg "$OUT"; then
  echo "ERROR: --out must be a non-empty, non-whitespace string" >&2
  exit 1
fi

if [[ ! -f "$HEADER" ]]; then
  echo "ERROR: header file not found: $HEADER" >&2
  exit 1
fi

# Resolve skills from config file when --skills is not provided but --circuit is
if [[ -z "$SKILLS" && -n "$CIRCUIT" ]]; then
  # Auto-discover config file if --config not specified
  if [[ -z "$CONFIG" ]]; then
    if [[ -f "./circuit.config.yaml" ]]; then
      CONFIG="./circuit.config.yaml"
    elif [[ -f "$HOME/.claude/circuit.config.yaml" ]]; then
      CONFIG="$HOME/.claude/circuit.config.yaml"
    fi
  fi

  # Read skills from config if available
  if [[ -n "$CONFIG" && -f "$CONFIG" ]]; then
    # Extract skills for the given circuit id using basic YAML parsing
    # Supports format: circuits.<id>.skills: [skill1, skill2]
    # or: circuits.<id>.skills:\n  - skill1\n  - skill2
    CONFIG_SKILLS="$(npx tsx "$READ_CONFIG" --key "circuits.$CIRCUIT.skills" --fallback "" 2>/dev/null || true)"
    if [[ -n "$CONFIG_SKILLS" ]]; then
      SKILLS="$CONFIG_SKILLS"
    fi
  fi
fi

# Start with header
track_placeholder_source "$HEADER"
cp "$HEADER" "$OUT"

# Append domain skills
if [[ -n "$SKILLS" ]]; then
  IFS=',' read -ra SKILL_ARRAY <<< "$SKILLS"
  for skill in "${SKILL_ARRAY[@]}"; do
    if skill_file="$(resolve_skill "$skill")"; then
      track_placeholder_source "$skill_file"
      printf '\n---\n## Domain Guidance: %s\n\n' "$skill" >> "$OUT"
      cat "$skill_file" >> "$OUT"
    else
      echo "WARNING: skill not found: $skill (searched: ${SKILL_DIRS[*]})" >&2
    fi
  done
fi

# Append template
if [[ -n "$TEMPLATE" ]]; then
  if [[ "$TEMPLATE" == "review" || "$TEMPLATE" == "ship-review" || "$TEMPLATE" == "converge" ]]; then
    preamble_file="$WORKERS_DIR/review-preamble.md"
    if [[ -f "$preamble_file" ]]; then
      append_section_file "$OUT" "$preamble_file"
    fi
  fi

  template_file="$WORKERS_DIR/${TEMPLATE}-template.md"
  append_section_file "$OUT" "$template_file"
fi

# Legacy fallback: older templates rely on a separately appended relay protocol.
protocol_file="$WORKERS_DIR/relay-protocol.md"
if ! output_has_inline_relay "$OUT" && [[ -f "$protocol_file" ]]; then
  append_section_file "$OUT" "$protocol_file"
fi

if [[ -n "$ROOT" ]]; then
  apply_relay_root_substitution "$OUT" "$ROOT"
fi

fail_if_unresolved_placeholders "$OUT"

# Auto-detect backend if not specified
if [[ -z "$BACKEND" ]]; then
  if command -v codex >/dev/null 2>&1; then
    BACKEND="codex"
  else
    BACKEND="agent"
  fi
fi

# Emit backend hint as a metadata comment at the end of the composed prompt
printf '\n<!-- dispatch-backend: %s -->\n' "$BACKEND" >> "$OUT"

echo "Composed: $OUT ($(wc -l < "$OUT" | tr -d ' ') lines, backend=$BACKEND)"

#!/usr/bin/env bash
# verify-install.sh -- Check that all Circuitry plugin prerequisites are met
#
# Usage:
#   ./scripts/verify-install.sh
#
# Checks:
#   1. Node.js (required by the engine)
#   2. Engine CLIs (bundled, no build step)
#   3. Bash version
#   4. Skill directories
#   5. Relay scripts
#   6. compose-prompt.sh smoke test
#   7. Engine dev environment (contributors only)
#   8. Codex CLI (optional, faster parallelism)

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0
WARN=0

pass() {
  printf '  \033[32m✓\033[0m %s\n' "$1"
  (( PASS++ ))
}

fail() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  (( FAIL++ ))
}

warn() {
  printf '  \033[33m!\033[0m %s\n' "$1"
  (( WARN++ ))
}

section() {
  printf '\n\033[1m%s\033[0m\n' "$1"
}

# ── 1. Node.js (engine runtime) ────────────────────────────────────
section "Node.js"

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>&1)"
  pass "node found: $node_version (engine runtime)"
else
  fail "node not found -- required by the engine (scripts/runtime/bin/)"
fi

# ── 2. Engine CLIs (shipped bundles) ───────────────────────────────
section "Engine CLIs"

bin_dir="$PLUGIN_ROOT/scripts/runtime/bin"
for cli_name in append-event catalog-compiler derive-state resume update-batch; do
  cli_path="$bin_dir/${cli_name}.js"
  if [[ -f "$cli_path" ]]; then
    pass "engine CLI: ${cli_name}"
  else
    fail "engine CLI missing: ${cli_name} -- bundled CLIs should ship with the plugin at scripts/runtime/bin/"
  fi
done

# ── 3. Bash version ──────────────────────────────────────────────────
section "Bash version"

bash_version="${BASH_VERSINFO[0]:-0}"
if [[ "$bash_version" -ge 4 ]]; then
  pass "bash ${BASH_VERSION}"
else
  pass "bash ${BASH_VERSION} (relay scripts are compatible with bash 3.2+)"
fi

# ── 4. Skill directories ─────────────────────────────────────────────
section "Skill directories"

skill_count=0
while IFS= read -r -d '' skill_dir; do
  skill="$(basename "$skill_dir")"
  if [[ -f "$skill_dir/SKILL.md" ]]; then
    pass "$skill/"
    skill_count=$((skill_count + 1))
  else
    warn "$skill/ exists but missing SKILL.md"
  fi
done < <(find "$PLUGIN_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

if [[ $skill_count -eq 0 ]]; then
  fail "no skill directories found in $PLUGIN_ROOT/skills"
fi

# ── 5. Relay scripts ─────────────────────────────────────────────────
section "Relay scripts"

for script in compose-prompt.sh dispatch.sh update-batch.sh; do
  script_path="$PLUGIN_ROOT/scripts/relay/$script"
  if [[ -f "$script_path" ]]; then
    if [[ -x "$script_path" ]]; then
      pass "$script (exists, executable)"
    else
      fail "$script exists but is NOT executable -- run: chmod +x $script_path"
    fi
  else
    fail "$script not found at scripts/relay/$script"
  fi
done

# ── 6. compose-prompt.sh template smoke test ──────────────────────────
section "Template smoke test"

TEMPLATES_DIR="$PLUGIN_ROOT/skills/workers/references"
EXPECTED_TEMPLATES=(
  implement-template.md
  review-template.md
  review-preamble.md
  ship-review-template.md
  converge-template.md
  relay-protocol.md
)

templates_ok=true
for tmpl in "${EXPECTED_TEMPLATES[@]}"; do
  if [[ ! -f "$TEMPLATES_DIR/$tmpl" ]]; then
    fail "template missing: workers/references/$tmpl"
    templates_ok=false
  fi
done

if $templates_ok; then
  # Run a real smoke test: compose a prompt with a dummy header
  smoke_header="$(mktemp "${TMPDIR:-/tmp}/verify-header.XXXXXX")"
  smoke_out="$(mktemp "${TMPDIR:-/tmp}/verify-out.XXXXXX")"
  echo "# Smoke Test Header" > "$smoke_header"

  if "$PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
      --header "$smoke_header" \
      --template implement \
      --root /tmp/smoke-relay-root \
      --out "$smoke_out" >/dev/null 2>&1; then
    line_count="$(wc -l < "$smoke_out" | tr -d ' ')"
    pass "compose-prompt.sh smoke test passed ($line_count lines output)"
  else
    fail "compose-prompt.sh smoke test failed -- run manually to debug"
  fi

  rm -f "$smoke_header" "$smoke_out"
else
  warn "skipping compose-prompt.sh smoke test (templates missing)"
fi

# ── 7. Engine dev environment (contributors only) ─────────────────
section "Engine dev environment (contributors)"

engine_dir="$PLUGIN_ROOT/scripts/runtime/engine"
if [[ -d "$engine_dir/node_modules" ]]; then
  pass "engine node_modules installed (contributor)"
else
  warn "engine node_modules missing -- contributors run: cd $engine_dir && npm install"
fi

# ── 8. Codex CLI (optional -- Agent fallback available) ────────────────
section "Codex CLI (optional)"

if command -v codex >/dev/null 2>&1; then
  codex_version="$(codex --version 2>/dev/null || echo 'unknown')"
  pass "codex found: $codex_version (dispatch backend: codex)"
else
  warn "codex not found -- dispatch will use Agent fallback (install for better parallelism: npm install -g @openai/codex)"
fi

# ── Summary ───────────────────────────────────────────────────────────
printf '\n\033[1m── Summary ──\033[0m\n'
printf '  \033[32m%d passed\033[0m' "$PASS"
if [[ "$WARN" -gt 0 ]]; then
  printf '  \033[33m%d warnings\033[0m' "$WARN"
fi
if [[ "$FAIL" -gt 0 ]]; then
  printf '  \033[31m%d failed\033[0m' "$FAIL"
fi
printf '\n'

if [[ "$FAIL" -gt 0 ]]; then
  printf '\n\033[31mSome checks failed. Fix the issues above before using the Circuitry plugin.\033[0m\n'
  exit 1
else
  printf '\n\033[32mAll checks passed. Circuitry plugin is ready to use.\033[0m\n'
  exit 0
fi

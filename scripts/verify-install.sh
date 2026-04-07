#!/usr/bin/env bash
# verify-install.sh -- Check that all Circuit plugin prerequisites are met
#
# Usage:
#   ./scripts/verify-install.sh
#
# Checks:
#   1. Node.js (version 20+, required by the engine)
#   2. Engine CLIs (bundled, no build step)
#   3. Bash version
#   4. Hooks
#   5. Schemas
#   6. Skill directories
#   7. Relay scripts
#   8. compose-prompt.sh smoke test
#   9. Engine dev environment (contributors only)
#  10. Codex CLI (optional, faster parallelism)

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
  node_major="$(node -e "console.log(process.versions.node.split('.')[0])")"
  if [[ "$node_major" -ge 20 ]]; then
    pass "node $node_version (engine runtime)"
  else
    fail "node $node_version found, but 20+ required (engine targets node20)"
  fi
else
  fail "node not found -- required by the engine (scripts/runtime/bin/)"
fi

# ── 2. Engine CLIs (shipped bundles) ───────────────────────────────
section "Engine CLIs"

bin_dir="$PLUGIN_ROOT/scripts/runtime/bin"
for cli_name in append-event catalog-compiler derive-state read-config resume update-batch; do
  cli_path="$bin_dir/${cli_name}.js"
  if [[ -f "$cli_path" ]]; then
    pass "engine CLI: ${cli_name}"
  else
    fail "engine CLI missing: ${cli_name} -- bundled CLIs should ship with the plugin at scripts/runtime/bin/"
  fi
done

# ── 3. Hooks ────────────────────────────────────────────────────────
section "Hooks"

if [[ -f "$PLUGIN_ROOT/hooks/hooks.json" ]]; then
  pass "hooks.json"
else
  fail "hooks.json missing -- SessionStart hook will not run"
fi

if [[ -f "$PLUGIN_ROOT/hooks/session-start.sh" ]]; then
  if [[ -x "$PLUGIN_ROOT/hooks/session-start.sh" ]]; then
    pass "session-start.sh (exists, executable)"
  else
    fail "session-start.sh exists but is NOT executable -- run: chmod +x $PLUGIN_ROOT/hooks/session-start.sh"
  fi
else
  fail "session-start.sh missing -- handoff resume will not work"
fi

# ── 4. Schemas ──────────────────────────────────────────────────────
section "Schemas"

schemas_dir="$PLUGIN_ROOT/schemas"
if [[ -d "$schemas_dir" ]]; then
  schema_count=0
  for schema in "$schemas_dir"/*.schema.json; do
    [[ -f "$schema" ]] && schema_count=$((schema_count + 1))
  done
  if [[ $schema_count -gt 0 ]]; then
    pass "schemas/ found ($schema_count schema files)"
  else
    fail "schemas/ exists but contains no .schema.json files"
  fi
else
  fail "schemas/ missing -- engine CLIs will fail to validate events and state"
fi

# ── 5. Bash version ──────────────────────────────────────────────────
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

# ── 5. Command shims ──────────────────────────────────────────────────
section "Command shims"

commands_dir="$PLUGIN_ROOT/commands"
if [[ -d "$commands_dir" ]]; then
  # Every skill directory must have a matching command shim
  shim_count=0
  shim_missing=0
  while IFS= read -r -d '' skill_dir; do
    skill="$(basename "$skill_dir")"
    if [[ -f "$commands_dir/${skill}.md" ]]; then
      shim_count=$((shim_count + 1))
    else
      fail "skill $skill/ has no matching command shim at commands/${skill}.md"
      shim_missing=$((shim_missing + 1))
    fi
  done < <(find "$PLUGIN_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
  if [[ $shim_missing -eq 0 ]]; then
    pass "commands/ complete ($shim_count shims match $shim_count skills)"
  fi
else
  fail "commands/ directory not found -- slash-command picker will not show circuit commands"
fi

# ── 6. Config example ────────────────────────────────────────────────
section "Config example"

config_example="$PLUGIN_ROOT/circuit.config.example.yaml"
if [[ -f "$config_example" ]]; then
  # Check for known stale references
  stale_found=0
  if grep -q 'Circuit v3' "$config_example"; then
    fail "circuit.config.example.yaml still references 'Circuit v3'"
    stale_found=1
  fi
  if grep -q 'cleanup' "$config_example"; then
    fail "circuit.config.example.yaml still uses 'cleanup' (renamed to 'sweep')"
    stale_found=1
  fi
  if [[ $stale_found -eq 0 ]]; then
    pass "circuit.config.example.yaml (no stale references)"
  fi
else
  warn "circuit.config.example.yaml not found"
fi

# ── 7. Relay scripts ─────────────────────────────────────────────────
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

# ── 8. rsync (required by sync-to-cache.sh) ────────────────────────────
section "rsync"

if command -v rsync >/dev/null 2>&1; then
  pass "rsync found (required by sync-to-cache.sh)"
else
  warn "rsync not found -- sync-to-cache.sh will fail; install rsync for contributor workflow"
fi

# ── 9. Codex CLI (optional -- Agent fallback available) ────────────────
section "Codex CLI (optional)"

if command -v codex >/dev/null 2>&1; then
  codex_version="$(codex --version 2>/dev/null || echo 'unknown')"
  pass "codex found: $codex_version (dispatch backend: codex)"
else
  warn "codex not found -- dispatch will use Agent fallback (install for better parallelism: npm install -g @openai/codex)"
fi

# ── 9. Official plugin validation (requires claude CLI) ──────────────
section "Plugin validation (optional)"

if command -v claude >/dev/null 2>&1; then
  validate_output="$(claude plugin validate "$PLUGIN_ROOT" 2>&1)" || true
  if echo "$validate_output" | grep -q "Validation passed"; then
    pass "claude plugin validate passed"
  elif echo "$validate_output" | grep -q "warning"; then
    warn "claude plugin validate passed with warnings"
  else
    fail "claude plugin validate failed -- run manually to debug"
  fi
else
  warn "claude CLI not found -- skipping official plugin validation"
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
  printf '\n\033[31mSome checks failed. Fix the issues above before using the Circuit plugin.\033[0m\n'
  exit 1
else
  printf '\n\033[32mAll checks passed. Circuit plugin is ready to use.\033[0m\n'
  exit 0
fi

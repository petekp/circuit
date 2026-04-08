#!/usr/bin/env bash
# verify-install.sh -- Validate the shipped Circuit surface from the current
# plugin root. Designed to run from both the repo checkout and the installed
# plugin cache path.
#
# Usage:
#   ./scripts/verify-install.sh
#
# Coverage:
#   1. Node.js and bundled engine CLIs
#   2. Hooks, schemas, skill directories, and command shims
#   3. Relay script executability
#   4. Workers template composition across all supported templates
#   5. Placeholder rejection and warning-free prompt assembly
#   6. Config precedence (explicit > nearest project config > home)
#   7. Malformed config failure behavior
#   8. Bundled CLI round trips (append-event -> derive-state -> resume)
#   9. Stale-state rebuild and corrupted-state fail-loud behavior
#   10. Contributor helpers (`rsync`, optional Codex CLI)

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

READ_CONFIG="$PLUGIN_ROOT/scripts/runtime/bin/read-config.js"
APPEND_EVENT="$PLUGIN_ROOT/scripts/runtime/bin/append-event.js"
DERIVE_STATE="$PLUGIN_ROOT/scripts/runtime/bin/derive-state.js"
RESUME="$PLUGIN_ROOT/scripts/runtime/bin/resume.js"
COMPOSE_PROMPT="$PLUGIN_ROOT/scripts/relay/compose-prompt.sh"

PASS=0
FAIL=0
WARN=0
TMP_PATHS=()

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

new_temp_dir() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/circuit-verify.XXXXXX")"
  TMP_PATHS+=("$dir")
  printf '%s\n' "$dir"
}

new_temp_file() {
  local file
  file="$(mktemp "${TMPDIR:-/tmp}/circuit-verify.XXXXXX")"
  TMP_PATHS+=("$file")
  printf '%s\n' "$file"
}

cleanup() {
  local path
  for path in "${TMP_PATHS[@]+"${TMP_PATHS[@]}"}"; do
    rm -rf "$path"
  done
}
trap cleanup EXIT

write_test_manifest() {
  local run_root="$1"
  cat > "$run_root/circuit.manifest.yaml" <<'EOF'
schema_version: "2"
circuit:
  id: integration-test
  version: "2026-04-07"
  purpose: >
    Minimal manifest for verify-install round trips.
  entry:
    expert_command: /circuit:build
    signals:
      include: [feature]
      exclude: []
  entry_modes:
    default:
      start_at: frame
      description: Default test mode
  steps:
    - id: frame
      title: Frame
      executor: orchestrator
      kind: synthesis
      reads: [user.task]
      writes:
        artifact:
          path: artifacts/brief.md
          schema: brief@v1
      gate:
        kind: schema_sections
        source: artifacts/brief.md
        required: [Objective]
      routes:
        pass: "@complete"
EOF
}

# ── 1. Node.js ────────────────────────────────────────────────────────
section "Node.js"

if command -v "$NODE_BIN" >/dev/null 2>&1; then
  node_version="$("$NODE_BIN" --version 2>&1)"
  node_major="$("$NODE_BIN" -e "console.log(process.versions.node.split('.')[0])")"
  if [[ "$node_major" -ge 20 ]]; then
    pass "node $node_version (engine runtime)"
  else
    fail "node $node_version found, but 20+ required (engine targets node20)"
  fi
else
  fail "node not found -- required by the engine (scripts/runtime/bin/)"
fi

# ── 2. Engine CLIs ────────────────────────────────────────────────────
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

# ── 3. Hooks ──────────────────────────────────────────────────────────
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

# ── 4. Schemas ────────────────────────────────────────────────────────
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

# ── 5. Bash version ───────────────────────────────────────────────────
section "Bash version"

bash_version="${BASH_VERSINFO[0]:-0}"
if [[ "$bash_version" -ge 4 ]]; then
  pass "bash ${BASH_VERSION}"
else
  pass "bash ${BASH_VERSION} (relay scripts are compatible with bash 3.2+)"
fi

# ── 6. Skill directories ──────────────────────────────────────────────
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

# ── 7. Command shims ──────────────────────────────────────────────────
section "Command shims"

commands_dir="$PLUGIN_ROOT/commands"
public_commands_file="$PLUGIN_ROOT/.claude-plugin/public-commands.txt"
catalog_compiler="$PLUGIN_ROOT/scripts/runtime/bin/catalog-compiler.js"
if [[ -d "$commands_dir" ]]; then
  if [[ ! -f "$public_commands_file" ]]; then
    fail "public-commands.txt not found -- run catalog-compiler generate"
  elif [[ ! -f "$catalog_compiler" ]]; then
    fail "catalog-compiler.js not found -- cannot derive authoritative public command surface"
  else
    expected_surface_root="$(new_temp_dir)"
    mkdir -p \
      "$expected_surface_root/.claude-plugin" \
      "$expected_surface_root/commands" \
      "$expected_surface_root/skills" \
      "$expected_surface_root/scripts/runtime/bin"
    cp -R "$PLUGIN_ROOT/skills/." "$expected_surface_root/skills/"
    cp "$catalog_compiler" "$expected_surface_root/scripts/runtime/bin/catalog-compiler.js"
    cat > "$expected_surface_root/CIRCUITS.md" <<'EOF'
# Surface Verification Fixture

<!-- BEGIN CIRCUIT_TABLE -->
<!-- END CIRCUIT_TABLE -->

<!-- BEGIN UTILITY_TABLE -->
<!-- END UTILITY_TABLE -->

<!-- BEGIN ENTRY_MODES -->
<!-- END ENTRY_MODES -->
EOF

    if (
      cd "$expected_surface_root" && \
      "$NODE_BIN" "$expected_surface_root/scripts/runtime/bin/catalog-compiler.js" generate
    ) > /dev/null 2>&1; then
      surface_failures=0
      shim_count=0
      expected_public_commands_file="$expected_surface_root/.claude-plugin/public-commands.txt"

      if [[ ! -f "$expected_public_commands_file" ]]; then
        fail "authoritative catalog generation did not emit public-commands.txt"
        surface_failures=$((surface_failures + 1))
      elif ! cmp -s "$expected_public_commands_file" "$public_commands_file"; then
        fail "public-commands.txt does not match authoritative catalog output"
        surface_failures=$((surface_failures + 1))
      fi

      while IFS= read -r command; do
        [[ -z "$command" ]] && continue
        expected_shim="$expected_surface_root/commands/${command}.md"
        actual_shim="$commands_dir/${command}.md"
        if [[ ! -f "$actual_shim" ]]; then
          fail "public command $command has no shipped shim at commands/${command}.md"
          surface_failures=$((surface_failures + 1))
        elif ! cmp -s "$expected_shim" "$actual_shim"; then
          fail "public command shim commands/${command}.md does not match authoritative catalog output"
          surface_failures=$((surface_failures + 1))
        else
          shim_count=$((shim_count + 1))
        fi
      done < "$expected_public_commands_file"

      for shim_file in "$commands_dir"/*.md; do
        [[ -f "$shim_file" ]] || continue
        shim_name="$(basename "$shim_file" .md)"
        if [[ ! -f "$expected_surface_root/commands/${shim_name}.md" ]]; then
          fail "stale command shim commands/${shim_name}.md is outside the authoritative public command surface"
          surface_failures=$((surface_failures + 1))
        fi
      done

      if [[ $surface_failures -eq 0 ]]; then
        pass "commands/ and public-commands.txt match authoritative catalog output ($shim_count public commands)"
      fi
    else
      fail "authoritative catalog generation failed -- verify-install cannot prove public command freshness"
    fi
  fi
else
  fail "commands/ directory not found -- slash-command picker will not show circuit commands"
fi

# ── 8. Config example ─────────────────────────────────────────────────
section "Config example"

config_example="$PLUGIN_ROOT/circuit.config.example.yaml"
if [[ -f "$config_example" ]]; then
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

# ── 9. Relay scripts ──────────────────────────────────────────────────
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

# ── 10. Workers template composition ─────────────────────────────────
section "Workers template composition"

for template in implement review ship-review converge; do
  temp_root="$(new_temp_dir)"
  header="$temp_root/header.md"
  out="$temp_root/prompt.md"
  stderr_file="$(new_temp_file)"
  printf '# Template Check: %s\n' "$template" > "$header"

  if "$COMPOSE_PROMPT" \
      --header "$header" \
      --template "$template" \
      --root "$temp_root/relay-root" \
      --out "$out" > /dev/null 2> "$stderr_file"; then
    if [[ -s "$stderr_file" ]]; then
      fail "template $template emitted stderr output"
    elif grep -Eq '\{[a-z_][a-z0-9_.]*\}' "$out"; then
      fail "template $template leaked unresolved placeholders"
    else
      pass "template $template composed cleanly"
    fi
  else
    fail "template $template failed to compose"
  fi
done

# ── 11. Placeholder rejection ────────────────────────────────────────
section "Placeholder rejection"

placeholder_root="$(new_temp_dir)"
placeholder_header="$placeholder_root/header.md"
placeholder_out="$placeholder_root/prompt.md"
placeholder_stderr="$(new_temp_file)"
printf '# Bad Header\nUse {mystery_token}.\n' > "$placeholder_header"

if "$COMPOSE_PROMPT" \
    --header "$placeholder_header" \
    --out "$placeholder_out" > /dev/null 2> "$placeholder_stderr"; then
  fail "compose-prompt.sh accepted an unresolved placeholder outside a code fence"
else
  if grep -q '{mystery_token}' "$placeholder_stderr"; then
    pass "compose-prompt.sh rejects unresolved placeholders"
  else
    fail "compose-prompt.sh failed without naming the unresolved placeholder"
  fi
fi

# ── 12. Config precedence ─────────────────────────────────────────────
section "Config precedence"

config_root="$(new_temp_dir)"
config_home="$config_root/home"
config_repo="$config_root/repo"
config_nested="$config_repo/nested/deeper"
config_outside="$config_root/outside"
explicit_config="$config_root/explicit.yaml"
mkdir -p "$config_home/.claude" "$config_nested" "$config_outside"

cat > "$config_home/.claude/circuit.config.yaml" <<'EOF'
roles:
  implementer: home-role
EOF

cat > "$config_repo/circuit.config.yaml" <<'EOF'
roles:
  implementer: project-role
EOF

cat > "$explicit_config" <<'EOF'
roles:
  implementer: explicit-role
EOF

if git init -q "$config_repo" > /dev/null 2>&1; then
  :
fi

current_home_config="${HOME:-}/.claude/circuit.config.yaml"
if [[ -f "$current_home_config" ]]; then
  current_env_probe="$(new_temp_dir)"
  current_home_output="$(
    cd "$current_env_probe" && \
    HOME="${HOME:-}" \
    "$NODE_BIN" "$READ_CONFIG" \
      --key roles.implementer \
      --fallback auto 2>&1
  )"
  current_home_status=$?
  if [[ $current_home_status -eq 0 ]]; then
    pass "current HOME config parses cleanly"
  else
    fail "current HOME config failed to parse: $current_home_output"
  fi
else
  pass "no current HOME config present"
fi

explicit_output="$(
  HOME="$config_home" \
  "$NODE_BIN" "$READ_CONFIG" \
    --config "$explicit_config" \
    --key roles.implementer \
    --fallback auto 2>&1
)"
if [[ "$explicit_output" == "explicit-role" ]]; then
  pass "explicit config wins over project and home"
else
  fail "explicit config did not win over project and home"
fi

project_output="$(
  cd "$config_nested" && \
  HOME="$config_home" \
  "$NODE_BIN" "$READ_CONFIG" \
    --key roles.implementer \
    --fallback auto 2>&1
)"
if [[ "$project_output" == "project-role" ]]; then
  pass "nearest project config wins over home"
else
  fail "nearest project config did not win over home"
fi

home_output="$(
  cd "$config_outside" && \
  HOME="$config_home" \
  "$NODE_BIN" "$READ_CONFIG" \
    --key roles.implementer \
    --fallback auto 2>&1
)"
if [[ "$home_output" == "home-role" ]]; then
  pass "home config is used when no project config exists"
else
  fail "home config was not used outside a project"
fi

cat > "$config_repo/circuit.config.yaml" <<'EOF'
roles: [broken
EOF

malformed_output="$(
  cd "$config_nested" && \
  HOME="$config_home" \
  "$NODE_BIN" "$READ_CONFIG" \
    --key roles.implementer \
    --fallback auto 2>&1
)"
malformed_status=$?
if [[ $malformed_status -ne 0 ]] && printf '%s' "$malformed_output" | grep -q 'failed to parse'; then
  pass "malformed project config fails loudly"
else
  fail "malformed project config did not fail loudly"
fi

# ── 13. Bundled CLI round trips ──────────────────────────────────────
section "Bundled CLI round trips"

run_root="$(new_temp_dir)"
mkdir -p "$run_root/artifacts"
write_test_manifest "$run_root"

run_started_payload='{"manifest_path":"circuit.manifest.yaml","entry_mode":"default","head_at_start":"abc1234"}'
step_started_payload='{"step_id":"frame"}'

if "$NODE_BIN" "$APPEND_EVENT" "$run_root" run_started --payload "$run_started_payload" > /dev/null 2>&1; then
  pass "append-event records run_started"
else
  fail "append-event failed for run_started"
fi

if "$NODE_BIN" "$APPEND_EVENT" "$run_root" step_started --payload "$step_started_payload" --step-id frame --attempt 1 > /dev/null 2>&1; then
  pass "append-event records step_started"
else
  fail "append-event failed for step_started"
fi

if "$NODE_BIN" "$DERIVE_STATE" "$run_root" > /dev/null 2>&1; then
  pass "derive-state writes state.json"
else
  fail "derive-state failed to write state.json"
fi

resume_output="$("$NODE_BIN" "$RESUME" "$run_root" 2>&1)"
resume_status=$?
if [[ $resume_status -eq 0 ]] && \
   printf '%s' "$resume_output" | grep -q '"status": "in_progress"' && \
   printf '%s' "$resume_output" | grep -q '"resume_step": "frame"'; then
  pass "resume round trip returns the active step"
else
  fail "resume round trip did not return the active step"
fi

touch -t 202001010000 "$run_root/state.json"
stale_resume_output="$("$NODE_BIN" "$RESUME" "$run_root" 2>&1)"
stale_resume_status=$?
if [[ $stale_resume_status -eq 0 ]] && \
   printf '%s' "$stale_resume_output" | grep -q '"status": "in_progress"'; then
  pass "resume rebuilds stale state.json from events"
else
  fail "resume did not rebuild stale state.json"
fi

printf '{"status": "in_progr' > "$run_root/state.json"
bad_state_output="$("$NODE_BIN" "$RESUME" "$run_root" 2>&1)"
bad_state_status=$?
if [[ $bad_state_status -ne 0 ]] && \
   printf '%s' "$bad_state_output" | grep -Eq '"status":[[:space:]]*"error"' && \
   printf '%s' "$bad_state_output" | grep -q 'State load failed'; then
  pass "resume fails loudly on corrupted state"
else
  fail "resume did not fail loudly on corrupted state"
fi

# ── 14. Engine dev environment (contributors only) ───────────────────
section "Engine dev environment (contributors)"

engine_dir="$PLUGIN_ROOT/scripts/runtime/engine"
if [[ -d "$engine_dir/node_modules" ]]; then
  pass "engine node_modules installed (contributor)"
else
  warn "engine node_modules missing -- contributors run: cd $engine_dir && npm install"
fi

# ── 15. rsync ─────────────────────────────────────────────────────────
section "rsync"

if command -v rsync >/dev/null 2>&1; then
  pass "rsync found (required by sync-to-cache.sh)"
else
  warn "rsync not found -- sync-to-cache.sh will fail; install rsync for contributor workflow"
fi

# ── 16. Codex CLI (optional) ──────────────────────────────────────────
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
  printf '\n\033[31mSome checks failed. Fix the issues above before using the Circuit plugin.\033[0m\n'
  exit 1
else
  printf '\n\033[32mAll checks passed. Circuit plugin is ready to use.\033[0m\n'
  exit 0
fi

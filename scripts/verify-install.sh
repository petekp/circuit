#!/usr/bin/env bash
# verify-install.sh — Check that all Circuit plugin prerequisites are met
#
# Usage:
#   ./scripts/verify-install.sh
#
# Checks:
#   1. Codex CLI is installed
#   2. Python 3 is available
#   3. Bash version (3.2+ works; 4+ recommended)
#   4. All expected skill directories exist
#   5. Both relay scripts exist and are executable
#   6. compose-prompt.sh can find its templates (smoke test)

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

# ── 1. Codex CLI ──────────────────────────────────────────────────────
section "Codex CLI"

if command -v codex >/dev/null 2>&1; then
  codex_version="$(codex --version 2>/dev/null || echo 'unknown')"
  pass "codex found: $codex_version"
else
  fail "codex not found — install with: npm install -g @openai/codex"
fi

# ── 2. Python 3 ──────────────────────────────────────────────────────
section "Python 3"

if command -v python3 >/dev/null 2>&1; then
  py_version="$(python3 --version 2>&1)"
  pass "python3 found: $py_version"
else
  fail "python3 not found — required by update-batch.sh"
fi

# ── 3. Bash version ──────────────────────────────────────────────────
section "Bash version"

bash_version="${BASH_VERSINFO[0]:-0}"
if [[ "$bash_version" -ge 4 ]]; then
  pass "bash ${BASH_VERSION}"
else
  # Relay scripts use Python for heavy lifting; bash 3.2 works fine
  pass "bash ${BASH_VERSION} (relay scripts are compatible with bash 3.2+)"
fi

# ── 4. Skill directories ─────────────────────────────────────────────
section "Skill directories"

EXPECTED_SKILLS=(
  manage-codex
  circuit-autonomous-ratchet
  circuit-create
  circuit-decision-pressure-loop
  circuit-dry-run
  circuit-flow-audit-and-repair
  circuit-janitor
  circuit-research-to-implementation
  circuit-router
  circuit-spec-hardening
)

for skill in "${EXPECTED_SKILLS[@]}"; do
  skill_dir="$PLUGIN_ROOT/skills/$skill"
  if [[ -d "$skill_dir" ]]; then
    if [[ -f "$skill_dir/SKILL.md" ]]; then
      pass "$skill/"
    else
      warn "$skill/ exists but missing SKILL.md"
    fi
  else
    fail "$skill/ not found"
  fi
done

# ── 5. Relay scripts ─────────────────────────────────────────────────
section "Relay scripts"

for script in compose-prompt.sh update-batch.sh; do
  script_path="$PLUGIN_ROOT/scripts/relay/$script"
  if [[ -f "$script_path" ]]; then
    if [[ -x "$script_path" ]]; then
      pass "$script (exists, executable)"
    else
      fail "$script exists but is NOT executable — run: chmod +x $script_path"
    fi
  else
    fail "$script not found at scripts/relay/$script"
  fi
done

# ── 6. compose-prompt.sh template smoke test ──────────────────────────
section "Template smoke test"

TEMPLATES_DIR="$PLUGIN_ROOT/skills/manage-codex/references"
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
    fail "template missing: manage-codex/references/$tmpl"
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
    fail "compose-prompt.sh smoke test failed — run manually to debug"
  fi

  rm -f "$smoke_header" "$smoke_out"
else
  warn "skipping compose-prompt.sh smoke test (templates missing)"
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

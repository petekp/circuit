#!/bin/bash
# A Claude Code user (CLI installed, signed out) following README "Claude
# Code" install steps. The README shows slash commands; the claude CLI has
# equivalent plugin subcommands, which is what a scripted/agent install uses.
set -u
source /lab/steps.sh

banner "Environment"
step "node version" node --version
step "claude version" claude --version

banner "README Claude Code funnel (CLI equivalents of the slash commands)"
step "marketplace add" claude plugin marketplace add petekp/circuit
step "plugin install" claude plugin install circuit@circuit

banner "What landed on disk"
step "installed plugin tree (top levels)" find "$HOME/.claude" -maxdepth 4 -name "*.md" -path "*circuit*" -o -maxdepth 4 -type d -path "*circuit*"

PLUGIN_ROOT=$(find "$HOME/.claude" -maxdepth 6 -type d -name "runtime" -path "*circuit*" 2>/dev/null | head -1 | xargs -r dirname)
echo "PLUGIN_ROOT=${PLUGIN_ROOT:-NOT FOUND}"

banner "Self-contained runtime claim (README: no clone, no npm install needed)"
if [ -n "${PLUGIN_ROOT:-}" ]; then
  step "bundled runtime: version" node "$PLUGIN_ROOT/runtime/circuit.js" version
  step "bundled runtime: doctor" node "$PLUGIN_ROOT/runtime/circuit.js" doctor
  step "bundled runtime: run with missing goal (arg error quality)" node "$PLUGIN_ROOT/runtime/circuit.js" run review
  step "launcher script present" ls "$PLUGIN_ROOT/scripts"
else
  echo "SKIPPED runtime checks: plugin root not found"
fi

banner "Done"

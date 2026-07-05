#!/bin/bash
# A Codex user (CLI installed, signed out) following README "Codex" install
# steps verbatim, including the published --ref pin.
set -u
source /lab/steps.sh

banner "Environment"
step "node version" node --version
step "codex version" codex --version

banner "README Codex funnel, verbatim"
step "marketplace add at published ref" codex plugin marketplace add petekp/circuit --ref circuit--v0.1.0-alpha.9

banner "What landed on disk"
step "codex home tree (circuit paths)" find "$HOME/.codex" -maxdepth 5 -type d -path "*circuit*"

# Prefer the codex host package; the marketplace clone also carries
# plugins/claude, and an unordered find can land there first.
PLUGIN_ROOT=$(find "$HOME/.codex" -maxdepth 7 -type d -name "runtime" -path "*plugins/codex*" 2>/dev/null | head -1 | xargs -r dirname)
if [ -z "${PLUGIN_ROOT:-}" ]; then
  PLUGIN_ROOT=$(find "$HOME/.codex" -maxdepth 7 -type d -name "runtime" -path "*circuit*" 2>/dev/null | head -1 | xargs -r dirname)
fi
echo "PLUGIN_ROOT=${PLUGIN_ROOT:-NOT FOUND}"

banner "Bundled runtime smoke (alpha.9 as published)"
if [ -n "${PLUGIN_ROOT:-}" ]; then
  step "bundled runtime: version" node "$PLUGIN_ROOT/runtime/circuit.js" version
  step "bundled runtime: doctor (alpha.9 predates doctor — record what happens)" node "$PLUGIN_ROOT/runtime/circuit.js" doctor
  step "bundled runtime: inbox" node "$PLUGIN_ROOT/runtime/circuit.js" inbox
else
  echo "SKIPPED runtime checks: plugin root not found"
fi

banner "Done"

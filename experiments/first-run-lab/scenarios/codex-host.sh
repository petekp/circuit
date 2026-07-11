#!/bin/bash
# A Codex user (CLI installed, signed out) following README "Codex" install
# steps verbatim, including the published --ref pin. The driver extracts that
# ref from the README and passes it in, so the lab always tests the exact
# line users copy-paste.
set -u
source /lab/steps.sh

: "${CIRCUIT_CODEX_REF:?run via run-lab.sh, which reads the published ref from README.md}"

banner "Environment"
step "node version" node --version
step "codex version" codex --version

banner "README Codex funnel, verbatim"
step "marketplace add at published ref ($CIRCUIT_CODEX_REF)" codex plugin marketplace add petekp/circuit --ref "$CIRCUIT_CODEX_REF"

banner "What landed on disk"
step "codex home tree (circuit paths)" find "$HOME/.codex" -maxdepth 5 -type d -path "*circuit*"

# Prefer the codex host package; the marketplace clone also carries
# plugins/claude, and an unordered find can land there first.
PLUGIN_ROOT=$(find "$HOME/.codex" -maxdepth 7 -type d -name "runtime" -path "*plugins/codex*" 2>/dev/null | head -1 | xargs -r dirname)
if [ -z "${PLUGIN_ROOT:-}" ]; then
  PLUGIN_ROOT=$(find "$HOME/.codex" -maxdepth 7 -type d -name "runtime" -path "*circuit*" 2>/dev/null | head -1 | xargs -r dirname)
fi
echo "PLUGIN_ROOT=${PLUGIN_ROOT:-NOT FOUND}"

banner "Bundled runtime smoke ($CIRCUIT_CODEX_REF as published)"
if [ -n "${PLUGIN_ROOT:-}" ]; then
  step "bundled runtime: version" node "$PLUGIN_ROOT/runtime/circuit.js" version
  step "bundled runtime: doctor" node "$PLUGIN_ROOT/runtime/circuit.js" doctor
  step "bundled runtime: checkpoints" node "$PLUGIN_ROOT/runtime/circuit.js" checkpoints
else
  echo "SKIPPED runtime checks: plugin root not found"
fi

banner "Done"

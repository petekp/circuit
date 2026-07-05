#!/bin/bash
# A user below the documented Node 22.18 floor. What do they actually see,
# and at which step does the funnel break for them?
set -u
source /lab/steps.sh

banner "Environment (below the documented floor)"
step "node version" node --version

banner "README Local CLI funnel on Node 20"
step "clone the repo" git clone --depth 1 https://github.com/petekp/circuit.git
cd circuit || { echo "FATAL: clone failed, cannot continue"; exit 1; }
step "npm install (watch for EBADENGINE visibility)" npm install
step "npm run build" npm run build

banner "What the floor violation looks like at run time"
step "circuit version" ./bin/circuit version
step "circuit doctor" ./bin/circuit doctor
step "circuit run review" ./bin/circuit run review --goal "x" --power low

banner "Done"

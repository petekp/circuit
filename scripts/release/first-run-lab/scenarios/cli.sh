#!/bin/bash
# First-time CLI user on a clean Node 22 box, following README "Local CLI"
# verbatim, then poking at it the way a curious new user does.
set -u
source /lab/steps.sh

banner "Environment"
step "node version" node --version
step "npm version" npm --version

banner "README Local CLI funnel, verbatim"
step "clone the repo" git clone --depth 1 https://github.com/petekp/circuit.git
cd circuit || { echo "FATAL: clone failed, cannot continue"; exit 1; }
step "npm install" npm install
step "npm run build" npm run build

banner "First contact with the CLI"
step "bare circuit (front door)" ./bin/circuit
step "circuit doctor (no connectors installed anywhere)" ./bin/circuit doctor
step "circuit version" ./bin/circuit version
step "circuit preview review" ./bin/circuit preview review

banner "First real run attempt (no agent CLIs exist, must fail honestly pre-spend)"
step "circuit run review" ./bin/circuit run review --goal "does the README install section match this repo" --power low

banner "Plausible first mistakes"
step "misspelled flow name" ./bin/circuit run prototpe --goal "x"
step "forgot --goal" ./bin/circuit run review
step "resume with a made-up run id" ./bin/circuit resume --run-folder 1234 --checkpoint-choice keep
step "checkpoints on a fresh project" ./bin/circuit checkpoints

banner "Running from their own project directory (not the checkout)"
mkdir -p "$HOME/myproject" && cd "$HOME/myproject"
git init -q . 2>/dev/null || true
step "run review from another directory" "$HOME/circuit/bin/circuit" run review --goal "check my project" --power low
step "doctor from another directory" "$HOME/circuit/bin/circuit" doctor

banner "Done"

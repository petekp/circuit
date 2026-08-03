#!/bin/bash
# First-time user installing the published CLI from the live npm registry,
# following README "Local CLI" verbatim. This is the only scenario that proves
# what `npm install -g` actually serves; every other funnel installs from the
# repo or a tag. Run it after `npm publish`, never before: until the publish
# lands, this battery tests the previous version.
set -u
source /lab/steps.sh

VERSION="${CIRCUIT_NPM_VERSION:?CIRCUIT_NPM_VERSION must name the published version}"

banner "Environment"
step "node version" node --version
step "npm version" npm --version

banner "README Local CLI funnel, from the live registry"
# Pinned so the transcript proves the version this release published, not
# whatever `latest` happens to point at when someone reruns the lab.
step "npm install -g @petepetrash/circuit@$VERSION" \
  npm install -g "@petepetrash/circuit@$VERSION"

banner "The installed binary is the published one"
step "which circuit" which circuit
step "circuit version (must report $VERSION)" circuit version

banner "First contact"
step "bare circuit (front door)" circuit
step "circuit doctor (no connectors installed anywhere)" circuit doctor
step "circuit preview review" circuit preview review

banner "The documented first run"
# The demo does a real Fix run with real model cost, so on a box with no
# connectors and no credentials it must refuse before spending anything. That
# honest pre-spend stop is what this step proves; the lab never spends.
cd "$HOME"
step "circuit demo" circuit demo --dir "$HOME/demo"

banner "First real run attempt (no agent CLIs exist, must fail honestly pre-spend)"
mkdir -p "$HOME/myproject" && cd "$HOME/myproject"
git init -q . 2>/dev/null || true
step "circuit run review" circuit run review --goal "check my project" --power low

banner "Plausible first mistakes"
step "misspelled flow name" circuit run prototpe --goal "x"
step "forgot --goal" circuit run review
step "checkpoints on a fresh project" circuit checkpoints

banner "Done"

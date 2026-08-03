#!/bin/bash
# Build the lab images and run the first-run batteries, one transcript per
# scenario. Usage: run-lab.sh [cli|cli-node20|claude|codex|npm|all]
#
# `all` deliberately leaves out `npm`. That scenario installs from the live
# registry, so it only means something after `npm publish` has landed; running
# it on the pre-release pass would just retest the previous version. Run it by
# name in the post-publish gate.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_DIR/../../.." && pwd)"
# The lab reads the repo it is testing (README for the pinned ref, the checkout
# it mounts into every container), so a wrong root is not a quiet failure, it is
# a lab that tests the wrong thing. Say so here rather than three scenarios in.
if [[ ! -f "$REPO_ROOT/package.json" ]]; then
  echo "first-run lab: expected the repo root at $REPO_ROOT, found no package.json there." >&2
  echo "The lab resolves the root by walking up from its own directory; if the lab moved, fix that walk." >&2
  exit 1
fi
RUNS_DIR="$LAB_DIR/runs"
mkdir -p "$RUNS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

# The codex funnel installs at the exact ref the README tells users to pin.
# Reading it from the README keeps the lab testing what users copy-paste;
# a release only has to update the README and the lab follows.
CODEX_REF="$(grep -oE 'circuit--v[0-9A-Za-z.-]+' "$REPO_ROOT/README.md" | head -1)"
if [ -z "$CODEX_REF" ]; then
  echo "could not find a circuit--v* ref in $REPO_ROOT/README.md" >&2
  exit 2
fi

# The npm funnel installs the exact version this checkout declares, so the
# transcript proves the release being cut rather than whatever `latest` points
# at whenever someone reruns the lab.
NPM_VERSION="$(node -p "require('$REPO_ROOT/plugins/version.json').version")"

run_one() {
  local name="$1" dockerfile="$2" scenario="$3"
  local image="circuit-lab-$name"
  local log="$RUNS_DIR/$STAMP-$name.log"
  echo "=== [$name] building $image"
  docker build -q -f "$LAB_DIR/$dockerfile" -t "$image" "$LAB_DIR" >/dev/null
  echo "=== [$name] running battery -> $log"
  # No stdin, no TTY: the transcript captures what a script/agent sees; the
  # scenario scripts close stdin per step anyway so prompts fail fast.
  docker run --rm \
    -e "CIRCUIT_CODEX_REF=$CODEX_REF" \
    -e "CIRCUIT_NPM_VERSION=$NPM_VERSION" \
    -v "$LAB_DIR/scenarios:/lab:ro" \
    "$image" bash "/lab/$scenario" >"$log" 2>&1 || true
  echo "=== [$name] done (exit recorded per step in transcript)"
}

target="${1:-all}"
case "$target" in
  cli) run_one cli Dockerfile.cli cli.sh ;;
  cli-node20) run_one cli-node20 Dockerfile.cli-node20 cli-node20.sh ;;
  claude) run_one claude Dockerfile.claude claude-host.sh ;;
  codex) run_one codex Dockerfile.codex codex-host.sh ;;
  npm) run_one npm Dockerfile.npm npm.sh ;;
  all)
    run_one cli Dockerfile.cli cli.sh
    run_one cli-node20 Dockerfile.cli-node20 cli-node20.sh
    run_one claude Dockerfile.claude claude-host.sh
    run_one codex Dockerfile.codex codex-host.sh
    ;;
  *) echo "usage: run-lab.sh [cli|cli-node20|claude|codex|npm|all]" >&2; exit 2 ;;
esac

echo
echo "Transcripts:"
ls -1 "$RUNS_DIR/$STAMP"-*.log

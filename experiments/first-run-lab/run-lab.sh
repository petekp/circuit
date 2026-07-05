#!/bin/bash
# Build the lab images and run the first-run batteries, one transcript per
# scenario. Usage: run-lab.sh [cli|cli-node20|claude|codex|all]
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS_DIR="$LAB_DIR/runs"
mkdir -p "$RUNS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

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
  all)
    run_one cli Dockerfile.cli cli.sh
    run_one cli-node20 Dockerfile.cli-node20 cli-node20.sh
    run_one claude Dockerfile.claude claude-host.sh
    run_one codex Dockerfile.codex codex-host.sh
    ;;
  *) echo "usage: run-lab.sh [cli|cli-node20|claude|codex|all]" >&2; exit 2 ;;
esac

echo
echo "Transcripts:"
ls -1 "$RUNS_DIR/$STAMP"-*.log

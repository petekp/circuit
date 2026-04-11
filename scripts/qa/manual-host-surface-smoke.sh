#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
NODE_BIN="${NODE_BIN:-node}"
RSYNC_BIN="${RSYNC_BIN:-rsync}"
RG_BIN="${RG_BIN:-rg}"
CLAUDE_TIMEOUT_SEC="${CLAUDE_TIMEOUT_SEC:-90}"
CONTINUITY_CLI="$REPO_ROOT/scripts/runtime/bin/continuity.js"

SYNC_CACHE=1
REQUESTED_CASES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sync)
      SYNC_CACHE=0
      ;;
    --case)
      shift
      REQUESTED_CASES+=("${1:-}")
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift || true
done

for command_name in "$CLAUDE_BIN" "$NODE_BIN" "$RSYNC_BIN" "$RG_BIN" git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

if (( SYNC_CACHE == 1 )); then
  "$REPO_ROOT/scripts/sync-to-cache.sh"
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
HARNESS_ROOT="$REPO_ROOT/.circuit/manual-host-surface-smoke/$STAMP"
LOG_ROOT="$HARNESS_ROOT/logs"
mkdir -p "$LOG_ROOT"

ALL_CASES=(
  run-develop
  run-develop-pending-handoff
  run-develop-active-run
  build
  explore
  repair
  migrate
  sweep
  review-current-changes
  handoff-done
  handoff-resume
)

if (( ${#REQUESTED_CASES[@]} == 0 )); then
  CASES=("${ALL_CASES[@]}")
else
  CASES=("${REQUESTED_CASES[@]}")
fi

PASS_COUNT=0
FAIL_COUNT=0
FAILED_CASES=()

handoff_path_for() {
  local home_dir="$1"
  local repo_root="$2"
  "$NODE_BIN" "$CONTINUITY_CLI" \
    --project-root "$repo_root" \
    --handoff-home "$home_dir" \
    --field handoff_path
}

continuity_field() {
  local repo_root="$1"
  local field_name="$2"
  local home_dir="${3:-}"
  local args=(
    "$CONTINUITY_CLI"
    --project-root "$repo_root"
    --field "$field_name"
  )

  if [[ -n "$home_dir" ]]; then
    args+=(--handoff-home "$home_dir")
  fi

  "$NODE_BIN" "${args[@]}"
}

assert_exists() {
  local path="$1"
  [[ -e "$path" ]] || {
    printf 'missing expected path: %s\n' "$path" >&2
    return 1
  }
}

assert_not_exists() {
  local path="$1"
  [[ ! -e "$path" ]] || {
    printf 'unexpected path exists: %s\n' "$path" >&2
    return 1
  }
}

assert_log_contains() {
  local log_path="$1"
  local snippet="$2"
  "$RG_BIN" -q --fixed-strings "$snippet" "$log_path" || {
    printf 'log missing required snippet: %s\n' "$snippet" >&2
    return 1
  }
}

assert_log_not_contains() {
  local log_path="$1"
  local snippet="$2"
  if "$RG_BIN" -q --fixed-strings "$snippet" "$log_path"; then
    printf 'log contained forbidden snippet: %s\n' "$snippet" >&2
    return 1
  fi
}

assert_bootstrap_only_log() {
  local log_path="$1"
  assert_log_not_contains "$log_path" "Let me understand the repo first"
  assert_log_not_contains "$log_path" "Frame checkpoint resolved, routing to Plan"
  assert_log_not_contains "$log_path" "plan.md written"
  assert_log_not_contains "$log_path" "ls ~/.claude/plugins/cache"
}

assert_build_semantic_bootstrap_log() {
  local log_path="$1"
  assert_log_contains "$log_path" ".circuit/bin/circuit-engine" || return 1
  assert_log_contains "$log_path" "bootstrap" || return 1
  assert_log_not_contains "$log_path" "\"name\":\"Write\"" || return 1
}

current_run_target() {
  local repo_root="$1"
  local target
  target="$(continuity_field "$repo_root" run_root)"
  if [[ -z "$target" ]]; then
    printf 'no current-run pointer found for %s\n' "$repo_root" >&2
    return 1
  fi

  printf '%s\n' "$target"
}

copy_repo_fixture() {
  local target_root="$1"
  mkdir -p "$target_root"
  "$RSYNC_BIN" -a \
    --delete \
    --exclude '.git' \
    --exclude '.claude' \
    --exclude '.circuit' \
    --exclude '.circuit*' \
    --exclude 'scripts/runtime/engine/node_modules' \
    "$REPO_ROOT/" \
    "$target_root/"
}

init_fixture_repo() {
  local repo_root="$1"
  git -C "$repo_root" init -q
  git -C "$repo_root" config user.name "Circuit Smoke Harness"
  git -C "$repo_root" config user.email "smoke-harness@example.com"
  git -C "$repo_root" add -A
  git -C "$repo_root" commit -qm "fixture baseline"
}

seed_handoff() {
  local home_dir="$1"
  local repo_root="$2"
  local sentinel="$3"
  local handoff_path
  handoff_path="$(handoff_path_for "$home_dir" "$repo_root")"
  mkdir -p "$(dirname "$handoff_path")"
  cat >"$handoff_path" <<EOF
# Handoff
WRITTEN: 2026-04-10T00:00:00Z
DIR: $repo_root

NEXT: DO: resume-$sentinel
GOAL: Resume $sentinel [VERIFY: confirm this is still the right target before acting]
STATE:
- $sentinel
EOF
}

seed_active_run() {
  local repo_root="$1"
  local workflow_label="${2:-Build}"
  local phase_label="${3:-frame}"
  local sentinel="${4:-}"
  local run_root="$repo_root/.circuit/circuit-runs/manual-active-run"
  mkdir -p "$run_root/artifacts"
  mkdir -p "$repo_root/.circuit"
  ln -sfn "circuit-runs/manual-active-run" "$repo_root/.circuit/current-run"
  cat >"$run_root/artifacts/active-run.md" <<EOF
# Active Run
## Workflow
${workflow_label}
## Current Phase
${phase_label}
EOF
  if [[ -n "$sentinel" ]]; then
    printf '%s\n' "$sentinel" >>"$run_root/artifacts/active-run.md"
  fi
}

seed_review_diff() {
  local repo_root="$1"
  cat >"$repo_root/review-scope-sentinel.ts" <<'EOF'
export const reviewScopeSentinel = "baseline";
EOF
  git -C "$repo_root" add review-scope-sentinel.ts
  git -C "$repo_root" commit -qm "add review scope sentinel"
  cat >"$repo_root/review-scope-sentinel.ts" <<'EOF'
export const reviewScopeSentinel = "REVIEW_SCOPE_SENTINEL";
EOF
}

run_claude_case() {
  local repo_root="$1"
  local prompt="$2"
  local log_path="$3"
  local home_dir="$4"

  CLAUDE_CASE_BIN="$CLAUDE_BIN" \
  CLAUDE_CASE_LOG="$log_path" \
  CLAUDE_CASE_PROMPT="$prompt" \
  CLAUDE_CASE_REPO_ROOT="$repo_root" \
  CLAUDE_CASE_HANDOFF_HOME="$home_dir" \
  CLAUDE_CASE_TIMEOUT_SEC="$CLAUDE_TIMEOUT_SEC" \
  "$NODE_BIN" <<'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const logPath = process.env.CLAUDE_CASE_LOG;
const repoRoot = process.env.CLAUDE_CASE_REPO_ROOT;
const prompt = process.env.CLAUDE_CASE_PROMPT;
const claudeBin = process.env.CLAUDE_CASE_BIN;
const handoffHome = process.env.CLAUDE_CASE_HANDOFF_HOME;
const timeoutMs = Number(process.env.CLAUDE_CASE_TIMEOUT_SEC || "180") * 1000;

const logFd = fs.openSync(logPath, "w");
const result = spawnSync(
  claudeBin,
  [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    prompt,
  ],
  {
    cwd: repoRoot,
    stdio: ["ignore", logFd, logFd],
    timeout: timeoutMs,
    env: {
      ...process.env,
      CIRCUIT_HANDOFF_HOME: handoffHome,
    },
  },
);
fs.closeSync(logFd);

if (result.error && result.error.code === "ETIMEDOUT") {
  process.exit(124);
}
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
NODE
}

assert_continuity_banner() {
  local log_path="$1"
  assert_log_contains "$log_path" "Circuit continuity available"
  assert_log_contains "$log_path" "This is context only."
  assert_log_contains "$log_path" 'Fresh `/circuit:*` commands should be honored as the active task.'
  assert_log_contains "$log_path" "/circuit:handoff resume"
}

assert_build_bootstrap() {
  local repo_root="$1"
  local run_root
  run_root="$(current_run_target "$repo_root")"

  [[ -d "$run_root" ]] || {
    printf 'current-run target is not a directory: %s\n' "$run_root" >&2
    return 1
  }
  assert_exists "$run_root/circuit.manifest.yaml"
  assert_exists "$run_root/events.ndjson"
  assert_exists "$run_root/state.json"
  assert_exists "$run_root/artifacts/active-run.md"
  assert_log_contains "$run_root/artifacts/active-run.md" "## Workflow"
  assert_log_contains "$run_root/artifacts/active-run.md" "Build"
}

assert_legacy_workflow_bootstrap() {
  local repo_root="$1"
  local workflow_label="$2"
  local run_root
  run_root="$(current_run_target "$repo_root")"

  [[ -d "$run_root" ]] || {
    printf 'current-run target is not a directory: %s\n' "$run_root" >&2
    return 1
  }
  assert_exists "$run_root/artifacts"
  assert_exists "$run_root/phases"
  assert_exists "$run_root/artifacts/active-run.md"
  assert_log_contains "$run_root/artifacts/active-run.md" "## Workflow"
  assert_log_contains "$run_root/artifacts/active-run.md" "$workflow_label"
}

run_case() {
  local case_id="$1"
  local case_root="$HARNESS_ROOT/$case_id"
  local repo_root="$case_root/repo"
  local case_home="$case_root/home"
  local log_path="$LOG_ROOT/$case_id.stream.jsonl"
  local prompt=""
  local handoff_path=""

  rm -rf "$case_root"
  mkdir -p "$case_root"
  mkdir -p "$case_home"
  copy_repo_fixture "$repo_root"
  init_fixture_repo "$repo_root"

  case "$case_id" in
    run-develop)
      prompt="/circuit:run develop: smoke bootstrap the build path for host-surface verification; create and validate .circuit/current-run plus circuit.manifest.yaml, events.ndjson, state.json, and artifacts/active-run.md for the selected run, then stop"
      ;;
    run-develop-pending-handoff)
      seed_handoff "$case_home" "$repo_root" "HANDOFF_RESUME_SENTINEL"
      prompt="/circuit:run develop: smoke bootstrap the build path for host-surface verification; create and validate .circuit/current-run plus circuit.manifest.yaml, events.ndjson, state.json, and artifacts/active-run.md for the selected run, then stop"
      ;;
    run-develop-active-run)
      seed_active_run "$repo_root" "LegacyCarryover" "frame" "ACTIVE_RUN_CONTINUITY_SENTINEL"
      prompt="/circuit:run develop: smoke bootstrap the build path for host-surface verification; create and validate .circuit/current-run plus circuit.manifest.yaml, events.ndjson, state.json, and artifacts/active-run.md for the selected run, then stop"
      ;;
    build)
      prompt="/circuit:build smoke bootstrap the build path for host-surface verification; create and validate .circuit/current-run plus circuit.manifest.yaml, events.ndjson, state.json, and artifacts/active-run.md for the selected run, then stop"
      ;;
    explore)
      prompt="/circuit:explore smoke inspect the public-surface bootstrap path; create and validate .circuit/current-run plus artifacts/, phases/, and artifacts/active-run.md for the selected run, then stop"
      ;;
    repair)
      prompt="/circuit:repair smoke investigate the placeholder host-surface regression; create and validate .circuit/current-run plus artifacts/, phases/, and artifacts/active-run.md for the selected run, then stop"
      ;;
    migrate)
      prompt="/circuit:migrate smoke migrate the placeholder host-surface contract; create and validate .circuit/current-run plus artifacts/, phases/, and artifacts/active-run.md for the selected run, then stop"
      ;;
    sweep)
      prompt="/circuit:sweep smoke clean placeholder host-surface residue; create and validate .circuit/current-run plus artifacts/, phases/, and artifacts/active-run.md for the selected run, then stop"
      ;;
    review-current-changes)
      seed_review_diff "$repo_root"
      prompt="/circuit:review current changes"
      ;;
    handoff-done)
      seed_handoff "$case_home" "$repo_root" "HANDOFF_DONE_SENTINEL"
      seed_active_run "$repo_root"
      prompt="/circuit:handoff done"
      ;;
    handoff-resume)
      seed_handoff "$case_home" "$repo_root" "HANDOFF_RESUME_SENTINEL"
      seed_active_run "$repo_root" "LegacyCarryover" "frame" "ACTIVE_RUN_RESUME_SENTINEL"
      prompt="/circuit:handoff resume"
      ;;
    *)
      printf 'Unknown case id: %s\n' "$case_id" >&2
      return 1
      ;;
  esac

  handoff_path="$(handoff_path_for "$case_home" "$repo_root")"

  local status=0
  local assert_status=0

  set +e
  run_claude_case "$repo_root" "$prompt" "$log_path" "$case_home"
  status=$?

  if (( status == 0 )); then
    case "$case_id" in
      run-develop)
        assert_build_bootstrap "$repo_root" || assert_status=1
        assert_bootstrap_only_log "$log_path" || assert_status=1
        assert_build_semantic_bootstrap_log "$log_path" || assert_status=1
        ;;
      run-develop-pending-handoff)
        assert_build_bootstrap "$repo_root" || assert_status=1
        assert_bootstrap_only_log "$log_path" || assert_status=1
        assert_build_semantic_bootstrap_log "$log_path" || assert_status=1
        assert_continuity_banner "$log_path" || assert_status=1
        assert_log_contains "$log_path" "pending handoff" || assert_status=1
        assert_log_not_contains "$log_path" "Resume from the handoff above." || assert_status=1
        assert_log_not_contains "$log_path" "HANDOFF_RESUME_SENTINEL" || assert_status=1
        ;;
      run-develop-active-run)
        assert_build_bootstrap "$repo_root" || assert_status=1
        assert_bootstrap_only_log "$log_path" || assert_status=1
        assert_build_semantic_bootstrap_log "$log_path" || assert_status=1
        assert_continuity_banner "$log_path" || assert_status=1
        assert_log_contains "$log_path" "active run" || assert_status=1
        assert_log_not_contains "$log_path" "ACTIVE_RUN_CONTINUITY_SENTINEL" || assert_status=1
        if [[ "$(current_run_target "$repo_root")" == "$repo_root/.circuit/circuit-runs/manual-active-run" ]]; then
          printf 'fresh workflow command did not replace the seeded active run\n' >&2
          assert_status=1
        fi
        ;;
      build)
        assert_build_bootstrap "$repo_root" || assert_status=1
        assert_bootstrap_only_log "$log_path" || assert_status=1
        assert_build_semantic_bootstrap_log "$log_path" || assert_status=1
        ;;
      explore)
        assert_legacy_workflow_bootstrap "$repo_root" "Explore" || assert_status=1
        ;;
      repair)
        assert_legacy_workflow_bootstrap "$repo_root" "Repair" || assert_status=1
        ;;
      migrate)
        assert_legacy_workflow_bootstrap "$repo_root" "Migrate" || assert_status=1
        ;;
      sweep)
        assert_legacy_workflow_bootstrap "$repo_root" "Sweep" || assert_status=1
        ;;
      review-current-changes)
        assert_not_exists "$repo_root/.circuit/current-run" || assert_status=1
        assert_log_contains "$log_path" "Review verdict:" || assert_status=1
        assert_log_contains "$log_path" "review-scope-sentinel.ts" || assert_status=1
        ;;
      handoff-done)
        assert_not_exists "$handoff_path" || assert_status=1
        assert_not_exists "$repo_root/.circuit/current-run" || assert_status=1
        assert_not_exists "$repo_root/.circuit/circuit-runs/manual-active-run/artifacts/active-run.md" || assert_status=1
        assert_exists "$repo_root/.circuit/circuit-runs/manual-active-run/artifacts/completed-run.md" || assert_status=1
        ;;
      handoff-resume)
        assert_log_contains "$log_path" "# Circuit Resume" || assert_status=1
        assert_log_contains "$log_path" "HANDOFF_RESUME_SENTINEL" || assert_status=1
        assert_log_not_contains "$log_path" "ACTIVE_RUN_RESUME_SENTINEL" || assert_status=1
        ;;
    esac
  elif (( status == 124 )); then
    printf '\nTimed out after %ss\n' "$CLAUDE_TIMEOUT_SEC" >>"$log_path"
  fi
  set -e

  rm -rf "$(dirname "$handoff_path")"

  if (( status == 0 && assert_status == 0 )); then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS %s\n' "$case_id"
    return 0
  fi

  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CASES+=("$case_id")
  printf 'FAIL %s (log: %s)\n' "$case_id" "$log_path"
  return 0
}

printf 'Manual host-surface smoke harness\n'
printf 'Log root: %s\n' "$LOG_ROOT"
printf 'Cases: %s\n\n' "${CASES[*]}"

for case_id in "${CASES[@]}"; do
  run_case "$case_id"
done

printf '\nSummary: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if (( FAIL_COUNT > 0 )); then
  printf 'Failed cases: %s\n' "${FAILED_CASES[*]}"
  exit 1
fi

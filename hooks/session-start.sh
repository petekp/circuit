#!/usr/bin/env bash
set -euo pipefail

if git rev-parse --show-toplevel >/dev/null 2>&1; then
  project_dir="$(git rev-parse --show-toplevel)"
else
  project_dir="$PWD"
fi
project_slug=$(printf '%s' "$project_dir" | tr '/' '-')
handoff_file="$HOME/.claude/projects/${project_slug}/handoff.md"

# Check for active-run.md in the most recent circuit run
active_run=""
circuit_runs_dir="${project_dir}/.circuitry/circuit-runs"
if [[ -d "$circuit_runs_dir" ]]; then
  # Find the most recently modified active-run.md
  active_run=$(find "$circuit_runs_dir" -name "active-run.md" -maxdepth 3 -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)
fi

if [[ -f "$handoff_file" ]] && head -1 "$handoff_file" | grep -q '^# Handoff'; then
  cat <<'HANDOFF_HEADER'
> **Pending handoff detected.** A previous session saved its state before ending. Resume context follows.

---

HANDOFF_HEADER
  cat "$handoff_file"
  cat <<'HANDOFF_FOOTER'

---

Resume from the handoff above.

1. Read DIR. This is your working directory for all file operations and git commands.
2. Read GOAL and verify it is still accurate. Check it against current repo state. Do not acknowledge it -- assess it. If it appears stale, say so before acting.
3. Read all DEBT entries. RULED OUT approaches should not be re-investigated unless you have new evidence that changes the original reasoning. BLOCKED entries may be unblocked -- check the unblocking condition. CONSTRAINT entries are operating rules for this session.
4. Read STATE for current facts.
5. If NEXT is DO: execute it. The DO prefix means the action is ready. You have already read DEBT -- use it to operate safely.
6. If NEXT is DECIDE: resolve the decision using STATE and DEBT before taking any action. If the DECIDE text says "need user input," stop and ask.
7. Run /circuit:handoff done when this work is complete.

---

HANDOFF_FOOTER
elif [[ -n "$active_run" ]] && [[ -f "$active_run" ]]; then
  cat <<'ACTIVERUN_HEADER'
> **Active circuit run detected.** Injecting current state.

---

ACTIVERUN_HEADER
  cat "$active_run"
  cat <<'ACTIVERUN_FOOTER'

---

Review the active run state above and resume from the current phase.

ACTIVERUN_FOOTER
else
  cat <<'WELCOME'
Circuitry is active. Try one of these to get started:

  /circuit fix: login form rejects valid emails       Bug fix with test-first discipline
  /circuit add dark mode support to the settings page  Router picks the right workflow
  /circuit decide: REST vs GraphQL for the new API     Adversarial evaluation of options

Circuitry classifies your task into the right workflow (Explore, Build, Repair,
Migrate, Sweep), selects a rigor level, and runs it. You step in at checkpoints.
If a session crashes, the next one picks up where it stopped.
WELCOME
fi

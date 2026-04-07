#!/usr/bin/env bash
set -euo pipefail

if git rev-parse --show-toplevel >/dev/null 2>&1; then
  project_dir="$(git rev-parse --show-toplevel)"
else
  project_dir="$PWD"
fi
# Sanitize project path to a slug: normalize separators and strip unsafe chars
# Converts backslashes and slashes to dashes, strips colons and other
# characters unsafe in file paths (e.g. Windows drive letter "C:").
project_slug=$(printf '%s' "$project_dir" | tr '\\' '/' | tr '/' '-' | sed 's/[:<>"|?*]//g; s/^-//')
handoff_file="$HOME/.claude/projects/${project_slug}/handoff.md"

# Check for active run via explicit pointer, fall back to most-recent heuristic
active_run=""
circuit_runs_dir="${project_dir}/.circuit/circuit-runs"
current_run_pointer="${project_dir}/.circuit/current-run"

if [[ -L "$current_run_pointer" ]] || [[ -f "$current_run_pointer" ]]; then
  # Explicit pointer exists -- resolve it
  if [[ -L "$current_run_pointer" ]]; then
    pointed_dir=$(readlink "$current_run_pointer")
    # Resolve relative symlinks
    if [[ ! "$pointed_dir" = /* ]]; then
      pointed_dir="${project_dir}/.circuit/${pointed_dir}"
    fi
  else
    # Plain file containing the run slug
    pointed_dir="${circuit_runs_dir}/$(cat "$current_run_pointer")"
  fi
  if [[ -f "${pointed_dir}/artifacts/active-run.md" ]]; then
    active_run="${pointed_dir}/artifacts/active-run.md"
  fi
fi

# Fallback: most recently modified active-run.md (single-run heuristic)
# Fully null-safe: use find -print0 and compare mtimes in a while-read loop.
# No ls parsing, no newline assumptions, works on macOS and Linux.
if [[ -z "$active_run" ]] && [[ -d "$circuit_runs_dir" ]]; then
  newest_mtime=0
  newest_file=""
  while IFS= read -r -d '' candidate; do
    # stat -f %m (macOS) or stat -c %Y (Linux) for mtime as epoch seconds
    if mtime=$(stat -f %m "$candidate" 2>/dev/null) || mtime=$(stat -c %Y "$candidate" 2>/dev/null); then
      if (( mtime > newest_mtime )); then
        newest_mtime=$mtime
        newest_file="$candidate"
      fi
    fi
  done < <(find "$circuit_runs_dir" -name "active-run.md" -maxdepth 3 -type f -print0 2>/dev/null)
  [[ -n "$newest_file" ]] && active_run="$newest_file"
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
Circuit is active. Try one of these to get started:

  /circuit:run fix: login form rejects valid emails       Bug fix with test-first discipline
  /circuit:run add dark mode support to the settings page  Router picks the right workflow
  /circuit:run decide: REST vs GraphQL for the new API     Adversarial evaluation of options

Circuit classifies your task into the right workflow (Explore, Build, Repair,
Migrate, Sweep), selects a rigor level, and runs it. You step in at checkpoints.
If a session crashes, the next one picks up where it stopped.
WELCOME
fi

#!/usr/bin/env bash
set -euo pipefail

if git rev-parse --show-toplevel >/dev/null 2>&1; then
  handoff_dir="$(git rev-parse --show-toplevel)"
else
  handoff_dir="$PWD"
fi
handoff_slug=$(printf '%s' "$handoff_dir" | tr '/' '-')
handoff_file="$HOME/.claude/projects/${handoff_slug}/handoff.md"

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
else
  # First run or no pending handoff -- show a brief welcome
  cat <<'WELCOME'
Circuitry is active. Try one of these to get started:

  /circuit fix: login form rejects valid emails       Bug fix with test-first discipline
  /circuit add dark mode support to the settings page  Triage picks the right workflow
  /circuit decide: REST vs GraphQL for the new API     Adversarial evaluation of options

Circuitry classifies your task, picks the right workflow (quick fix, full feature,
architecture decision, and more), and runs it. You step in at checkpoints. If a
session crashes, the next one picks up where it stopped.
WELCOME
fi

#!/usr/bin/env bash
# session-start.sh — Outputs the Flow plugin session banner as markdown
#
# Called by hooks.json on SessionStart. Checks prerequisites and lists
# available methods.

set -uo pipefail

# ── Prerequisite check: Codex CLI ─────────────────────────────────────
if ! command -v codex >/dev/null 2>&1; then
  cat <<'WARNING'
> **Warning: Codex CLI not found**
>
> The Flow plugin dispatches heavy implementation to Codex workers.
> Without `codex`, methods that use `manage-codex` will fail.
>
> Install it:
> ```
> npm install -g @openai/codex
> ```
>
> Then verify: `codex --version`

---

WARNING
fi

# ── Banner ────────────────────────────────────────────────────────────
cat <<'BANNER'
# Flow System Available

You have access to the **Flow** plugin — structured multi-phase workflows for complex engineering tasks.

## Available Methods

| Method | Invoke | Use When |
|--------|--------|----------|
| **Router** | `/method:router` | Unsure which method fits — routes to the best one |
| **Research-to-Implementation** | `/method:research-to-implementation` | Multi-file feature delivery with unclear approach |
| **Decision Pressure Loop** | `/method:decision-pressure-loop` | Architecture choices with real tradeoffs |
| **Spec Hardening** | `/method:spec-hardening` | Existing RFC/spec that needs to become build-ready |
| **Flow Audit & Repair** | `/method:flow-audit-and-repair` | Broken/flaky end-to-end flow that needs forensic repair |
| **Autonomous Ratchet** | `/method:autonomous-ratchet` | Overnight autonomous quality improvement |
| **Janitor** | `/method:janitor` | Systematic dead code/stale docs cleanup |
| **Method Create** | `/method:create` | Author a new method from a workflow description |
| **Dry Run** | `/method:dry-run` | Validate a method skill's mechanical soundness |

## How It Works

Methods produce **artifact chains** — each phase writes a durable file that feeds the next. Heavy implementation is dispatched to **Codex workers** via the `manage-codex` orchestrator.

The relay scripts (`compose-prompt.sh`, `update-batch.sh`) handle prompt assembly and batch state.

## Quick Start

1. Copy relay scripts to your project: `cp -r "$(claude plugin path flow)/scripts/relay" ./scripts/relay`
2. Ensure `codex` CLI is installed: `npm install -g @openai/codex`
3. Invoke a method: `/method:router <describe your task>`

Use `/manage-codex` to orchestrate Codex workers directly without a method wrapper.
BANNER

#!/usr/bin/env bash
# session-start.sh — Outputs the Circuit plugin session banner as markdown
#
# Called by hooks.json on SessionStart. Checks prerequisites and lists
# available circuits.

set -uo pipefail

# ── Prerequisite check: Codex CLI ─────────────────────────────────────
if ! command -v codex >/dev/null 2>&1; then
  cat <<'WARNING'
> **Warning: Codex CLI not found**
>
> The Circuit plugin dispatches heavy implementation to Codex workers.
> Without `codex`, circuits that use `manage-codex` will fail.
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
# Circuit System Available

You have access to the **Circuit** plugin — structured multi-phase workflows for complex engineering tasks.

## Available Circuits

| Circuit | Invoke | Use When |
|---------|--------|----------|
| **Router** | `/circuit:router` | Unsure which circuit fits — routes to the best one |
| **Research-to-Implementation** | `/circuit:research-to-implementation` | Multi-file feature delivery with unclear approach |
| **Decision Pressure Loop** | `/circuit:decision-pressure-loop` | Architecture choices with real tradeoffs |
| **Spec Hardening** | `/circuit:spec-hardening` | Existing RFC/spec that needs to become build-ready |
| **Flow Audit & Repair** | `/circuit:flow-audit-and-repair` | Broken/flaky end-to-end flow that needs forensic repair |
| **Autonomous Ratchet** | `/circuit:autonomous-ratchet` | Overnight autonomous quality improvement |
| **Janitor** | `/circuit:janitor` | Systematic dead code/stale docs cleanup |
| **Circuit Create** | `/circuit:create` | Author a new circuit from a workflow description |
| **Dry Run** | `/circuit:dry-run` | Validate a circuit skill's mechanical soundness |

## How It Works

Circuits produce **artifact chains** — each phase writes a durable file that feeds the next. Heavy implementation is dispatched to **Codex workers** via the `manage-codex` orchestrator.

The relay scripts (`compose-prompt.sh`, `update-batch.sh`) handle prompt assembly and batch state.

## Quick Start

1. Copy relay scripts to your project: `cp -r "$(claude plugin path circuit)/scripts/relay" ./scripts/relay`
2. Ensure `codex` CLI is installed: `npm install -g @openai/codex`
3. Invoke a circuit: `/circuit:router <describe your task>`

Use `/manage-codex` to orchestrate Codex workers directly without a circuit wrapper.
BANNER

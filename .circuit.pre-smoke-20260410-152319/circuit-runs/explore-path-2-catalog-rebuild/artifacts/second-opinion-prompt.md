# Second Opinion: Circuit Runtime Engine Integration

## Your Role

You are an independent systems architect reviewing an open design question for Circuit, a Claude Code plugin that provides multi-phase workflow orchestration. You have access to the full codebase. Read the files referenced below before forming opinions.

## Context

Circuit defines workflows as two files per workflow:
- `circuit.yaml` — machine-readable topology (steps, gates, routes, artifacts)
- `SKILL.md` — prose execution contract that Claude reads and follows at runtime

At runtime, Claude (the LLM) reads the SKILL.md and follows it line by line: writing artifacts, updating state, dispatching workers. There is no separate runtime process — Claude IS the executor.

## The Problem

Circuit has a **built, tested, but completely disconnected** event-sourcing engine. The engine exists at `scripts/runtime/engine/` and provides three CLI tools:

1. **`append-event.js`** — Appends typed events (step_started, gate_passed, artifact_written, etc.) to `events.ndjson`
2. **`derive-state.js`** — Deterministic projection: replays `events.ndjson` → `state.json`
3. **`resume.js`** — Reads state + manifest → determines exact resume point after a crash

The engine has 34 tests, validates against JSON schemas, and handles edge cases (stale state detection, rebuild-on-drift, route-aware resume). It is solid infrastructure.

**But nothing calls it.** No SKILL.md, no hook, no relay script ever invokes these CLIs. Instead, workflows persist state via a simpler mechanism:

- Claude directly writes/updates `active-run.md` (a markdown dashboard) after each phase
- On session resume, a SessionStart hook finds and injects the most recent `active-run.md`
- Claude reads the dashboard and picks up from the stated phase

This means the current resume model is "read the last snapshot" rather than "replay the event log."

## Files to Read

Read these files to understand both systems before providing guidance:

### The event engine (built but disconnected)
- `scripts/runtime/engine/src/append-event.ts` — event append logic
- `scripts/runtime/engine/src/derive-state.ts` — state projection from events
- `scripts/runtime/engine/src/resume.ts` — resume point determination
- `scripts/runtime/engine/src/derive-state.test.ts` — understand the state model
- `scripts/runtime/engine/src/resume.test.ts` — understand resume semantics
- `schemas/state.schema.json` — the state schema
- `schemas/event.schema.json` — the event schema

### The current execution model (what actually runs)
- `skills/build/SKILL.md` — a complete workflow. Note the "Update active-run.md" instructions at each phase transition. Note the absence of any append-event calls.
- `skills/build/circuit.yaml` — the topology that SHOULD correspond to the event engine's manifest
- `skills/run/SKILL.md` — the router that dispatches to workflows
- `hooks/session-start.sh` — how resume currently works (finds active-run.md)

### Architecture documentation
- `ARCHITECTURE.md` — especially "The Gate System" (§4), "Execution Model" (§3), and "The Artifact Chain Model" (§2)
- `docs/literate-guide.md` — especially §7 ("Runtime Execution Is an Artifact Chain Backed by Events"), §8 ("Resume and Continuity"), and §12 ("Runtime Flow and Maintenance Flow"). Note: §12's sequence diagram shows "Engine: append events, derive state, update active-run" as part of the runtime flow, but this is aspirational — the engine is never actually called.

### The relay/worker system
- `scripts/relay/dispatch.sh` — how workers are dispatched
- `scripts/relay/update-batch.sh` — deterministic batch.json state machine for the workers loop
- `skills/workers/SKILL.md` — the implement-review-converge loop

## Questions to Answer

1. **Should the event engine be wired into the execution path?** What would that buy us over the current active-run.md approach? Be specific about failure modes that active-run.md handles poorly and events.ndjson would handle well.

2. **If yes, how?** The executor is Claude following prose. There is no daemon process. The integration points are:
   - SKILL.md instructions (tell Claude to run bash commands at each transition)
   - Hooks (PreToolUse/PostToolUse could intercept file writes)
   - A wrapper script that SKILL.md calls instead of direct file writes
   - Something else?
   
   Evaluate each option for reliability, complexity, and Claude-execution overhead.

3. **If no, what should we do with the dormant infrastructure?** Options: remove it (dead code), keep it (future investment), or repurpose it (e.g., post-hoc analysis tool that reconstructs state from artifacts on disk without requiring runtime event logging).

4. **What are the tradeoffs?** Specifically:
   - active-run.md is a lossy snapshot vs. events.ndjson is a complete log. When does the lossiness actually matter?
   - Adding bash commands to every phase transition in every SKILL.md increases prose complexity and Claude execution overhead. Is the reliability gain worth the cost?
   - The event engine validates against schemas. active-run.md is unvalidated markdown. Does this matter for a single-user tool?
   - Circuit's `circuit.yaml` defines gates, but gates are currently enforced by Claude following prose instructions, not by the TypeScript engine. Would wiring in the event engine change this? Should it?

5. **Is there a middle path?** For example: keep active-run.md as the primary resume mechanism, but add event logging as an optional audit trail that doesn't affect the execution path. Or: use the event engine only for worker dispatch steps (where relay scripts already exist) and leave orchestrator steps prose-driven.

## Constraints

- This is a single-user power tool, not a multi-tenant platform
- Claude Code plugins have no daemon processes — only hooks (SessionStart, PreToolUse, PostToolUse) and skills (prose files Claude reads)
- The SKILL.md is the runtime authority. circuit.yaml is build-time metadata and resume infrastructure.
- Adding complexity to SKILL.md files has a real cost: more prose = more chance Claude drifts from the instructions
- The event engine is well-tested and works. The question is whether to connect it, not whether it's correct.

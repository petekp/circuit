# Circuit Catalog

Circuitry v3 has four circuits sharing a supergraph architecture. The primary
circuit (`run`) handles most tasks through triage classification into one of
seven workflow shapes. Companion circuits (`cleanup`, `migrate`) handle tasks
with specialized topologies. The `workers` skill provides the dispatch
backbone for all circuits.

## Quick Reference

| Circuit | Invoke | Best For |
|---------|--------|----------|
| Run | `/circuit <task>` | Any task: triage classifies into quick, researched, adversarial, spec-review, ratchet, or crucible |
| Cleanup | `/circuit:cleanup` | Systematic dead code, stale docs, orphaned artifacts |
| Migrate | `/circuit:migrate` | Framework swaps, dependency replacements, architecture transitions |
| Workers | `/circuit:workers` | Direct worker dispatch for batch orchestration |

## Circuit Details

### Run

**Invoke:** `/circuit <task>` or `/circuit:run <task>`
**Steps:** 43 (supergraph -- only active-path steps are visited per run)
**Entry modes:** default, quick, researched, adversarial, spec-review, ratchet, crucible

The primary entry point for all Circuitry work. Triage classifies your task
into one of seven workflow shapes, then the runtime engine walks only the
active path. Steps on inactive paths are never visited.

**Intent hints** skip triage and lock a specific mode:

| Prefix | Mode | Description |
|--------|------|-------------|
| `fix:` | quick + bug augmentation | Known bugs with test-first discipline |
| `decide:` | adversarial | Architecture decisions under real uncertainty |
| `develop:` | researched | Non-trivial feature with research phase |
| `repair:` | researched + bug augmentation | Multi-system debugging |
| `migrate:` | redirect | Redirects to `circuit:migrate` |
| `cleanup:` | redirect | Redirects to `circuit:cleanup` |

**Artifact chains by mode:**

- **Quick:** `triage-result.md` -> `scope.md` -> `scope-confirmed.md` -> `implementation-handoff.md` -> `done.md`
- **Researched:** `triage-result.md` -> `external-digest.md` + `internal-digest.md` -> `constraints.md` -> `scope.md` -> `scope-confirmed.md` -> `implementation-handoff.md` -> `review-findings.md` -> `done.md`
- **Adversarial:** `triage-result.md` -> digests -> `constraints.md` -> `options.md` -> `decision-packet.md` -> `adr.md` -> `execution-packet.md` -> `seam-proof.md` -> `implementation-handoff.md` -> `ship-review.md` -> `done.md`
- **Spec-review:** `spec-brief.md` -> `draft-digest.md` -> 3 reviews -> `caveat-resolution.md` -> `amended-spec.md` -> `execution-packet.md` -> `seam-proof.md` -> `implementation-handoff.md` -> `ship-review.md` -> `done.md`
- **Ratchet:** 17 steps across 6 phases. See `references/workflow-ratchet.md`
- **Crucible:** 7 steps. Adversarial tournament for competing approaches. See `references/workflow-crucible.md`

**Example:** You ask `/circuit add pagination to the user list`. Triage
classifies this as "Feature Build" (quick mode). The circuit scopes the
change, shows you the plan for confirmation, dispatches workers to implement
with independent review, and produces a done summary.

**Example:** You ask `/circuit decide: should we use WebSockets or SSE for
real-time updates?`. The intent hint locks adversarial mode. The circuit
gathers external and internal evidence in parallel, synthesizes constraints,
generates distinct options, pressure-tests them via adversarial evaluation,
and presents a decision packet for your tradeoff selection.

---

### Cleanup

**Invoke:** `/circuit:cleanup` or `/circuit:cleanup --auto`
**Steps:** 8 across 5 phases: Survey -> Triage -> Prove -> Clean -> Verify
**Entry modes:** default (interactive), auto (autonomous)

Systematic codebase cleanup with false-positive protection at every gate.
Every removal must be backed by evidence, not intuition. Five parallel
category workers scan for dead code, stale docs, orphaned artifacts,
vestigial comments, and redundant abstractions. Triage classifies each
finding by confidence x risk. Evidence adjudication proves items dead before
removal. Batch execution removes items in risk-ordered batches with build/test
verification after each.

**Artifact chain:** `cleanup-scope.md` -> `survey-inventory.md` -> `triage-report.md` -> `evidence-log.md` -> `cleanup-batches.md` -> `verification-report.md` (+ `deferred-review.md` in autonomous mode)

**Example:** After the v3 migration you have 10 deleted circuit directories,
stale documentation references, and orphaned config files. The cleanup circuit
surveys systematically, triages by confidence and risk, proves each item is
genuinely dead, and removes in safe batches.

---

### Migrate

**Invoke:** `/circuit:migrate`
**Steps:** 7 across 5 phases: Scope -> Inventory -> Strategy -> Execution -> Verification
**Entry modes:** default (interactive)

Large-scale migrations where old and new must coexist during the transition.
The key differentiator from `circuit:run` is the coexistence plan: a
first-class artifact that defines adapter/bridge patterns, rollback
procedures, and batch ordering before any code moves. Each batch is
independently verifiable. If batch N fails, batches 1 through N-1 remain valid.

**Artifact chain:** `migration-brief.md` -> `dependency-inventory.md` + `risk-assessment.md` -> `coexistence-plan.md` -> `migration-steer.md` -> `batch-log.md` -> `verification-report.md` -> `cutover-report.md`

**Example:** You need to swap Express for Fastify. The circuit maps every
dependency, classifies risk, designs a coexistence strategy with adapters,
gets your approval on batch order, migrates in risk-ordered batches with
verification, and produces a cutover report.

---

### Workers

**Invoke:** `/circuit:workers` or dispatched by other circuits
**Type:** Utility skill (not a standalone circuit)

The batch orchestrator that powers all circuit dispatch steps. Manages the
implement -> review -> converge cycle with independent worker sessions.
Supports Codex CLI (preferred) or Claude Code Agent (fallback) as the
dispatch backend.

Workers is not typically invoked directly. It provides the execution backbone
that `circuit:run`, `circuit:cleanup`, and `circuit:migrate` use for their
dispatch steps.

---

### Handoff

**Invoke:** `/circuit:handoff`
**Type:** Utility skill (not a standalone circuit)

Saves session state to disk so a fresh session can resume automatically. Use
when context is getting heavy, the user asks for a handoff, or you need to
preserve progress before a session boundary.

`/circuit:handoff done` clears a pending handoff after the resumed work is
complete.

---
name: migrate
description: >
  Large-scale migrations: framework swaps, dependency replacements, architecture
  transitions, incremental rewrites. Coexistence and rollback are first-class.
  Phases: Frame -> Inventory -> Coexistence plan -> Batch execution -> Verify
  -> Cutover review -> Close. Uses Build as the inner executor for batches, with
  plan/execute/review loops controlled by the circuit.
trigger: >
  Use for /circuit:migrate, or when circuit:run routes here.
---

# Migrate

Framework swaps, dependency replacements, architecture transitions, incremental rewrites.
The migration workflow.

## Phases

Frame -> Analyze (Inventory) -> Plan (Coexistence) -> Act (Batches) -> Verify -> Review (Cutover) -> Close

## Entry

The router passes: task description, rigor profile (Standard, Deep, Autonomous).
YAML entry modes are `standard`, `default`, and `autonomous`; `default` maps to
Deep rigor. Default rigor: Deep.

**Direct invocation:** When invoked directly via `/circuit:migrate` (not through
the router), bootstrap the run root if one does not already exist:

Derive `RUN_SLUG` from the task description: lowercase, replace spaces and
special characters with hyphens, collapse consecutive hyphens, trim to 50
characters. Example: "Migrate Auth to OAuth2" produces `migrate-auth-to-oauth2`.

```bash
RUN_SLUG="migrate-auth-to-oauth2"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
```

Write initial `${RUN_ROOT}/artifacts/active-run.md` with Workflow=Migrate,
Rigor=Deep (or as specified), Current Phase=frame. If the router already set
up the run root, skip bootstrap and proceed to the current phase.

## Phase: Frame

Write `artifacts/brief.md`:

```markdown
# Brief: <migration>
## Objective
<what is being migrated and why>
## Scope
<what is in scope for this migration>
## Output Types
<code, tests, docs, config -- check all that apply>
## Success Criteria
<what "migration complete" looks like, measurably>
## Constraints
<hard invariants>
## Verification Commands
<exact commands to prove success>
## Out of Scope
<what we are NOT migrating>
## Coexistence Requirements
<what old and new must share during transition: data, state, routes, APIs>
## Rollback Requirements
<how far back must we be able to revert? at what granularity?>
## Forcing Function
<why now? timeline pressure?>
```

The Coexistence Requirements and Rollback Requirements sections are mandatory for
Migrate. They do not appear in other workflows' brief.md.

**Gate:** brief.md exists with non-empty Objective, Coexistence Requirements, Rollback Requirements, Success Criteria, Verification Commands.

Update `active-run.md`: phase=frame, next step=Inventory.

## Phase: Analyze (Inventory)

Map all dependencies on the migration target and classify by risk.

Dispatch two parallel workers:

```bash
mkdir -p "${RUN_ROOT}/phases/inventory-scan/reports" "${RUN_ROOT}/phases/inventory-scan/last-messages"
mkdir -p "${RUN_ROOT}/phases/inventory-risk/reports" "${RUN_ROOT}/phases/inventory-risk/last-messages"
```

**Worker A -- Dependency Scan** (role: `--role researcher`):
- Mission: Exhaustively map all code that depends on the migration target. Every import,
  call site, config reference, test dependency, transitive dependency. Exact file paths
  and function/symbol references.
- Input: brief.md
- Output: dependency scan document

**Worker B -- Risk Assessment** (role: `--role researcher`):
- Mission: Classify every dependency by migration difficulty (trivial/moderate/complex)
  and risk (data loss, behavior change, performance regression, API breakage).
- Input: brief.md
- Output: risk classification document

Compose and dispatch both:

```bash
# Pick 1-2 domain skills matching the migration target. Omit --skills if none apply.
for w in scan risk; do
  "$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
    --header "${RUN_ROOT}/phases/inventory-${w}/prompt-header.md" \
    --skills "rust,tdd" \
    --root "${RUN_ROOT}/phases/inventory-${w}" \
    --out "${RUN_ROOT}/phases/inventory-${w}/prompt.md"

  "$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
    --prompt "${RUN_ROOT}/phases/inventory-${w}/prompt.md" \
    --output "${RUN_ROOT}/phases/inventory-${w}/last-messages/last-message.txt" \
    --circuit migrate \
    --role researcher
done
```

Synthesize into `artifacts/inventory.md`:

```markdown
# Inventory: <migration target>
## Dependencies
| # | Name | Path | Type | Current | Target | Risk | Difficulty | Notes |
## Risk Matrix
### Trivial (mechanical, low risk)
### Moderate (logic changes, medium risk)
### Complex (behavior changes, high risk)
## Recommended Migration Order
<trivial first, complex last>
## Dependencies Requiring Manual Review
## Coexistence Constraints Discovered
<additional constraints not in brief.md>
```

If a worker only wrote `reports/report.md`, synthesize the inventory manually.

**Gate:** inventory.md exists. Every dependency has exact file/function reference, difficulty, and risk classification.

Update `active-run.md`: phase=inventory, next step=Coexistence plan.

## Phase: Plan (Coexistence)

Design how old and new coexist, define batch order and rollback boundaries.

Read brief.md and inventory.md. Write `artifacts/plan.md`:

```markdown
# Plan: <migration>
## Coexistence Strategy
<adapter/bridge, feature flags, routing, or hybrid -- be specific>
## Adapter/Bridge Specification
<if applicable: what adapts, interface shape, ownership>
## Shared State Management
<how old and new share data/state during transition>
## Slices (Batch Definitions)
### Batch 1: <name> (lowest risk)
<what migrates, adapter changes, verification, rollback procedure>
### Batch 2: <name>
<same structure>
### Batch N: <name> (highest risk)
<same structure>
## Verification Commands
<per-batch: commands that prove old+new both pass>
## Rollback Triggers
<per-batch: conditions that mean "stop and revert this batch">
## Per-Batch Rollback Procedure
<exact steps to revert each batch independently>
## Cutover Criteria
<when to remove the old system entirely>
## Adjacent-Output Checklist
- [ ] Tests: migration tests for each batch?
- [ ] Docs: architecture docs updated for new system?
- [ ] Config: config for both old and new?
- [ ] Migrations: data/schema migrations needed?
- [ ] Observability: monitoring during coexistence?
- [ ] Compatibility: API versioning during transition?
```

**Checkpoint:** This is the main migration steering checkpoint. In interactive
runs, present the plan and ask:

> Here is the coexistence plan and batch order.
> 1. Does the coexistence strategy match how your system works?
> 2. Does the batch order feel right?
> 3. Are the rollback procedures realistic?
> 4. Any scope cuts or batches to defer?

If the checkpoint response is `adjust`, revise `plan.md` and stay in Plan. Only
move to Execute on `continue`. `autonomous` mode does not skip this checkpoint.

**Gate:** plan.md exists with explicit coexistence strategy, batch definitions with risk-first ordering, per-batch rollback procedures, verification commands, cutover criteria.

Update `active-run.md`: phase=plan, next step=Batch execution.

## Phase: Act (Batch Execution)

Execute batches in order. Each batch uses workers (implement -> review -> converge).

**Per-batch setup:**

For each batch defined in plan.md, create a numbered batch directory and dispatch:

```bash
# N is the 1-based batch index from plan.md (batch-1, batch-2, etc.)
BATCH_ROOT="${RUN_ROOT}/phases/batch-1"
mkdir -p "${BATCH_ROOT}/archive" "${BATCH_ROOT}/reports" "${BATCH_ROOT}/last-messages"
```

Write `${BATCH_ROOT}/CHARTER.md` with the batch definition from plan.md.

Prepare the adapter handoff:

```bash
# Keep the parent-owned workspace minimal and typed.
touch "${BATCH_ROOT}/jobs/execute-1.request.json"
```

Then hand off to the `workers` internal adapter with:
- 0-2 domain skills for the migration target
- per-batch verification commands and rollback triggers
- the success criteria for the execute step
- the expectation that `workers` owns prompt assembly, batch slicing, review,
  and convergence inside the child root

Do **not** pass `workers` via `--skills`. `workers` is the internal adapter.
Parent migration steps read only the public contract files:
- `jobs/{step_id}-{attempt}.request.json`
- `jobs/{step_id}-{attempt}.receipt.json`
- `jobs/{step_id}-{attempt}.result.json`
- `reports/report-converge.md`
- `reports/report-{slice_id}.md`

**After each batch:**
1. Verify old+new both pass (run verification commands)
2. If a batch fails, follow the execute-step routes rather than inventing a new branch
   - `coexistence_invalidated`: route back to Plan, revise `plan.md`, then resume Execute from the failed batch
   - Any other non-pass result: retry within the execute-step budget (max 3 attempts), then escalate
3. Record batch result. `partial` is acceptable only when the remaining work is explicitly deferred and the approved coexistence plan still holds.

**Mandatory re-evaluation after each batch:** Before proceeding to the next batch,
check: did this batch reveal anything that changes the plan for remaining batches?
If yes, update plan.md before continuing.

**Gate:** All approved batches executed. Each batch verified (old+new pass). Coexistence intact.

Update `active-run.md`: phase=execute, next step=Verify.

## Phase: Verify

Dispatch a verification worker:

```bash
step_dir="${RUN_ROOT}/phases/verify"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

Mission: Run full test suite, scan for leftover references to old system (imports,
config, variables, comments, docs), verify no dual-system artifacts remain unless
explicitly deferred. Diagnose only -- no code changes.

**Gate:** Full test suite passes. Leftovers cataloged.

Update `active-run.md`: phase=verify, next step=Review.

## Phase: Review (Cutover)

Dispatch a cutover reviewer:

```bash
step_dir="${RUN_ROOT}/phases/review"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

Write `artifacts/review.md`:

```markdown
# Review: <migration>
## Migration Completeness
<all batches vs plan>
## Coexistence Scaffolding Status
<what remains, what can be removed>
## Findings
### Critical (must fix before cutover)
### High (should fix)
### Low (acceptable debt)
## Leftover References
<old system references found>
## Rollback Assessment
<is rollback still possible? still needed?>
## Documentation Updates
<what docs need updating>
## Verdict: CLEAN | ISSUES FOUND
```

**Gate:** Close only when the review worker returns `ready`, `ship_ready`, or
`clean`. If it returns `revise`, route back to Execute, then Verify, then Review
again (max 2 review attempts).

Update `active-run.md`: phase=review, next step=Close on pass, Execute on revise.

## Phase: Close

Write `artifacts/result.md`:

```markdown
# Result: <migration>
## Changes
<what was migrated, files affected>
## Batches Completed
<batch summary with verification results>
## Coexistence Scaffolding
<what was removed, what remains (with justification)>
## Verification
<full test suite results>
## Residual Risks / Debt
## Leftovers Deferred
<old system references intentionally kept, with rationale>
## Follow-ups
<coexistence teardown tasks, docs updates, monitoring to add>
## PR Summary
### Title
refactor: migrate <old> to <new>
### Summary
<what was migrated, batch count, verification results>
### Test Plan
- Full suite: PASS
- Old system references: <removed | N deferred>
- Coexistence scaffolding: <removed | N items remain>
```

**Gate:** result.md exists with Changes, Batches Completed, Verification, PR Summary.

Update `active-run.md`: phase=close.

## Principles

- **Coexistence is first-class.** Old and new run simultaneously. The plan defines how.
- **Each batch is independently verifiable.** If batch N fails, batches 1 through N-1 remain valid.
- **Rollback is documented and verified.** Every batch boundary is a safe rollback point.
- **Risk drives ordering.** Trivial first, complex last.
- **Build is the inner executor.** Each batch is essentially a Build run with stronger safety rules.
- **Re-evaluate after each batch.** Don't blindly execute the plan if reality diverges.

## Circuit Breakers

Escalate when:
- Coexistence strategy proves unworkable (don't iterate, escalate)
- Batch fails and coexistence plan cannot accommodate the failure
- Cutover review returns ISSUES FOUND with critical after 2 attempts
- Migration target is more entangled than inventory showed (reopen from Inventory)
- Dispatch step fails twice

## Resume

Check artifacts in chain order:
1. brief.md missing -> Frame
2. inventory.md missing -> Inventory
3. plan.md missing -> Coexistence plan
4. Check batch state -> Batch execution (resume from first incomplete batch)
5. review.md missing -> Review
6. result.md missing -> Close
7. All present -> complete

---
name: circuit:migrate
description: >
  Artifact-driven circuit for large-scale migrations and refactors — framework swaps,
  dependency replacements, architecture transitions, and incremental rewrites.
  8 steps across 5 phases: Scope -> Inventory -> Strategy -> Execution -> Verification.
  Use when migrating between frameworks, replacing dependencies, transitioning
  architectures, or doing incremental rewrites where old and new must coexist.
  Not for greenfield features, bug fixes, or single-file refactors.
---

# Migrate Circuit

An artifact-centric workflow that chains migration brief -> dependency inventory +
risk assessment -> coexistence plan -> batched execution -> verification -> cutover.
The key differentiator from `circuit:develop` is dual-system coexistence: old and new
run simultaneously during the transition, each batch is independently verifiable, and
rollback is a first-class concern at every stage.

## When to Use

- Framework swaps (e.g., React class components to hooks, Express to Fastify)
- Dependency replacements (e.g., Moment.js to date-fns, REST to GraphQL)
- Architecture transitions (e.g., monolith to services, MVC to hexagonal)
- Incremental rewrites where old and new must coexist during the transition
- Any migration where rollback must be possible at every batch boundary

Do NOT use for greenfield features, bug fixes, config changes, single-file refactors,
or tasks where no dual-system coexistence is needed.

## Glossary

- **Artifact** -- A canonical circuit output file in `${RUN_ROOT}/artifacts/`. These are the
  durable chain. Each step produces exactly one artifact (or a parallel pair).
- **Worker handoff** -- The raw output a Codex worker writes to its relay `handoffs/` directory.
  Worker handoffs are inputs to artifact synthesis, not artifacts themselves.
- **Prompt header** -- A self-contained file the orchestrator writes before dispatch. Contains
  the full worker contract: mission, inputs, output path, output schema, success criteria.
- **Synthesis** -- When the orchestrator (Claude session) reads prior artifacts and writes a
  new artifact directly, without dispatching a worker.
- **Coexistence** -- The period during migration when old and new systems run simultaneously.
  The coexistence plan defines adapter/bridge patterns, feature flags, or routing strategies
  that make this safe.
- **Batch** -- An ordered group of dependencies migrated together. Each batch is independently
  verifiable: if batch 3 fails, batches 1-2 remain valid.

## Principles

- **Artifacts, not activities.** Every step produces a concrete file. No step exits
  without writing its output artifact.
- **Self-contained headers.** Dispatch steps do NOT use `--template`. The prompt header
  carries the full worker contract: mission, inputs, output schema, success criteria,
  and handoff instructions.
- **Coexistence is a first-class artifact.** Step 4 produces the coexistence plan before
  any code moves. This is not an afterthought bolted onto the execution phase.
- **Each batch is independently verifiable.** If batch N fails, batches 1 through N-1
  are still valid and the system is in a known state.
- **Rollback is documented and verified.** The migration brief captures rollback requirements;
  the coexistence plan verifies them; every batch boundary is a safe rollback point.
- **Risk drives ordering.** Trivial dependencies migrate first, complex last. The risk
  assessment directly determines the batch sequence.

## Setup

```bash
RUN_SLUG="<migration-slug>"
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts"
```

Record `RUN_ROOT` -- all paths below are relative to it.

**Per-step scaffolding** -- before each dispatch step, create:
```bash
step_dir="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${step_dir}/handoffs" "${step_dir}/last-messages"
```

## Domain Skill Selection

When a step says `<domain-skills>`, pick 1-2 skills matching the affected code.
Never exceed 3 total skills per dispatch. For Step 6, because `manage-codex` is
already required, pick at most 2 domain skills.

## Canonical Header Schema

Every dispatch step's prompt header MUST include these fields:

```markdown
# Step N: <title>

## Mission
[What the worker must accomplish]

## Inputs
[Full text or digest of consumed artifacts]

## Output
- **Path:** [exact path where the worker must write its primary artifact]
- **Schema:** [required sections/headings in the output]

## Success Criteria
[What "done" looks like for this step]

## Handoff Instructions
Write your primary output to the path above. Also write a standard handoff to
`handoffs/handoff.md` with these exact section headings:

### Files Changed
### Tests Run
### Verification
### Verdict
### Completion Claim
### Issues Found
### Next Steps
```

**Why these headings matter:** `compose-prompt.sh` checks for `### Files Changed`,
`### Tests Run`, and `### Completion Claim` in the assembled prompt. If missing, it
appends `relay-protocol.md` which contains unresolved `{slice_id}` placeholders.
Including these headings in the header prevents that contamination.

---

## Phase 1: Scope

### Step 1: Migration Brief -- `interactive`

**Objective:** Define the migration target, constraints, rollback requirements, and
success criteria before any inventory or planning starts.

Ask the user (via AskUserQuestion):

> Describe the migration you want to perform. Then answer:
> 1. What is being migrated (framework, dependency, architecture pattern)?
> 2. Why is the migration happening now? What is the forcing function?
> 3. What must old and new systems share during the transition (data, state, routes, APIs)?
> 4. What are the rollback requirements? How far back must we be able to revert?
> 5. What is the timeline pressure, if any?
> 6. What is explicitly out of scope for this migration?
> 7. What exact result lets us say the migration is done?

Write their response to `${RUN_ROOT}/artifacts/migration-brief.md`:

```markdown
# Migration Brief
## Migration Target
## Motivation and Forcing Function
## Coexistence Constraints
## Rollback Requirements
## Timeline Pressure
## Out of Scope
## Success Criteria
## Known Risks
```

**Gate:** `migration-brief.md` exists with non-empty Migration Target, Rollback
Requirements, Success Criteria, and Coexistence Constraints.

**Failure mode:** The team migrates the wrong surface, underestimates coexistence
complexity, or has no rollback plan when a batch fails.

---

## Phase 2: Inventory

### Steps 2-3: Dependency Scan + Risk Assessment -- `dispatch` (parallel)

**Objective:** Map all code that depends on the migration target (Step 2), and classify
each dependency by migration difficulty and risk (Step 3).

Dispatch two Codex workers in parallel. Each header is self-contained (no `--template`).

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-2a/handoffs" "${RUN_ROOT}/phases/step-2a/last-messages"
mkdir -p "${RUN_ROOT}/phases/step-2b/handoffs" "${RUN_ROOT}/phases/step-2b/last-messages"
```

**Worker A header** (`${RUN_ROOT}/phases/step-2a/prompt-header.md`):
Include the canonical header schema with:
- Mission: Exhaustively map all code that depends on the migration target. Every import,
  call site, config reference, test dependency, and transitive dependency must be catalogued
  with exact file paths and function/symbol references.
- Inputs: Full text of `migration-brief.md`
- Output path: `${RUN_ROOT}/phases/step-2a/dependency-inventory.md`
- Output schema:
  ```markdown
  # Dependency Inventory
  ## Migration Target Summary
  ## Direct Dependencies (file:function/symbol)
  ## Transitive Dependencies
  ## Config and Build References
  ## Test Dependencies
  ## Documentation References
  ## Total Dependency Count
  ```
- Success criteria: Every dependency has an exact file path and function/symbol reference.
  No dependency is described generically.
- Handoff: `handoffs/handoff.md`

**Worker B header** (`${RUN_ROOT}/phases/step-2b/prompt-header.md`):
Include the canonical header schema with:
- Mission: Classify every dependency from the codebase by migration difficulty
  (trivial/moderate/complex) and risk category (data loss, behavior change, performance
  regression, API breakage). Note: Worker B can discover dependencies independently
  since it reads the same migration brief; the orchestrator will reconcile with Worker A's
  inventory during promotion.
- Inputs: Full text of `migration-brief.md`
- Output path: `${RUN_ROOT}/phases/step-2b/risk-assessment.md`
- Output schema:
  ```markdown
  # Risk Assessment
  ## Difficulty Classification
  ### Trivial (mechanical find-replace or adapter swap)
  ### Moderate (logic changes, test updates, minor API differences)
  ### Complex (behavior changes, data model shifts, cross-boundary rewiring)
  ## Risk Categories
  ### Data Loss Risk
  ### Behavior Change Risk
  ### Performance Regression Risk
  ### API Breakage Risk
  ## Recommended Migration Order (trivial first, complex last)
  ## Dependencies Requiring Manual Review
  ```
- Success criteria: Every discovered dependency is classified by both difficulty and risk.
  The recommended migration order is explicit.
- Handoff: `handoffs/handoff.md`

**Dispatch (no --template):**
```bash
./scripts/relay/compose-prompt.sh \
  --header ${RUN_ROOT}/phases/step-2a/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-2a \
  --out ${RUN_ROOT}/phases/step-2a/prompt.md

cat ${RUN_ROOT}/phases/step-2a/prompt.md | \
  codex exec --full-auto \
  -o ${RUN_ROOT}/phases/step-2a/last-messages/last-message.txt -
```

```bash
./scripts/relay/compose-prompt.sh \
  --header ${RUN_ROOT}/phases/step-2b/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-2b \
  --out ${RUN_ROOT}/phases/step-2b/prompt.md

cat ${RUN_ROOT}/phases/step-2b/prompt.md | \
  codex exec --full-auto \
  -o ${RUN_ROOT}/phases/step-2b/last-messages/last-message.txt -
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-2a/dependency-inventory.md
test -f ${RUN_ROOT}/phases/step-2b/risk-assessment.md
cp ${RUN_ROOT}/phases/step-2a/dependency-inventory.md ${RUN_ROOT}/artifacts/dependency-inventory.md
cp ${RUN_ROOT}/phases/step-2b/risk-assessment.md ${RUN_ROOT}/artifacts/risk-assessment.md
```

If a worker only wrote `handoffs/handoff.md`, the orchestrator reads it and synthesizes
the artifact manually using the schema above.

**Gate:** Both artifacts exist. Every dependency has an exact file/function reference.
Every dependency is classified by difficulty and risk.

**Failure mode:** Missing dependencies surface mid-migration and invalidate batch boundaries.

---

## Phase 3: Strategy

### Step 4: Coexistence Plan -- `synthesis`

**Objective:** Design how old and new systems run simultaneously during the transition.
This is the defining artifact of the migrate circuit.

The orchestrator reads `artifacts/migration-brief.md`, `artifacts/dependency-inventory.md`,
and `artifacts/risk-assessment.md` and writes `${RUN_ROOT}/artifacts/coexistence-plan.md`:

```markdown
# Coexistence Plan
## Coexistence Strategy (adapter/bridge, feature flags, routing, or hybrid)
## Adapter/Bridge Specification
## Shared State Management
## Batch Definitions
## Batch Order (risk-driven: trivial first, complex last)
## Per-Batch Rollback Procedure
## Verification Strategy (how to prove old+new pass after each batch)
## Cutover Criteria (when to remove the old system)
## Known Coexistence Risks
```

The coexistence strategy must address every constraint from `migration-brief.md`. The batch
order must follow the risk assessment's recommended migration order. Each batch must define
what gets migrated, what adapter/bridge changes are needed, and how to verify that both
old and new pass.

**Gate:** `coexistence-plan.md` has an explicit coexistence strategy, batch definitions with
risk-first ordering, per-batch rollback procedures verified against `migration-brief.md`
requirements, and a verification strategy.

**Failure mode:** The team starts migrating code without a plan for how old and new coexist,
leading to a half-migrated state that neither works nor rolls back cleanly.

### Step 5: Migration Steer -- `interactive`

**Objective:** Let the user review and approve the coexistence strategy and batch order
before any code moves.

Present `coexistence-plan.md` and `risk-assessment.md` to the user. Ask (via AskUserQuestion):

> Here is the coexistence plan and batch migration order.
>
> 1. Does the coexistence strategy (adapter/bridge/flags/routing) match how your system works?
> 2. Does the batch order feel right? Should any dependency move earlier or later?
> 3. Are the per-batch rollback procedures realistic for your deployment pipeline?
> 4. What scope cuts are you willing to make if a complex batch proves harder than expected?
> 5. Any batches you want to defer to a later migration pass?

Write their response to `${RUN_ROOT}/artifacts/migration-steer.md`:

```markdown
# Migration Steer
## Approved Coexistence Strategy
## Approved Batch Order (with any user adjustments)
## Scope Cuts
## Deferred Batches
## Rollback Confidence
## Escalation Triggers
```

**Gate:** `migration-steer.md` exists with explicit approval of the batch order and
coexistence strategy. Any scope cuts are named.

**Failure mode:** Migration proceeds with a batch order or coexistence strategy the user
would have rejected, causing rework after code has already moved.

---

## Phase 4: Execution

### Step 6: Batch Migration -- `dispatch` (via manage-codex)

**Objective:** Execute the migration in ordered batches. Each batch: migrate code, update
tests, verify old+new pass, commit.

This step delegates to the `manage-codex` skill for the full implement -> review ->
converge cycle. The orchestrator must create the manage-codex workspace explicitly.

**Adapter contract:**

```bash
MIGRATION_ROOT="${RUN_ROOT}/phases/step-6"
mkdir -p "${MIGRATION_ROOT}/archive" "${MIGRATION_ROOT}/handoffs" \
  "${MIGRATION_ROOT}/last-messages" "${MIGRATION_ROOT}/review-findings"
```

1. **Create CHARTER.md** from the coexistence plan, migration steer, and risk assessment:
   ```bash
   {
     cat "${RUN_ROOT}/artifacts/coexistence-plan.md"
     printf '\n\n'
     cat "${RUN_ROOT}/artifacts/migration-steer.md"
     printf '\n\n'
     cat "${RUN_ROOT}/artifacts/risk-assessment.md"
   } > "${MIGRATION_ROOT}/CHARTER.md"
   ```

2. **Write the manage-codex prompt header** at `${MIGRATION_ROOT}/prompt-header.md`:
   Use the canonical header schema with:
   - Mission: Execute the batched migration described in CHARTER.md using the manage-codex
     implement -> review -> converge cycle. Each batch is one or more slices. After each
     batch, verify that both old and new systems pass. Respect batch order from the
     coexistence plan.
   - Inputs: Full text of `coexistence-plan.md`, `migration-steer.md`, and `risk-assessment.md`
     (already combined into CHARTER.md)
   - Output path: `${MIGRATION_ROOT}/handoffs/handoff-converge.md`
   - Output schema: manage-codex convergence handoff format
   - Success criteria: All approved batches converged with `COMPLETE AND HARDENED` verdict.
     Each batch verified that old+new pass before proceeding to the next.
   - Handoff: Standard relay handoff headings (`### Files Changed`, `### Tests Run`,
     `### Completion Claim`) to prevent relay-protocol.md contamination
   - Also reference: domain skills and verification commands from the coexistence plan

3. **Compose and dispatch:**
   ```bash
   ./scripts/relay/compose-prompt.sh \
     --header ${MIGRATION_ROOT}/prompt-header.md \
     --skills manage-codex,<domain-skills> \
     --root ${MIGRATION_ROOT} \
     --out ${MIGRATION_ROOT}/prompt.md

   cat ${MIGRATION_ROOT}/prompt.md | \
     codex exec --full-auto \
     -o ${MIGRATION_ROOT}/last-messages/last-message-manage-codex.txt -
   ```

4. **After manage-codex completes**, the orchestrator synthesizes `batch-log.md`:

   **Source artifacts (read in this order):**
   - `${MIGRATION_ROOT}/handoffs/handoff-converge.md` -- the convergence verdict (primary source)
   - `${MIGRATION_ROOT}/batch.json` -- slice metadata showing what was built
   - The last implementation slice handoff at `${MIGRATION_ROOT}/handoffs/handoff-<last-slice-id>.md`
     (find the slice id from `batch.json`)

   Note: manage-codex review workers may overwrite per-slice handoff files. If a slice
   handoff is missing or appears to be a review artifact, use `batch.json` slice metadata
   and the convergence handoff to reconstruct what was built.

   **Write** `${RUN_ROOT}/artifacts/batch-log.md` with:
   ```markdown
   # Batch Log
   ## Batches Completed
   ## Per-Batch Summary (what migrated, tests updated, old+new verification)
   ## Coexistence Status (adapter/bridge still intact?)
   ## Files Changed
   ## Tests Added or Updated
   ## Convergence Verdict
   ## Open Issues
   ```

   **Gate (evidence-reopen):** If a batch invalidates the coexistence plan (e.g., the
   adapter/bridge pattern cannot accommodate this batch, or old+new verification fails
   in a way the plan did not anticipate):
   - Record the governing issue in `batch-log.md` under `## Coexistence Invalidation`
   - Reopen Step 4 (Coexistence Plan) with the governing issue as additional input
   - The orchestrator updates `coexistence-plan.md` and returns to Step 6 with a revised plan

   If convergence says `ISSUES REMAIN` and the coexistence plan is still valid, the
   manage-codex loop should have addressed them -- escalate to the user if it did not.

**Failure mode:** A batch breaks coexistence and the circuit pushes forward instead of
revising the plan, leaving a half-migrated state that neither old nor new system handles.

---

## Phase 5: Verification

### Step 7: Full Verification -- `dispatch`

**Objective:** Run the complete test suite, check for leftover references to the old system,
and verify no dual-system artifacts remain.

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-7/handoffs" "${RUN_ROOT}/phases/step-7/last-messages"
```

**Header** (`${RUN_ROOT}/phases/step-7/prompt-header.md`):
Include the canonical header schema with:
- Mission: Run the full test suite, exhaustively scan for leftover references to the old
  system (imports, config keys, variable names, comments, documentation), and verify that
  no dual-system artifacts (adapters, bridges, feature flags, routing shims) remain unless
  explicitly deferred.
- Inputs: Full `migration-brief.md`, full `dependency-inventory.md`, full `batch-log.md`
- Output path: `${RUN_ROOT}/phases/step-7/verification-report.md`
- Output schema:
  ```markdown
  # Verification Report
  ## Full Test Suite Results
  ## Leftover Reference Scan
  ### Old Imports Still Present
  ### Old Config Keys Still Present
  ### Old Variable/Symbol Names Still Present
  ### Old System References in Comments/Docs
  ## Dual-System Artifact Scan
  ### Adapters/Bridges Still Present
  ### Feature Flags Still Active
  ### Routing Shims Still Present
  ## Deferred Items (explicitly accepted)
  ## Verdict: CLEAN / LEFTOVERS FOUND
  ```
- Success criteria: Full test suite passes. Every leftover reference is either removed or
  explicitly deferred. No surprise dual-system artifacts.
- Handoff: `handoffs/handoff.md`

**Dispatch:** Same compose-prompt + codex exec pattern as Step 2, with
`--header ${RUN_ROOT}/phases/step-7/prompt-header.md`,
`--skills <domain-skills>`,
`--root ${RUN_ROOT}/phases/step-7`.

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-7/verification-report.md
cp ${RUN_ROOT}/phases/step-7/verification-report.md ${RUN_ROOT}/artifacts/verification-report.md
```

If the worker only wrote `handoffs/handoff.md`, the orchestrator reads it and synthesizes
`verification-report.md` manually using the schema above.

**Gate:** `verification-report.md` exists with full test suite results, leftover reference
scan, and dual-system artifact scan. Verdict is CLEAN or LEFTOVERS FOUND with every
leftover explicitly named.

**Failure mode:** Leftover references to the old system cause runtime failures after the
coexistence scaffolding is removed.

### Step 8: Cutover Review -- `dispatch`

**Objective:** Final review: confirm the old system can be fully removed, coexistence
scaffolding can be torn down, and documentation is updated.

This step is assessment only -- the worker does NOT modify source code. If issues are found,
the orchestrator handles remediation by reopening Step 6.

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-8/handoffs" "${RUN_ROOT}/phases/step-8/last-messages"
```

**Header** (`${RUN_ROOT}/phases/step-8/prompt-header.md`):
Include the canonical header schema with:
- Mission: Audit the completed migration against the coexistence plan and migration brief.
  Verify that coexistence scaffolding (adapters, bridges, flags, shims) can be safely
  removed. Check documentation updates. Do NOT modify source code -- diagnose only.
- Inputs: Full `coexistence-plan.md`, full `batch-log.md`, full `verification-report.md`
- Output path: `${RUN_ROOT}/phases/step-8/cutover-report.md`
- Output schema:
  ```markdown
  # Cutover Report
  ## Migration Completeness (all batches vs plan)
  ## Coexistence Scaffolding Removal Checklist
  ## Documentation Updates Needed
  ## Findings
  ### Critical (must fix before cutover)
  ### Moderate (should fix)
  ### Low (acceptable debt)
  ## Rollback Assessment (is rollback still possible? still needed?)
  ## Verdict: READY / REVISE
  ```
- Success criteria: Every finding references a specific artifact or code location. If
  REVISE, the exact governing issue is named.
- Handoff: `handoffs/handoff.md`

**Dispatch:** Same compose-prompt + codex exec pattern as Step 2, with
`--header ${RUN_ROOT}/phases/step-8/prompt-header.md`,
`--skills <domain-skills>`,
`--root ${RUN_ROOT}/phases/step-8`.

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-8/cutover-report.md
cp ${RUN_ROOT}/phases/step-8/cutover-report.md ${RUN_ROOT}/artifacts/cutover-report.md
```

**Gate (verdict-reopen):** Read the cutover verdict.
- `READY` -> Circuit complete. The old system can be removed and coexistence scaffolding
  torn down.
- `REVISE` with governing issues -> Record the governing issue in `cutover-report.md`.
  Reopen Step 6 (Batch Migration) with the governing issue as additional input. The
  orchestrator updates the CHARTER.md with the specific remediation needed and re-runs
  the manage-codex cycle for the affected batches only.

**If verdict is `REVISE` after 2 total attempts** -> escalate to the user.

**Failure mode:** Coexistence scaffolding is removed prematurely, breaking the system in
a way that is harder to fix than the original migration.

---

## Artifact Chain Summary

```text
migration-brief.md                              [Step 1, interactive]
  -> dependency-inventory.md || risk-assessment.md  [Step 2/3, parallel dispatch]
  -> coexistence-plan.md                         [Step 4, synthesis]
  -> migration-steer.md                          [Step 5, interactive]
  -> batch-log.md                                [Step 6, manage-codex dispatch]
  -> verification-report.md                      [Step 7, dispatch]
  -> cutover-report.md                           [Step 8, dispatch]
```

## Resume Awareness

If `${RUN_ROOT}/artifacts/` already has files, determine the resume point:

1. Check artifacts in chain order (migration-brief -> dependency-inventory + risk-assessment
   -> coexistence-plan -> migration-steer -> batch-log -> verification-report -> cutover-report)
2. Find the last complete artifact with a passing gate
3. For Step 6 specifically: check `${RUN_ROOT}/phases/step-6/batch.json` for manage-codex
   resume state before restarting batch migration
4. If `cutover-report.md` exists with a `REVISE` verdict, read its governing issue and
   resume from Step 6 with that issue as input
5. Continue from the next step

This is best-effort -- the circuit has no durable state beyond artifacts on disk and
step-local relay directories. If a session dies mid-step, check the step's relay
directory for worker output before concluding the step failed.

## Circuit Breaker

Escalate to the user when:
- A dispatch step fails twice (no valid output after 2 attempts)
- Step 6 converges to `ISSUES REMAIN` and the coexistence plan cannot accommodate the failure
- Step 8 returns `REVISE` after 2 total attempts
- The migration target turns out to be deeply entangled with the codebase in ways the
  inventory did not capture (reopen from Step 2)
- The coexistence strategy proves fundamentally unworkable (escalate rather than iterate)

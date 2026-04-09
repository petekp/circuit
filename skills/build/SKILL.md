---
name: build
description: >
  Build features, scoped refactors, docs, tests, or mixed changes. The doing
  workflow. Phases: Frame -> Plan -> Act -> Verify -> Review -> Close. Docs and
  tests are first-class outputs, not afterthoughts. If architecture uncertainty
  appears, transfers to Explore rather than muddling through.
trigger: >
  Use for /circuit:build, or when circuit:run routes here.
---

# Build

Features, scoped refactors, docs, tests, mixed code+docs+tests changes. The doing workflow.

## Phases

Frame -> Plan -> Act -> Verify -> Review -> Close

## Entry

The router passes: task description, rigor profile (Lite, Standard, Deep, Autonomous).

**Direct invocation:** When invoked directly via `/circuit:build` (not through the
router), bootstrap the run root if one does not already exist:

Derive `RUN_SLUG` from the task description: lowercase, replace spaces and
special characters with hyphens, collapse consecutive hyphens, trim to 50
characters. Example: "Add Dark Mode Support" produces `add-dark-mode-support`.

```bash
RUN_SLUG="add-dark-mode-support"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
```

Write initial `${RUN_ROOT}/artifacts/active-run.md` with Workflow=Build,
Rigor=Standard (or as specified), Current Phase=frame. If the router already set
up the run root (active-run.md exists at `${RUN_ROOT}/artifacts/active-run.md`),
skip bootstrap and proceed to the current phase.

## Phase: Frame

Write `artifacts/brief.md`:

```markdown
# Brief: <task>
## Objective
<what we are building and why>
## Scope
<what is in scope -- be specific about boundaries>
## Output Types
<check all that apply: code, tests, docs, ADRs, config>
## Success Criteria
<measurable conditions for done>
## Constraints
<hard invariants, boundaries, non-negotiables>
## Verification Commands
<exact commands to prove success -- not placeholders>
## Out of Scope
<what we are NOT doing>
```

**Key rule:** Output Types must be explicit. If the change affects code, ask: does
this also need tests? Updated docs? Config changes? Docs and tests are first-class
outputs, not afterthoughts.

**Ambiguity check:** If the task is genuinely ambiguous (more than one reasonable
interpretation), ask ONE clarifying question before writing brief.md.

**Gate:** brief.md exists with non-empty Objective, Scope, Output Types, Success
Criteria, Verification Commands.

**Rigor behavior:**
- Lite: Write brief.md and proceed. No checkpoint.
- Standard: Write brief.md and proceed. Pause only if scope is ambiguous
  (more than one reasonable interpretation), irreversible (data migration,
  public API change), or success criteria are unclear.
- Deep/Autonomous: Present brief.md for confirmation. One checkpoint.

Update `active-run.md`: phase=frame, next step=Plan.

## Phase: Plan

Write `artifacts/plan.md`:

```markdown
# Plan: <task>
## Approach
<how we will do this -- concrete, not abstract>
## Slices
<ordered implementation sequence>
### Slice 1: <name>
<what this slice does, files affected, verification>
### Slice N: <name>
<what this slice does, files affected, verification>
## Verification Commands
<exact commands, run after each slice and at completion>
## Rollback Triggers
<conditions that mean "stop and revert">
## Adjacent-Output Checklist
- [ ] Tests: new/updated tests for changed behavior?
- [ ] Docs: do any docs reference changed code/APIs?
- [ ] Config: any config changes needed?
- [ ] Migrations: any data/schema migrations?
- [ ] Observability: logging, metrics, alerts affected?
- [ ] Compatibility: any breaking changes to document?
```

Address each adjacent-output item explicitly: mark it required (with details) or
mark it N/A. Treat unchecked items as plan-quality gaps to fix before
proceeding, not as a separate manifest gate.

**Architecture uncertainty:** If during planning you discover the approach is
unclear, involves multiple viable architectures, or touches unfamiliar territory,
transfer to Explore within the same run. This is orchestrator behavior, not a
dedicated route in `circuit.yaml`:

1. Update `active-run.md`:
   ```markdown
   ## Current Phase
   transfer
   ## Next Step
   Explore: investigate architecture options
   ## Transfer
   from: Build
   to: Explore
   reason: architecture uncertainty detected during Plan
   ```
2. Load the `circuit:explore` skill and follow its Frame phase from here. The
   existing run root, brief.md, and plan.md (if partial) carry forward as
   context. Explore will produce analysis.md and a revised plan.md.
3. When Explore finishes with a plan ready for execution, reload
   `circuit:build` in the same run and resume from Plan. See Explore's
   close-to-Build transfer guidance.

**Gate:** plan.md exists with non-empty Approach, Slices, Verification Commands.

Update `active-run.md`: phase=plan, next step=Act.

## Phase: Act

Create the workers workspace and dispatch implementation.

```bash
IMPL_ROOT="${RUN_ROOT}/phases/implement"
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/reports" "${IMPL_ROOT}/last-messages"
cp ${RUN_ROOT}/artifacts/plan.md ${IMPL_ROOT}/CHARTER.md
```

Write prompt header at `${IMPL_ROOT}/prompt-header.md`:
- Mission: Implement the task described in CHARTER.md
- Inputs: Full plan.md
- Output: convergence report
- Success criteria: All slices complete, verification commands pass

Include canonical relay headings: `### Files Changed`, `### Tests Run`,
`### Completion Claim`.

Prepare the adapter handoff:

```bash
# Keep the parent-owned workspace minimal and typed.
touch "${IMPL_ROOT}/jobs/act-1.request.json"
```

Then hand off to the `workers` internal adapter with:
- 0-2 domain skills for the affected code (for example `rust`, `tdd`)
- verification commands copied from `plan.md`
- success criteria for the act step
- the expectation that `workers` owns prompt assembly, dispatch, review, and convergence

Do **not** pass `workers` via `--skills`. `workers` is the internal adapter, not
a domain skill. The parent workflow owns the child root and reads back only the
public contract files:
- `jobs/{step_id}-{attempt}.request.json`
- `jobs/{step_id}-{attempt}.receipt.json`
- `jobs/{step_id}-{attempt}.result.json`
- `reports/report-converge.md`
- `reports/report-{slice_id}.md`

**Rigor behavior:**
- Lite: Dispatch single worker or do inline for very small changes.
- Standard/Deep: Dispatch via workers (implement -> review -> converge).
- Autonomous: Same as Standard, auto-resolve checkpoints.

**Gate:** Implementation complete. Workers convergence = COMPLETE AND HARDENED.
Verification commands pass.

Update `active-run.md`: phase=act, next step=Verify.

## Phase: Verify

Independently re-run all verification commands from plan.md. Record results.
This is objective proof, not narrative confirmation.

```markdown
## Verification Results
- <command>: PASS | FAIL
- <command>: PASS | FAIL
## Regression Check
<any new failures introduced?>
```

**Gate:** All verification commands pass. No regressions.

Update `active-run.md`: phase=verify, next step=Review (or Close for Lite).

## Phase: Review

**Skipped at Lite rigor.** Lite goes directly from Verify to Close.

Dispatch an independent reviewer in a fresh context.

```bash
step_dir="${RUN_ROOT}/phases/review"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

Write prompt header:
- Mission: Audit implementation against brief.md and plan.md. Check constraint
  violations, missing test coverage, scope drift, adjacent-output compliance.
  Do NOT modify source code -- diagnose only.
- Inputs: brief.md, plan.md
- Output: `review/reports/review-report.md`

Review schema:

```markdown
# Review: <task>
## Contract Compliance
<does implementation match brief.md and plan.md?>
## Findings
### Critical (must fix before ship)
### High (should fix)
### Low (acceptable debt)
## Adjacent-Output Audit
<were all checked items in the checklist actually delivered?>
## Verification Rerun
<re-ran verification commands, results>
## Verdict: CLEAN | ISSUES FOUND
```

Compose and dispatch with `--circuit build --role reviewer`.
Adapter routing stays semantic.

Promote to `artifacts/review.md`.

**Gate with retry:**
- CLEAN: proceed to Close.
- ISSUES FOUND with critical findings: address findings, re-run review (max 2 loops).
  After 2 loops with persistent critical findings, escalate to user.
- ISSUES FOUND, no critical: proceed to Close. High/low become tracked debt in result.md.

Update `active-run.md`: phase=review, next step=Close.

## Phase: Close

Write `artifacts/result.md`:

```markdown
# Result: <task>
## Changes
<what changed, files affected>
## Verification
<test results, verification command output>
## Adjacent Outputs Delivered
<tests, docs, config, etc. that were updated>
## Residual Risks / Debt
<known issues left intentionally, high/low findings from review>
## Follow-ups
<future work surfaced during this run>
## PR Summary
<ready-to-use PR body>
### Title
<short PR title>
### Summary
<bullet points>
### Test Plan
<how to verify>
```

**Gate:** result.md exists with non-empty Changes, Verification, PR Summary.

Update `active-run.md`: phase=close.

## Deep Rigor: Seam Proof

When rigor is Deep, add a seam proof step between Plan and Act:

1. Identify the riskiest seam in the plan.
2. Dispatch a worker to prove it with code (failing test, spike, minimal integration).
3. DESIGN HOLDS: continue to Act.
4. NEEDS ADJUSTMENT: update plan.md, continue.
5. DESIGN INVALIDATED: transfer to Explore.

## Circuit Breakers

Escalate when:
- Workers: impl_attempts > 3 or impl_attempts + review_rejections > 5
- Review says ISSUES FOUND with critical after 2 fix loops
- Architecture uncertainty detected during Plan (transfer to Explore)
- Verification commands fail after implementation and fix attempts
- Dispatch step fails twice

Include: counter values, failure output, options (adjust scope, skip slice, abort).

## Resume

Check artifacts in chain order:
1. brief.md missing -> Frame
2. plan.md missing -> Plan
3. Check workers convergence state -> Act (resume workers if partial)
4. review.md missing -> Review (skip for Lite)
5. result.md missing -> Close
6. All present -> complete

---
name: sweep
description: >
  Systematic codebase sweeps: cleanup, quality passes, coverage improvements,
  docs-sync. Absorbs the old cleanup circuit and ratchet workflow. Phases:
  Frame -> Survey -> Queue/Triage -> Batch execute -> Verify -> Deferred review
  -> Close. Scans broadly, triages by confidence x risk, batches by risk order,
  defers ambiguous cases.
trigger: >
  Use for /circuit:sweep, or when circuit:run routes here.
---

# Sweep

Cleanup, quality passes, coverage sweeps, docs-sync. The maintenance workflow.

## Phases

Frame -> Survey -> Queue/Triage -> Batch execute -> Verify -> Deferred review -> Close

## Entry

The router passes: task description, rigor profile (Lite, Standard, Deep, Autonomous),
and sweep objective (cleanup, quality improvement, coverage, docs-sync).

**Direct invocation:** When invoked directly via `/circuit:sweep` (not through
the router), bootstrap the run root if one does not already exist:

Derive `RUN_SLUG` from the task description: lowercase, replace spaces and
special characters with hyphens, collapse consecutive hyphens, trim to 50
characters. Example: "Dead Code Cleanup Sprint" produces `dead-code-cleanup-sprint`.

```bash
RUN_SLUG="dead-code-cleanup-sprint"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
```

Write initial `${RUN_ROOT}/artifacts/active-run.md` with Workflow=Sweep,
Rigor=Standard (or as specified), Current Phase=frame. If the router already set
up the run root, skip bootstrap and proceed to the current phase.

## Phase: Frame

Write `artifacts/brief.md`:

```markdown
# Brief: <sweep objective>
## Objective
<what we are sweeping for and why>
## Sweep Type
<cleanup | quality | coverage | docs-sync>
## Scope
<target directory, modules, or repo-wide>
## Output Types
<code, tests, docs -- check all that apply>
## Success Criteria
<measurable improvement target>
## Build Command
<exact command>
## Test Command
<exact command>
## Optional Verify Command
<project-specific verification, if any>
## Scope Exclusions
<paths or patterns to skip>
## Known External Consumers
<if any, or "none">
## High-Risk Boundaries
<public APIs, FFI exports, published packages, or "none">
## Out of Scope
<what we are NOT touching>
```

**Gate:** brief.md exists with non-empty Objective, Sweep Type, Build Command, Test Command.

Update `active-run.md`: phase=frame, next step=Survey.

## Phase: Survey (Analyze)

### Lite

Quick scan. High-confidence items only.

Write `artifacts/analysis.md` with a short inventory of high-confidence findings.

### Standard / Deep

Dispatch parallel survey workers across categories relevant to the sweep type.

**Cleanup categories:** dead-code, stale-docs, orphaned-artifacts, vestigial-comments, redundant-abstractions

**Quality categories:** test-coverage-gaps, error-handling, type-safety, lint-violations, performance-risks

**Coverage categories:** untested-modules, untested-branches, test-quality

**Docs-sync categories:** stale-docs, missing-docs, broken-links, outdated-architecture

Select the category set matching the sweep type from the lists above, then dispatch
one worker per category:

```bash
# Example: cleanup sweep categories. Substitute the right set for your sweep type.
for category in dead-code stale-docs orphaned-artifacts vestigial-comments redundant-abstractions; do
  step_dir="${RUN_ROOT}/phases/survey-${category}"
  mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"

  # Write prompt-header.md for each category worker.
  # Pick 1-2 domain skills matching the affected code. Omit --skills if none apply.
  "$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
    --header "${step_dir}/prompt-header.md" \
    --skills "rust,tdd" \
    --root "${step_dir}" \
    --out "${step_dir}/prompt.md"

  "$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
    --prompt "${step_dir}/prompt.md" \
    --output "${step_dir}/last-messages/last-message.txt" \
    --circuit sweep \
    --role researcher
done
```

Each worker writes `<category>-findings.md` with:

```markdown
# <Category> Findings
## Summary
<count, confidence distribution>
## Candidates
| # | Path | Line/Anchor | Description | Confidence | Risk | Uncertainty Note |
```

### Consolidation

Read all findings. Deduplicate. Write `artifacts/analysis.md`:

```markdown
# Analysis: <sweep objective>
## Summary
<total candidates by category, cross-category overlaps>
## Inventory
| # | Category | Path | Description | Confidence | Risk | Ambiguity Flag | Notes |
```

**Deduplication rules:**
- Items appearing in multiple categories: keep higher-confidence categorization.
- Preserve original category label for traceability.
- Flag items near scope exclusions or high-risk boundaries.

**Gate:** analysis.md exists with deduplicated candidates. Every candidate has confidence and risk.

Update `active-run.md`: phase=survey, next step=Queue/Triage.

## Phase: Queue/Triage

Classify each finding by confidence x risk. Assign action.

Write `artifacts/queue.md`:

```markdown
# Queue: <sweep objective>
## Triage Decision Table
| Confidence | Risk | Action |
|-----------|------|--------|
| High | Low | ACT |
| High | High | PROVE then ACT |
| Low | Low | PROVE |
| Low | High | DEFER |

## Classified Items
| # | Path | Category | Confidence | Risk | Action | Rationale |
## Batch Assignment
### Batch 1 (lowest risk)
<items, scope, verification>
### Batch 2
<items, scope, verification>
### Batch 3 (highest risk)
<items, scope, verification>
## Deferred Items
<items deferred with rationale>
```

**Batch ordering:** Lowest risk first. For cleanup: comments -> fixtures -> orphaned files -> unused functions -> exports -> public API. For quality: lint fixes -> error handling -> type safety -> coverage -> performance.

**Rigor behavior:**
- Standard: Proceed with triage. Pause only if deferred items exceed 30% of
  total or if any PROVE-HIGH items remain (ambiguity + risk warrants a check).
- Deep: Evidence adjudication for PROVE items before batching.
- Autonomous: Auto-approve using triage decision table. Log deferred items.

### Evidence Adjudication (Deep / Standard with PROVE items)

For items marked PROVE, dispatch an evidence worker:

Dynamic usage proof checklist (check ALL before marking confirmed):
1. grep/search: zero references across full repo
2. git blame recency: touched in last 90 days?
3. Reflection/dynamic dispatch: symbol constructed at runtime?
4. FFI boundary: exposed across FFI?
5. Code generation: referenced by codegen/macro/build script?
6. Plugin/registration: registered via plugin system?
7. External consumers: any known consumer references this?
8. Conditional compilation: behind feature flag/platform gate?
9. CI scripts/test fixtures: referenced in CI/shell tests?

Verdict: All clear -> CONFIRMED. Any positive -> KEEP with cited evidence.

**Gate:** queue.md exists. Every finding classified. Batches assigned. PROVE items adjudicated.

Update `active-run.md`: phase=triage, next step=Batch execute.

## Phase: Batch Execute (Act)

Execute batches in order using workers.

**Per-batch execution:**

```bash
BATCH_ID="batch-1"
BATCH_ROOT="${RUN_ROOT}/phases/batches/${BATCH_ID}"
mkdir -p "${BATCH_ROOT}/archive" "${BATCH_ROOT}/reports" "${BATCH_ROOT}/last-messages"
```

Write `${BATCH_ROOT}/CHARTER.md`:
- Batch items with evidence references
- Allowed file scope
- Verification commands (build/test/verify)
- Revert rule: revert ALL on any verification failure

Prepare the adapter handoff:

```bash
# Keep the parent-owned workspace minimal and typed.
touch "${BATCH_ROOT}/jobs/execute-1.request.json"
```

Then hand off to the `workers` internal adapter with:
- 0-2 domain skills for the affected code
- the verification commands for the batch
- the success criteria and revert rule for the batch
- the expectation that `workers` owns prompt assembly and the implement ->
  review -> converge loop

Do **not** pass `workers` via `--skills`. `workers` is the internal adapter.
Sweep reads back only the public worker contract files:
- `jobs/{step_id}-{attempt}.request.json`
- `jobs/{step_id}-{attempt}.receipt.json`
- `jobs/{step_id}-{attempt}.result.json`
- `reports/report-converge.md`
- `reports/report-{slice_id}.md`

After each batch, record results:

```markdown
## Batch: <id>
### Items
| # | Path | Action | Evidence | Result |
### Verification
- Build: PASS | FAIL
- Test: PASS | FAIL
### Disposition
COMPLETE | REVERTED | PARTIAL
```

**Retry:** Up to 3 attempts per batch. After 3, mark as REVERTED and continue.

**Rigor behavior:**
- Standard: Dispatch sequentially. Pause before any batch that touches
  high-risk boundaries (public APIs, FFI, published packages) or has items
  marked PROVE. Other batches proceed without confirmation.
- Autonomous: Dispatch sequentially, no pause. Max 3 batches then stop.
- Deep: Confirm every batch + stronger false-positive aversion.

**Gate:** All eligible batches executed. Verification results recorded. Reverted batches noted.

Update `active-run.md`: phase=execute, next step=Verify.

## Phase: Verify

In Sweep, `review.md` is written here, during Verify. This is the workflow's
independent audit inside the verify -> deferred -> close flow, not a separate
Review phase on the shared spine.

### Independent Audit

Dispatch an independent verification worker (diagnose only, no code changes):

- Re-run build, test, verify commands
- Compare before/after metrics (warnings, test counts, coverage)
- Spot-check removed/changed items against evidence
- Cross-check: every acted item should have evidence

Write verification results.

Write `artifacts/review.md` using the shared review schema:

```markdown
# Review: <sweep objective>
## Contract Compliance
<does execution match brief.md and queue.md?>
## Findings
### Critical (must fix before ship)
<findings that block shipping>
### High (should fix)
<findings that should be addressed>
### Low (acceptable debt)
<minor issues or style concerns>
## Verification Rerun
<command outputs, pass/fail>
## Verdict: CLEAN | ISSUES FOUND
```

### Autonomous: Injection Check

For Autonomous rigor, also check for issues introduced during the sweep:
- New lint warnings
- New test failures
- Degraded coverage
- Orphaned code from the sweep itself

Verdicts: clean | minor_injections (log to deferred) | critical_injections (halt)

**Gate:** review.md exists. Verification complete. No critical injections.
Build/test pass.

Update `active-run.md`: phase=verify, next step=Deferred review.

## Phase: Deferred Review

Collect all deferred items:
- Items with action DEFER from triage
- Items with KEEP verdict from evidence adjudication
- Reverted batches
- Audit findings
- Autonomous decision log

Write `artifacts/deferred.md`:

```markdown
# Deferred Items
## Summary
<N items deferred for human review>
## Items
| # | Source | Path | Description | Severity | Reason Deferred | Suggested Follow-up |
## Decision Log (Autonomous only)
<autonomous decisions made: auto-approvals, deferrals, escalations>
## Follow-up Actions
### Immediate (review before merge)
### Soon (next sprint)
### Later (backlog)
```

**Gate:** deferred.md exists. Every deferred/blocked item from prior phases included.

Update `active-run.md`: phase=deferred, next step=Close.

## Phase: Close

Write `artifacts/result.md`:

```markdown
# Result: <sweep objective>
## Summary
<one paragraph: goal, achievement, scope>
## Metrics Before/After
| Metric | Before | After | Delta |
## Delivered Scope
<what was acted on, by batch>
## Deferred Items
<count, summary, highlight any merge-blocking items>
## Verification
<build, test, verify results>
## Residual Risks / Debt
## Follow-ups
## PR Summary
### Title
chore: <sweep description>
### Summary
<what was cleaned/improved>
### Test Plan
- Build: PASS
- Tests: PASS
- No regressions introduced
```

**Gate:** result.md exists with non-empty Summary, Verification.

Update `active-run.md`: phase=close.

## Principles

- **False-positive aversion.** Better to leave something suspicious than remove something load-bearing.
- **Evidence-based action.** Every change has a stated reason with cited evidence.
- **Batch + verify.** Never change everything at once. Ordered batches catch mistakes early.
- **Agent-context priority.** Stale docs are worse than dead code because agents trust them.
- **Defer over heroics.** Ambiguous items go to deferred.md, not to risky guesses.

## Circuit Breakers

Escalate when:
- Fewer than 5 candidates found (overhead not justified)
- Build/test infrastructure is broken (fix that first)
- Sweep requires behavior changes (use Build instead)
- Batch produces regression that verification confirms
- Critical injections detected in Autonomous mode
- Same step fails its gate twice

## Resume

Check artifacts in chain order:
1. brief.md missing -> Frame
2. analysis.md missing -> Survey
3. queue.md missing -> Triage
4. Check batch state -> Batch execute (resume from first incomplete batch)
5. review.md missing -> Verify
6. deferred.md missing -> Deferred review
7. result.md missing -> Close
8. All present -> complete

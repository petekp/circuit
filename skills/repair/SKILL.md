---
name: repair
description: >
  Fix bugs, regressions, flaky behavior, and incidents. Test-first discipline.
  Phases: Frame -> Analyze -> Fix -> Verify -> Review -> Close.
  The analyze phase covers both reproduction and root-cause isolation.
  Forces expected vs actual behavior, repro recipe, and regression-proof mindset.
  fix: routes here at Lite rigor. repair: routes here at Deep rigor.
trigger: >
  Use for /circuit:repair, or when circuit:run routes here.
---

# Repair

Bugs, regressions, flaky behavior, incidents. The fixing workflow.

## Phases

Frame -> Analyze (reproduce + isolate) -> Fix -> Verify -> Review -> Close

## Entry

The router passes: task description, rigor profile (Lite, Standard, Deep, Autonomous).

**Direct invocation:** When invoked directly via `/circuit:repair` (not through
the router), bootstrap the run root if one does not already exist:

Derive `RUN_SLUG` from the task description: lowercase, replace spaces and
special characters with hyphens, collapse consecutive hyphens, trim to 50
characters. Example: "Fix Login Email Validation" produces `fix-login-email-validation`.

```bash
RUN_SLUG="fix-login-email-validation"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
```

Write initial `${RUN_ROOT}/artifacts/active-run.md` with Workflow=Repair,
Rigor=Standard (or as specified), Current Phase=frame. If the router already set
up the run root, skip bootstrap and proceed to the current phase.

## Phase: Frame

Write `artifacts/brief.md`:

```markdown
# Brief: <task>
## Objective
<what is broken and what "fixed" looks like>
## Scope
<what is in scope for this fix>
## Output Types
<check all that apply: code, tests, docs, config>
## Success Criteria
<measurable conditions for done -- regression test passes>
## Constraints
<hard invariants, boundaries>
## Verification Commands
<exact commands to prove the fix works>
## Out of Scope
<what we are NOT fixing>
## Regression Contract
### Expected Behavior
<what should happen>
### Actual Behavior
<what happens instead>
### Repro Command
<exact command or steps to reproduce, or "not yet reproducible">
### Regression Test
<test that fails now, must pass after fix -- this is Slice 0>
<OR: "deferred -- see Diagnostic Path below">
```

The Regression Contract is mandatory. Expected Behavior, Actual Behavior, and Repro
Command are always required. Regression Test may be deferred if the bug is not yet
reproducible (flaky, environment-sensitive, partial incident). See Diagnostic Path below.

When the Regression Test is present, it becomes Slice 0 in any plan.

**Gate:** brief.md exists with non-empty Objective, Regression Contract (Expected
Behavior, Actual Behavior, Repro Command), Verification Commands.

Update `active-run.md`: phase=frame, next step=Analyze.

## Phase: Analyze

The YAML `analyze` step covers both reproduction and root-cause isolation.
Start by attempting to reproduce the bug using the Repro Command from brief.md.

**If reproducible:** Record the reproduction evidence, then continue within
Analyze to isolate the root cause.

**If not reproducible after bounded search:**
- Lite: Try 3 variations of the repro. If still no repro, escalate with hypotheses.
- Standard: Try 5 variations. Check different environments, inputs, timing.
- Deep: Parallel evidence probes (external patterns + internal trace).

Write reproduction results into `artifacts/analysis.md`:

```markdown
# Analysis: <task>
## Repro Results
<exact commands run, exact output observed>
## Repro Confidence
<reproducible | intermittent | not reproducible>
```

### Diagnostic Path (within Analyze, when not reproducible)

When the bug cannot be reproduced but evidence suggests it is real (logs, user
reports, monitoring data), use this analyze-phase guidance instead of stalling:

1. **Contain:** Apply a minimal containment measure (add logging, add a guard
   clause, enable a feature flag) that either prevents the failure or captures
   the signal needed to write a regression test later.
2. **Instrument:** Add targeted observability (structured logs, metrics, error
   boundaries) at the suspected failure point.
3. **Defer regression test:** Record the deferred test in analysis.md with the
   trigger condition that would make it writable. The test becomes a follow-up
   item in result.md, not a blocker.
4. **Continue within Analyze:** Root-cause isolation now works from the
   containment and instrumentation evidence rather than a clean repro.

The diagnostic path is not a shortcut. It trades upfront test certainty for
signal-gathering discipline. The containment must be code-reviewed. The deferred
test is tracked.

**Gate:** The circuit gate for `analyze` requires `analysis.md` with `Repro Results`.
Use the rest of Analyze to add hypotheses and isolate the root cause before moving
to Fix.

### Root-Cause Isolation (still within Analyze)

Identify the root cause. Generate hypotheses, test them, eliminate.

Add to `artifacts/analysis.md`:

```markdown
## Hypotheses (ranked by likelihood)
### Hypothesis 1: <name>
- Evidence for: <what supports this>
- Evidence against: <what contradicts this>
- Test: <how to confirm or eliminate>
- Status: CONFIRMED | ELIMINATED | UNTESTED
### Hypothesis N: <name>
...
## Eliminated Hypotheses
<approach -- why eliminated>
## Root Cause
<the confirmed root cause, with evidence>
## Implications
<what else might be affected>
```

**Budget constraints by rigor:**
- Lite: Max 3 hypotheses. If no root cause after 3, escalate.
- Standard: Max 3 hypotheses or 1 root-cause branch change before asking user.
- Deep: Broader search. Parallel evidence probes for related patterns. Max 5 hypotheses.

**Escalation:** If no root cause found within budget:

> Root cause not isolated within budget. Here are the current hypotheses:
> 1. <hypothesis> -- <evidence for/against>
> 2. <hypothesis> -- <evidence for/against>
> 3. <hypothesis> -- <evidence for/against>
>
> Which direction should I pursue, or should I widen the search?

**Expectation within Analyze:** expand `analysis.md` with ranked hypotheses and
`Root Cause` when isolation succeeds. If you exhaust the analyze budget without
isolating the cause, escalate with ranked hypotheses rather than pretending the
circuit guarantees a separate `isolate` branch.

Update `active-run.md`: phase=analyze, next step=Fix.

## Phase: Fix (Act)

### Write the regression test first (Slice 0)

If the Regression Test is present in the contract: write it before any code fix.
It must FAIL against the current code. This proves the bug exists in test form.

If the Regression Test was deferred (diagnostic path): Slice 0 is the
containment/instrumentation from the diagnostic path instead. The regression test
becomes a follow-up item in result.md.

### Then fix the code (Slice 1+)

Optionally write `artifacts/plan.md` to plan slices (internal guidance, not a gated artifact):

```markdown
# Plan: <task>
## Slices
### Slice 0: Regression test
<test that fails now, proves the bug>
### Slice 1: <fix description>
<what changes, files affected>
### Slice N: <if additional changes needed>
## Verification Commands
## Adjacent-Output Checklist
- [ ] Tests: regression test + any additional tests?
- [ ] Docs: do any docs reference the buggy behavior?
- [ ] Config: any config changes needed?
- [ ] Migrations: N/A (unless data fix)
- [ ] Observability: should we add logging for this failure mode?
- [ ] Compatibility: does the fix change any public behavior?
```

**Dispatch:**

```bash
IMPL_ROOT="${RUN_ROOT}/phases/implement"
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/reports" "${IMPL_ROOT}/last-messages"
cp ${RUN_ROOT}/artifacts/plan.md ${IMPL_ROOT}/CHARTER.md 2>/dev/null || \
  cp ${RUN_ROOT}/artifacts/brief.md ${IMPL_ROOT}/CHARTER.md
```

For Lite: single worker or inline implementation.
For Standard+: dispatch via workers (implement -> review -> converge).

```bash
# Keep the parent-owned workspace minimal and typed.
touch "${IMPL_ROOT}/jobs/fix-1.request.json"
```

Then hand off to the `workers` internal adapter with:
- 0-2 domain skills for the affected code (for example `rust`, `tdd`)
- the regression test / verification commands
- the success criteria for the fix step
- the expectation that `workers` owns prompt assembly plus the implement ->
  review -> converge loop

Do **not** pass `workers` via `--skills`. `workers` is the internal adapter.
The repair workflow reads back only the parent-readable contract files:
- `jobs/{step_id}-{attempt}.request.json`
- `jobs/{step_id}-{attempt}.receipt.json`
- `jobs/{step_id}-{attempt}.result.json`
- `reports/report-converge.md`
- `reports/report-{slice_id}.md`

**Gate:** Regression test passes. Verification commands pass. Workers convergence = COMPLETE AND HARDENED (for Standard+).

Update `active-run.md`: phase=fix, next step=Verify.

## Phase: Verify

Independently re-run ALL verification commands plus the regression test.

Check for collateral regressions: run the full test suite, not just the
regression test.

```markdown
## Verification Results
- Regression test: PASS
- <verification command>: PASS | FAIL
- Full test suite: PASS | FAIL (N tests, N passed, N failed)
## Regression Check
<any new failures introduced? list them>
```

**Gate:** Regression test passes. No new regressions. All verification commands pass.

Update `active-run.md`: phase=verify, next step=Review (or Close for Lite).

## Phase: Review

**Skipped at Lite rigor.** Lite goes directly from Verify to Close.

Dispatch an independent reviewer:

```bash
step_dir="${RUN_ROOT}/phases/review"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

Reviewer mission: Audit the fix against brief.md (regression contract) and
analysis.md (root cause). Check: is the root cause actually addressed? Could the
fix introduce new failure modes? Is the regression test sufficient? Do NOT modify
source code.

Write `artifacts/review.md`:

```markdown
# Review: <task>
## Root Cause Verification
<does the fix address the confirmed root cause?>
## Regression Test Adequacy
<does the test actually catch the bug? edge cases?>
## Findings
### Critical (must fix)
### High (should fix)
### Low (acceptable debt)
## Verification Rerun
## Verdict: CLEAN | ISSUES FOUND
```

**Gate:** CLEAN, or ISSUES FOUND with no critical after fix loop (max 2).

Update `active-run.md`: phase=review, next step=Close.

## Phase: Close

Write `artifacts/result.md`:

```markdown
# Result: <task>
## Root Cause
<confirmed root cause>
## Fix
<what was changed>
## Regression Test
<test name, what it covers -- or "deferred" with trigger condition>
## Verification
<all test results>
## Eliminated Hypotheses
<approaches ruled out and why -- useful for future debugging>
## Residual Risks / Debt
## Follow-ups
## PR Summary
### Title
fix: <short description>
### Summary
<what was broken, what caused it, what fixes it>
### Test Plan
- Regression test: <test name>
- Full suite: PASS
```

**Gate:** result.md exists with non-empty Root Cause, Fix, Regression Test, PR Summary.

Update `active-run.md`: phase=close.

## Circuit Breakers

Escalate when:
- No reproducible signal after bounded search (Lite: 3 tries, Standard: 5, Deep: broader)
- 3 hypotheses eliminated with no root cause (Lite/Standard)
- Workers: impl_attempts > 3
- Review critical findings persist after 2 fix loops
- Regression test cannot be written (behavior not testable)
- Fix introduces more regressions than it solves

Include: hypothesis ranking, evidence gathered, options (widen search, different approach, accept risk).

## Resume

Check artifacts in chain order:
1. brief.md missing -> Frame
2. analysis.md missing or no Repro Results -> Analyze
3. analysis.md shows Analyze is still in progress -> Analyze
4. Check workers state -> Fix (resume if partial)
5. review.md missing -> Review (skip for Lite)
6. result.md missing -> Close
7. All present -> complete

# Shared Phase Spine

Every workflow is a preset over this spine. Phases may be skipped but never reordered.

## Phase Definitions

### Frame

**Question:** What are we doing? What counts as done? What is in/out of scope?

**Artifact:** `brief.md`

```markdown
# Brief: <task>
## Objective
## Scope
## Output Types
[code | tests | docs | ADRs | config -- check all that apply]
## Success Criteria
## Constraints
## Verification Commands
## Out of Scope
```

**Gate:** brief.md exists with non-empty Objective, Scope, Output Types, Success Criteria, Verification Commands.

**active-run.md update:** Write initial dashboard with workflow, rigor, phase=Frame, goal, verification commands.

### Analyze

**Question:** What did we learn that materially changes the approach?

**Artifact:** `analysis.md`

Content varies by workflow:
- **Explore:** Evidence and options. External + internal probes.
- **Repair:** Repro results, root cause hypotheses, eliminated hypotheses.
- **Sweep:** Survey findings, category inventory.
- **Migrate:** Dependency inventory, risk assessment.

```markdown
# Analysis: <task>
## Facts (confirmed, high confidence)
## Inferences (derived, medium confidence)
## Unknowns (gaps that matter)
## Implications
```

Label every item: `[fact]`, `[inference]`, or `[assumption]`.

**Gate:** analysis.md exists with non-empty Facts and Unknowns. Every item has a certainty label.

### Plan

**Question:** What exact slices or sequence will be executed?

**Artifact:** `plan.md`

```markdown
# Plan: <task>
## Slices
[Ordered implementation sequence]
## Verification Commands
## Rollback Triggers
## Adjacent-Output Checklist
- [ ] Tests: new/updated tests for changed behavior?
- [ ] Docs: do any docs reference changed code/APIs?
- [ ] Config: any config changes needed?
- [ ] Migrations: any data/schema migrations?
- [ ] Observability: logging, metrics, alerts affected?
- [ ] Compatibility: any breaking changes to document?
```

**Gate:** plan.md exists with non-empty Slices, Verification Commands. Every adjacent-output item checked or marked N/A.

### Act

Workers execute the plan. The orchestrator dispatches via the workers skill.

**Charter:** Copy plan.md (or brief.md for Lite) as CHARTER.md for the worker workspace.

**Gate:** Implementation complete. Verification commands pass. Workers convergence = COMPLETE AND HARDENED.

### Verify

**Question:** Does objective proof confirm the work?

Independent re-run of all verification commands. Not narrative confirmation.

**Gate:** All verification commands re-run. Results recorded. No regressions.

### Review

**Question:** Does a fresh-context critique find issues?

**Artifact:** `review.md`

```markdown
# Review: <task>
## Findings
### Critical (must fix before ship)
### High (should fix)
### Low (acceptable debt)
## Verification Rerun
## Verdict: CLEAN | ISSUES FOUND
```

Review runs in a separate session (dispatch with the workflow's `--circuit` and `--role reviewer`). Reviewer does NOT modify source code.

**Gate:** review.md exists. Verdict is CLEAN, or ISSUES FOUND with no critical findings after fix loop (max 2 loops).

### Close

**Question:** What is the consumable outcome?

**Artifact:** `result.md`

```markdown
# Result: <task>
## Changes
[What changed, files affected]
## Verification
[Test results, command output]
## Residual Risks / Debt
## Follow-ups
## PR Summary
[Ready-to-use PR body seed]
```

**Gate:** result.md exists with non-empty Changes, Verification. PR Summary present.

### Pause

**Question:** Is the session boundary more important than continuing?

**Artifact:** `handoff.md` (via /circuit:handoff)

Only written on explicit pause or session boundary. See the handoff skill for format.

**active-run.md update:** Updated to reflect pause state.

## Phase-to-Workflow Mapping

| Workflow | Frame | Analyze | Plan | Act | Verify | Review | Close | Pause |
|----------|-------|---------|------|-----|--------|--------|-------|-------|
| Explore  | Y     | Y       | Y*   | -   | -      | -      | Y     | opt   |
| Build    | Y     | -       | Y    | Y   | Y      | Y**    | Y     | opt   |
| Repair   | Y     | Y***    | opt  | Y   | Y      | Y**    | Y     | opt   |
| Migrate  | Y     | Y       | Y    | Y   | Y      | Y      | Y     | opt   |
| Sweep    | Y     | Y       | -    | Y   | Y      | Y****  | Y     | opt   |

- *Explore Plan = Decide/Plan (may produce plan.md or decision.md)
- **Build/Repair Review skipped at Lite rigor
- ***Repair Analyze = Reproduce + Isolate
- ****Sweep Review = Deferred review (items logged to deferred.md)

## active-run.md Protocol

Updated after every phase transition:

```markdown
# Active Run
## Workflow
## Rigor
## Current Phase
## Goal
## Next Step
## Verification Commands
## Active Worktrees
## Blockers
## Last Updated
```

This is the automatic continuity mechanism. SessionStart hook injects it.
Handoff.md is the intentional high-quality continuity path.

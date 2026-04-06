# Canonical Artifacts

Every workflow draws from this vocabulary. No workflow invents its own artifact
language beyond one specialized extension.

## Core Artifacts

### active-run.md

Always present while work is live. Updated after every phase transition.

```markdown
# Active Run
## Workflow
<explore | build | repair | migrate | sweep>
## Rigor
<lite | standard | deep | tournament | autonomous>
## Current Phase
<frame | analyze | plan | act | verify | review | close | pause>
## Goal
<one sentence>
## Next Step
<what happens next>
## Verification Commands
<commands that prove success>
## Active Worktrees
<paths, or "none">
## Blockers
<current blockers, or "none">
## Last Updated
<ISO 8601 timestamp>
```

### brief.md

Always present. The contract for the run.

```markdown
# Brief: <task>
## Objective
<what we are doing and why>
## Scope
<what is in scope -- be specific>
## Output Types
<check all that apply: code, tests, docs, ADRs, config>
## Success Criteria
<measurable conditions for done>
## Constraints
<hard invariants, boundaries, non-negotiables>
## Verification Commands
<exact commands to prove success -- concrete, not placeholders>
## Out of Scope
<what we are NOT doing>
```

**Workflow-specific extensions to brief.md:**

- **Repair:** Add `## Regression Contract` (expected vs actual, repro command,
  regression test = Slice 0)
- **Migrate:** Add `## Coexistence Requirements` (how old and new coexist)

### analysis.md

Optional but common. Evidence gathered before acting.

Content varies by workflow:

**Explore:** Evidence and options
```markdown
# Analysis: <task>
## Facts (confirmed, high confidence)
## Inferences (derived, medium confidence)
## Unknowns (gaps that matter)
## Implications
## Source Confidence
```

**Repair:** Root cause investigation
```markdown
# Analysis: <task>
## Repro Results
## Hypotheses (ranked by likelihood)
## Eliminated Hypotheses
<approach -- why eliminated>
## Root Cause
## Implications
```

**Sweep:** Survey inventory
```markdown
# Analysis: <task>
## Summary
<total candidates by category>
## Inventory
| # | Category | Path | Description | Confidence | Risk | Action |
```

**Migrate:** Dependency inventory
```markdown
# Analysis: <task>
## Dependencies
| # | Dependency | Version | Risk | Difficulty | Migration Path |
## Risk Assessment
## Coexistence Constraints
```

Every item labeled `[fact]`, `[inference]`, or `[assumption]`.

### plan.md

Optional but common. The execution contract.

```markdown
# Plan: <task>
## Slices
<ordered implementation sequence, one per slice>
### Slice 0: <name> (if regression test or prerequisite)
### Slice 1: <name>
### Slice N: <name>
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

**Migrate extension:** Add `## Coexistence Plan` (adapter/bridge strategy, shared
state, per-batch rollback) and `## Batch Definitions` (ordered batches with
rollback boundaries).

### review.md

The independent verdict.

```markdown
# Review: <task>
## Contract Compliance
<does implementation match brief.md and plan.md?>
## Findings
### Critical (must fix before ship)
### High (should fix)
### Low (acceptable debt)
## Verification Rerun
<re-ran verification commands, results>
## Verdict: CLEAN | ISSUES FOUND
```

Review always runs in a separate session. Reviewer does NOT modify source code.

### result.md

Always present on completion. The consumable outcome.

```markdown
# Result: <task>
## Changes
<what changed, files affected>
## Verification
<test results, verification command output>
## Residual Risks / Debt
<known issues left intentionally>
## Follow-ups
<future work surfaced during this run>
## PR Summary
<ready-to-use PR body seed -- title, summary bullets, test plan>
```

### handoff.md

Only when pausing. Distilled hidden state.

See the handoff skill for the full format (NEXT, GOAL, STATE, DEBT).
Written via `/circuit:handoff` or when session boundary matters more than
continuing.

### deferred.md

Sweep only. Written during the deferred review phase for ambiguous or borderline items.

```markdown
# Deferred Items
## Summary
<N items deferred for human review>
## Items
| # | Source | Path | Description | Severity | Reason Deferred | Suggested Follow-up |
## Decision Log
<autonomous decisions made, for human validation>
```

## Specialized Extensions

Each workflow may introduce ONE specialized artifact if it genuinely helps.

| Artifact | Workflow | When |
|----------|----------|------|
| **decision.md** | Explore (when the output is a decision; any profile) | Architecture decision rendered |
| **queue.md** | Sweep | Triaged work items (replaces analysis.md when survey is primary) |
| **inventory.md** | Migrate | Dependency catalog (replaces analysis.md when inventory is primary) |

### decision.md

```markdown
# Decision: <topic> -- <chosen approach>
## Decision
## Rationale
## Accepted Risks
## Rejected Alternatives
<name -- why rejected>
## Reopen Conditions
<testable conditions that would change this decision>
```

### queue.md

```markdown
# Queue: <sweep objective>
## Triage Decision Table
| Confidence | Risk | Action |
|-----------|------|--------|
| High | Low | REMOVE/FIX |
| High | High | PROVE then act |
| Low | Low | PROVE |
| Low | High | DEFER |
## Classified Items
| # | Path | Category | Confidence | Risk | Action | Rationale |
## Batch Assignment
<items grouped into ordered batches, lowest risk first>
```

### inventory.md

```markdown
# Inventory: <migration target>
## Dependencies
| # | Name | Current | Target | Risk | Difficulty | Batch |
## Risk Matrix
## Coexistence Requirements
## Rollback Boundaries
```

## Artifact Chains by Workflow

**Explore:** brief.md -> analysis.md -> plan.md or decision.md -> result.md

**Build:** brief.md -> plan.md -> review.md -> result.md

**Repair:** brief.md (+ regression contract) -> analysis.md -> plan.md (opt) -> review.md -> result.md

**Migrate:** brief.md -> inventory.md -> plan.md (+ coexistence) -> review.md -> result.md

**Sweep:** brief.md -> queue.md -> deferred.md -> result.md

**Review (utility):** review.md (standalone)

**Handoff (utility):** handoff.md (standalone)

All workflows maintain active-run.md throughout.

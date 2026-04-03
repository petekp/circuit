# Workflow: Crucible

Adversarial tournament that pressure-tests competing approaches. Seven steps,
three phases: Frame, Diverge/Explore/Stress-Test, Converge/Harden/Select.

Three independent workers develop genuinely different approaches. Each is
reviewed by a single adversarial reviewer, then revised. Red-team stress testers
attack the revised versions. The orchestrator selects the strongest, steals the
best ideas from the losers, hardens via pre-mortem, and produces a final
proposal that has survived pressure from multiple angles.

## Step Chain

```
crucible-frame -> crucible-diverge -> crucible-explore -> crucible-stress-test -> crucible-converge -> crucible-harden -> crucible-select
```

## Artifact Chain

```text
problem-brief.md                                    [crucible-frame: checkpoint]
  -> proposal-a.md, proposal-b.md, proposal-c.md   [crucible-diverge: dispatch]
  -> revised-a.md, revised-b.md, revised-c.md       [crucible-explore: dispatch]
  -> review-a.md, review-b.md, review-c.md          [crucible-stress-test: dispatch]
  -> selection-synthesis.md                          [crucible-converge: synthesis]
  -> pre-mortem.md                                   [crucible-harden: synthesis]
  -> final-proposal.md                               [crucible-select: synthesis]
```

## Setup

```bash
RUN_SLUG="<topic-slug>"
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}-crucible"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
```

## Dispatch Scaffolding

Before each dispatch step, create per-worker directories:

```bash
step_dir="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

For parallel steps with 3 workers, repeat with suffix `-{a,b,c}`.

## Role Assignment

| Step | Role |
|------|------|
| crucible-diverge | `--role researcher` |
| crucible-explore (review sub-phase) | `--role reviewer` |
| crucible-explore (revise sub-phase) | `--role researcher` |
| crucible-stress-test | `--role reviewer` |

## Domain Skills

Exploration workers (crucible-diverge) may use domain skills:
- Research-heavy: `deep-research`
- Comparison: `solution-explorer`

Max 2 skills per worker. Never append interactive skills to autonomous dispatches.

---

## Step 1: crucible-frame

**Kind:** checkpoint (orchestrator)

**Objective:** Produce a structured problem brief for independent workers.

**Autonomy rule:** If the task already contains a clear problem statement, goals,
and constraints, synthesize the brief directly. Otherwise ask the user:

1. What is the core problem?
2. What does a successful solution look like?
3. What constraints must any solution respect?
4. What context is relevant?
5. What is explicitly out of scope?
6. (Optional) Hints about approaches worth exploring?

### Artifact: `artifacts/problem-brief.md`

```markdown
# Problem Brief
## Problem Statement
## Goals
## Constraints
## Context
## Exclusions
## Exploration Directives
```

### Gate

Non-empty Problem Statement and Constraints (may state "none identified").

### Routes

| Outcome | Target |
|---------|--------|
| continue | crucible-diverge |

---

## Step 2: crucible-diverge

**Kind:** dispatch (3 parallel workers)

**Reads:** `artifacts/problem-brief.md`

**Writes:** `artifacts/proposal-{a,b,c}.md`

**Objective:** Three genuinely different approaches, each from a different
philosophical stance.

### Stances

Default (override when the problem demands others):
- Worker A: Minimize complexity. Simplest solution that works.
- Worker B: Maximize robustness. Handle every edge case and failure mode.
- Worker C: Optimize for extensibility. Build for the next three problems too.

Each stance must produce a fundamentally different approach, not a surface
variation.

### Prompt Header Pattern

```markdown
# Crucible Diverge -- Worker {A/B/C}

## Mission
Develop a proposal. Your stance: {stance}. Commit fully. Do not hedge.
State explicitly what you are NOT doing and why.

## Inputs
{full text of problem-brief.md}

## Output
- **Path:** `${step_dir}/proposal-{w}.md`
- **Schema:** `# Proposal {A/B/C}: <name>`, `## Approach`, `## Rationale`,
  `## Tradeoffs`, `## Implementation Sketch`

## Success Criteria
Commits to a distinct stance. Covers all four schema sections. States exclusions.

## Report Instructions
### Files Changed
### Tests Run
### Verification
### Verdict
### Completion Claim
### Issues Found
### Next Steps
```

Do not mention other workers in any prompt. Each worker believes it is writing
the sole proposal.

### Compose and Dispatch

```bash
for w in a b c; do
  "$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
    --header ${RUN_ROOT}/phases/crucible-diverge-${w}/prompt-header.md \
    --skills <domain-skills> \
    --root ${RUN_ROOT}/phases/crucible-diverge-${w} \
    --out ${RUN_ROOT}/phases/crucible-diverge-${w}/prompt.md
done
# dispatch all three in parallel, then wait
```

### Promote

```bash
for w in a b c; do
  cp ${RUN_ROOT}/phases/crucible-diverge-${w}/proposal-${w}.md \
     ${RUN_ROOT}/artifacts/proposal-${w}.md
done
```

**Fallback:** If a worker wrote only `reports/report.md`, extract the approach
narrative and write it into the proposal schema. Do not re-dispatch.

### Gate

All three proposals exist with Approach, Rationale, Tradeoffs, Implementation
Sketch.

---

## Step 3: crucible-explore

**Kind:** dispatch (two sequential sub-phases, each with 3 parallel workers)

**Reads:** `artifacts/proposal-{a,b,c}.md`

**Writes:** `artifacts/revised-{a,b,c}.md`

### Sub-phase A: Adversarial Review

Each reviewer sees exactly ONE proposal. No cross-contamination.

Prompt header mission: "You are a red-team reviewer. Find what is wrong. Do not
be balanced."

Review criteria to embed in each header:
- **Internal coherence:** Does the approach contradict itself?
- **Hidden assumptions:** What must be true for this to work?
- **Feasibility:** Where is complexity underestimated?
- **Failure modes:** Specific conditions, not "it could be hard."
- **Verdict:** Select with modifications / revise significantly / discard.

Output path: `${step_dir}/review-{w}.md`

Output schema:
```markdown
# Review {A/B/C}: <proposal name>
## Strengths
## Weaknesses
## Hidden Assumptions
## Feasibility Assessment
## Verdict
```

Sub-phase A gate: All three reviews exist with all five sections populated.

### Sub-phase B: Strengthened Proposals

Each worker receives its proposal AND its paired review from sub-phase A.
Workers do not see other proposals or reviews.

Prompt header mission: "Revise this proposal to address every weakness and
assumption. Strengthen it. Do not abandon it or merge with others."

Output path: `${step_dir}/revised-{w}.md`

Output schema:
```markdown
# Revised Proposal {A/B/C}: <name>
## Approach
## Rationale
## Tradeoffs
## Implementation Sketch
## Changes from Original
```

Sub-phase B gate: All three revised proposals exist. Every review weakness
is addressed or explicitly rebutted in Changes from Original.

### Promote

```bash
for w in a b c; do
  cp ${RUN_ROOT}/phases/crucible-explore-revise-${w}/revised-${w}.md \
     ${RUN_ROOT}/artifacts/revised-${w}.md
done
```

### Routes

| Outcome | Target |
|---------|--------|
| pass | crucible-stress-test |

---

## Step 4: crucible-stress-test

**Kind:** dispatch (3 parallel workers)

**Reads:** `artifacts/revised-{a,b,c}.md`

**Writes:** `artifacts/review-{a,b,c}.md`

Note: the supergraph declares `review-{a,b,c}.md` as artifact paths for this
step, not `stress-test-{a,b,c}.md`. Use the declared paths when promoting.

Each stress-test worker receives exactly ONE revised proposal. These proposals
have already survived one review+revision cycle.

### Attack Vectors (embed in header)

- **Seam failures:** Where do components interact? What breaks at boundaries?
- **Scale pressure:** What happens at 10x load, data, or team size?
- **Dependency failure:** What if an external dependency is unavailable?
- **Assumption inversion:** Top 3 assumptions -- invert each. What breaks?
- **Time decay:** What happens after 6 months of maintenance by a different team?

### Output Schema

```markdown
# Stress Test {A/B/C}: <proposal name>
## Attack Surface
## Failure Modes
## Surviving Assumptions
## Verdict
```

Verdict options: viable under stress / viable with modifications / fatally flawed.

### Promote

```bash
for w in a b c; do
  cp ${RUN_ROOT}/phases/crucible-stress-test-${w}/stress-test-${w}.md \
     ${RUN_ROOT}/artifacts/review-${w}.md
done
```

### Gate

All three exist as `artifacts/review-{a,b,c}.md`. Each has Attack Surface,
Failure Modes (3+ specific entries), Surviving Assumptions, Verdict.

### Routes

| Outcome | Target |
|---------|--------|
| pass | crucible-converge |

---

## Step 5: crucible-converge

**Kind:** synthesis (orchestrator, NOT dispatched)

**Reads:** `artifacts/problem-brief.md`, `artifacts/revised-{a,b,c}.md`,
`artifacts/review-{a,b,c}.md`

**Writes:** `artifacts/selection-synthesis.md`

### Selection Criteria (priority order)

1. **First-principles fit** -- Addresses root cause, not symptoms.
2. **Thoroughness** -- Handles edge cases and full problem scope.
3. **Context fit** -- Realistic given problem brief constraints.
4. **Adversarial survivability** -- Held up best under stress testing.

### Steal from the Losers

After selecting, name 2-3 ideas from non-selected proposals that strengthen the
winner. The synthesis is "make the best even better using what the others got
right."

### Artifact Schema

```markdown
# Selection + Synthesis
## Selection Rationale
## Synthesized Elements
## Merged Proposal
```

### Gate

Non-empty Selection Rationale (names chosen approach), Synthesized Elements
(lists absorbed ideas), Merged Proposal.

### Reopen Logic

| Trigger | Target | Action |
|---------|--------|--------|
| All approaches inadequate | crucible-diverge | Delete `proposal-*.md` forward. Optionally sharpen constraints in brief. |
| Viable winner | crucible-harden | Continue. |

---

## Step 6: crucible-harden

**Kind:** synthesis (orchestrator, NOT dispatched)

**Reads:** `artifacts/selection-synthesis.md`

**Writes:** `artifacts/pre-mortem.md`

Prior reviews and stress tests are intentionally withheld for fresh perspective.

### Pre-mortem Framing

> Assume this proposal was fully implemented six months ago. It failed. You are
> the person who saw it coming but did not speak up. Explain exactly why it failed.

This framing prevents generic risk lists. Produce specific, situated failure
narratives.

### Artifact Schema

```markdown
# Pre-mortem Review
## Failure Scenarios
## Edge Cases
## Blind Spots
## Environmental Risks
```

Failure Scenarios: 3-5 entries with concrete mechanisms. Not "insufficient testing"
but "the caching layer was added in week 3 without updating invalidation logic,
causing stale data for 72 hours."

### Gate

All four sections populated. Failure Scenarios has 3-5 entries with concrete
mechanisms.

### Routes

| Outcome | Target |
|---------|--------|
| pass | crucible-select |

---

## Step 7: crucible-select

**Kind:** synthesis (orchestrator, NOT dispatched)

**Reads:** `artifacts/selection-synthesis.md`, `artifacts/pre-mortem.md`

**Writes:** `artifacts/final-proposal.md`

Address every finding from `pre-mortem.md`. Every failure scenario, edge case,
blind spot, and environmental risk must have either:
- A specific mitigation incorporated into the proposal, or
- An explicit acceptance with rationale for why the risk is tolerable.

"We will monitor this" is not a mitigation unless it specifies what is monitored,
what threshold triggers action, and what the action is.

### Artifact Schema

```markdown
# Final Proposal
## Executive Summary
## The System
## Mitigations
## Implementation Plan
## Open Risks
```

### Gate

Non-empty Executive Summary and The System. Every pre-mortem finding appears in
Mitigations or Open Risks.

### Reopen Logic

| Trigger | Target | Action |
|---------|--------|--------|
| Pre-mortem gaps | crucible-harden | Delete `pre-mortem.md` + `final-proposal.md`. Re-run. |
| Synthesis flawed | crucible-converge | Delete from `selection-synthesis.md` forward. |
| All approaches inadequate | crucible-diverge | Delete from `proposal-*.md` forward. |

Reopen always deletes from the target step forward. Never delete upstream.

### Routes

| Outcome | Target |
|---------|--------|
| pass | @complete |
| fail | @escalate |

---

## Resume Awareness

Check artifacts in chain order:

1. `problem-brief.md` missing -> crucible-frame
2. Any `proposal-{a,b,c}.md` missing -> crucible-diverge
3. Any `revised-{a,b,c}.md` missing -> crucible-explore
4. Any `review-{a,b,c}.md` missing -> crucible-stress-test
5. `selection-synthesis.md` missing -> crucible-converge
6. `pre-mortem.md` missing -> crucible-harden
7. `final-proposal.md` missing -> crucible-select
8. All present -> circuit complete; surface `final-proposal.md`

**Partial parallel resume:** For steps 2, 3, 4 -- check individual worker
artifacts. If 2 of 3 exist, dispatch only the missing worker.

**Reopen resume:** Artifacts from a reopen target forward are stale. Delete from
target forward and resume at that step.

## Circuit Breakers

Escalate to the user when:
- A dispatch step fails twice with no valid output
- All three proposals converge on the same approach despite different stances
- The pre-mortem identifies a fundamental flaw that no revision can address
- The problem brief is too vague for meaningfully different explorations
- Stress testing returns "fatally flawed" for all three revised proposals

Include: failure context, counter values, options (adjust scope, re-frame, abort).

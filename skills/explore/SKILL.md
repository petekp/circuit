---
name: explore
description: >
  Investigate, understand, choose among options, or shape an execution plan.
  Covers codebase exploration, architectural investigation, RFC/PRD review,
  and decision-making. Absorbs the old researched, adversarial, spec-review,
  and crucible modes. Rigor profiles: Lite (quick look), Standard (evidence +
  options), Deep (+ seam proof), Tournament (bounded adversarial evaluation),
  Autonomous (Standard with auto-resolved checkpoints).
trigger: >
  Use for /circuit:explore, or when circuit:run routes here.
---

# Explore

Investigate, understand, choose among options, shape a plan. The thinking workflow.

## Phases

Frame -> Analyze -> Decide/Plan -> Close (or handoff to Build)

## Entry

The router passes: task description, rigor profile, and optional spec input.

**Direct invocation:** When invoked directly via `/circuit:explore` (not through
the router), bootstrap the run root if one does not already exist:

Derive `RUN_SLUG` from the task description: lowercase, replace spaces and
special characters with hyphens, collapse consecutive hyphens, trim to 50
characters. Example: "Evaluate Auth Strategies" produces `evaluate-auth-strategies`.

```bash
RUN_SLUG="evaluate-auth-strategies"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
```

Write initial `${RUN_ROOT}/artifacts/active-run.md` with Workflow=Explore,
Rigor=Standard (or as specified), Current Phase=frame. If the router already set
up the run root, skip bootstrap and proceed to the current phase.

## Phase: Frame

Write `artifacts/brief.md`:

```markdown
# Brief: <task>
## Objective
<what we are investigating and why>
## Scope
<what is in scope for this exploration>
## Output Types
<plan | decision | analysis -- what this exploration produces>
## Success Criteria
<what counts as a sufficient answer>
## Constraints
<hard boundaries on the investigation>
## Verification Commands
<commands that validate findings, if applicable>
## Out of Scope
<what we are NOT investigating>
```

**Spec input mode:** If an RFC/PRD/spec was provided, add:

```markdown
## Source Document
<path or inline reference>
## Intended Outcome
<what the hardened spec must enable>
## Decisions Required Before Build
<open questions that block execution>
```

**Gate:** brief.md exists with non-empty Objective, Scope, Output Types, Success Criteria.

Update `active-run.md`: phase=frame, next step=Analyze.

## Phase: Analyze

Content depends on rigor profile.

### Lite

Read the codebase directly. No external research.

Write `artifacts/analysis.md`:

```markdown
# Analysis: <task>
## Facts (confirmed, high confidence)
## Unknowns (gaps that matter)
## Implications
```

### Standard

Dispatch two parallel evidence workers.

```bash
mkdir -p "${RUN_ROOT}/phases/analyze-ext/reports" "${RUN_ROOT}/phases/analyze-ext/last-messages"
mkdir -p "${RUN_ROOT}/phases/analyze-int/reports" "${RUN_ROOT}/phases/analyze-int/last-messages"
```

**Worker A -- External Research** (role: `--role researcher`):
- Mission: Research external patterns, prior art, comparable approaches.
- Input: brief.md
- Output: `analyze-ext/external-evidence.md`
- Schema: `## Facts`, `## Inferences`, `## Unknowns`, `## Implications`, `## Source Confidence`

**Worker B -- Internal Analysis** (role: `--role researcher`):
- Mission: Trace the internal system surface relevant to this task.
- Input: brief.md
- Output: `analyze-int/internal-evidence.md`
- Schema: same as Worker A

Compose and dispatch both:

```bash
# Pick 1-2 domain skills matching the affected code (see Domain Skill Selection in run/SKILL.md).
# Omit --skills entirely if no domain skills apply.
for w in ext int; do
  "$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
    --header "${RUN_ROOT}/phases/analyze-${w}/prompt-header.md" \
    --skills "rust,tdd" \
    --root "${RUN_ROOT}/phases/analyze-${w}" \
    --out "${RUN_ROOT}/phases/analyze-${w}/prompt.md"

  "$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
    --prompt "${RUN_ROOT}/phases/analyze-${w}/prompt.md" \
    --output "${RUN_ROOT}/phases/analyze-${w}/last-messages/last-message.txt" \
    --circuit explore \
    --role researcher
done
```

Synthesize into `artifacts/analysis.md`:

```markdown
# Analysis: <task>
## Facts (confirmed, high confidence)
## Inferences (derived, medium confidence)
## Unknowns (gaps that matter)
## Contradictions Between Sources
## Implications
## Hard Invariants (must not violate)
## Seams and Integration Points
```

Label every item: `[fact]`, `[inference]`, or `[assumption]`.

### Deep

Same as Standard, plus: after analysis, identify the riskiest assumption and plan
a seam proof. The seam proof runs after Plan, before handing to Build.

### Tournament

Same as Standard for evidence gathering. The tournament divergence happens in the
Decide phase.

### Autonomous

Same as Standard. Checkpoints auto-resolve. Ambiguous findings do not block the
run; carry them forward as clearly labeled deferred findings in the normal
Explore outputs instead of introducing a separate `deferred.md` artifact.

### Spec Input Mode (any rigor)

If a spec was provided, replace external research with spec digestion:

**Worker A -- Spec Digest** (role: `--role researcher`):
- Mission: Normalize the spec into claims, mechanism, dependencies, assumptions, ambiguities.
- Output schema: `## Core Claims`, `## Proposed Mechanism`, `## Dependencies`, `## Assumptions`, `## Ambiguities`, `## Missing Artifacts`

**Worker B -- Internal Analysis** (same as Standard).

Plus dispatch 3 parallel review lenses:

**Implementer Review** (role: `--role implementer`):
- Buildability risks, missing interfaces, testability, sequencing hazards.

**Systems Review** (role: `--role reviewer`):
- Boundary risks, operational concerns, failure modes, state/concurrency.

**Comparative Review** (role: `--role researcher`):
- Adjacent patterns, tradeoffs vs spec, adopt-or-avoid guidance.

Synthesize all reviews into analysis.md with additional `## Caveat Resolution`
section listing accepted/rejected/deferred caveats.

**Gate:** analysis.md exists with non-empty Facts and Unknowns. Every item labeled.

Update `active-run.md`: phase=analyze, next step=Decide/Plan.

## Phase: Decide/Plan

The shape depends on whether this is a decision or a plan.

### Plan Output (Lite, Standard, Deep)

If the exploration produces an execution plan (not a decision), write
`artifacts/plan.md`:

```markdown
# Plan: <task>
## Approach
<chosen approach with evidence-backed rationale>
## Slices
<ordered implementation sequence>
## Verification Commands
## Adjacent-Output Checklist
- [ ] Tests
- [ ] Docs
- [ ] Config
- [ ] Migrations
- [ ] Observability
- [ ] Compatibility
```

### Decision Output (Standard, Deep, Tournament)

If the exploration produces a decision among alternatives:

**Standard/Deep:** Write `artifacts/decision.md`:

```markdown
# Decision: <topic> -- <chosen approach>
## Options Considered
### Option 1: <name>
- Approach, tradeoffs, risks
### Option 2: <name>
- Approach, tradeoffs, risks
## Decision
## Rationale
## Accepted Risks
## Rejected Alternatives
## Reopen Conditions
```

Budget: 2 meaningful options max, 1 critique pass, 1 user checkpoint if
consequential.

**Tournament:** Bounded adversarial evaluation inside the Decide phase. The
manifest exposes Tournament as an entry mode; the sequence below is
orchestrator behavior, not a set of separate YAML steps.

#### Tournament Sequence

**Step 1: Diverge** -- Dispatch 3 parallel workers, each with a different stance.

Default stances (override when the problem demands others):
- Worker A: Minimize complexity. Simplest solution that works.
- Worker B: Maximize robustness. Handle every edge case.
- Worker C: Optimize for extensibility. Build for the next three problems.

Each writes `proposal-{a,b,c}.md`. Do not mention other workers in prompts.

```bash
# Pick 1-2 domain skills matching the affected code. Omit --skills if none apply.
# These workers run inside Explore's `decide` manifest step.
for w in a b c; do
  mkdir -p "${RUN_ROOT}/phases/diverge-${w}/reports" "${RUN_ROOT}/phases/diverge-${w}/last-messages"
  "$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
    --header "${RUN_ROOT}/phases/diverge-${w}/prompt-header.md" \
    --skills "rust,tdd" \
    --root "${RUN_ROOT}/phases/diverge-${w}" \
    --out "${RUN_ROOT}/phases/diverge-${w}/prompt.md"
  "$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
    --prompt "${RUN_ROOT}/phases/diverge-${w}/prompt.md" \
    --output "${RUN_ROOT}/phases/diverge-${w}/last-messages/last-message.txt" \
    --circuit explore \
    --role researcher
done
```

Proposal schema: `## Approach`, `## Rationale`, `## Tradeoffs`, `## Implementation Sketch`.

**Step 2: Adversarial Review** -- 3 parallel reviewers, each sees ONE proposal.

Red-team mission: "Find what is wrong. Do not be balanced."
Review schema: `## Strengths`, `## Weaknesses`, `## Hidden Assumptions`, `## Feasibility`, `## Verdict`

**Step 3: Revise** -- Each worker gets its proposal + its review. Strengthen, do
not abandon.

Revised schema: same as proposal + `## Changes from Original`.

**Step 4: Stress Test** -- 3 parallel attackers. Attack vectors: seam failures,
scale pressure, dependency failure, assumption inversion, time decay.

Stress test schema: `## Attack Surface`, `## Failure Modes`, `## Surviving Assumptions`, `## Verdict`

**Step 5: Converge** -- Orchestrator selects strongest, steals best ideas from
losers.

Selection criteria (priority): first-principles fit > thoroughness > context fit > adversarial survivability.

Write `artifacts/decision.md` with the converged proposal.

**Step 6: Pre-mortem** -- "Assume this was implemented 6 months ago. It failed.
Explain exactly why."

Write pre-mortem findings into decision.md `## Mitigations` and `## Open Risks`.

**Checkpoint:** Present the converged decision to the user for confirmation.
Treat this as the one user checkpoint this protocol should take in Tournament
rigor, even though the manifest does not model it as a separate gate.

**Gate:** decision.md or plan.md exists with required sections populated.

### Deep: Seam Proof

If rigor is Deep, after Plan/Decision, dispatch a worker to prove the riskiest
seam with code (failing test, thin spike, minimal integration).

```bash
step_dir="${RUN_ROOT}/phases/seam-proof"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

Seam proof schema: `## Seam Identified`, `## What Was Built/Tested`,
`## Evidence`, `## Verdict: DESIGN HOLDS | NEEDS ADJUSTMENT | DESIGN INVALIDATED`

- DESIGN HOLDS: continue.
- NEEDS ADJUSTMENT: update plan, continue.
- DESIGN INVALIDATED: escalate to user.

Update `active-run.md`: phase=decide, next step=Close or handoff to Build.

## Phase: Close

Write `artifacts/result.md`:

```markdown
# Result: <task>
## Findings
<key discoveries>
## Decision (if applicable)
<what was decided and why>
## Plan (if applicable)
<execution plan ready for Build>
## Next Steps
<hand to Build, or done>
## PR Summary
<PR body seed if applicable>
```

**Transfer to Build:** If the result is an execution plan (plan.md exists with
Slices), transfer to Build within the same run instead of asking the user to
run a separate command. This is orchestrator behavior; `circuit.yaml` does not
encode a dedicated transfer edge:

1. Update `active-run.md`:
   ```markdown
   ## Current Phase
   transfer
   ## Next Step
   Build: execute the plan from Explore
   ## Transfer
   from: Explore
   to: Build
   reason: exploration complete, plan ready for execution
   ```
2. Load the `circuit:build` skill and resume from its Plan phase (plan.md
   already exists). Build skips Frame (brief.md carries forward from Explore)
   and validates the existing plan.md against its gate before proceeding to Act.

If the result is a decision (decision.md, no plan.md with Slices), close
normally. The user decides what to do next.

**Gate:** result.md exists with non-empty Findings.

Update `active-run.md`: phase=close.

## Circuit Breakers

Escalate when:
- Evidence probes return contradictory facts with no resolution path
- Tournament: all three proposals converge on the same approach (problem may be over-constrained)
- Tournament: all three stress tests return "fatally flawed"
- Seam proof returns DESIGN INVALIDATED
- Problem brief is too vague for meaningfully different explorations
- Dispatch step fails twice

Include: failure context, options (narrow scope, re-frame, abort).

## Resume

Check artifacts in chain order:
1. brief.md missing -> Frame
2. analysis.md missing -> Analyze
3. plan.md or decision.md missing -> Decide/Plan
4. result.md missing -> Close
5. All present -> complete

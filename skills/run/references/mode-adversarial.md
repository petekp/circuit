# Mode: Adversarial

Reference for the adversarial path through the circuit:run supergraph. Load after
triage classifies the task as adversarial (or after the `decide:` intent hint).

## Artifact Chain

```
triage-result.md -> external-digest.md + internal-digest.md -> constraints.md
  -> options.md -> decision-packet.md -> adr.md -> execution-packet.md
  -> seam-proof.md -> implementation-handoff.md -> ship-review.md -> done.md
```

## Step IDs

```
triage -> evidence-probes -> constraints -> options -> decision-packet
  -> tradeoff-decision -> execution-contract -> prove-seam -> implement
  -> ship-review -> summarize
```

## Role Assignment

| Step | Role |
|------|------|
| evidence-probes (both workers) | `--role researcher` |
| options | `--role implementer` |
| decision-packet | `--role reviewer` |
| prove-seam | `--role implementer` |
| implement | `--role implementer` |
| ship-review | `--role reviewer` |

---

## Step 1: evidence-probes -- `dispatch`

Dispatch two parallel workers. Worker A researches external patterns and prior art.
Worker B traces internal codebase surface. Each produces an evidence digest.

**Protocol reference:** `protocols/parallel-evidence-probes.md`

### Setup

```bash
mkdir -p "${RUN_ROOT}/phases/evidence-probes-a/reports" \
         "${RUN_ROOT}/phases/evidence-probes-a/last-messages"
mkdir -p "${RUN_ROOT}/phases/evidence-probes-b/reports" \
         "${RUN_ROOT}/phases/evidence-probes-b/last-messages"
```

### Worker A -- External Research

Header at `${RUN_ROOT}/phases/evidence-probes-a/prompt-header.md`:
- Mission: Research external patterns, prior art, and comparable approaches. Use
  `deep-research` skill if available.
- Inputs: Full text of `artifacts/triage-result.md`
- Output: `${RUN_ROOT}/phases/evidence-probes-a/external-digest.md`
- Schema: `# Evidence Digest: External Research` with `## Facts` (confirmed, high
  confidence), `## Inferences` (derived, medium confidence), `## Unknowns` (gaps
  that matter), `## Implications for This Decision`, `## Source Confidence`
- Success: At least 2 facts, at least 1 unknown, source confidence on every claim.

### Worker B -- Internal Codebase Analysis

Header at `${RUN_ROOT}/phases/evidence-probes-b/prompt-header.md`:
- Mission: Trace the internal system surface. Map boundaries, ownership, data flow,
  failure surfaces, and constraints any option must respect.
- Inputs: Full text of `artifacts/triage-result.md`
- Output: `${RUN_ROOT}/phases/evidence-probes-b/internal-digest.md`
- Schema: Same evidence digest schema as Worker A, titled `Internal Analysis`
- Success: At least 1 boundary, 1 constraint, 1 unknown, all with certainty labels.

### Dispatch

Worker A: compose with `--skills deep-research`, dispatch with `--role researcher`.
Worker B: compose with `--skills <domain-skills>`, dispatch with `--role researcher`.
Run in parallel when backend supports it.

### Verify and Promote

Copy `external-digest.md` and `internal-digest.md` to `${RUN_ROOT}/artifacts/`. If
a worker only wrote `reports/report.md`, synthesize the digest manually.

### Gate

Both digests exist with non-empty Facts, Unknowns, and Implications. Source Confidence
labels present.

---

## Step 2: constraints -- `synthesis`

Read both digests and triage result. Merge into a single decision substrate.

### Artifact

Write `${RUN_ROOT}/artifacts/constraints.md`:

```markdown
# Constraints: <decision topic>
## Hard Invariants (must not violate)
## Seams and Integration Points
## Contradictions Between Sources
## Open Questions (ranked by decision impact)
## Performance and Operational Constraints
```

Label every item: `[fact]`, `[inference]`, or `[assumption]`.

### Gate

At least 1 hard invariant, at least 1 seam, ranked open questions. Every item labeled.

### Critical Routing

Read `artifacts/triage-result.md` mode field after writing constraints:
- Mode `researched` -> emit route `"researched"` (routes to scope step, not covered here)
- Mode `adversarial` -> emit route `"adversarial"` (routes to options, continue below)

---

## Step 3: options -- `dispatch`

Dispatch a worker to generate 3-5 genuinely distinct approaches.

### Setup

```bash
step_dir="${RUN_ROOT}/phases/options"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

### Prompt Header

Write `${step_dir}/prompt-header.md`:
- Mission: Generate 3-5 genuinely distinct approaches. Each must differ on at least 2
  of: architecture shape, ownership boundary, failure surface, data model. Include at
  least one option that challenges the prevailing assumption.
- Inputs: Full `artifacts/triage-result.md` + full `artifacts/constraints.md`
- Output: `${step_dir}/options.md`
- Schema per option:
  ```markdown
  ## Option N: <name>
  - Architecture shape
  - Key seam
  - Failure surface
  - Prerequisite changes
  - Rollback cost
  - Explicit disqualifiers
  ```

### Dispatch

Compose with `--skills solution-explorer,architecture-exploration,<domain-skills>`.
Dispatch with `--role implementer`. Promote to `artifacts/options.md`.

### Gate

At least 3 options. Each differs from every other on at least 2 structural dimensions.
All 6 schema fields populated per option.

---

## Step 4: decision-packet -- `dispatch`

Dispatch a worker to red-team each option, then synthesize a decision matrix.

### Setup

```bash
step_dir="${RUN_ROOT}/phases/decision-packet"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

### Prompt Header

Write `${step_dir}/prompt-header.md`:
- Mission: Attack each option's weakest seam. Synthesize a decision matrix with risk
  dimensions (not just feature comparison). Recommend with explicit rationale. Name
  reopen conditions.
- Inputs: Full `artifacts/constraints.md` + full `artifacts/options.md`
- Output: `${step_dir}/decision-packet.md`
- Schema:
  ```markdown
  # Decision Packet: <topic>
  ## Per-Option Risk Assessment
  ## Decision Matrix
  ## Recommendation and Rationale
  ## Unresolved Risks
  ## Reopen Conditions
  ```

### Dispatch

Compose with `--skills seam-ripper,clean-architecture,<domain-skills>`. Dispatch with
`--role reviewer`. Promote to `artifacts/decision-packet.md`.

### Gate

At least 1 option materially weakened by critique. Matrix includes risk dimensions.
Reopen conditions present and testable.

---

## Step 5: tradeoff-decision -- `checkpoint`

Present `artifacts/decision-packet.md` to the user. Ask:

> Here is the decision packet with [N] options. The recommendation is [X].
> 1. Which tradeoff priority: correctness, UX, speed, extensibility, simplicity?
> 2. What risks from the packet are you accepting?
> 3. Any scope cuts?

### Artifact

Write `${RUN_ROOT}/artifacts/adr.md`:

```markdown
# ADR: <topic> -- <chosen approach>
## Decision
## Rationale
## Accepted Risks
## Rejected Alternatives
## Scope Cuts
## Non-Goals
## Reopen Conditions
```

### Gate

Non-empty Decision, Accepted Risks, at least 1 Rejected Alternative mapping to
`options.md`.

---

## Step 6: execution-contract -- `synthesis`

Read `adr.md`, `constraints.md`, and `triage-result.md`. Convert into an executable
build contract.

### Artifact

Write `${RUN_ROOT}/artifacts/execution-packet.md`:

```markdown
# Execution Packet: <topic>
## Invariants (from constraints + ADR)
## Interface Boundaries (what changes, what must not)
## Slice Order (implementation sequence)
## Test Obligations (what must be tested and how)
## Artifact Expectations
## Rollback Triggers
## Non-Goals
## Verification Commands
```

### Gate

Non-empty Invariants, Slice Order, Test Obligations. Each invariant has at least one
test obligation.

### Augmentation Injection

Check `triage-result.md` augmentations:
- **Bug augmentation:** Add `## Regression Contract` section. Regression test becomes
  Slice 0.
- **Migration augmentation:** Add `## Coexistence Plan` section. Define old/new
  coexistence, rollout flag, removal condition.

---

## Step 7: prove-seam -- `dispatch`

Identify the riskiest seam in the execution packet. Dispatch a worker to prove it
with code (failing tests, thin spike, or minimal integration).

### Setup

```bash
step_dir="${RUN_ROOT}/phases/prove-seam"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

### Prompt Header

Write `${step_dir}/prompt-header.md`:
- Mission: Identify the riskiest seam and prove it with code. Evidence must come from
  execution, not reasoning alone.
- Inputs: Full `artifacts/execution-packet.md`
- Output: `${step_dir}/seam-proof.md`
- Schema:
  ```markdown
  # Seam Proof: <seam name>
  ## Seam Identified
  ## What Was Built/Tested
  ## Evidence (test results, spike output)
  ## Design Validity
  ## Verdict: DESIGN HOLDS / NEEDS ADJUSTMENT / DESIGN INVALIDATED
  ```

### Dispatch

Compose with `--skills <domain-skills>`. Dispatch with `--role implementer`. Promote
to `artifacts/seam-proof.md`.

### Gate with Reopen

- **DESIGN HOLDS** -> continue to implement.
- **NEEDS ADJUSTMENT** -> update `execution-packet.md`, log adjustment, continue.
- **DESIGN INVALIDATED** -> escalate. Ask user: narrow scope, adjust approach, or
  reopen at options step with updated constraints.

---

## Step 8: implement -- `dispatch` (via workers)

Create workers workspace, dispatch for implement -> review -> converge, synthesize
handoff artifact.

**Protocol reference:** `protocols/workers-execute.md`

### Setup

```bash
IMPL_ROOT="${RUN_ROOT}/phases/implement"
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/reports" "${IMPL_ROOT}/last-messages"
cp ${RUN_ROOT}/artifacts/execution-packet.md ${IMPL_ROOT}/CHARTER.md
```

### Prompt Header

Write `${IMPL_ROOT}/prompt-header.md`:
- Mission: Implement per CHARTER.md using workers implement -> review -> converge.
  Follow Slice Order. Respect Invariants. Run Verification Commands.
- Inputs: execution-packet.md (copied as CHARTER.md)
- Output: `${IMPL_ROOT}/reports/report-converge.md`
- Success: All slices converge with `COMPLETE AND HARDENED`.

Include `### Files Changed`, `### Tests Run`, `### Completion Claim` headings.

### Dispatch

Compose with `--skills workers,<domain-skills>`. Dispatch with `--role implementer`.

### Synthesize Handoff

Read (in order): `report-converge.md`, `job-result.json`, last slice report. Write
`${RUN_ROOT}/artifacts/implementation-handoff.md`:

```markdown
# Implementation Handoff: <topic>
## What Was Built
## Tests Run and Verification Results
## Convergence Verdict
## Open Issues
```

### Gate

`implementation-handoff.md` exists. Convergence verdict is `COMPLETE AND HARDENED`.

### Routing

Emit route `"to_ship_review"`. Do NOT emit `"to_summary"` or `"to_review"`.

---

## Step 9: ship-review -- `dispatch`

Independent audit against execution packet. Reviewer does NOT modify source code.

**Protocol reference:** `protocols/final-review.md`

### Setup

```bash
step_dir="${RUN_ROOT}/phases/ship-review"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

### Prompt Header

Write `${step_dir}/prompt-header.md`:
- Mission: Audit implementation against execution packet. Check contract drift,
  correctness bugs, naming, dead code, missing tests. Diagnose only, no code changes.
- Inputs: Full `artifacts/execution-packet.md`, full
  `artifacts/implementation-handoff.md`, digested `artifacts/triage-result.md`
- Output: `${step_dir}/ship-review.md`
- Schema:
  ```markdown
  # Ship Review: <topic>
  ## Contract Compliance
  ## Findings
  ### Critical (must fix before ship)
  ### High (should fix)
  ### Low (acceptable debt)
  ## Intentional Debt
  ## Fit-to-Intent Assessment
  ## Verdict: SHIP-READY / ISSUES FOUND
  ```

### Dispatch

Compose with `--skills <domain-skills>`. Dispatch with `--role reviewer`. Promote to
`artifacts/ship-review.md`.

### Gate with Retry

- **SHIP-READY** -> route to summarize.
- **ISSUES FOUND with critical findings** -> address findings, re-run (max 2 total).
  After 2 attempts, escalate to user.
- **ISSUES FOUND, no critical** -> route to summarize. High/low become tracked debt.

---

## Step 10: summarize -- `synthesis`

Write the terminal artifact.

### Artifact

Write `${RUN_ROOT}/artifacts/done.md`:

```markdown
# Done: <topic>
## Changes
## Verification
## Notes
```

### Gate

Non-empty Changes, Verification, Notes.

---

## Circuit Breakers

Escalate when:
- Dispatch step fails twice (no valid output after 2 attempts)
- Seam proof returns `DESIGN INVALIDATED`
- Workers: `impl_attempts > 3` or `impl_attempts + review_rejections > 5`
- Convergence fails after max attempts
- Ship review `ISSUES FOUND` with critical findings after 2 attempts

Include: counter values, failure output, options (adjust scope, skip slice, abort).

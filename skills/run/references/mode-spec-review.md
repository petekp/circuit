# Mode: Spec Review

Existing RFC, PRD, or spec needs multi-angle review before build.

**Path:** spec-intake -> draft-digest -> parallel-reviews -> caveat-resolution -> amended-draft -> execution-contract -> prove-seam -> implement -> ship-review -> summarize

## Step: spec-intake (checkpoint)

If a spec path was provided (e.g., `--spec <path>`), read it. Otherwise ask the
user to provide or point to the draft.

Ask the user:
1. Who is the primary audience for this document?
2. What intended outcome must the hardened spec enable?
3. What is explicitly out of scope?
4. What open questions still matter?
5. Which decisions are required before build begins?

Write `artifacts/spec-brief.md`:
```markdown
# Spec Brief
## Source Document
## Intended Outcome
## Primary Audience
## Non-Goals
## Open Questions
## Decisions Required Before Build
```

**Gate:** Non-empty Source Document, Intended Outcome, Non-Goals.

**Route:** emit `continue` -> draft-digest

## Step: draft-digest (synthesis)

Read the source spec and spec-brief.md. Normalize into `artifacts/draft-digest.md`:

```markdown
# Draft Digest
## Core Claims
## Proposed Mechanism
## Dependencies
## Assumptions
## Ambiguities
## Missing Artifacts
```

Do NOT invent new design decisions. Capture the mechanism and assumptions as they
exist in the draft.

**Gate:** draft-digest.md captures mechanism and assumptions without inventing.

**Route:** emit `pass` -> parallel-reviews

## Step: parallel-reviews (dispatch)

Three independent review lenses, dispatched in parallel.

```bash
mkdir -p "${RUN_ROOT}/phases/review-impl/reports" "${RUN_ROOT}/phases/review-impl/last-messages"
mkdir -p "${RUN_ROOT}/phases/review-sys/reports" "${RUN_ROOT}/phases/review-sys/last-messages"
mkdir -p "${RUN_ROOT}/phases/review-comp/reports" "${RUN_ROOT}/phases/review-comp/last-messages"
```

**Worker A -- Implementer Review** (role: `--role implementer`):
- Mission: Evaluate buildability, missing seams, testability, sequencing hazards
- Input: draft-digest.md
- Output: `review-impl/implementer-review.md`
- Schema: Buildability Risks, Missing Interfaces, Testability Concerns, Sequencing Hazards, Required Clarifications

**Worker B -- Systems Review** (role: `--role reviewer`):
- Mission: Pressure for boundary issues, runtime risks, failure handling gaps
- Input: draft-digest.md
- Output: `review-sys/systems-review.md`
- Schema: Boundary Risks, Operational Concerns, Failure Modes, State and Concurrency Concerns, Migration or Observability Gaps

**Worker C -- Comparative Review** (role: `--role researcher`):
- Mission: Compare to adjacent patterns/prior art, produce adopt-or-avoid guidance
- Input: draft-digest.md
- Output: `review-comp/comparative-review.md`
- Schema: Comparable Patterns, Tradeoffs vs Draft, Where Draft is Stronger, Where Draft is Weaker, Adopt or Avoid Recommendations

Promote all three to `artifacts/`.

**Gate:** All three exist. Implementer names build seams, systems covers
architecture + runtime, comparative includes at least two comparisons.

**Route:** emit `pass` -> caveat-resolution

## Step: caveat-resolution (checkpoint)

Present all three reviews. Ask:
1. Which caveats should become amendments now?
2. Which are you explicitly rejecting?
3. Which risks are real but deferred?
4. Scope cuts before rewriting?

Write `artifacts/caveat-resolution.md`:
```markdown
# Caveat Resolution
## Accepted Caveats
## Rejected Caveats
## Deferred Risks
## Priority Amendments
## Scope Cuts
```

**Gate:** Accepted Caveats exist or explicit no-change rationale. Deferred Risks named.

**Route:** emit `continue` -> amended-draft

## Step: amended-draft (synthesis)

Read source spec, draft-digest.md, and caveat-resolution.md.
Write `artifacts/amended-spec.md`:

```markdown
# Amended Spec
## Problem and Goal
## Proposed Design
## Interfaces and Boundaries
## Invariants
## Failure Handling
## Open Risks
## Non-Goals
```

Every accepted caveat must be reflected. Every deferred risk must remain visible.

**Gate:** Every accepted caveat reflected, every deferred risk visible.

**Route:** emit `pass` -> execution-contract

## Steps: execution-contract through summarize

From this point, follow the same steps as adversarial mode:
- **execution-contract**: Read amended-spec.md + caveat-resolution.md + spec-brief.md
  (instead of adr.md + constraints.md). Same execution-packet.md schema.
- **prove-seam**: Same as adversarial mode.
- **implement**: Same. Route: emit `to_ship_review`.
- **ship-review**: Same as adversarial mode.
- **summarize**: Same.

See `references/mode-adversarial.md` for detailed instructions on these shared steps.

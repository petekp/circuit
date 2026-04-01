---
name: circuit:develop
description: >
  Artifact-driven circuit for taking a significant feature from idea to shipped code.
  10 steps across 5 phases: Alignment → Evidence → Decision → Preflight → Delivery.
  Use when the user describes a non-trivial feature that needs research, design, and
  implementation -- not for bug fixes, single-file changes, or quick wiring tasks.
---

# Develop Circuit

An artifact-centric workflow that chains intent → constraints → decision → contract → code.
Each phase produces a named artifact that becomes the next phase's input. The user steers
at three checkpoints where product judgment matters most.

## When to Use

- Feature additions that span multiple files or domains
- Cross-domain work (Rust + Swift, frontend + backend)
- Problems where the implementation approach isn't obvious
- Work where research should precede implementation

Do NOT use for bug fixes, config changes, or single-file wiring tasks.

For tasks where the approach is already clear but the work still benefits from structured
intent/contract/implement/review flow, use `--light` mode (see Mode Selection below).

For tasks where a written spec, RFC, or PRD already exists and needs review before
build, use `--spec-review` mode (see Mode Selection below).

## Glossary

- **Artifact** -- A canonical circuit output file in `${RUN_ROOT}/artifacts/`. These are the
  durable chain. Each step produces exactly one artifact.
- **Worker report** -- The raw output a worker writes to its relay `reports/` directory.
  Worker reports are inputs to artifact synthesis, not artifacts themselves.
- **Prompt header** -- A self-contained file the orchestrator writes before dispatch. Contains
  the full worker contract: mission, inputs, output path, output schema, success criteria.
- **Synthesis** -- When the orchestrator (Claude session) reads prior artifacts and writes a
  new artifact directly, without dispatching a worker.

## Principles

- **Artifacts, not activities.** Every step produces a concrete file. No step exits
  without writing its output artifact.
- **Self-contained headers.** Dispatch steps do NOT use `--template`. The prompt header
  carries the full worker contract: mission, inputs, output schema, success criteria,
  and report instructions.
- **User steers tradeoffs, not approvals.** Checkpoints ask the user to choose between
  competing priorities, not rubber-stamp a recommendation.
- **Digest chaining.** The orchestrator reads prior artifacts and writes a compact digest
  into the next step's prompt header. No strict named-output contracts.
- **Prove before you build.** The hardest seam gets a thin slice or failing test before
  the full implementation pipeline commits.

## Setup

```bash
RUN_SLUG="<feature-slug>"
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts"
```

Record `RUN_ROOT` -- all paths below are relative to it.

**Per-step scaffolding** -- before each dispatch step, create:
```bash
step_dir="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

## Mode Selection

Parse the circuit invocation args for mode flags.

- If `--light` is present → `MODE=light`. Log: "Running in light mode (4 steps)."
- If `--spec-review` is present → `MODE=spec-review`. Log: "Running in spec-review mode."
- If `--spec <path>` is present → `MODE=spec-review`, set `SOURCE_SPEC=<path>`. Log: "Running in spec-review mode with spec: <path>."
- If no mode flag is present → `MODE=full` (default). The full 10-step workflow runs unchanged.

**Light mode** runs 4 of the 10 steps:

| Light step | Full step | Action      | Produces                |
|------------|-----------|-------------|-------------------------|
| 1          | Step 1    | interactive | intent-brief.md         |
| 2          | Step 7    | synthesis   | execution-packet.md     |
| 3          | Step 9    | dispatch    | implementation-handoff.md |
| 4          | Step 10   | dispatch    | ship-review.md          |

**Light mode artifact chain:**
```
intent-brief.md → execution-packet.md → implementation-handoff.md → ship-review.md
```

Skipped phases: Evidence, Decision. Skipped steps: Parallel Evidence Probes,
Constraints Synthesis, Generate Distinct Candidates, Adversarial Evaluation,
Tradeoff Decision, Prove the Hardest Seam.

**Key differences from full mode:**
- Step 7 (Implementation Contract) reads from `intent-brief.md` directly -- there is no
  `adr.md` or `constraints.md` to reference. See the Light Mode Variant under Step 7.
- The intent-brief MUST include a `## Mode` section (see Step 1 light mode note).
- Gates still apply to every step -- no quality compromise.

### Spec-Review Mode

**When to use:** An existing draft, spec, RFC, or PRD exists and needs multi-angle review
before implementation. This mode replaces the standalone `harden-spec` circuit -- it runs
the same review pipeline but continues through to code delivery instead of stopping before
implementation.

**Spec-review mode** runs a modified step sequence that replaces the Alignment/Evidence/Decision
phases with a spec intake and multi-angle review pipeline, then merges back into the standard
Preflight/Delivery phases:

| Spec-review step | Action      | Produces                 |
|------------------|-------------|--------------------------|
| 1. Spec Intake          | interactive | spec-brief.md            |
| 2. Draft Digest         | synthesis   | draft-digest.md          |
| 3. Parallel Reviews     | dispatch    | implementer-review.md + systems-review.md + comparative-review.md |
| 4. Caveat Resolution    | interactive | caveat-resolution.md     |
| 5. Amended Draft        | synthesis   | amended-spec.md          |
| 6. Implementation Contract | synthesis | execution-packet.md      |
| 7. Prove the Hardest Seam | dispatch  | seam-proof.md            |
| 8. Implement            | dispatch    | implementation-handoff.md |
| 9. Ship Review          | dispatch    | ship-review.md           |

**Spec-review mode artifact chain:**
```
spec-brief.md → draft-digest.md → implementer-review.md + systems-review.md + comparative-review.md → caveat-resolution.md → amended-spec.md → execution-packet.md → seam-proof.md → implementation-handoff.md → ship-review.md
```

Skipped phases: Evidence (external/internal probes), Decision (candidate generation,
adversarial evaluation, tradeoff decision). These are replaced by the multi-angle
review pipeline which provides equivalent scrutiny from an existing document rather
than from scratch.

**Key differences from full mode:**
- Steps 1-5 come from the harden-spec pipeline (spec intake, digest, parallel reviews,
  caveat resolution, amended draft) instead of develop's alignment/evidence/decision.
- Step 6 (Implementation Contract) reads from `amended-spec.md` and `caveat-resolution.md`
  instead of `adr.md` and `constraints.md`. See the Spec-Review Mode Variant under Step 7.
- Steps 7-9 (Prove Seam, Implement, Ship Review) run identically to full mode.
- Gates still apply to every step -- no quality compromise.

**Key difference from standalone harden-spec:** This mode continues through to code
delivery (Steps 7-9). Standalone harden-spec stopped after producing the execution
packet and implementation plan without writing any code.

If `MODE=spec-review`, follow the spec-review step descriptions below, then rejoin the
standard phases at Step 7 (Implementation Contract) using the spec-review variant.

If `MODE=full`, ignore all light-mode and spec-review-mode variants below and follow the standard phases.

---

## Domain Skill Selection

When a step says `<domain-skills>`, pick 1-2 skills matching the affected code:
- Rust core: `rust`
- Swift app: `swift-apps`
- Both: `rust,swift-apps`

Never exceed 3 total skills per dispatch. Do not append interactive skills
(like `proposal-review` or `grill-me`) to autonomous worker dispatches.

## Dispatch Backend

Dispatch steps use either **Codex CLI** or **Claude Code Agent** as the worker
backend. The backend is auto-detected: if `codex` is on PATH, use Codex; otherwise,
fall back to Agent. The assembled prompt is identical for both backends.

**Codex backend** (when `codex` CLI is installed):
```bash
cat ${step_dir}/prompt.md | \
  codex exec --full-auto \
  -o ${step_dir}/last-messages/last-message.txt -
```

**Agent backend** (when `codex` CLI is NOT installed):
Use the Agent tool with the assembled prompt as the task and `isolation: "worktree"`:
```
Agent(task=<contents of ${step_dir}/prompt.md>, isolation="worktree")
```
After the Agent completes, verify its output artifacts exist at the expected paths.
If the Agent did not write to the expected artifact path, check its response for the
artifact content and write it manually.

**Backend detection:**
```bash
if command -v codex >/dev/null 2>&1; then
  # Use Codex backend
  cat ${step_dir}/prompt.md | codex exec --full-auto -o ${step_dir}/last-messages/last-message.txt -
else
  # Use Agent backend -- invoke the Agent tool with the prompt content
  # Agent(task=<prompt contents>, isolation="worktree")
fi
```

Or use the dispatch helper:
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${step_dir}/prompt.md \
  --output ${step_dir}/last-messages/last-message.txt
```

The artifact chain, gates, report format, and resume logic are **identical**
regardless of backend. The only difference is the execution mechanism.

**Parallel dispatch:** The Codex backend supports true parallel workers (`&` + `wait`). Agent
backend dispatches sequentially unless the orchestrator uses multiple Agent tool calls
in one response. When backend is Agent and a step has parallel workers (e.g., Step 2),
dispatch them as separate sequential Agent calls.

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

## Report Instructions
Write your primary output to the path above. Also write a standard report to
`reports/report.md` with these exact section headings:

### Files Changed
[List files modified or created]

### Tests Run
[List test commands and results, or "None" if no tests]

### Verification
[How the output was verified]

### Verdict
[CLEAN / ISSUES FOUND]

### Completion Claim
[COMPLETE / PARTIAL]

### Issues Found
[List any issues, or "None"]

### Next Steps
[What the next phase should focus on]
```

**Why these headings matter:** `compose-prompt.sh` checks for `### Files Changed`,
`### Tests Run`, and `### Completion Claim` in the assembled prompt. If missing, it
appends `relay-protocol.md` as a legacy report-format safety net. Including these
headings in the header prevents that extra prompt contamination.

---

## Phase 1: Alignment

### Step 1: Intent Lock -- `interactive`

**Objective:** Define what success looks like before any research starts.

Ask the user (via AskUserQuestion):

> Describe the feature you want to build. Then answer:
> 1. If we can only get two things right in v1, what are they?
> 2. What would make this feature feel wrong even if it technically ships?
> 3. What is explicitly out of scope?

Write their response to `${RUN_ROOT}/artifacts/intent-brief.md`:

```markdown
# Intent Brief: <feature>
## Ranked Outcomes
## Non-Goals
## Kill Criteria
## Unresolved Questions
## Domain and File Scope
```

**Gate:** `intent-brief.md` exists with non-empty Ranked Outcomes and Non-Goals.

**Light mode note:** When `MODE=light`, the intent-brief MUST include a `## Mode` section
as the first section after the title heading. This section declares that the evidence
gathering, option generation, and adversarial evaluation phases were intentionally skipped
because the implementation approach is clear. Example:

```markdown
# Intent Brief: <feature>
## Mode
Light mode -- evidence/decision phases skipped. Approach is clear because: <reason>.
## Ranked Outcomes
...
```

The `## Mode` section is required in light mode so that downstream steps (and future
readers) understand why artifacts like `constraints.md` and `adr.md` do not exist.

---

## Spec-Review Mode Steps

When `MODE=spec-review`, the following steps replace Phase 1 (Alignment), Phase 2
(Evidence), and Phase 3 (Decision). After these steps complete, the circuit rejoins
the standard flow at Step 7 (Implementation Contract) using the spec-review variant.

### SR-1: Spec Intake -- `interactive`

**Objective:** Establish what draft is in scope, who the document must serve, and
what the build-vs-debate boundary is.

If `SOURCE_SPEC` was set from `--spec <path>`, read that file. Otherwise, ask the
user to provide the draft.

Ask the user (via AskUserQuestion):

> Share the draft you want hardened (or confirm the path above). Then answer:
> 1. Who is the primary audience for this document?
> 2. What intended outcome must the hardened spec enable?
> 3. What is explicitly out of scope?
> 4. What open questions still matter?
> 5. Which decisions are required before build begins?

Write their response to `${RUN_ROOT}/artifacts/spec-brief.md`:

```markdown
# Spec Brief
## Source Document
## Intended Outcome
## Primary Audience
## Non-Goals
## Open Questions
## Decisions Required Before Build
```

**Gate:** `spec-brief.md` exists with non-empty Source Document, Intended Outcome,
and Non-Goals sections.

### SR-2: Draft Digest -- `synthesis`

**Objective:** Normalize the draft into a concise substrate so every review pass
critiques the same thing.

The orchestrator reads `SOURCE_SPEC` (or the source document referenced in
`artifacts/spec-brief.md`) and `artifacts/spec-brief.md` and writes
`${RUN_ROOT}/artifacts/draft-digest.md`:

```markdown
# Draft Digest
## Core Claims
## Proposed Mechanism
## Dependencies
## Assumptions
## Ambiguities
## Missing Artifacts
```

Do not invent new design decisions while writing the digest. Capture the current
mechanism, assumptions, and ambiguities as they exist in the draft.

**Gate:** `draft-digest.md` captures the mechanism, assumptions, and ambiguities
without inventing new design decisions.

### SR-3: Parallel Reviews -- `dispatch`

**Objective:** Run three independent review lenses on the draft in parallel:
implementer (buildability), systems (architecture/operations), and comparative
(prior art).

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/sr-3a/reports" "${RUN_ROOT}/phases/sr-3a/last-messages"
mkdir -p "${RUN_ROOT}/phases/sr-3b/reports" "${RUN_ROOT}/phases/sr-3b/last-messages"
mkdir -p "${RUN_ROOT}/phases/sr-3c/reports" "${RUN_ROOT}/phases/sr-3c/last-messages"
```

**Worker A -- Implementer Review** (`${RUN_ROOT}/phases/sr-3a/prompt-header.md`):
- Mission: Evaluate the draft for buildability, missing seams, testability, and
  sequencing hazards from an implementer point of view
- Inputs: Full `draft-digest.md`
- Output path: `${RUN_ROOT}/phases/sr-3a/implementer-review.md`
- Output schema:
  ```markdown
  # Implementer Review
  ## Buildability Risks
  ## Missing Interfaces or Contracts
  ## Testability Concerns
  ## Sequencing Hazards
  ## Required Clarifications
  ```
- Success criteria: Names concrete build seams or explicitly says why the draft
  already looks buildable

**Worker B -- Systems Review** (`${RUN_ROOT}/phases/sr-3b/prompt-header.md`):
- Mission: Pressure the draft for architectural boundary issues, runtime risks,
  failure handling gaps, concurrency concerns, and operational blind spots
- Inputs: Full `draft-digest.md`
- Output path: `${RUN_ROOT}/phases/sr-3b/systems-review.md`
- Output schema:
  ```markdown
  # Systems Review
  ## Boundary Risks
  ## Operational Concerns
  ## Failure Modes
  ## State and Concurrency Concerns
  ## Migration or Observability Gaps
  ```
- Success criteria: Covers both architecture and runtime or operational concerns

**Worker C -- Comparative Review** (`${RUN_ROOT}/phases/sr-3c/prompt-header.md`):
- Mission: Compare the draft to serious adjacent patterns or prior art and turn
  those comparisons into adopt-or-avoid guidance
- Inputs: Full `draft-digest.md`
- Output path: `${RUN_ROOT}/phases/sr-3c/comparative-review.md`
- Output schema:
  ```markdown
  # Comparative Review
  ## Comparable Patterns
  ## Tradeoffs vs Draft
  ## Where the Draft is Stronger
  ## Where the Draft is Weaker
  ## Adopt or Avoid Recommendations
  ```
- Success criteria: Includes at least two meaningful comparisons or explicitly
  records that relevant prior art was not found

**Compose and dispatch all three (no --template):**
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/sr-3a/prompt-header.md \
  --skills clean-architecture,<domain-skills> \
  --root ${RUN_ROOT}/phases/sr-3a \
  --out ${RUN_ROOT}/phases/sr-3a/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/sr-3b/prompt-header.md \
  --skills architecture-exploration,clean-architecture,<domain-skills> \
  --root ${RUN_ROOT}/phases/sr-3b \
  --out ${RUN_ROOT}/phases/sr-3b/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/sr-3c/prompt-header.md \
  --skills deep-research,architecture-exploration \
  --root ${RUN_ROOT}/phases/sr-3c \
  --out ${RUN_ROOT}/phases/sr-3c/prompt.md
```

Dispatch all three workers (parallel when backend supports it):
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/sr-3a/prompt.md \
  --output ${RUN_ROOT}/phases/sr-3a/last-messages/last-message.txt

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/sr-3b/prompt.md \
  --output ${RUN_ROOT}/phases/sr-3b/last-messages/last-message.txt

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/sr-3c/prompt.md \
  --output ${RUN_ROOT}/phases/sr-3c/last-messages/last-message.txt
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/sr-3a/implementer-review.md
test -f ${RUN_ROOT}/phases/sr-3b/systems-review.md
test -f ${RUN_ROOT}/phases/sr-3c/comparative-review.md
cp ${RUN_ROOT}/phases/sr-3a/implementer-review.md ${RUN_ROOT}/artifacts/implementer-review.md
cp ${RUN_ROOT}/phases/sr-3b/systems-review.md ${RUN_ROOT}/artifacts/systems-review.md
cp ${RUN_ROOT}/phases/sr-3c/comparative-review.md ${RUN_ROOT}/artifacts/comparative-review.md
```

If a worker only wrote `reports/report.md`, synthesize the review artifact manually
using the required schema.

**Gate:** All three review artifacts exist. Implementer review names build seams,
systems review covers architecture and runtime concerns, comparative review includes
at least two meaningful comparisons.

### SR-4: Caveat Resolution -- `interactive`

**Objective:** Turn three critique streams into explicit decisions about what to
amend now, what to defer, and what to reject.

Present the three review artifacts to the user. Ask (via AskUserQuestion):

> Here are the implementer, systems, and comparative review caveats.
>
> 1. Which caveats should become amendments now?
> 2. Which caveats are you explicitly rejecting?
> 3. Which risks are real but deferred instead of fixed in this pass?
> 4. What scope cuts, if any, should we make before rewriting the draft?

Write their response to `${RUN_ROOT}/artifacts/caveat-resolution.md`:

```markdown
# Caveat Resolution
## Accepted Caveats
## Rejected Caveats
## Deferred Risks
## Priority Amendments
## Scope Cuts
```

**Gate:** Accepted Caveats exist or an explicit no-change rationale is recorded,
and Deferred Risks are named.

### SR-5: Amended Draft -- `synthesis`

**Objective:** Publish one canonical revised spec that incorporates accepted
caveats and makes remaining risk explicit.

The orchestrator reads `SOURCE_SPEC` (or the source document referenced in
`spec-brief.md`), `artifacts/draft-digest.md`, and `artifacts/caveat-resolution.md`
and writes `${RUN_ROOT}/artifacts/amended-spec.md`:

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

Every accepted caveat must be reflected in the amended draft, and every deferred
risk must remain visible.

**Gate:** Every accepted caveat is reflected in the amended draft, and every
deferred risk remains visible.

After SR-5, the circuit continues at Step 7 (Implementation Contract) using the
spec-review variant described below.

---

## Phase 2: Evidence

### Step 2: Parallel Evidence Probes -- `dispatch`

> **Protocol reference:** See `protocols/parallel-evidence-probes.md` for the canonical version of this pattern.

**Objective:** Gather external patterns and internal system surface in parallel.

Dispatch two workers. Each header is self-contained (no `--template`).

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-2a/reports" "${RUN_ROOT}/phases/step-2a/last-messages"
mkdir -p "${RUN_ROOT}/phases/step-2b/reports" "${RUN_ROOT}/phases/step-2b/last-messages"
```

**Worker A header** (`${RUN_ROOT}/phases/step-2a/prompt-header.md`):
Include the canonical header schema with:
- Mission: Research external patterns, prior art, and recording/playback approaches in similar systems
- Inputs: Full text of `intent-brief.md`
- Output path: `${RUN_ROOT}/phases/step-2a/external-digest.md`
- Output schema: the evidence digest schema (below)
- Success criteria: Digest covers facts, inferences, unknowns with source confidence
- Report: `reports/report.md`

**Worker B header** (`${RUN_ROOT}/phases/step-2b/prompt-header.md`):
Include the canonical header schema with:
- Mission: Trace the internal system surface relevant to this feature
- Inputs: Full text of `intent-brief.md`
- Output path: `${RUN_ROOT}/phases/step-2b/internal-digest.md`
- Output schema: the evidence digest schema (below)
- Success criteria: Digest covers all relevant internal seams with certainty labels
- Report: `reports/report.md`

**Evidence digest schema (required for both workers):**
```markdown
# Evidence Digest: <topic>
## Facts (confirmed, high confidence)
## Inferences (derived, medium confidence)
## Unknowns (gaps that matter for decisions)
## Implications for This Feature
## Source Confidence
```

**Compose and dispatch (no --template):**
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/step-2a/prompt-header.md \
  --skills deep-research \
  --root ${RUN_ROOT}/phases/step-2a \
  --out ${RUN_ROOT}/phases/step-2a/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/step-2a/prompt.md \
  --output ${RUN_ROOT}/phases/step-2a/last-messages/last-message.txt
```

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/step-2b/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-2b \
  --out ${RUN_ROOT}/phases/step-2b/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/step-2b/prompt.md \
  --output ${RUN_ROOT}/phases/step-2b/last-messages/last-message.txt
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-2a/external-digest.md
test -f ${RUN_ROOT}/phases/step-2b/internal-digest.md
```

If the worker wrote the primary artifact at the specified path, copy it directly:
```bash
cp ${RUN_ROOT}/phases/step-2a/external-digest.md ${RUN_ROOT}/artifacts/external-digest.md
cp ${RUN_ROOT}/phases/step-2b/internal-digest.md ${RUN_ROOT}/artifacts/internal-digest.md
```

If the worker only wrote `reports/report.md`, the orchestrator reads it and
synthesizes the digest artifact manually using the evidence digest schema.

**Gate:** Both digest artifacts exist. Each digest contains non-empty Facts,
Unknowns, and Implications for This Feature sections. Source Confidence labels
are present.

### Step 3: Constraints Synthesis -- `synthesis`

**Objective:** Merge parallel research into decision-grade substrate.

The orchestrator reads `artifacts/external-digest.md` and `artifacts/internal-digest.md`
and writes `${RUN_ROOT}/artifacts/constraints.md`:

```markdown
# Constraints: <feature>
## Hard Invariants (must not violate)
## Seams and Integration Points
## Contradictions Between Sources
## Open Questions (ranked by decision impact)
## Performance and Operational Constraints
```

Label every item by certainty: `[fact]`, `[inference]`, or `[assumption]`.

**Gate:** `constraints.md` has at least one hard invariant, at least one seam, and
ranked open questions. Every item has a certainty label.

---

## Phase 3: Decision

### Step 4: Generate Distinct Candidates -- `dispatch`

**Objective:** Produce 3-5 approaches that differ on real dimensions.

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-4/reports" "${RUN_ROOT}/phases/step-4/last-messages"
```

**Header** (`${RUN_ROOT}/phases/step-4/prompt-header.md`):
- Mission: Generate 3-5 genuinely distinct implementation approaches
- Inputs: Digested `intent-brief.md` (ranked outcomes + non-goals) and full `constraints.md`
- Output path: `${RUN_ROOT}/phases/step-4/options.md`
- Output schema:
  ```markdown
  # Implementation Options: <feature>
  ## Option 1: <name>
  - Architecture shape
  - Key seam
  - Failure surface
  - Prerequisite changes
  - Rollback cost
  - Explicit disqualifiers (if any)
  ## Option 2: <name>
  ...
  ```
- Success criteria: Each option differs on at least 2 of: architecture shape, ownership
  boundary, failure surface, data model. At least 3 options.
- Report: `reports/report.md`

**Compose and dispatch (no --template):**
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/step-4/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-4 \
  --out ${RUN_ROOT}/phases/step-4/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/step-4/prompt.md \
  --output ${RUN_ROOT}/phases/step-4/last-messages/last-message.txt
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-4/options.md
cp ${RUN_ROOT}/phases/step-4/options.md ${RUN_ROOT}/artifacts/options.md
```

If the worker only wrote `reports/report.md`, synthesize `options.md` from the report.

### Step 5: Adversarial Evaluation + Decision Packet -- `dispatch`

**Objective:** Red-team each option AND synthesize into a decision packet.

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-5/reports" "${RUN_ROOT}/phases/step-5/last-messages"
```

**Header** (`${RUN_ROOT}/phases/step-5/prompt-header.md`):
- Mission: Attack each option's weakest seam, then synthesize a decision packet with matrix
- Inputs: Full `constraints.md` and full `options.md`
- Output path: `${RUN_ROOT}/phases/step-5/decision-packet.md`
- Output schema:
  ```markdown
  # Decision Packet: <feature>
  ## Per-Option Risk Assessment
  ## Decision Matrix
  ## Recommendation and Rationale
  ## Unresolved Risks
  ## Reopen Conditions
  ```
- Success criteria: At least one option materially weakened by critique. Matrix includes
  risk dimensions, not just feature comparison.
- Report: `reports/report.md`

**Compose and dispatch (no --template):**
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/step-5/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-5 \
  --out ${RUN_ROOT}/phases/step-5/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/step-5/prompt.md \
  --output ${RUN_ROOT}/phases/step-5/last-messages/last-message.txt
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-5/decision-packet.md
cp ${RUN_ROOT}/phases/step-5/decision-packet.md ${RUN_ROOT}/artifacts/decision-packet.md
```

### Step 6: Tradeoff Decision -- `interactive`

**Objective:** User chooses based on tradeoffs, not generic approval.

Present `decision-packet.md` to the user. Ask (via AskUserQuestion):

> Here's the decision packet with [N] options evaluated. The recommendation is [X].
>
> 1. Which tradeoff are you choosing on purpose: correctness margin, UX smoothness,
>    implementation speed, extensibility, or operational simplicity?
> 2. What risks from the packet are you accepting?
> 3. Any scope cuts you want to make now?

Write their response to `${RUN_ROOT}/artifacts/adr.md`:

```markdown
# ADR: <feature> -- <chosen approach>
## Decision
## Rationale (user's tradeoff reasoning)
## Accepted Risks
## Rejected Alternatives (and why)
## Scope Cuts
## Non-Goals (carried from intent brief)
## Reopen Conditions
```

**Gate:** `adr.md` exists with non-empty Decision, Accepted Risks, and at least one
Rejected Alternative that maps back to `options.md`.

---

## Phase 4: Preflight

### Step 7: Implementation Contract -- `synthesis`

**Objective:** Convert the ADR into an executable build packet.

The orchestrator reads `adr.md`, `constraints.md`, AND `intent-brief.md` and writes
`${RUN_ROOT}/artifacts/execution-packet.md`:

```markdown
# Execution Packet: <feature>
## Invariants (from constraints + ADR)
## Interface Boundaries (what changes, what must not)
## Slice Order (implementation sequence)
## Test Obligations (what must be tested and how)
## Artifact Expectations (what the implementer must produce)
## Rollback Triggers (when to stop and escalate)
## Non-Goals (from intent brief and ADR)
## Verification Commands
```

**Gate:** `execution-packet.md` has non-empty Invariants, Slice Order, and Test Obligations.

#### Spec-Review Mode Variant (Step 7)

When `MODE=spec-review`, this step consumes `amended-spec.md`, `caveat-resolution.md`,
and `spec-brief.md` instead of `adr.md`, `constraints.md`, and `intent-brief.md`.

The orchestrator derives the execution packet sections as follows:

- **Invariants:** Extract from the amended spec's Invariants section plus any hard
  constraints surfaced in the systems review and caveat resolution.
- **Interface Boundaries:** Derive from the amended spec's Interfaces and Boundaries.
- **Slice Order:** Derive from the amended spec's Proposed Design, ordered by dependency.
- **Test Obligations:** Derive from the amended spec's Invariants and the systems review
  findings -- each invariant needs at least one verification method.
- **Non-Goals:** Carried from the spec brief and amended spec.
- **Rollback Triggers, Artifact Expectations, Verification Commands:** Derived from
  the amended spec's Open Risks and Failure Handling sections.

The execution-packet schema is identical across all modes. The gate is identical:
`execution-packet.md` must have non-empty Invariants, Slice Order, and Test Obligations.

After writing the execution-packet, spec-review mode continues to Step 8 (Prove the
Hardest Seam), then Steps 9-10 (Implement, Ship Review) -- identical to full mode.

#### Light Mode Variant (Step 7)

When `MODE=light`, this step consumes **only** `intent-brief.md`. There is no `adr.md`
or `constraints.md` to reference -- those artifacts do not exist in the light chain.

The orchestrator derives the execution packet sections as follows:

- **Invariants:** Extract from the intent brief's Ranked Outcomes, Non-Goals, and Kill
  Criteria. Frame each outcome as an invariant that must hold.
- **Interface Boundaries:** Derive from Domain and File Scope.
- **Slice Order:** Derive from Domain and File Scope, ordered by dependency.
- **Test Obligations:** Derive from Ranked Outcomes -- each outcome needs at least one
  verification method.
- **Non-Goals:** Carried directly from the intent brief.
- **Rollback Triggers, Artifact Expectations, Verification Commands:** Derived from
  context as in full mode.

The execution-packet schema is identical in both modes. The gate is identical:
`execution-packet.md` must have non-empty Invariants, Slice Order, and Test Obligations.

After writing the execution-packet, light mode skips Step 8 (Prove the Hardest Seam)
and proceeds directly to Step 9 (Implement).

### Step 8: Prove the Hardest Seam -- `dispatch`

**Objective:** Write a thin slice or failing tests on the highest-risk boundary.

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-8/reports" "${RUN_ROOT}/phases/step-8/last-messages"
```

**Header** (`${RUN_ROOT}/phases/step-8/prompt-header.md`):
- Mission: Identify the single riskiest seam in the execution packet and prove it with
  code -- write failing tests, a thin spike, or a minimal integration that exercises the
  boundary. This is proof, not analysis.
- Inputs: Full `execution-packet.md`
- Output path: `${RUN_ROOT}/phases/step-8/seam-proof.md`
- Output schema:
  ```markdown
  # Seam Proof: <seam name>
  ## Seam Identified
  ## What Was Built/Tested
  ## Evidence (test results, spike output)
  ## Design Validity
  ## Verdict: DESIGN HOLDS / DESIGN INVALIDATED / NEEDS ADJUSTMENT
  ```
- Success criteria: Code was written and run. Evidence is from execution, not reasoning.
- Report: `reports/report.md`

**Compose and dispatch (no --template):**
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/step-8/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-8 \
  --out ${RUN_ROOT}/phases/step-8/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/step-8/prompt.md \
  --output ${RUN_ROOT}/phases/step-8/last-messages/last-message.txt
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-8/seam-proof.md
cp ${RUN_ROOT}/phases/step-8/seam-proof.md ${RUN_ROOT}/artifacts/seam-proof.md
```

**Gate with reopen:** Read the seam proof verdict.
- `DESIGN HOLDS` → continue to Step 9
- `NEEDS ADJUSTMENT` → update `execution-packet.md` with adjustments, continue
- `DESIGN INVALIDATED` → present to user, ask:
  "The seam proof found [X]. Narrow scope, adjust approach, or reopen decision?"
  - Reopen → return to Step 4 with updated constraints
  - Adjust → update execution packet, continue
  - Narrow → update scope in execution packet, continue

---

## Phase 5: Delivery

### Step 9: Implement -- `dispatch` (via workers)

> **Protocol reference:** See `protocols/workers-execute.md` for the canonical version of this pattern.

**Objective:** Build against the execution packet with traceability.

This step delegates to the workers skill for the full implement → review → converge
cycle. The orchestrator must create the workers workspace explicitly.

**Adapter contract:**

```bash
IMPL_ROOT="${RUN_ROOT}/phases/step-9"
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/reports" \
  "${IMPL_ROOT}/last-messages" "${IMPL_ROOT}/review-findings"
```

1. **Create CHARTER.md** from the execution packet:
   ```bash
   cp ${RUN_ROOT}/artifacts/execution-packet.md ${IMPL_ROOT}/CHARTER.md
   ```

2. **Write the workers prompt header** at `${IMPL_ROOT}/prompt-header.md`:
   Use the canonical header schema with:
   - Mission: Implement the feature described in CHARTER.md using the workers
     implement → review → converge cycle
   - Inputs: Full text of `execution-packet.md` (already copied as CHARTER.md)
   - Output path: `${IMPL_ROOT}/reports/report-converge.md`
   - Output schema: workers convergence report format
   - Success criteria: All slices converged with `COMPLETE AND HARDENED` verdict
   - Report: Standard relay report headings (### Files Changed, ### Tests Run,
     ### Completion Claim) to prevent relay-protocol.md contamination
   - Also reference: domain skills and verification commands from the execution packet

3. **Compose and dispatch:**
   ```bash
   "$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
     --header ${IMPL_ROOT}/prompt-header.md \
     --skills workers,<domain-skills> \
     --root ${IMPL_ROOT} \
     --out ${IMPL_ROOT}/prompt.md

   "$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
     --prompt ${IMPL_ROOT}/prompt.md \
     --output ${IMPL_ROOT}/last-messages/last-message-workers.txt
   ```

4. **After workers completes**, the orchestrator synthesizes `implementation-handoff.md`:

   **Source artifacts (read in this order):**
   - `${IMPL_ROOT}/reports/report-converge.md` -- the convergence verdict (primary source)
   - `${IMPL_ROOT}/batch.json` -- slice metadata showing what was built
   - The last implementation slice report at `${IMPL_ROOT}/reports/report-<last-slice-id>.md`
     (find the slice id from `batch.json`)

   Note: workers review workers may overwrite per-slice report files. If a slice
   report is missing or appears to be a review artifact, use `batch.json` slice metadata
   and the convergence report to reconstruct what was built.

   **Write** `${RUN_ROOT}/artifacts/implementation-handoff.md` with:
   ```markdown
   # Implementation Handoff: <feature>
   ## What Was Built (from batch slices and convergence)
   ## Tests Run and Verification Results
   ## Convergence Verdict
   ## Open Issues (from convergence findings, if any)
   ```

   **Gate:** `implementation-handoff.md` exists AND convergence verdict is
   `COMPLETE AND HARDENED`. If convergence says `ISSUES REMAIN`, the workers
   loop should have addressed them -- escalate to user if it didn't.

**Verify:**
```bash
test -f ${IMPL_ROOT}/reports/report-converge.md
test -f ${RUN_ROOT}/artifacts/implementation-handoff.md
```

### Step 10: Final Ship Review -- `dispatch`

> **Protocol reference:** See `protocols/final-review.md` for the canonical version of this pattern.

**Objective:** Independent assessment of the shipped work against the execution packet.

This step is assessment only -- the worker does NOT modify source code. If issues are
found, the orchestrator handles remediation separately before re-running this step.

**Setup:**
```bash
mkdir -p "${RUN_ROOT}/phases/step-10/reports" "${RUN_ROOT}/phases/step-10/last-messages"
```

**Header** (`${RUN_ROOT}/phases/step-10/prompt-header.md`):
- Mission: Audit the implementation against the execution packet and original intent.
  Check for contract drift, correctness bugs, naming issues, dead code, missing tests,
  and residue. Do NOT modify source code -- diagnose only.
- Inputs: Full `execution-packet.md`, full `implementation-handoff.md`,
  digested `intent-brief.md` (ranked outcomes + non-goals), current repo state
- Output path: `${RUN_ROOT}/phases/step-10/ship-review.md`
- Output schema:
  ```markdown
  # Ship Review: <feature>
  ## Contract Compliance (execution packet vs actual)
  ## Findings
  ### Critical (must fix before ship)
  ### High (should fix)
  ### Low (acceptable debt)
  ## Intentional Debt (deferred with rationale)
  ## Fit-to-Intent Assessment (compare to intent-brief.md)
  ## Verdict: SHIP-READY / ISSUES FOUND
  ```
- Success criteria: Every finding references a contract section or intent-brief item.
  Findings are categorized by severity, not listed as a flat list.
- Report: `reports/report.md`

**Compose and dispatch (no --template):**
```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header ${RUN_ROOT}/phases/step-10/prompt-header.md \
  --skills <domain-skills> \
  --root ${RUN_ROOT}/phases/step-10 \
  --out ${RUN_ROOT}/phases/step-10/prompt.md

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt ${RUN_ROOT}/phases/step-10/prompt.md \
  --output ${RUN_ROOT}/phases/step-10/last-messages/last-message.txt
```

**Verify and promote:**
```bash
test -f ${RUN_ROOT}/phases/step-10/ship-review.md
cp ${RUN_ROOT}/phases/step-10/ship-review.md ${RUN_ROOT}/artifacts/ship-review.md
```

**If verdict is `ISSUES FOUND` with critical findings:**
1. The orchestrator addresses critical findings (directly or via a targeted worker dispatch)
2. Re-runs Step 10 (max 2 total attempts)
3. If still `ISSUES FOUND` after 2 attempts → escalate to user

**If verdict is `SHIP-READY`:** Circuit complete.

---

## Artifact Chain Summary

```
intent-brief.md                              [user: intent lock]
  → external-digest.md ∥ internal-digest.md
  → constraints.md
  → options.md
  → decision-packet.md
  → adr.md                                   [user: tradeoff choice]
  → execution-packet.md
  → seam-proof.md                            [user: reopen if invalidated]
  → implementation-handoff.md
  → ship-review.md
```

### Spec-Review Mode Artifact Chain

```
spec-brief.md                                          [user: spec intake]
  → draft-digest.md                                    [orchestrator: synthesis]
  → implementer-review.md ∥ systems-review.md ∥ comparative-review.md
  → caveat-resolution.md                               [user: caveat disposition]
  → amended-spec.md                                    [orchestrator: synthesis]
  → execution-packet.md                                [orchestrator: synthesis from amended spec]
  → seam-proof.md                                      [user: reopen if invalidated]
  → implementation-handoff.md                          [workers: identical to full mode]
  → ship-review.md                                     [worker: identical to full mode]
```

### Light Mode Artifact Chain

```
intent-brief.md (with ## Mode section)   [user: intent lock]
  → execution-packet.md                  [orchestrator: synthesis from intent-brief only]
  → implementation-handoff.md            [workers: identical to full mode]
  → ship-review.md                       [worker: identical to full mode]
```

## Resume Awareness

If `${RUN_ROOT}/artifacts/` already has files, determine the resume point:

1. Check artifacts in chain order (intent-brief → external-digest → ... → ship-review)
2. Find the last complete artifact with passing gate
3. For Step 9 specifically: check `${RUN_ROOT}/phases/step-9/batch.json` for workers
   resume state before restarting implementation
4. Continue from the next step

This is best-effort -- the circuit has no durable state beyond artifacts on disk and
step-local relay directories. If a session dies mid-step, check the step's relay
directory for worker output before concluding the step failed.

## Light Mode Resume Awareness

When `MODE=light`, resume uses the abbreviated artifact chain:

1. Check artifacts in light-mode chain order:
   `intent-brief.md` → `execution-packet.md` → `implementation-handoff.md` → `ship-review.md`
2. **Ignore** artifacts from skipped steps if present (`external-digest.md`,
   `internal-digest.md`, `constraints.md`, `options.md`, `decision-packet.md`, `adr.md`,
   `seam-proof.md`). These may exist if the run started in full mode and switched to light.
3. Find the last complete light-mode artifact with a passing gate.
4. For Step 9 specifically: check `${RUN_ROOT}/phases/step-9/batch.json` for workers
   resume state (identical to full mode).
5. Continue from the next light-mode step.

**Full-to-light switch:** If the intent-brief exists but lacks a `## Mode` section (because
it was written in full mode), add the `## Mode` section before proceeding. Note in it:
"Switched from full to light mode mid-run. Evidence/decision artifacts exist but are not
consumed by the remaining light-mode steps."

**Light-to-full switch:** Not supported. If a light-mode run needs the full workflow,
start a new run.

## Spec-Review Mode Resume Awareness

When `MODE=spec-review`, resume uses the spec-review artifact chain:

1. Check artifacts in spec-review chain order:
   `spec-brief.md` → `draft-digest.md` → `implementer-review.md`, `systems-review.md`,
   `comparative-review.md` → `caveat-resolution.md` → `amended-spec.md` →
   `execution-packet.md` → `seam-proof.md` → `implementation-handoff.md` → `ship-review.md`
2. Treat the parallel review step as complete only when all three review artifacts exist
   and satisfy their gates.
3. **Ignore** artifacts from skipped steps if present (`intent-brief.md`,
   `external-digest.md`, `internal-digest.md`, `constraints.md`, `options.md`,
   `decision-packet.md`, `adr.md`).
4. Find the last complete spec-review artifact with a passing gate.
5. For the Implement step: check `${RUN_ROOT}/phases/step-9/batch.json` for workers
   resume state (identical to full mode).
6. Continue from the next spec-review step.

## Circuit Breaker

Escalate to the user when:
- A dispatch step fails twice (no valid output after 2 attempts)
- The seam proof returns `DESIGN INVALIDATED` (Step 8 gate)
- Any workers slice hits `impl_attempts > 3` or
  `impl_attempts + review_rejections > 5` (Step 9)
- Convergence fails after max attempts (Step 9)
- Ship review says `ISSUES FOUND` after 2 attempts (Step 10)

Include in the escalation: counter values, failure output, the failure pattern,
and options (adjust scope, skip the problematic slice, switch circuits, or abort).

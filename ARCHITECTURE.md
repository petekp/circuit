# Circuit Architecture

This document explains the design of the circuit system: why it exists, how its
pieces fit together, and what you need to understand to extend it. It is written
for an experienced engineer who wants to build new circuits or modify existing
ones, not someone looking for a quick-start guide.

The system solves a specific problem: **how do you make an AI agent
reliably complete multi-phase engineering work across session boundaries, with
durable state, bounded autonomy, and honest quality gates?**

Chat threads die. Context windows overflow. Workers hallucinate completion.
Circuits are the structural answer to all three failure modes.

---

## Table of Contents

1. [What Is a Circuit?](#what-is-a-circuit)
2. [The Artifact Chain Model](#the-artifact-chain-model)
3. [Execution Model](#execution-model)
4. [The Gate System](#the-gate-system)
5. [Relay Infrastructure](#relay-infrastructure)
6. [Circuit Composition](#circuit-composition)
7. [Extending the System](#extending-the-system)

---

## What Is a Circuit?

A circuit is a multi-phase workflow encoded as two files:

| File | Role | Analogy |
|------|------|---------|
| `circuit.yaml` | Topology declaration | Type signature |
| `SKILL.md` | Runtime truth | Implementation |

Both files live in the same directory under `skills/<name>/`. The
`circuit.yaml` declares the shape: phases, steps, actions, artifacts, gates, and
parallel fanout. The `SKILL.md` contains everything the orchestrator actually
needs to execute: commands, paths, output schemas, prompt headers, resume rules,
adapter seams, and reopen choreography.

### Why Two Files?

The split is deliberate and serves different consumers:

**`circuit.yaml`** is machine-readable topology. It answers structural questions:
How many phases? What does each step produce? What does it consume? Is this step
parallel? What gate type guards it? The router, the dry-run validator, and the
`circuit:create` compiler all read `circuit.yaml` to reason about circuit shape
without parsing prose.

**`SKILL.md`** is the execution contract. It answers operational questions: What
shell commands does the orchestrator run? What sections must appear in the output
artifact? What happens when a review says REVISE? How does a fresh session pick
up where the last one died? The orchestrator follows `SKILL.md` line by line
during execution.

### What Happens When They Drift

When the two files disagree, the circuit is mechanically broken. This is not a
documentation nit -- it is the workflow equivalent of a type signature diverging
from its implementation.

Consider a concrete case: `circuit.yaml` says Step 5 produces `stability-gate.md`
with a `verdict-consistency` gate, but `SKILL.md` describes a simpler
`outputs_present` gate for the same step. A dry-run validator would trace
`circuit.yaml` and expect verdict routing (`stable -> continue`, `repair_again ->
reopen`), but the actual runtime behavior in `SKILL.md` would skip the reopen
logic entirely. The circuit would silently continue past failures that should
trigger upstream repair.

The `circuit:dry-run` validator and the `circuit:create` compiler both treat
prose/YAML drift as a first-class defect (anti-pattern `AP-15`). Cross-validation
is not optional -- it is a required step in both authoring and validation.

### The `circuit:` Prefix Convention

All circuit skills use a `circuit:` prefix in their frontmatter `name` field:

```yaml
# In SKILL.md frontmatter
name: circuit:ratchet-quality
```

This prefix does three things:

1. **Discovery.** Claude Code's skill matcher uses the frontmatter `name` and
   `description` to route slash commands. The prefix groups circuits visually
   and semantically.
2. **Router integration.** The `circuit:router` skill knows to look for
   `circuit:*` skills when routing requests.
3. **Namespace separation.** Domain skills (`rust`, `swift-apps`, `tdd`) live
   in a different namespace from circuit skills. A circuit can compose domain
   skills without naming collisions.

The directory name matches the slug: `circuit:ratchet-quality` lives at
`skills/ratchet-quality/`. The slug `ratchet-quality` is the
canonical identifier used in `circuit.yaml`'s `id` field.

---

## The Artifact Chain Model

The central design insight of the circuit system is: **artifacts are the durable
state, not the chat thread.**

### Every Step Produces a Named File

Each step in a circuit exits by writing a specific file to a known path. The
`develop` circuit makes this concrete:

```text
intent-brief.md           [Step 1, interactive]
  -> external-digest.md   [Step 2a, dispatch worker]
  -> internal-digest.md   [Step 2b, dispatch worker]
  -> constraints.md       [Step 3, synthesis]
  -> options.md           [Step 4, dispatch]
  -> decision-packet.md   [Step 5, dispatch]
  -> adr.md               [Step 6, interactive]
  -> execution-packet.md  [Step 7, synthesis]
  -> seam-proof.md        [Step 8, dispatch]
  -> implementation-handoff.md [Step 9, dispatch via manage-codex]
  -> ship-review.md       [Step 10, dispatch]
```

This is not a suggestion -- it is a contract. Step 7 cannot begin until Step 6
has written `adr.md`. Step 9 reads `execution-packet.md` and nothing else from
the decision phase. The artifact chain is the workflow's dependency graph made
explicit.

### Why Artifacts Instead of Chat

Three failure modes drive this design:

**Session death.** A Claude session can be interrupted, time out, or hit context
limits at any point. If progress lives only in the chat thread, a dead session
means starting over. With artifacts on disk, a new session scans the artifact
directory and resumes from the first missing file.

**Context overflow.** A 17-step circuit like `ratchet-quality` generates far
more content than fits in a single context window. The artifact chain means each
step only needs to read its declared inputs, not the entire history. Step 14
(Execution Audit) reads `execution-log.md`, `execution-charter.md`,
`mission-brief.md`, and `quality-calibration.md` -- not the 600 lines of
handoffs from Steps 3 through 13.

**Truthfulness.** Workers sometimes claim completion without actually finishing.
Artifacts give the orchestrator (and the next session) something concrete to
verify. The gate system checks artifact contents, not worker claims.

### Resume Awareness

Every circuit includes a `Resume Awareness` section that defines how a fresh
session picks up where the last one left off. The algorithm is simple:

1. Check for a reopen marker (a file that says "start here, not where you'd
   normally expect").
2. Scan artifacts in canonical chain order.
3. Resume from the first missing or gate-failing artifact.
4. For `manage-codex` steps, inspect child state (`batch.json`) before
   deciding to rerun.

Here is the resume logic from `ratchet-quality` for the Stabilize phase:

> Inspect `${RUN_ROOT}/phases/step-3/attempts/` before rerunning Step 3.
> If `stability-findings.md` exists but `stability-gate.md` does not,
> resume at Step 5 and reconcile any existing injections first.

The key insight is **relay state takes precedence over artifact presence**. A
step might have produced its artifact but left child workers in an inconsistent
state. Resume must check the step-local state (like `batch.json` or injection
ledgers) before blindly re-executing.

### Artifact vs. Handoff

The system distinguishes between two kinds of output:

- **Artifacts** (`${RUN_ROOT}/artifacts/*.md`) are canonical circuit outputs.
  They are the durable chain. Each one has a defined schema and a gate.
- **Handoffs** (`${RUN_ROOT}/phases/step-N/handoffs/*.md`) are raw worker
  outputs. They follow the relay protocol format but are not the canonical
  chain.

A common anti-pattern (`AP-02: Copy-The-Handoff`) is promoting a raw handoff
directly into an artifact without synthesis. The correct pattern is for the
orchestrator to read the handoff, extract the relevant information, and write
the canonical artifact with the expected schema.

### Artifact Location

All artifacts live under a single run root:

```bash
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts"
```

The `RUN_SLUG` incorporates both the topic and the circuit name. For example,
a ratchet-quality run on a feature called "auth-refactor" would use:

```bash
RUN_ROOT=".circuitry/circuit-runs/auth-refactor-ratchet-quality"
```

Step-specific relay state (handoffs, last messages, prompt headers) lives under
`${RUN_ROOT}/phases/step-N/`. This separation keeps the canonical artifact
chain clean while preserving the full execution trace for debugging.

---

## Execution Model

Circuits use three action types, each with different execution semantics:

### The Three Action Types

#### 1. Interactive (`action: interactive`)

The orchestrator (Claude session) works directly with the user. Interactive steps
are conversations that produce an artifact. They exist at decision points where
human judgment is required -- choosing tradeoffs, confirming scope, setting
quality bars.

From `develop`, Step 1 (Intent Lock):

> Ask the user to describe the feature and rank their desired outcomes. Probe
> for non-goals and constraints. Write `intent-brief.md`.

Interactive steps are the only steps that can ask questions and wait for
answers. They are never dispatched to workers.

#### 2. Dispatch (`action: dispatch`)

The orchestrator writes a prompt header, assembles the full prompt using
`compose-prompt.sh`, and dispatches the work to a worker via `dispatch.sh`.
The backend is auto-detected: Codex CLI when installed, Claude Code's Agent
tool (with worktree isolation) otherwise. The orchestrator does not do the
work itself -- it composes the instructions and reads the result.

The dispatch pipeline:

```bash
# 1. Orchestrator writes the task-specific header
#    (mission, inputs, output path, schema, success criteria)

# 2. Assemble the full prompt
./scripts/relay/compose-prompt.sh \
  --header "${STEP_ROOT}/prompt-header.md" \
  --skills "rust,tdd" \
  --template implement \
  --root "${STEP_ROOT}" \
  --out "${STEP_ROOT}/prompt.md"

# 3. Dispatch to worker (auto-detects Codex or Agent backend)
./scripts/relay/dispatch.sh \
  --prompt "${STEP_ROOT}/prompt.md" \
  --output "${STEP_ROOT}/last-messages/last-message.txt"

# 4. Orchestrator reads the handoff and verifies
test -f "${STEP_ROOT}/handoffs/handoff.md"
```

Dispatch steps come in several flavors:

- **Simple dispatch**: One worker, one output. Most common.
- **Parallel dispatch**: Multiple workers run simultaneously, each producing
  its own artifact. Used for independent probes (like the triage probes in
  `ratchet-quality` Step 2, which fan out to baseline, quality, and backlog
  workers).
- **Dispatch via `manage-codex`**: The `manage-codex` adapter handles a full
  implement-review-converge loop. This is for steps that involve real code
  changes with quality gates. More on this below.

#### 3. Synthesis (`action: synthesis`)

The orchestrator reads upstream artifacts and writes a new artifact directly,
without dispatching a worker. Synthesis is for steps where the value is in
combining and distilling information, not in generating new research or code.

From `ratchet-quality`, Step 7 (Proposal Synthesis):

> Collapse the exploration fanout into a bounded improvement proposal that is
> specific enough to review but not yet authoritative.

Synthesis steps read `inside-out-digest.md` and `outside-in-digest.md` (from
two parallel dispatch workers) and write `improvement-proposal.md`. The
orchestrator has the full context from reading both digests and can make
cross-cutting decisions that a single worker could not.

### Why Implementation and Review Run in Separate Sessions

This is a core principle of `manage-codex`:

> Implementation and review always run in separate sessions.

The reason is contamination. If the same session implements code and then
reviews it, the reviewer has already seen (and mentally committed to) the
implementation choices. The review becomes a rubber stamp rather than an
adversarial check.

Separate Codex sessions mean the review worker starts fresh. It reads the diff,
re-runs verification commands independently, and judges the code without the
sunk-cost bias of having written it.

### The `manage-codex` Loop

When a dispatch step uses `adapter: manage-codex`, it delegates to a
multi-phase inner loop:

```text
plan -> implement -> review -> converge
                  \-> reject -> re-implement -> re-review
```

The orchestrator:
1. Writes a `CHARTER.md` in the child root from the parent execution contract.
2. Creates `batch.json` with one record per work slice.
3. For each slice: dispatches an implementation worker, then a review worker.
4. If review says `ISSUES FOUND`: re-dispatches implementation, then re-review.
5. When all slices are done: dispatches a convergence worker that checks the
   whole batch.
6. If convergence says `COMPLETE AND HARDENED`: done.
7. If convergence says `ISSUES REMAIN`: adds fix slices and loops.

The loop is bounded by circuit breakers: any slice that hits
`impl_attempts > 3` or `impl_attempts + review_rejections > 5` triggers user
escalation.

The orchestrator never modifies `batch.json` by hand. All state transitions go
through `update-batch.sh`:

```bash
./scripts/relay/update-batch.sh --root "${CHILD_ROOT}" \
  --slice slice-001 --event review_clean
```

This is a critical design decision. LLMs are unreliable at maintaining JSON
state. Making `batch.json` mutations go through a deterministic script eliminates
an entire class of state-corruption bugs.

### Circuits That Use `manage-codex`

Several circuits delegate their heavy-lifting steps to `manage-codex`:

- `develop` Step 9 (Implement): Turns the execution packet
  into working code.
- `repair` Step 6 (Layered Repair): Executes repair slices in
  dependency order.
- `ratchet-quality` Steps 3, 13, and 15: Baseline repair, batch execution,
  and execution ratchet respectively.

Each adapter step defines a child root layout and a CHARTER.md contract.
For example, `ratchet-quality` Step 13:

```
${RUN_ROOT}/phases/step-13/batches/<batch-id>/
  CHARTER.md
  batch.json
  handoffs/
  last-messages/
  review-findings/
  archive/
```

The parent step owns the child root. After `manage-codex` completes, the parent
reads back in a specific order:

1. `handoffs/handoff-converge.md` (the convergence verdict)
2. `batch.json` (the final state of all slices)
3. `handoffs/handoff-<last-slice-id>.md` (the last implementation handoff)

Then the parent synthesizes the canonical circuit artifact from that evidence.

---

## The Gate System

Gates are the quality enforcement mechanism. Every non-trivial step has a gate
that checks the step's output before the circuit advances.

### The Four Gate Types

#### 1. `outputs_present`

The simplest gate. Checks that the expected artifact exists and contains the
required sections.

From `ratchet-quality` Step 1 (Mission Freeze):

```yaml
gate:
  type: outputs_present
  required: [mission-brief.md]
  checks:
    - "mission-brief.md contains the exact schema headings"
    - "allowed file scopes and verification command sets are explicit"
    - "quality bar, non-goals, constraints, and success definition are falsifiable"
```

This is stronger than just checking file existence (which would be anti-pattern
`AP-10: Weak Gates`). The checks require specific content properties. But the
gate does not route outcomes -- if the checks fail, the step simply re-runs.

#### 2. `evidence-reopen`

Used when a proof step can validate, adjust, or invalidate the plan. The key
property is that the evidence might contradict what came before.

From `develop` Step 8 (Prove the Hardest Seam):

```yaml
gate:
  type: evidence-reopen
  outcomes:
    design_holds: continue
    needs_adjustment: update-execution-packet
    design_invalidated: interactive-reopen
```

Three possible outcomes:
- The seam proof confirms the design -> continue to delivery.
- The seam proof suggests adjustments -> update the execution packet and
  re-prove.
- The seam proof invalidates the design entirely -> reopen the decision with
  the user.

This gate type embodies a principle: **disconfirming evidence changes the
workflow**. Without it, the circuit would blindly continue building on a
foundation that just failed its proof step.

#### 3. `verdict-consistency`

Used when a terminal verdict must match named evidence boundaries. This is the
gate type used by ratchet steps in `ratchet-quality`.

From Step 5 (Stabilize Ratchet):

```yaml
gate:
  type: verdict-consistency
  outcomes:
    stable: continue
    repair_again: reopen-baseline-repair
    retriage: reopen-triage-probes
```

The verdict is only valid if it matches the evidence in the artifact. Saying
`stable` requires that critical/high findings are closed, injections are
resolved, and verification supports a trustworthy baseline. The gate enforces
that the verdict vocabulary is bounded (exactly one of three values) and that
each verdict maps to a specific next action.

#### 4. `verdict-reopen`

Used when a review step decides between continue and upstream revision. Similar
to `verdict-consistency` but specifically for diagnose-only review steps.

From `ratchet-quality` Step 16 (Final Review):

```yaml
gate:
  type: verdict-reopen
  outcomes:
    ship_ready: continue
    partial: continue
    reopen_execute: reopen-execution-ratchet
```

The critical property: the review worker that emits this verdict does NOT fix
code. It only diagnoses. If the verdict is `reopen_execute`, the circuit routes
back to the execution ratchet step, not to a "fix it" step inside the review.
This separation prevents anti-pattern `AP-19: Review Step Mutates Source`.

### Gate Selection Guide

| Gate type | Use when | Required contract |
|-----------|----------|-------------------|
| `outputs_present` | Quality can be checked from the file plus explicit content checks | Exact output schema, concrete gate checks |
| `evidence-reopen` | A proof step can validate, adjust, or invalidate the plan | Bounded verdicts, explicit artifact to update, user checkpoint for invalidation |
| `verdict-consistency` | A terminal verdict is valid only if it matches named evidence | Verdict meanings, exact evidence threshold, exact failing boundary requirement |
| `verdict-reopen` | A review step decides between continue and upstream revision | Diagnose-only contract, ready threshold, named reopen targets |

### How Gates Route Outcomes

Gates have three possible routing actions:

- **continue**: Advance to the next step in the circuit.
- **reopen**: Route back to a named upstream step. This triggers the reopen
  invalidation protocol: downstream artifacts are archived, a reopen marker
  is written, and the circuit resumes from the reopen target.
- **escalate**: Stop and involve the user. Used when the circuit breaker fires
  or when evidence invalidation requires human judgment.

### The Circuit Breaker Pattern

Every circuit includes a `Circuit Breaker` section that defines when to stop and
redirect. This is the last line of defense against unbounded loops.

From `ratchet-quality`:

> Stop and redirect when:
> - The same governing issue reopens the same upstream target twice.
> - A phase exhausts its injection ceiling and a critical issue still cannot close.
> - Execute exhausts retry budgets for multiple charter-critical batches.
> - Build, test, or verify commands cannot be made explicit enough for honest
>   verification.

The circuit breaker also handles circuit misrouting:

> - Greenfield feature delivery -> `circuit:develop`
> - Architecture or protocol choice -> `circuit:decide`
> - Cleanup-only scope -> `circuit:cleanup`

This creates a safety net: if the circuit discovers mid-execution that the work
does not actually fit its contract, it stops and suggests the right circuit
instead of forcing a bad fit.

---

## Relay Infrastructure

The relay layer is the system's plumbing: two shell scripts and a set of
templates that handle prompt assembly, state management, and the handoff
protocol between orchestrator and workers.

### `compose-prompt.sh`: Prompt Assembly

This script assembles a Codex worker prompt from modular pieces:

```bash
./scripts/relay/compose-prompt.sh \
  --header "${STEP_ROOT}/prompt-header.md" \
  --skills "rust,tdd" \
  --template implement \
  --root "${STEP_ROOT}" \
  --out "${STEP_ROOT}/prompt.md"
```

The assembly pipeline:

1. **Start with the header.** The orchestrator writes a task-specific header
   containing the mission, inputs, output path, output schema, and success
   criteria. This is the only part that changes per step.

2. **Append domain skills.** For each skill in the `--skills` list, the script
   finds the skill's `SKILL.md` file and appends it as a `## Domain Guidance`
   section. This gives the worker domain-specific knowledge (Rust idioms, React
   patterns, etc.) without the orchestrator having to inline it.

3. **Append the template.** Templates define the worker's operating contract:
   - `implement`: Write code, run verification, produce a handoff.
   - `review`: Inspect the diff, re-run verification, produce findings.
   - `ship-review`: Audit existing code without a preceding diff.
   - `converge`: Final quality gate across all slices.

   For review-family templates (`review`, `ship-review`, `converge`), a review
   preamble is appended first with shared review instructions.

4. **Append relay protocol (legacy fallback).** The script checks whether the
   assembled output already contains the canonical relay headings
   (`### Files Changed`, `### Tests Run`, `### Completion Claim`). If not, it
   appends `relay-protocol.md` as a safety net. This prevents a common failure
   where workers produce handoffs without the required structure.

5. **Substitute `{relay_root}` tokens.** If `--root` is provided, all literal
   `{relay_root}` tokens in the assembled output are replaced with the actual
   path. If tokens remain after substitution (or if no `--root` was provided
   when tokens exist), the script fails with an error that names which source
   file introduced the unresolved tokens. This prevents anti-pattern
   `AP-04: Placeholder Leakage`.

The skill directory resolution follows a priority chain:
1. `CIRCUIT_PLUGIN_SKILL_DIR` environment variable (for testing)
2. Sibling `skills/` directory relative to the script (the plugin layout)
3. `~/.claude/skills` (legacy layout)

### `update-batch.sh`: Deterministic State Machine

This script manages `batch.json` -- the state file that tracks every slice in a
`manage-codex` run. The key design principle: **the orchestrator never
hand-edits `batch.json`**. All mutations go through this script.

Why? LLMs are unreliable at precise JSON manipulation. They miscount array
indices, forget to update correlated fields, and sometimes generate syntactically
invalid JSON. By routing all mutations through a deterministic Python script
embedded in the shell wrapper, the system eliminates an entire class of
state-corruption bugs.

The script supports these events:

| Event | What it does |
|-------|-------------|
| `attempt_started` | Increment `impl_attempts`, set `attempt_in_progress` |
| `impl_dispatched` | Clear `attempt_in_progress`, record handoff |
| `review_clean` | Set slice status to `done` |
| `review_rejected` | Increment `review_rejections` |
| `converge_complete` | Set all converge slices to `done`, phase to `complete` |
| `converge_failed` | Increment `convergence_attempts` |
| `analytically_resolved` | Close slice without code change |
| `orchestrator_direct` | Close slice with orchestrator fix |
| `add_slice` | Append a new slice to the batch |

Every mutation is also appended to `events.ndjson` as an append-only event log.
This enables two recovery modes:

- `--validate`: Check `batch.json` for internal consistency (valid phases,
  statuses, no done slices with zero attempts, no completed batches with
  pending slices).
- `--rebuild`: Reconstruct `batch.json` from `plan.json` + `events.ndjson`.
  This is the nuclear recovery option when `batch.json` gets corrupted.

The `--root` flag threads through all paths, keeping the batch state isolated
to its relay root:

```bash
./scripts/relay/update-batch.sh --root "${CHILD_ROOT}" \
  --slice slice-001 --event review_clean --summary "CLEAN"
```

### The Handoff Contract

Every Codex worker writes a handoff file with these exact sections:

```markdown
### Files Changed
[Every file changed, created, or deleted with a one-line reason]

### Tests Run
[Exact command, pass/fail count, failures; SANDBOX_LIMITED for sandbox issues]

### Verification
[Verifier result or "not run"]

### Verdict
[Role-specific: "N/A" for implement, "CLEAN"/"ISSUES FOUND" for review,
 "COMPLETE AND HARDENED"/"ISSUES REMAIN" for converge]

### Completion Claim
[COMPLETE, PARTIAL, or BLOCKED]

### Issues Found
[Problems, concerns, or edge cases]

### Next Steps
[Required for PARTIAL or BLOCKED]
```

These headings are not cosmetic. `compose-prompt.sh` checks for their
presence. If a template already contains them, the relay protocol file is not
appended. If they are missing, the script appends the protocol as a fallback.
Workers that omit these headings produce handoffs that the orchestrator cannot
reliably parse.

### `{relay_root}` Token Substitution

Templates and skill files reference paths using `{relay_root}` tokens:

```markdown
Write `{relay_root}/handoffs/handoff-{slice_id}.md`.
```

The `compose-prompt.sh` script replaces these tokens with the actual path when
`--root` is provided. This indirection is what makes templates reusable across
different relay roots -- the same `implement-template.md` works whether the
relay root is `.circuitry`, `.circuitry/circuit-runs/foo/phases/step-3/attempts/001`, or
any other path.

If a source file introduces `{relay_root}` tokens but no `--root` flag is
provided, `compose-prompt.sh` fails with a diagnostic error that names the
source file responsible. This fail-fast behavior prevents workers from receiving
prompts with unresolved placeholders.

---

## Circuit Composition

Circuits do not exist in isolation. They compose with each other and with
non-circuit skills through well-defined interfaces.

### How Circuits Call `manage-codex` as an Adapter

The `manage-codex` skill is not a circuit -- it is an adapter. Circuits delegate
their implementation-heavy steps to `manage-codex`, which handles the
plan-implement-review-converge loop.

The composition contract:

1. **The circuit owns the child root.** The circuit creates the directory
   structure, writes `CHARTER.md`, and defines the domain skills.

2. **`manage-codex` owns the inner loop.** Once dispatched, `manage-codex`
   handles slicing, worker dispatch, review, and convergence autonomously.

3. **The circuit synthesizes the result.** After `manage-codex` completes, the
   circuit reads back the child state and writes its canonical artifact.

This is a clean adapter boundary. The circuit does not reach into `manage-codex`'s
inner loop, and `manage-codex` does not know about the circuit's artifact chain.

The adapter seam contract requires explicit documentation of:
- Child root creation and layout
- `CHARTER.md` required sections
- The `compose-prompt.sh` and `codex exec --full-auto` dispatch calls
- Required child files and their locations
- Readback order
- Synthesis rules for the parent artifact
- Escalation behavior on failure

### How the Router Selects Circuits

The `circuit:router` skill matches requests to circuits using positive signals and
exclusions:

```text
- circuit:develop
  Match: multi-file or cross-domain feature delivery, unclear approach
  Exclude: bug fixes, config changes, or already-clear tasks

- circuit:decide
  Match: architecture or protocol choices with real downside
  Exclude: code delivery, bug fixes, or settled decisions

- circuit:ratchet-quality
  Match: overnight autonomous quality improvement
  Exclude: interactive work, greenfield features, architecture decisions
```

The router also defines sequencing rules:

- Broken existing flow -> `repair` before any rebuild.
- Unsettled architecture -> `decide` before `harden`
  or `develop`.
- Draft exists but is not build-ready -> `harden` before
  `develop`.
- New circuit authoring -> `circuit:create` before `circuit:dry-run`.

If nothing fits, the router says so. It does not force a circuit onto trivial
work.

### Domain Skills as Optional Companions

Domain skills (`rust`, `swift-apps`, `tdd`, `next-best-practices`) are not
bundled into circuits. They are composed at dispatch time via `--skills`:

```bash
./scripts/relay/compose-prompt.sh \
  --header "${STEP_ROOT}/prompt-header.md" \
  --skills "rust,tdd" \
  --template implement \
  --root "${STEP_ROOT}" \
  --out "${STEP_ROOT}/prompt.md"
```

This design has several advantages:

- **Circuits stay domain-agnostic.** The same `develop`
  circuit works for Rust, Swift, or React projects.
- **Skill budgets are enforceable.** Circuits declare maximum skill counts
  (typically 2 domain skills, 3 total), preventing prompt bloat.
- **Domain knowledge stays current.** Updating a domain skill immediately
  affects all circuits that compose it, without editing any circuit files.

Each circuit includes a `Domain Skill Selection` section that defines the rules
for choosing skills at dispatch time. `ratchet-quality` uses a surface-based
mapping:

| Surface | Preferred skills |
|---------|------------------|
| Rust, systems, persistence | `rust` |
| Swift, SwiftUI, Apple platforms | `swift-apps`, `swiftui` |
| React, Next, web UI | `next-best-practices`, `vercel-react-best-practices` |
| Testing, regressions | `tdd` |

---

## Extending the System

### Creating New Circuits via `circuit:create`

The `circuit:create` skill is a compiler that turns a natural-language workflow
description into a circuit skill pair. Its artifact chain:

```text
workflow-brief.md          [Step 1, interactive intake]
  -> circuit-analysis.md   [Step 2, Codex dispatch]
  -> draft-circuit.yaml    [Step 3, Codex dispatch, staging]
  -> draft-SKILL.md        [Step 3, Codex dispatch, staging]
  -> cross-validation.md   [Step 3, Codex dispatch]
  -> validation-report.md  [Step 4, Codex dispatch]
  -> circuit.yaml + SKILL.md [Step 5, Claude refinement, installed]
```

The five phases:

1. **Intake.** Interactive conversation to understand the workflow, its phases,
   judgment checkpoints, artifact chain, and external dependencies.

2. **Analysis.** A Codex worker maps the workflow to existing circuit patterns
   and determines whether it is an artifact-centric circuit or a validator.

3. **Authoring.** A Codex worker generates `circuit.yaml` and `SKILL.md` from
   the analysis, then cross-validates them field by field.

4. **Validation.** A separate Codex worker walks six quality categories against
   the drafts without modifying them. This is diagnose-only.

5. **Refinement.** The orchestrator reads all upstream artifacts, addresses
   validation findings, optimizes trigger metadata for Claude Code, and
   installs the final files.

The compiler distinguishes between two circuit families:

- **Artifact-centric circuits** (the majority): Multi-phase workflows that chain
  artifacts. Examples: `develop`, `ratchet-quality`,
  `repair`.
- **Validator circuits**: Circuits whose primary job is symbolic execution or
  mechanical validation. Example: `circuit:dry-run`.

Each family has a different `SKILL.md` starter template. The artifact-centric
starter includes sections for Setup, Domain Skill Selection, Canonical Header
Schema, phases, Artifact Chain Summary, Resume Awareness, and Circuit Breaker.
The validator starter includes Core Model, Inputs, Fixed Checklist, Workflow,
Failure Logging, and Finish Condition.

### Validating Circuits via `circuit:dry-run`

Before trusting a new circuit for real work, run it through `circuit:dry-run`.
This validator symbolically executes every step with a concrete test feature:

1. Read the target `SKILL.md`, `circuit.yaml`, and every referenced script,
   template, and adapter.
2. For each step, walk a 10-dimension checklist:
   - Setup paths and directory creation
   - Artifact chain (consumes/produces)
   - Prompt assembly (header + skills + template)
   - Worker output expectations
   - Gate enforcement
   - Resume behavior
   - Parallel fanout correctness
   - Adapter seam completeness
   - Cross-file consistency
   - Template/script compatibility
3. For each dispatch step, simulate prompt assembly: what would
   `compose-prompt.sh` produce with these arguments?
4. For each gate, trace the verdict routing: what happens on each possible
   outcome?

The dry run produces a trace file with pass/fail results for every dimension of
every step, plus a terminal verdict of `PASS`, `PASS_WITH_NOTES`, or `FAIL`.

### The `circuit.yaml` Schema

```yaml
schema_version: "1"
circuit:
  id: your-circuit-slug          # kebab-case, matches directory name
  version: "YYYY-MM-DD"          # date of last topology change
  title: Human-Readable Title
  description: >
    One-sentence thesis. Topology only.

  phases:
    - id: phase-id               # kebab-case
      title: Phase Title
      execution: serial          # always serial at the phase level
      steps:
        - id: step-id
          title: Step Title
          action: interactive | dispatch | synthesis
          produces: artifact.md   # or list for multi-output steps
          consumes: [upstream.md] # optional
          gate:
            type: outputs_present | evidence-reopen | verdict-consistency | verdict-reopen
            required: [artifact.md]
            outcomes:             # only for non-outputs_present gates
              verdict_value: action
            checks:
              - "Concrete check description"

          # For dispatch steps:
          adapter: manage-codex   # optional, for implementation steps
          max_attempts: 3         # optional retry budget
          notes: >                # optional prose context
            Additional context

          # For parallel dispatch steps:
          execution: parallel
          workers:
            - id: worker-id
              title: Worker Title
              skills: [domain-skill]  # or [] for runtime resolution
              produces: worker-artifact.md
```

Key constraints:
- Phases are always serial.
- Parallelism is only intra-step (multiple workers within a single step).
- Step count in `circuit.yaml` must match step count in `SKILL.md`.
- Gate types, verdict vocabularies, and outcome routing must match between files.
- The `description` field is used by Claude Code for skill discovery -- weak
  descriptions mean the circuit will not be found.

### The `SKILL.md` Structure

An artifact-centric circuit `SKILL.md` follows this section order:

```markdown
---
name: circuit:your-circuit-slug
description: >
  Trigger-optimized description with phase count, use-when, and negative scope.
---

# Circuit Title

[1-2 paragraphs: artifact chain thesis and failure mode it prevents]

## When to Use
## Glossary
## Principles
## Setup
## Domain Skill Selection
## Canonical Header Schema

## Phase 1: Name
### Step 1: Title - `action_type`
### Step 2: Title - `action_type`

## Phase N: Name
### Step N: Title - `action_type`

## Artifact Chain Summary
## Resume Awareness
## Circuit Breaker
```

Each step contract includes:
- **Mission**: What the worker must accomplish.
- **Consumes**: Exact artifacts the worker reads.
- **Writes**: Exact path and schema of the output artifact.
- **Gate**: Type, required outputs, checks, and outcome routing.
- **Dispatch details** (for dispatch steps): Prompt header path, skills,
  template, and assembly command.

### The Quality Gate Checklist

When authoring or reviewing a circuit, check these six categories:

1. **Artifact Chain Integrity.** Every step names one canonical artifact. Every
   consumer knows where its input comes from. No dangling produces without a
   consumer.

2. **Gate Semantics.** Every non-trivial step has a gate stronger than file
   existence. Verdict vocabularies are bounded. Every negative outcome has a
   concrete next action.

3. **Handoff Contract Compliance.** All dispatch steps use the canonical header
   schema. Relay headings are present. Diagnose-only review steps are marked
   explicitly.

4. **Resume Safety.** Step-local relay state is checked before artifacts.
   Parallel completeness requires all worker artifacts. Child state like
   `batch.json` is inspected before restarting `manage-codex`.

5. **Dispatch Compatibility.** Only real CLI flags and template behavior are
   used. Skill budgets stay within limits. No interactive skills in autonomous
   dispatches.

6. **Prose/YAML Consistency.** Phase order, step count, consumes, produces,
   parallelism, gates, and adapters match between `SKILL.md` and `circuit.yaml`.

### Anti-Patterns to Avoid

The system catalogs 25 named anti-patterns. The most important:

| ID | Name | What goes wrong |
|----|------|----------------|
| `AP-01` | Open Artifact Chain | A step declares an output that no one produces |
| `AP-02` | Copy-The-Handoff | A raw handoff is promoted to artifact without synthesis |
| `AP-04` | Placeholder Leakage | Unresolved `{relay_root}` tokens reach the worker |
| `AP-05` | Interactive Skill In Autonomous Dispatch | An interactive skill appended to `codex exec --full-auto` |
| `AP-07` | Resume By Final Artifacts Only | Resume ignores step-local state like `batch.json` |
| `AP-10` | Weak Gates | A gate checks only file existence |
| `AP-11` | No Reopen Rule | Disconfirming evidence appears but the circuit only says "revise and continue" |
| `AP-15` | Prose/YAML Drift | `SKILL.md` and `circuit.yaml` disagree |
| `AP-19` | Review Step Mutates Source | A verdict step also changes code |
| `AP-20` | Reopen Without Governing Issue | "Reopen" is triggered without recording what caused it |
| `AP-22` | Repeated Dispatch Shell Blocks | The same compose+exec recipe shown in every step instead of once |

---

## Appendix: System Topology

### File Layout

```
circuit/
  hooks/
    hooks.json              # SessionStart hook registration
    session-start.sh        # Prerequisite check + circuit catalog banner
  scripts/
    relay/
      compose-prompt.sh     # Prompt assembly pipeline
      update-batch.sh       # Deterministic batch.json state machine
  skills/
    manage-codex/
      SKILL.md              # Codex batch orchestrator
      references/
        implement-template.md
        review-template.md
        ship-review-template.md
        converge-template.md
        review-preamble.md
        relay-protocol.md
        agents-md-template.md
    router/
      SKILL.md              # Routes requests to best-fit circuit
    develop/
      circuit.yaml
      SKILL.md
    decide/
      circuit.yaml
      SKILL.md
    harden-spec/
      circuit.yaml
      SKILL.md
    repair-flow/
      circuit.yaml
      SKILL.md
    ratchet-quality/
      circuit.yaml
      SKILL.md
    cleanup/
      circuit.yaml
      SKILL.md
    create/
      circuit.yaml
      SKILL.md
    dry-run/
      circuit.yaml
      SKILL.md
```

### Runtime Relay Layout (Example)

When `circuit:develop` executes for a feature called
"sync-engine":

```
.circuitry/circuit-runs/sync-engine/
  artifacts/
    intent-brief.md
    external-digest.md
    internal-digest.md
    constraints.md
    options.md
    decision-packet.md
    adr.md
    execution-packet.md
    seam-proof.md
    implementation-handoff.md
    ship-review.md
  phases/
    evidence-probes/
      external/
        prompt-header.md
        prompt.md
        handoffs/
          handoff.md
        last-messages/
          last-message.txt
      internal/
        prompt-header.md
        prompt.md
        handoffs/
          handoff.md
        last-messages/
          last-message.txt
    generate-candidates/
      prompt-header.md
      prompt.md
      handoffs/
        handoff.md
      last-messages/
        last-message.txt
    implement/
      CHARTER.md
      batch.json
      events.ndjson
      handoffs/
        handoff-slice-001.md
        handoff-converge.md
      review-findings/
        review-findings-slice-001.md
      last-messages/
        last-message-slice-001.txt
      archive/
```

### Data Flow Summary

```
User Request
    |
    v
circuit:router ──> selects circuit
    |
    v
SKILL.md (runtime truth)
    |
    ├── interactive steps: orchestrator + user -> artifact
    |
    ├── synthesis steps: orchestrator reads upstream -> writes artifact
    |
    └── dispatch steps:
            |
            ├── compose-prompt.sh
            |     (header + skills + template + relay_root substitution)
            |
            ├── codex exec --full-auto
            |     (worker executes, writes handoff)
            |
            ├── [if adapter: manage-codex]
            |     update-batch.sh manages state
            |     plan -> implement -> review -> converge loop
            |
            └── orchestrator reads handoff -> synthesizes artifact
                    |
                    v
              gate check
                    |
                    ├── pass -> next step
                    ├── reopen -> archive downstream, resume from target
                    └── escalate -> stop, involve user
```

---

## Design Principles (Summary)

1. **Artifacts are state.** The chat thread is ephemeral. The artifact chain on
   disk is the source of truth for circuit progress.

2. **Separate implementation from review.** Workers that write code must not
   review their own code. Different sessions prevent contamination.

3. **Gates enforce honesty.** Every step has a quality check. Verdicts are
   bounded. Negative outcomes have concrete routing, not vague "revise and
   continue" instructions.

4. **Topology is static, judgment is dynamic.** The step graph does not mutate
   at runtime. Extra work is admitted through injection ledgers within ratchet
   steps, not by adding new topology nodes.

5. **Deterministic state management.** LLMs do not hand-edit JSON. Shell scripts
   with embedded Python handle all state mutations to `batch.json`.

6. **Fail fast and redirect.** Circuit breakers stop circuits that are not
   working. The router redirects to better-fitting circuits. Neither the
   orchestrator nor the worker should ever silently continue past a structural
   failure.

7. **Compose, do not bundle.** Domain skills, adapter contracts, and templates
   are separate from circuits. Circuits declare what they need; the relay scripts
   assemble it at dispatch time.

8. **Resume from disk, not from memory.** A fresh session with no chat history
   can reconstruct the full circuit state by scanning artifacts, relay state,
   and reopen markers.

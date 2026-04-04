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
7. [Capability Resolution](#capability-resolution)
8. [The Supergraph Architecture](#the-supergraph-architecture)
9. [Extending the System](#extending-the-system)

---

## What Is a Circuit?

A circuit is a multi-phase workflow encoded as two files:

| File | Role | Analogy |
|------|------|---------|
| `circuit.yaml` | Topology declaration | Type signature |
| `SKILL.md` | Runtime truth | Implementation |

Both files live in the same directory under `skills/<name>/`. The
`circuit.yaml` declares the shape: steps, artifacts, gates, routes, and
entry modes. The `SKILL.md` contains everything the orchestrator actually
needs to execute: commands, paths, output schemas, prompt headers, resume rules,
adapter seams, and reopen choreography.

### Why Two Files?

The split is deliberate and serves different consumers:

**`circuit.yaml`** is machine-readable topology. It answers structural questions:
How many steps? What does each step produce? What does it consume? What gate
type guards it? The runtime engine reads `circuit.yaml` to derive state and
determine the next step.

**`SKILL.md`** is the execution contract. It answers operational questions: What
shell commands does the orchestrator run? What sections must appear in the output
artifact? What happens when a review says REVISE? How does a fresh session pick
up where the last one died? The orchestrator follows `SKILL.md` line by line
during execution.

### What Happens When They Drift

When the two files disagree, the circuit is mechanically broken. This is not a
documentation nit -- it is the workflow equivalent of a type signature diverging
from its implementation.

Consider a concrete case: `circuit.yaml` says a step has a `result_verdict`
gate with pass verdicts `[ship_ready]`, but `SKILL.md` describes a simpler
gate that just checks file existence. The runtime engine would expect specific
verdict routing, but the actual execution would skip the routing logic entirely.
The circuit would silently continue past failures that should trigger upstream
repair.

Cross-validation between the two files is not optional -- it is a required step
in both authoring and validation.

### The `circuit:` Prefix Convention

All circuit skills use a `circuit:` prefix in their frontmatter `name` field:

```yaml
# In SKILL.md frontmatter
name: circuit:run
```

This prefix does two things:

1. **Discovery.** Claude Code's skill matcher uses the frontmatter `name` and
   `description` to route slash commands. The prefix groups circuits visually
   and semantically.
2. **Namespace separation.** Domain skills (`rust`, `swift-apps`, `tdd`) live
   in a different namespace from circuit skills. A circuit can compose domain
   skills without naming collisions.

The directory name matches the slug: `circuit:run` lives at
`skills/run/`. The slug `run` is the canonical identifier used in
`circuit.yaml`'s `id` field.

---

## The Artifact Chain Model

The central design insight of the circuit system is: **artifacts are the durable
state, not the chat thread.**

### Every Step Produces a Named File

Each step in a circuit exits by writing a specific file to a known path. The
`run` circuit's adversarial path makes this concrete:

```text
triage-result.md          [triage, synthesis]
  -> external-digest.md   [evidence-probes, dispatch worker]
  -> internal-digest.md   [evidence-probes, dispatch worker]
  -> constraints.md       [constraints, synthesis]
  -> options.md           [options, dispatch]
  -> decision-packet.md   [decision-packet, dispatch]
  -> adr.md               [tradeoff-decision, checkpoint]
  -> execution-packet.md  [execution-contract, synthesis]
  -> seam-proof.md        [prove-seam, dispatch]
  -> implementation-handoff.md [implement, dispatch via workers]
  -> ship-review.md       [ship-review, dispatch]
  -> done.md              [summarize, synthesis]
```

This is not a suggestion -- it is a contract. The `execution-contract` step
cannot begin until `tradeoff-decision` has written `adr.md`. The `implement`
step reads `execution-packet.md` and nothing else from the decision phase. The
artifact chain is the workflow's dependency graph made explicit.

### Why Artifacts Instead of Chat

Three failure modes drive this design:

**Session death.** A Claude session can be interrupted, time out, or hit context
limits at any point. If progress lives only in the chat thread, a dead session
means starting over. With artifacts on disk, a new session scans the artifact
directory and resumes from the first missing file.

**Context overflow.** A 43-step supergraph generates far more content than fits
in a single context window. The artifact chain means each step only needs to
read its declared inputs, not the entire history. The `ship-review` step reads
`execution-packet.md` and `implementation-handoff.md` -- not the hundreds of
lines from upstream evidence gathering.

**Truthfulness.** Workers sometimes claim completion without actually finishing.
Artifacts give the orchestrator (and the next session) something concrete to
verify. The gate system checks artifact contents, not worker claims.

### Resume Awareness

Every circuit includes resume logic that defines how a fresh session picks up
where the last one left off. The runtime engine algorithm:

1. Read the circuit manifest and event log.
2. Derive the current state from recorded events.
3. Determine the next step based on the last completed step and its routes.
4. For `workers` steps, inspect child state (`job-result.json`) before
   deciding to rerun.

The key insight is **relay state takes precedence over artifact presence**. A
step might have produced its artifact but left child workers in an inconsistent
state. Resume must check the step-local state before blindly re-executing.

### Artifact vs. Worker Report

The system distinguishes between two kinds of output:

- **Artifacts** (`${RUN_ROOT}/artifacts/*.md`) are canonical circuit outputs.
  They are the durable chain. Each one has a defined schema and a gate.
- **Worker reports** (`${RUN_ROOT}/phases/step-N/reports/*.md`) are raw worker
  outputs. They follow the relay protocol format but are not the canonical
  chain.

A common anti-pattern is promoting a raw worker report directly into an artifact
without synthesis. The correct pattern is for the orchestrator to read the
report, extract the relevant information, and write the canonical artifact with
the expected schema.

### Artifact Location

All artifacts live under a single run root:

```bash
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts"
```

The `RUN_SLUG` incorporates the topic. For example, a run for "auth-refactor"
would use:

```bash
RUN_ROOT=".circuitry/circuit-runs/auth-refactor"
```

Step-specific relay state (reports, last messages, prompt headers) lives under
`${RUN_ROOT}/phases/<step-name>/`. This separation keeps the canonical artifact
chain clean while preserving the full execution trace for debugging.

---

## Execution Model

Circuits use three executor/kind combinations, each with different execution
semantics:

### The Three Step Types

#### 1. Orchestrator Synthesis (`executor: orchestrator, kind: synthesis`)

The orchestrator (Claude session) reads upstream artifacts and writes a new
artifact directly, without dispatching a worker. Synthesis is for steps where
the value is in combining and distilling information, not in generating new
research or code.

From `run`, the `constraints` step:

> Read `external-digest.md`, `internal-digest.md`, and `triage-result.md`.
> Synthesize `constraints.md` with Hard Invariants, Seams and Integration Points,
> and Open Questions.

Synthesis steps are lightweight and fast. The orchestrator has the full context
from reading upstream artifacts and can make cross-cutting decisions that a
single worker could not.

#### 2. Orchestrator Checkpoint (`executor: orchestrator, kind: checkpoint`)

The orchestrator works directly with the user at a decision point. Checkpoint
steps produce an artifact that records the user's choice. They exist where
human judgment is required -- choosing tradeoffs, confirming scope, setting
quality bars.

From `run`, the `confirm` step:

> Present the scope to the user for confirmation. Options: confirm or amend.
> If confirmed, write `scope-confirmed.md` and route to implement.
> If amended, route back to scope.

Checkpoint steps are the only steps that pause for user interaction. They are
never dispatched to workers.

#### 3. Worker Dispatch (`executor: worker, kind: dispatch`)

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
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${STEP_ROOT}/prompt-header.md" \
  --skills "rust,tdd" \
  --template implement \
  --root "${STEP_ROOT}" \
  --out "${STEP_ROOT}/prompt.md"

# 3. Dispatch to worker (auto-detects Codex or Agent backend)
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${STEP_ROOT}/prompt.md" \
  --output "${STEP_ROOT}/last-messages/last-message.txt" \
  --role implementer

# 4. Orchestrator reads the report and verifies
test -f "${STEP_ROOT}/reports/report.md"
```

Dispatch steps come in several flavors:

- **Simple dispatch**: One worker, one output. Most common.
- **Parallel dispatch**: Multiple workers run simultaneously, each producing
  its own artifact. Used for evidence probes and category surveys.
- **Dispatch via `workers`**: The `workers` adapter handles a full
  implement-review-converge loop. This is for steps that involve real code
  changes with quality gates.

### Why Implementation and Review Run in Separate Sessions

This is a core principle of `workers`:

> Implementation and review always run in separate sessions.

The reason is contamination. If the same session implements code and then
reviews it, the reviewer has already seen (and mentally committed to) the
implementation choices. The review becomes a rubber stamp rather than an
adversarial check.

Separate worker sessions mean the review worker starts fresh. It reads the diff,
re-runs verification commands independently, and judges the code without the
sunk-cost bias of having written it.

### The `workers` Loop

When a dispatch step delegates to `workers`, it runs a multi-phase inner loop:

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
"$CLAUDE_PLUGIN_ROOT/scripts/relay/update-batch.sh" --root "${CHILD_ROOT}" \
  --slice slice-001 --event review_clean
```

This is a critical design decision. LLMs are unreliable at maintaining JSON
state. Making `batch.json` mutations go through a deterministic script eliminates
an entire class of state-corruption bugs.

---

## The Gate System

Gates are the quality enforcement mechanism. Every non-trivial step has a gate
that checks the step's output before the circuit advances.

### The Three Gate Kinds

#### 1. `schema_sections`

Checks that the artifact contains required sections. Used for synthesis steps
where the value is in the structure and completeness of the output.

From `run`, the `triage` step:

```yaml
gate:
  kind: schema_sections
  source: artifacts/triage-result.md
  required: [Pattern, Mode, Reasoning, Probe]
```

This is stronger than just checking file existence. The gate verifies that
specific sections are present. If the triage result is missing the `Probe`
section, the step fails.

#### 2. `checkpoint_selection`

Used for interactive checkpoint steps where the user makes a choice. The gate
validates that the user's response is one of the allowed options.

From `run`, the `confirm` step:

```yaml
gate:
  kind: checkpoint_selection
  source: checkpoints/{step_id}-{attempt}.response.json
  allow: [confirm, amend]
```

The gate ensures the checkpoint produced a valid response before routing. The
`routes` field on the step then maps each option to a next step.

#### 3. `result_verdict`

Used for worker dispatch steps. Checks that the worker's job result contains
a passing verdict.

From `run`, the `evidence-probes` step:

```yaml
gate:
  kind: result_verdict
  source: jobs/{step_id}-{attempt}/job-result.json
  pass: [outputs_ready]
```

The `reroute` field (optional) maps specific non-passing verdicts to upstream
steps for reopening:

```yaml
gate:
  kind: result_verdict
  source: jobs/{step_id}-{attempt}/job-result.json
  pass: [evidence_sufficient]
  reroute:
    queue_adjustment_required: triage-classification
    risk_boundary_invalidated: cleanup-scope
```

### Gate Selection Guide

| Gate kind | Use when | Required contract |
|-----------|----------|-------------------|
| `schema_sections` | Quality can be checked from artifact section presence | `source` path, `required` section list |
| `checkpoint_selection` | User makes an interactive choice | `source` path, `allow` option list |
| `result_verdict` | Worker dispatch produces a structured result | `source` path, `pass` verdict list, optional `reroute` |

### How Routes Work

Each step declares its routing table in the `routes` field. Routes map
outcomes (gate verdicts, checkpoint selections, or logical labels) to next
step IDs:

```yaml
routes:
  quick: scope
  researched: evidence-probes
  adversarial: evidence-probes
  redirect_cleanup: "@stop"
  redirect_migrate: "@stop"
```

Special route targets:
- **`@complete`**: Circuit completed successfully.
- **`@escalate`**: Stop and involve the user.
- **`@stop`**: Terminate the run (used for companion circuit redirects).

The runtime engine reads routes to determine the next step after a gate passes.
This is the mechanism that enables the supergraph: different routes from the
same step lead to entirely different paths through the graph.

### The Circuit Breaker Pattern

Every circuit includes a Circuit Breaker section that defines when to stop and
redirect. This is the last line of defense against unbounded loops.

From `run`:

> Escalate to the user when:
> - A dispatch step fails twice (no valid output after 2 attempts)
> - Seam proof returns `DESIGN INVALIDATED`
> - Workers slice hits `impl_attempts > 3` or `impl_attempts + review_rejections > 5`
> - Ship review says `ISSUES FOUND` after 2 attempts

Circuit breakers also handle task misrouting. The `run` circuit's triage step
can redirect tasks to companion circuits (`cleanup`, `migrate`) when the task
signals don't fit the main supergraph.

---

## Relay Infrastructure

The relay layer is the system's plumbing: two shell scripts and a set of
templates that handle prompt assembly, state management, and the report
protocol between orchestrator and workers.

### `compose-prompt.sh`: Prompt Assembly

This script assembles a worker prompt from modular pieces:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
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
   - `implement`: Write code, run verification, produce a report.
   - `review`: Inspect the diff, re-run verification, produce findings.
   - `ship-review`: Audit existing code without a preceding diff.
   - `converge`: Final quality gate across all slices.

   For review-family templates (`review`, `ship-review`, `converge`), a review
   preamble is appended first with shared review instructions.

4. **Append relay protocol (legacy fallback).** The script checks whether the
   assembled output already contains the canonical relay headings
   (`### Files Changed`, `### Tests Run`, `### Completion Claim`). If not, it
   appends `relay-protocol.md` as a safety net.

5. **Substitute known placeholders and reject unresolved ones.** If `--root`
   is provided, all `{relay_root}` tokens are replaced. After substitution, the
   assembler scans for remaining `{...}` placeholders outside fenced code
   blocks. If any remain, the script fails with a diagnostic error naming the
   source file.

### `dispatch.sh`: Backend-Agnostic Dispatch

This script dispatches assembled prompts to workers. It auto-detects the
backend and supports role-based routing:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${STEP_ROOT}/prompt.md" \
  --output "${STEP_ROOT}/last-messages/last-message.txt" \
  --role implementer
```

Backends:
- **codex**: Codex CLI (`codex exec --full-auto`). Preferred for parallelism.
- **agent**: Claude Code Agent tool with worktree isolation. Fallback.
- **custom**: Any shell command. The prompt file is `$1`, output path is `$2`.

Role resolution: `--role` flag > `circuit.config.yaml` roles > auto-detect.

All backends emit a JSON receipt to stdout. For the agent backend, the receipt
contains the full prompt content ready for an Agent tool call. For codex, it
confirms dispatch with a PID.

### `update-batch.sh`: Deterministic State Machine

This script manages `batch.json` -- the state file that tracks every slice in a
`workers` run. The key design principle: **the orchestrator never
hand-edits `batch.json`**. All mutations go through this script.

The script supports these events:

| Event | What it does |
|-------|-------------|
| `attempt_started` | Increment `impl_attempts`, set `attempt_in_progress` |
| `impl_dispatched` | Clear `attempt_in_progress`, record report |
| `review_clean` | Set slice status to `done` |
| `review_rejected` | Increment `review_rejections` |
| `converge_complete` | Set all converge slices to `done`, phase to `complete` |
| `converge_failed` | Increment `convergence_attempts` |
| `add_slice` | Append a new slice to the batch |

Every mutation is appended to `events.ndjson` as an append-only event log,
enabling rebuild-from-events recovery.

### The Worker Report Contract

Every worker writes a report file with these exact sections:

```markdown
### Files Changed
### Tests Run
### Verification
### Verdict
### Completion Claim
### Issues Found
### Next Steps
```

These headings are not cosmetic. `compose-prompt.sh` checks for their
presence. If missing, it appends `relay-protocol.md` as a fallback. Workers
that omit these headings produce reports the orchestrator cannot reliably parse.

---

## Circuit Composition

Circuits compose with each other and with non-circuit skills through
well-defined interfaces.

### How Circuits Call `workers` as an Adapter

The `workers` skill is not a circuit -- it is an adapter. Circuits delegate
their implementation-heavy steps to `workers`, which handles the
plan-implement-review-converge loop.

The composition contract:

1. **The circuit owns the child root.** The circuit creates the directory
   structure, writes `CHARTER.md`, and defines the domain skills.

2. **`workers` owns the inner loop.** Once dispatched, `workers`
   handles slicing, worker dispatch, review, and convergence autonomously.

3. **The circuit synthesizes the result.** After `workers` completes, the
   circuit reads back the child state and writes its canonical artifact.

### The Sealed Workers Boundary

The `workers-execute@v1` protocol defines a strict public/private boundary.
Parent circuits interact with workers through a small set of typed contract
files and must not depend on worker-internal state.

**Public contract (parent circuits may read):**

| File | Direction | Purpose |
|------|-----------|---------|
| `dispatch-request.json` | Parent -> Workers | Slice definitions, file scope, verification commands |
| `dispatch-receipt.json` | Workers -> Parent | Confirmation that workers started |
| `job-result.json` | Workers -> Parent | Execution status, slice metadata, convergence outcome |
| `reports/report-converge.md` | Workers -> Parent | Human-readable convergence verdict |
| `reports/report-<slice-id>.md` | Workers -> Parent | Human-readable per-slice implementation reports |

**Worker-private (parent circuits must not read or depend on):**

- `batch.json` -- internal state machine managed by `update-batch.sh`
- `plan.json` -- internal planning state
- `events.ndjson` -- internal event log for recovery
- `review-findings/` -- internal review worker output

This boundary exists because worker internals are an implementation detail
that may change. The public contract files expose the same information in a
stable format designed for parent consumption.

### How Triage Routes Tasks

The `run` circuit's triage step classifies tasks and routes them to the
appropriate workflow path. Triage replaces the standalone router that existed
in earlier versions.

Triage classification:

| Signal Pattern | Mode | Path |
|---------------|------|------|
| Clear task, known approach, <6 files | quick | scope -> confirm -> implement -> summarize |
| Multi-domain, external research needed | researched | evidence -> constraints -> scope -> confirm -> implement -> review -> summarize |
| Named alternatives, architecture choice | adversarial | evidence -> constraints -> options -> decision -> preflight -> implement -> ship-review -> summarize |
| Existing RFC/PRD/spec | spec-review | spec-intake -> reviews -> caveat-resolution -> preflight -> implement -> ship-review -> summarize |
| Overnight quality improvement | ratchet | 17-step autonomous path |
| Adversarial tournament | crucible | 7-step diverge-explore-converge path |
| Strong cleanup signals | redirect | Redirects to `circuit:cleanup` |
| Strong migration signals | redirect | Redirects to `circuit:migrate` |

Companion circuit redirects use `@stop` routes. The triage step writes a
redirect note and tells the user to invoke the companion circuit directly.

### Domain Skills as Optional Companions

Domain skills (`rust`, `swift-apps`, `tdd`) are not bundled into circuits.
They are composed at dispatch time through capability resolution and injected
via `--skills`:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${STEP_ROOT}/prompt-header.md" \
  --skills "rust,tdd" \
  --template implement \
  --root "${STEP_ROOT}" \
  --out "${STEP_ROOT}/prompt.md"
```

This design has several advantages:

- **Circuits stay domain-agnostic.** The same `run` circuit works for Rust,
  Swift, or React projects.
- **Skill budgets are enforceable.** Circuits declare maximum skill counts
  (typically 2 domain skills, 3 total), preventing prompt bloat.
- **Domain knowledge stays current.** Updating a domain skill immediately
  affects all circuits that compose it, without editing any circuit files.

---

## Capability Resolution

Circuits do not reference skills by name in their topology. Instead, each
dispatch step declares the *capabilities* it needs -- semantic descriptors
like `testing.tdd`, `code.change`, or `review.independent`. At dispatch time,
the resolution layer maps those capabilities to concrete installed skills.

### What Capabilities Are

A capability is a dotted identifier that describes a semantic function:

| Capability | Meaning |
|------------|---------|
| `testing.tdd` | Test-driven development: write failing tests first, then implement |
| `code.change` | Make code changes in a specific language/framework context |
| `review.independent` | Review code without having written it |
| `research.external` | Conduct deep external research beyond the codebase |
| `repo.analysis` | Analyze codebase structure, find dead code, audit patterns |

Capabilities are not skills. A capability is *what needs to happen*; a skill
is *who does it*. The mapping between them is many-to-many.

### Resolution Order

When a dispatch step declares a required capability, the resolver checks
three sources in order:

1. **Project config** (`./circuit.config.yaml`). Per-circuit capability
   overrides take precedence.
2. **User config** (`~/.claude/circuit.config.yaml`). Global defaults.
3. **Engine built-ins**. Hardcoded fallback mappings for capabilities
   that can be inferred without explicit configuration.

### Required vs. Optional Capabilities

- **Required capabilities** must resolve to at least one skill before the
  step can dispatch. Unresolved required capabilities fail closed.
- **Optional capabilities** degrade gracefully. The step dispatches without
  the domain guidance if unresolved.

### Configuration Format

```yaml
# circuit.config.yaml
capabilities:
  testing.tdd: [tdd]
  research.external: [deep-research]
  code.change: []       # auto-detected
  review.independent: [] # auto-detected

circuits:
  cleanup:
    capabilities:
      repo.analysis: [dead-code-sweep]
```

An empty list (`[]`) means the capability is auto-detected or provided by
the engine built-ins.

---

## The Supergraph Architecture

Circuitry v3 collapsed 14 circuits into 4 using a supergraph model. The
primary `run` circuit contains 43 steps organized into 7 workflow paths that
share common steps where their flows converge.

### Why a Supergraph

The pre-v3 system had 14 separate circuits, each with its own `circuit.yaml`
and `SKILL.md`. This caused several problems:

- **Redundancy.** The implement-review-converge pattern was duplicated across
  6 circuits. A bug fix in the workers adapter needed updating in 6 places.
- **Triage overhead.** A standalone router skill had to classify tasks and
  redirect to the right circuit. Classification errors meant starting over.
- **Shared path drift.** Circuits that should have shared steps (like evidence
  probes) evolved independently, creating subtle behavioral differences.

The supergraph solves these by encoding all paths in a single graph with shared
nodes. The `implement` step, for example, is used by quick, researched,
adversarial, and spec-review paths. It exists once, with routes that branch
based on mode context.

### How Paths Share Steps

The supergraph uses entry modes and routes to create distinct paths through
shared infrastructure:

```
                                    ┌─ quick ──────> scope -> confirm ─┐
triage ─> classification ──────────>├─ researched ─> evidence ──┐      │
                                    ├─ adversarial -> evidence ─┤      │
                                    ├─ redirect ──> @stop       │      │
                                    └─ (spec-review, ratchet,   │      │
                                        crucible enter at their │      │
                                        own entry points)       │      │
                                                                │      │
                  constraints <────────────────────────────────>┘      │
                       │                                               │
            ┌──────────┴──────────┐                                    │
            │                     │                                    │
    researched: scope        adversarial: options                      │
         │                        │                                    │
         v                        v                                    │
       confirm              decision-packet                            │
         │                        │                                    │
         │                  tradeoff-decision                          │
         │                        │                                    │
         │              execution-contract  <── (spec-review merges)   │
         │                        │                                    │
         │                    prove-seam                               │
         │                        │                                    │
         └──────────>  implement  <────────────────────────────────────┘
                          │
                    ┌─────┼─────┐
                    │     │     │
              to_summary  │  to_ship_review
                    │     │     │
                    │  to_review │
                    │     │     │
                    v     v     v
                  summarize <- review / ship-review
                      │
                  @complete
```

Each step's `routes` field determines which branch is taken. The runtime
engine records the chosen route in the event log, so resume logic knows
exactly which path was active.

### Entry Modes

The `entry_modes` section in `circuit.yaml` defines where different workflow
shapes enter the graph:

```yaml
entry_modes:
  default:
    start_at: triage
  quick:
    start_at: triage
  ratchet:
    start_at: ratchet-survey
  crucible:
    start_at: crucible-frame
```

Entry modes that share a start point (default, quick, researched, adversarial
all start at `triage`) are differentiated by triage classification. Entry modes
with unique start points (spec-review, ratchet, crucible) enter at their own
subgraph and may never touch the shared triage/scope/implement path.

### The Four Circuits

| Circuit | Steps | Entry modes | Purpose |
|---------|-------|-------------|---------|
| `run` | 43 | 7 (default, quick, researched, adversarial, spec-review, ratchet, crucible) | Primary supergraph. Handles most tasks. |
| `cleanup` | 8 | 2 (default, auto) | Systematic dead code and cruft removal with evidence gates. |
| `migrate` | 7 | 1 (default) | Large-scale migrations with coexistence plans and rollback. |
| `workers` | -- | -- | Utility skill: dispatch backbone, not a standalone circuit. |

Companion circuits (`cleanup`, `migrate`) are reached by triage redirect or
direct invocation. They have specialized topologies that don't fit the
supergraph's structure (cleanup has a 5-category parallel survey; migrate has
a coexistence plan artifact that the supergraph doesn't model).

### The `circuit.yaml` v2 Schema

```yaml
schema_version: "2"
circuit:
  id: circuit-slug             # kebab-case, matches directory name
  version: "YYYY-MM-DD"       # date of last topology change
  purpose: >
    One-sentence thesis.

  entry:
    command: /circuit           # optional: bare command trigger
    expert_command: /circuit:run # explicit invocation
    signals:
      include: [signal_names]
      exclude: [signal_names]

  entry_modes:
    default:
      start_at: step-id
      description: >
        When and why this mode is used.

  steps:
    - id: step-id
      title: Step Title
      executor: orchestrator | worker
      kind: synthesis | checkpoint | dispatch
      protocol: protocol-name@v1     # optional
      reads: [artifact-paths]        # optional: prefix with "optional:"
      writes:
        artifact:
          path: artifacts/name.md
          schema: schema-name@v1
        # For checkpoints:
        request: checkpoints/{step_id}-{attempt}.request.json
        response: checkpoints/{step_id}-{attempt}.response.json
      capabilities:                  # for dispatch steps
        required: [capability.names]
        optional: [capability.names]
      budgets:
        max_attempts: N
      gate:
        kind: schema_sections | checkpoint_selection | result_verdict
        source: path/to/check
        required: [Section Names]    # for schema_sections
        allow: [options]             # for checkpoint_selection
        pass: [verdicts]             # for result_verdict
        reroute:                     # optional, for result_verdict
          verdict_name: target-step-id
      checkpoint:                    # for checkpoint steps
        kind: checkpoint_type
        options: [option_names]
        materialize_artifact: true   # optional
      routes:
        outcome: next-step-id
        fail: "@escalate"
```

Key differences from v1:
- `steps:` is a flat list (was nested under `phases:`)
- `executor` + `kind` (was `action`)
- `reads:` / `writes:` (was `consumes:` / `produces:`)
- `gate.kind:` (was `gate.type:`)
- `routes:` on the step (was outcomes in the gate)
- `capabilities:` / `budgets:` per step
- `entry_modes:` for supergraph path selection
- `reroute:` for conditional upstream routing

---

## Extending the System

### The Quality Gate Checklist

When authoring or reviewing a circuit, check these six categories:

1. **Artifact Chain Integrity.** Every step names one canonical artifact. Every
   consumer knows where its input comes from. No dangling produces without a
   consumer.

2. **Gate Semantics.** Every non-trivial step has a gate. Verdict vocabularies
   are bounded. Every negative outcome has a concrete next action.

3. **Handoff Contract Compliance.** All dispatch steps use the canonical header
   schema. Relay headings are present. Diagnose-only review steps are marked
   explicitly.

4. **Resume Safety.** Step-local relay state is checked before artifacts.
   Parallel completeness requires all worker artifacts. Child state like
   `job-result.json` is inspected before restarting `workers`.

5. **Dispatch Compatibility.** Only real CLI flags and template behavior are
   used. Skill budgets stay within limits. No interactive skills in autonomous
   dispatches.

6. **Prose/YAML Consistency.** Step count, reads, writes, parallelism, gates,
   and routes must match between `SKILL.md` and `circuit.yaml`.

### Anti-Patterns to Avoid

| ID | Name | What goes wrong |
|----|------|----------------|
| `AP-01` | Open Artifact Chain | A step declares an output that no one produces |
| `AP-02` | Copy-The-Handoff | A raw worker report is promoted to artifact without synthesis |
| `AP-04` | Placeholder Leakage | Unresolved `{relay_root}` tokens reach the worker |
| `AP-05` | Interactive Skill In Autonomous Dispatch | An interactive skill appended to `codex exec --full-auto` |
| `AP-07` | Resume By Final Artifacts Only | Resume ignores step-local state like `job-result.json` |
| `AP-10` | Weak Gates | A gate checks only file existence |
| `AP-11` | No Reopen Rule | Disconfirming evidence appears but the circuit only says "revise and continue" |
| `AP-15` | Prose/YAML Drift | `SKILL.md` and `circuit.yaml` disagree |
| `AP-19` | Review Step Mutates Source | A verdict step also changes code |

---

## Appendix: System Topology

### File Layout

```
circuitry/
  .claude-plugin/
    plugin.json               # Plugin manifest
  hooks/
    hooks.json                # SessionStart hook registration
    session-start.sh          # Handoff detection
  scripts/
    relay/
      compose-prompt.sh       # Prompt assembly pipeline
      dispatch.sh             # Backend-agnostic worker dispatch
      update-batch.sh         # Deterministic batch.json state machine
    runtime/
      engine/
        src/
          derive-state.ts     # State derivation from event log
          resume.ts           # Resume logic
          cli/
            read-config.ts    # Config file reader
    sync-to-cache.sh          # Plugin cache sync
    verify-install.sh         # Installation verification
  skills/
    run/
      circuit.yaml            # 43-step supergraph
      SKILL.md                # Execution contract
      references/
        mode-quick.md
        mode-researched.md
        mode-adversarial.md
        mode-spec-review.md
        workflow-ratchet.md
        workflow-crucible.md
        autonomous-gates.md
    cleanup/
      circuit.yaml            # 8-step cleanup circuit
      SKILL.md
    migrate/
      circuit.yaml            # 7-step migration circuit
      SKILL.md
    workers/
      SKILL.md                # Batch worker orchestrator (utility, no circuit.yaml)
      references/
        implement-template.md
        review-template.md
        ship-review-template.md
        converge-template.md
        review-preamble.md
        relay-protocol.md
        agents-md-template.md
    handoff/
      SKILL.md                # Session handoff (utility, no circuit.yaml)
      scripts/
```

### Runtime Layout (Example)

When `circuit:run` executes in adversarial mode for a task called
"sync-engine":

```
.circuitry/circuit-runs/sync-engine/
  artifacts/
    triage-result.md
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
    done.md
  phases/
    evidence-probes/
      prompt-header.md
      prompt.md
      reports/
      last-messages/
    implement/
      CHARTER.md
      batch.json
      events.ndjson
      reports/
      last-messages/
      archive/
  checkpoints/
    confirm-1.request.json
    confirm-1.response.json
    tradeoff-decision-1.request.json
    tradeoff-decision-1.response.json
  jobs/
    evidence-probes-1/
      dispatch-request.json
      dispatch-receipt.json
      job-result.json
```

### Data Flow

```
User Request
    |
    v
circuit:run triage ──> classifies task
    |
    ├── quick/researched/adversarial: route through supergraph
    ├── spec-review/ratchet/crucible: route to subgraph entry
    └── redirect: stop, suggest circuit:cleanup or circuit:migrate
    |
    v
SKILL.md (runtime truth)
    |
    ├── synthesis steps: orchestrator reads upstream -> writes artifact
    |
    ├── checkpoint steps: orchestrator + user -> artifact
    |
    └── dispatch steps:
            |
            ├── compose-prompt.sh
            |     (header + skills + template + relay_root substitution)
            |
            ├── dispatch.sh --role <role>
            |     (auto-detects codex/agent/custom backend)
            |
            ├── [if workers delegation]
            |     update-batch.sh manages state
            |     implement -> review -> converge loop
            |
            └── orchestrator reads report -> synthesizes artifact
                    |
                    v
              gate check
                    |
                    ├── pass -> follow route to next step
                    ├── reroute -> archive downstream, resume from target
                    └── fail -> @escalate, involve user
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
   at runtime. Routes select paths; they do not create new steps.

5. **Deterministic state management.** LLMs do not hand-edit JSON. Deterministic
   scripts handle all state mutations to `batch.json`.

6. **Fail fast and redirect.** Circuit breakers stop circuits that are not
   working. Triage redirects to companion circuits. Neither the orchestrator nor
   the worker should ever silently continue past a structural failure.

7. **Compose, do not bundle.** Domain skills, adapter contracts, and templates
   are separate from circuits. Circuits declare what they need; the relay scripts
   assemble it at dispatch time.

8. **Resume from disk, not from memory.** A fresh session with no chat history
   can reconstruct the full circuit state by scanning artifacts, relay state,
   and reopen markers.

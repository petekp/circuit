---
name: circuit:create
description: >
  Worker-powered compiler for turning a natural-language workflow description into
  a circuit skill that matches the live corpus. 5 phases: Intake -> Analysis ->
  Authoring -> Validation -> Refinement. Workers handle analysis, file
  generation, and quality gate; Claude does intake and a final refinement pass
  optimized for Claude Code. Use when you want to create a circuit, compile a
  circuit, author a circuit skill, or turn this workflow into a circuit. Not for
  editing existing circuits, not a runtime engine, and not for one-off prompts.
---

# Circuit Create

This skill compiles a workflow description into a circuit skill pair:
`circuit.yaml` for topology and `SKILL.md` for runtime truth. The artifact chain
is `workflow-brief.md -> circuit-analysis.md -> draft-circuit.yaml + draft-SKILL.md
+ cross-validation.md -> validation-report.md -> circuit.yaml + SKILL.md`.

Workers do the heavy lifting: pattern analysis, file generation, and
quality validation. The orchestrator handles intake (interactive) and a final
refinement pass that optimizes the generated circuit for Claude Code -- trigger
metadata, dispatch patterns, skill discovery, and session ergonomics.

This is a compiler, not a runtime engine. It can author either artifact-centric
delivery circuits or validator circuits, but it does not execute the generated
circuit. After authoring, recommend `circuit:dry-run` before anyone trusts the
result for real work.

## When to Use

- You want to create a new circuit from a natural-language workflow description
- You want to turn a proven multi-phase workflow into a reusable circuit skill
- You need to decide whether the workflow is an artifact-centric circuit or a validator
- You need both `circuit.yaml` and `SKILL.md` to match the live corpus

Do NOT use for editing an existing circuit, building a runtime engine, or
wrapping a tiny one-off prompt in unnecessary circuit structure.

## Glossary

- **Artifact** - A durable circuit output file under `${RUN_ROOT}/artifacts/`
  unless the step explicitly writes a final deliverable to `TARGET_CIRCUIT_ROOT`.
- **Runtime truth** - The execution contract in `SKILL.md`: commands, paths,
  headers, gates, resume rules, and adapter seams.
- **Topology metadata** - The ordered phase and step structure in `circuit.yaml`.
- **Circuit family** - The live branch the workflow fits: artifact-centric or
  validator.
- **Cross-validation** - The field-by-field comparison that proves the authored
  `circuit.yaml` and `SKILL.md` agree.
- **Adapter seam** - A dispatch boundary such as `workers` whose runtime
  contract must be described explicitly in prose.

## Principles

- **Compiler, not runtime.** `circuit:create` authors a circuit skill. It does not
  execute the generated workflow and it is not itself a `workers` circuit.
- **Workers generate, orchestrator refines.** Workers handle analysis, authoring,
  and quality validation. The orchestrator handles intake and a final refinement
  pass that optimizes for Claude Code.
- **`SKILL.md` is runtime truth.** Treat `circuit.yaml` as topology only. If the
  files disagree, the circuit is mechanically broken.
- **Frontmatter does trigger work.** The generated `name` and `description`
  decide whether the skill is discoverable at all.
- **Step granularity is a contract.** YAML topology steps must match prose
  topology steps. Worker detail may expand inside one step; topology may not drift.
- **Cross-validate before dry-run.** The cross-validation worker verifies during
  authoring; Claude verifies during refinement. Both passes are mandatory.
- **Trip the circuit breaker early.** If the workflow does not fit the live
  circuit contract, say so instead of forcing a fake circuit.

## Setup

```bash
WORKFLOW_SOURCE="<inline-description-or-path>"
TARGET_CIRCUIT_SLUG="<new-circuit-slug>"
TARGET_CIRCUIT_ROOT="${HOME}/.claude/skills/circuit/${TARGET_CIRCUIT_SLUG}"
RUN_ROOT=".circuitry/circuit-runs/${TARGET_CIRCUIT_SLUG}-circuit-create"
STAGING="${RUN_ROOT}/staging"
mkdir -p "${RUN_ROOT}/artifacts" "${STAGING}" \
  "${RUN_ROOT}/reports" "${RUN_ROOT}/last-messages" \
  "${TARGET_CIRCUIT_ROOT}"
```

Record these inputs before authoring:

- `WORKFLOW_SOURCE` - the user's workflow description, notes, or source file
- `TARGET_CIRCUIT_SLUG` - the generated circuit directory name (under `circuit/`)
- `TARGET_CIRCUIT_ROOT` - where the final `circuit.yaml` and `SKILL.md` will live
- `RUN_ROOT` - where relay state, compiler artifacts, and staging drafts live
- `STAGING` - where workers write draft files (sandbox cannot write to `~/.claude/`)

The `circuit:` prefix is added automatically to the frontmatter `name` field. For
example, slug `foo-bar` produces `name: circuit:foo-bar` and lives at
`~/.claude/skills/circuit/foo-bar/`.

## Domain Skill Selection

`circuit:create` does not need autonomous workers by default. When the workflow
you are compiling includes dispatch steps, author them with these limits:

- Default to 1-2 domain skills and at most 3 total skills per autonomous dispatch
- Never append interactive skills to autonomous worker dispatches
- Document any exception to the skill-budget ceiling explicitly in the generated circuit

## Dispatch Backend

Generated circuits should use the dispatch helper (`"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh"`)
which auto-detects whether Codex CLI or Agent fallback should be used. The
artifact chain, gates, and report format are identical regardless of backend.

## Canonical Header Schema

Every generated dispatch step should point back to this header contract unless
the author has a stronger, step-specific reason to inline a fuller variant.

```markdown
# Step N: <title>

## Mission
[What the worker must accomplish]

## Inputs
[The exact artifacts, digests, or external inputs the worker reads]

## Output
- **Path:** [exact path where the worker must write its primary artifact]
- **Schema:** [required sections or headings]

## Success Criteria
[What done means for this step]

## Report Instructions
Write your primary output to the path above. Also write a standard report to
`reports/report.md` with these exact section headings:

### Files Changed
### Tests Run
### Verification
### Verdict
### Completion Claim
### Issues Found
### Next Steps
```

Those relay headings are not cosmetic. `compose-prompt.sh` checks for
`### Files Changed`, `### Tests Run`, and `### Completion Claim`. If they are
missing, it may append `relay-protocol.md` and leak unresolved placeholders into
the worker prompt.

## Key Rules

### Runtime Source Of Truth

- Put identity, phase order, step order, actions, artifacts, fanout shape, and
  coarse gate types in `circuit.yaml`
- Put commands, paths, output schemas, prompt headers, resume rules, fallback
  synthesis, adapter seams, and reopen choreography in `SKILL.md`
- Treat drift between the two files as a mechanical defect, not a documentation nit

### Trigger Metadata

- Generated frontmatter must contain only `name` and `description`
- `name` must be kebab-case and match the circuit directory
- `description` must encode trigger phrases, circuit shape, and negative scope
- Weak metadata like "helps with workflows" is structurally legal and operationally poor

### Prose And YAML Granularity

- Keep phases serial
- Represent parallelism only as intra-step fanout with `execution: parallel` and `workers`
- Keep YAML topology step count aligned with prose topology step count
- Expand worker detail under one step instead of inventing extra topology steps

### Diagnose-Only Review Contract

When a generated review step is assessment only, say so explicitly:

```markdown
This step is assessment only - the worker does NOT modify source code.
```

Also define:

- who performs remediation if issues are found
- the bounded verdict vocabulary
- the reopen or rerun rule

### Adapter Seam Contract

If the generated workflow uses `adapter: workers`, the generated `SKILL.md`
must include all of the following:

- child root creation
- `CHARTER.md` creation from the parent execution contract
- the real `compose-prompt.sh` and `dispatch.sh` calls
- required child files: `CHARTER.md`, `batch.json`,
  `reports/report-<slice-id>.md`, and `reports/report-converge.md`
- readback order: `report-converge.md`, then `batch.json`, then the last slice report
- outer synthesis rules for the parent artifact
- escalation behavior if convergence says `ISSUES REMAIN`

## Reference Pack

These sections are the inline authoring reference. A fresh session should not
need the original review package open beside the generated circuit.

### Canonical `circuit.yaml` Starter

```yaml
schema_version: "1"
circuit:
  id: your-circuit-slug
  version: "YYYY-MM-DD"
  title: Your Circuit Title
  description: >
    One-sentence circuit thesis. Topology only - this file does not encode runtime
    behavior or adapter contracts.

  phases:
    - id: framing
      title: Framing
      execution: serial
      steps:
        - id: intake
          title: Intake
          action: interactive
          produces: brief.md
          gate:
            type: outputs_present
            required: [brief.md]
            checks:
              - "Decision or problem statement non-empty"

    - id: evidence
      title: Evidence
      execution: serial
      steps:
        - id: parallel-probes
          title: Parallel Probes
          action: dispatch
          execution: parallel
          workers:
            - id: probe-a
              title: Probe A
              skills: [deep-research]
              produces: probe-a.md
            - id: probe-b
              title: Probe B
              skills: []
              produces: probe-b.md
          consumes: [brief.md]
          produces: [probe-a.md, probe-b.md]
          gate:
            type: outputs_present
            required: [probe-a.md, probe-b.md]
            checks:
              - "Both worker artifacts exist and follow the promised schema"

        - id: synthesis
          title: Synthesis
          action: synthesis
          consumes: [probe-a.md, probe-b.md]
          produces: packet.md
          gate:
            type: outputs_present
            required: [packet.md]
            checks:
              - "Named sections present"

    - id: delivery
      title: Delivery
      execution: serial
      steps:
        - id: implement
          title: Implement
          action: dispatch
          adapter: workers
          consumes: [packet.md]
          produces: implementation-handoff.md
          max_attempts: 3
          notes: >
            Delegates to workers. Orchestrator creates CHARTER.md and
            synthesizes the outer handoff from child workflow artifacts.

        - id: validate
          title: Final Review
          action: dispatch
          consumes: [packet.md, implementation-handoff.md]
          produces: review.md
          gate:
            type: verdict-reopen
            outcomes:
              ready: continue
              revise: interactive-reopen
```

### Artifact-Centric `SKILL.md` Starter

````markdown
---
name: your-circuit-slug
description: >
  Artifact-driven circuit for [goal]. [N] steps across [M] phases: [Phase A] ->
  [Phase B] -> [Phase C]. Use when [positive trigger]. Do not use for
  [negative trigger].
---

# Your Circuit

One or two paragraphs stating the artifact chain, why it exists, and what kind
of failure it prevents.

## When to Use
- Specific trigger 1
- Specific trigger 2
- Specific trigger 3

Do NOT use for [negative scope].

## Glossary
- **Artifact** - Durable circuit output under `${RUN_ROOT}/artifacts/`.
- **Worker report** - Raw relay output, not the canonical artifact chain.
- **Synthesis** - Orchestrator-authored artifact created from upstream artifacts.

## Principles
- **Artifacts, not commentary.** Every step exits with a durable file.
- **Self-contained headers.** Dispatch prompts do not rely on implied template behavior.
- **Reopen on disconfirming evidence.** Invalidating evidence changes the workflow.

## Setup
```bash
RUN_SLUG="<topic-slug>"
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts"
```

## Domain Skill Selection
[Skill budget, domain mapping, and exclusions]

## Canonical Header Schema
[The shared header contract]

## Phase 1: <Name>
### Step 1: <Title> - `interactive`

## Phase 2: <Name>
### Step 2: <Title> - `dispatch`

## Phase 3: <Name>
### Step 3: <Title> - `synthesis`

## Artifact Chain Summary
[Show the durable chain]

## Resume Awareness
[Artifact order, relay-state precedence, child adapter state]

## Circuit Breaker
[When to escalate]
````

### Validator `SKILL.md` Starter

Use this section order instead of the artifact-centric starter when the circuit's
primary job is symbolic execution or mechanical validation of another circuit:

````markdown
---
name: your-circuit-slug
description: >
  Validator circuit for mechanically tracing [target] against a fixed checklist.
  Use when [positive trigger]. Do not use for delivery workflows or runtime execution.
---

# Your Validator Circuit

Short paragraph explaining the validator's core model and what a passing trace means.

## Core Model
## When to Use
## Inputs
## Output Location
## Citation Discipline
## Source-of-Truth Rule
## Fixed Checklist
## Workflow
### Special Step Types
## Targeted Closure Pass
## Failure Logging
## Output Schema
## Finish Condition
## Practical Notes
````

### Gate Selection Decision Table

| Gate type | Use when | Required contract | Bad smells |
|---|---|---|---|
| `outputs_present` | Artifact quality can be checked from the file plus explicit content checks | Exact output schema, concrete gate checks, fallback synthesis if a worker wrote only `reports/report.md` | Gate says only "file exists" or "looks good" |
| `evidence-reopen` | A proof step can validate, adjust, or invalidate the plan | Bounded verdicts, explicit artifact to update, explicit user checkpoint for invalidation | Proof can fail but the circuit only says "revise and continue" |
| `verdict-consistency` | A terminal verdict is valid only if it matches named evidence boundaries | Verdict meanings, exact evidence threshold, exact failing boundary requirement | "Closed" or equivalent is allowed without naming the checked boundary |
| `verdict-reopen` | A review step decides between continue and upstream revision | Diagnose-only contract, ready threshold, named reopen targets, user prompt for target plus governing issue | Review both edits code and judges it, or `REVISE` has no named target |

### Quality Gate Checklist

#### Artifact Chain Integrity

- Name one canonical artifact per topology step or one explicit promoted output
- Distinguish worker reports from canonical circuit artifacts
- Name the exact output path and schema for every dispatch step
- Declare every external input and the first step that reads it
- Normalize parallel fanout before downstream synthesis depends on one contract

#### Gate Semantics

- Give every non-trivial step a gate stronger than file existence
- Bound verdict vocabulary and next-action routing
- Preserve the same gate semantics in `SKILL.md` and `circuit.yaml`
- Record the governing issue whenever a verdict triggers reopen

#### Report Contract Compliance

- Use the canonical header schema and exact relay headings
- Tell the worker where the primary artifact lives and where the report lives
- Mark diagnose-only review steps explicitly
- Do not promote a raw worker report into a semantic artifact without synthesis

#### Resume Safety

- Check step-local relay state first and promoted artifacts second
- Treat parallel completeness as "all worker artifacts exist and satisfy the gate"
- Inspect child state like `batch.json` before restarting `workers`
- Resume from the chosen reopen target, not blindly from the verdict step

#### Dispatch Compatibility

- Use only real CLI flags, template behavior, and adapter behavior
- Keep autonomous skill budgets at 3 total skills unless a justified exception is documented
- Never append interactive skills to autonomous dispatches
- Make adapter seams concrete enough to execute by hand

#### Prose/YAML Consistency

- Align phase order, step count, consumes, produces, parallelism, gates, and adapters
- Keep runtime semantics in `SKILL.md`
- Author both files, then cross-validate them field by field
- Surface unsupported capabilities explicitly instead of implying hidden runtime behavior
- Verify total SKILL.md line count is proportional to circuit complexity. Comparable circuits in the corpus: repair-flow (593), develop (810+), decide (600). A circuit with similar topology should not exceed ~750 lines without justification. If it does, run the conciseness rules before shipping.

### Authoring Checklist

1. Define the circuit family and trigger surface.
2. Lock the topology and step granularity.
3. Inventory the artifact chain and every external input.
4. Draft `circuit.yaml` with the live topology schema.
5. Draft `SKILL.md` frontmatter and shared sections.
6. Write every step contract with the right action pattern.
7. Add gates, verdicts, and reopen choreography.
8. Add worker-role and adapter contracts.
9. Add resume and circuit-breaker behavior.
10. Cross-validate `SKILL.md` and `circuit.yaml`.
10b. **Apply conciseness rules:**
    - Setup must not re-list inputs that Step 1 captures -- forward-reference only
    - The canonical header schema should be shown compressed (required section names + relay heading rule), not as a full markdown template
    - Show the dispatch recipe (compose-prompt + dispatch.sh) in full exactly once; subsequent steps reference it
    - Tighten adapter seam contracts to required fields, not heredoc templates -- keep child-root layout, required CHARTER sections, readback order, and escalation rule; cut the shell heredoc
    - Remove standalone `Verify: test -f` lines -- the gate owns existence checks
    - Principles should not restate the intro or the dual-mode description in abstract form
    - Body negative scope can reference frontmatter instead of repeating the full list
11. Run the quality gate and recommend `circuit:dry-run`.

### Quality-Gate Crosswalk

| Quality category | Author task | Done when |
|---|---|---|
| Artifact Chain Integrity | Name every artifact, path, promotion rule, and external input | No consumer has to guess where input comes from |
| Gate Semantics | Write bounded gates plus outcome routing | Every negative outcome has a concrete next action |
| Handoff Contract Compliance | Freeze the header schema and relay headings | `compose-prompt.sh` cannot contaminate the prompt |
| Resume Safety | Define relay-first resume and reopen-target resume | A fresh session knows where to restart |
| Dispatch Compatibility | Check every command, skill budget, template, and adapter seam | A reviewer can execute the prose mechanically |
| Prose/YAML Consistency | Cross-check both files field by field | No topology drift remains |

### Anti-Pattern Catalog

| ID | Smell |
|---|---|
| `AP-01` | Open Artifact Chain - a step declares an output that no worker or synthesis step actually produces |
| `AP-02` | Copy-The-Handoff - a generic worker report is copied verbatim into a semantic artifact |
| `AP-03` | Template Misbinding - a step uses `review`, `ship-review`, `converge`, or `implement` for the wrong job |
| `AP-04` | Placeholder Leakage - unresolved placeholders reach the worker prompt |
| `AP-05` | Interactive Skill In Autonomous Dispatch - an AskUserQuestion-style skill is appended to an autonomous worker dispatch |
| `AP-06` | Relay Layout Drift - parent, child, and adapter layouts assume different ownership boundaries |
| `AP-07` | Resume By Final Artifacts Only - resume logic ignores step-local relay state such as `batch.json` |
| `AP-08` | Review Overwrites Implementation Evidence - the only implementation story lives in a path reused by review |
| `AP-09` | Ambiguous Final Synthesis - the circuit says "copy the final report" without explicit source artifacts and synthesis rules |
| `AP-10` | Weak Gates - a gate checks only existence or generic completion |
| `AP-11` | No Reopen Rule - disconfirming evidence appears but the circuit only says "revise and continue" |
| `AP-12` | Guide Instead Of Contract - downstream work gets a guide that drops invariants, tests, or rollback triggers |
| `AP-13` | Multiple Authoritative Packets - old and new packets coexist without a supersession rule |
| `AP-14` | Faux Runtime Claims - the circuit denies being a runtime engine while depending on hidden runtime behavior |
| `AP-15` | Prose/YAML Drift - `SKILL.md` and `circuit.yaml` disagree about topology or branching |
| `AP-16` | Boilerplate Swamps Signal - shell ceremony buries the only step-specific rules that matter |
| `AP-17` | Hidden External Input - a required source document, script, template, or circuit root is never declared |
| `AP-18` | Faux Validator - a validator names checks but never defines symbolic execution, citations, or a fixed checklist |
| `AP-19` | Review Step Mutates Source - a verdict step also changes code or rewrites the artifact under review |
| `AP-20` | Reopen Without Governing Issue - the circuit says "reopen" but never records what issue caused it |
| `AP-21` | Setup Duplicates Intake - the Setup section lists runtime inputs that Step 1's interactive intake already captures. Keep runtime inputs in one place (the intake step). Setup should only contain `RUN_ROOT` creation and a forward reference to Step 1. |
| `AP-22` | Repeated Dispatch Shell Blocks - near-identical `compose-prompt.sh` + `dispatch.sh` blocks appear in every dispatch step. Show the full recipe once (first dispatch step), then reference it. Per-step blocks should only name the header path, skills, and template if non-default. |
| `AP-23` | Duplicate Readback Orders - the same readback order appears in both the adapter contract and a later summary. Keep it in one location (the adapter contract section). |
| `AP-24` | Standalone Verify Lines - a `Verify: test -f ...` line that duplicates the gate check immediately below it. Every existence check should live in the gate, not also as a standalone line. |
| `AP-25` | Circuit Breaker Echoes Alternatives - a "Good alternatives" list at the end that repeats the redirects already named in the circuit breaker bullets. Remove the echo list. |

## Phase 1: Intake

### Step 1: Workflow Intake - `interactive`

**Objective:** Turn the user's workflow description into a durable authoring brief
before any topology is invented.

**User checkpoint:** The user confirms the real workflow shape, what should
trigger the generated circuit, and whether this is a delivery circuit or validator.

Ask the user:

> 1. What should a fresh session be able to accomplish with this circuit end to end?
> 2. What phases or checkpoints already exist in the workflow?
> 3. Which steps require human judgment, and which are interactive, dispatch, or synthesis candidates?
> 4. What artifacts must survive each phase?
> 5. What external inputs, adapters, scripts, templates, or child workflows does it depend on?
> 6. Is this an artifact-centric circuit or a validator? If unsure, what is being validated and does the workflow execute product work?
> 7. What should trigger the skill, and what is explicitly out of scope?
> 8. Where should the generated circuit be written?

Write `${RUN_ROOT}/artifacts/workflow-brief.md`:

```markdown
# Workflow Brief
## Circuit Goal
## Trigger Surface
## Negative Scope
## Circuit Family
## Candidate Phase List
## Judgment Checkpoints
## Artifact Chain
## External Inputs and Adapters
## Output Target
## Open Questions
```

**Gate:** `workflow-brief.md` exists with non-empty Circuit Goal, Trigger Surface,
Negative Scope, Circuit Family, and Output Target sections.

**Failure mode:** The compiler authors a circuit for the wrong problem, wrong
family, or wrong trigger surface.

## Phase 2: Analysis

### Step 2: Pattern Mapping - `dispatch`

**Objective:** Normalize the brief into the live circuit patterns and identify the
exact contract the generated files must encode.

Write a prompt header to `${RUN_ROOT}/prompt-header-analysis.md`:

```markdown
# Step 2: Pattern Mapping

## Mission
Read the workflow brief and map it to the live circuit patterns. Determine whether
this is an artifact-centric circuit or a validator circuit. Output a structured
analysis that will feed directly into file generation.

## Inputs
- `${RUN_ROOT}/artifacts/workflow-brief.md`
- The Reference Pack embedded in this skill's SKILL.md (starters, gate table,
  quality gate, anti-patterns)

## Output
- **Path:** `${RUN_ROOT}/artifacts/circuit-analysis.md`
- **Schema:**
  ## Recommended Circuit Family
  ## Phase Topology
  ## Step Inventory
  ## Action Map
  ## Artifact Chain and Promotion Rules
  ## Gate Plan
  ## External Inputs and Notes
  ## Resume and Reopen Plan
  ## Adapter and Worker Contracts
  ## Inline Reference Requirements

## Success Criteria
- Circuit family is explicitly chosen with reasoning
- Every step has an action type, artifact(s), and gate plan
- Circuit breaker triggered if the workflow does not fit

## Handoff Instructions
### Files Changed
### Tests Run
### Completion Claim
```

Assemble and dispatch:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${RUN_ROOT}/prompt-header-analysis.md" \
  --template implement \
  --root "${RUN_ROOT}" \
  --out "${RUN_ROOT}/prompt-analysis.md"

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${RUN_ROOT}/prompt-analysis.md" \
  --output "${RUN_ROOT}/last-messages/last-message-analysis.txt"
```

Verify: `test -f ${RUN_ROOT}/artifacts/circuit-analysis.md`

Analysis rules (encode in the prompt header):

- Choose the artifact-centric family unless the primary job is symbolic
  execution or validation of another circuit
- Do not invent a third family
- Keep phases serial and use worker fanout only inside a single step
- Mark review steps as diagnose-only when they should not mutate source
- If `workers` appears, record the full adapter-seam contract now
- If the workflow is too small, too graph-like, or too runtime-dependent for the
  live circuit contract, trip the circuit breaker instead of forcing it

**Gate:** `circuit-analysis.md` exists with explicit Phase Topology, Step
Inventory, Action Map, Artifact Chain and Promotion Rules, Gate Plan, and
Resume and Reopen Plan.

**Failure mode:** The generated files look plausible but encode the wrong family,
wrong topology, or hidden runtime assumptions.

## Phase 3: Authoring

### Step 3: Compile Circuit Files - `dispatch`

**Objective:** Generate draft `circuit.yaml` and `SKILL.md` from the analysis,
cross-validate them, and write all three to the staging area.

Write a prompt header to `${RUN_ROOT}/prompt-header-authoring.md` that includes:

- The full workflow brief digest
- The full circuit analysis digest
- The Reference Pack (canonical starters, gate table, quality gate, anti-patterns)
- Instructions to write:
  - `${STAGING}/circuit.yaml` -- from the canonical YAML starter
  - `${STAGING}/SKILL.md` -- from the appropriate family starter
  - `${RUN_ROOT}/artifacts/cross-validation.md` -- field-by-field comparison

Assemble and dispatch:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${RUN_ROOT}/prompt-header-authoring.md" \
  --template implement \
  --root "${RUN_ROOT}" \
  --out "${RUN_ROOT}/prompt-authoring.md"

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${RUN_ROOT}/prompt-authoring.md" \
  --output "${RUN_ROOT}/last-messages/last-message-authoring.txt"
```

Verify: `test -f ${STAGING}/circuit.yaml && test -f ${STAGING}/SKILL.md && test -f ${RUN_ROOT}/artifacts/cross-validation.md`

Cross-validation rules (encode in the prompt header):

- Compare phase ids, titles, and order
- Compare step ids, titles, actions, consumes, produces, adapters, and retries
- Compare parallel fanout shape and worker roles
- Compare gate types, verdict vocabularies, and reopen outcomes
- Compare the declared external inputs and adapter seams
- Fix every drift before declaring done
- The generated `name` must use `circuit:` prefix (e.g., `circuit:foo-bar`)

**Gate:** `circuit.yaml`, `SKILL.md`, and `cross-validation.md` exist in staging,
the files agree on topology and branching, and the generated `SKILL.md` includes
the embedded reference pack.

**Failure mode:** The circuit looks polished but fails because `SKILL.md` and
`circuit.yaml` describe different workflows.

## Phase 4: Validation

### Step 4: Quality Gate - `dispatch`

**Objective:** The review worker walks the six quality categories against the
draft files. This step is assessment only -- the worker does NOT modify the drafts.

Write a prompt header to `${RUN_ROOT}/prompt-header-validation.md` that includes:

- Digests of `${STAGING}/circuit.yaml` and `${STAGING}/SKILL.md`
- Full `cross-validation.md` content
- The Quality Gate Checklist and Anti-Pattern Catalog from this skill
- Instructions to write `${RUN_ROOT}/artifacts/validation-report.md`

Assemble and dispatch:

```bash
"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${RUN_ROOT}/prompt-header-validation.md" \
  --template ship-review \
  --root "${RUN_ROOT}" \
  --out "${RUN_ROOT}/prompt-validation.md"

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${RUN_ROOT}/prompt-validation.md" \
  --output "${RUN_ROOT}/last-messages/last-message-validation.txt"
```

Verify: `test -f ${RUN_ROOT}/artifacts/validation-report.md`

Validation report schema:

```markdown
# Validation Report
## Artifact Chain Integrity
## Gate Semantics
## Handoff Contract Compliance
## Resume Safety
## Dispatch Compatibility
## Prose/YAML Consistency
## Anti-Patterns Found
## Verdict: READY / REVISE
## Recommended Next Step
```

Validation rules (encode in the prompt header):

- Walk every quality category explicitly; do not stop at the first defect
- Name anti-patterns by ID when they appear
- If the generated circuit claims validator behavior, confirm the validator
  contract actually includes inputs, citations, fixed checklist, workflow,
  failure logging, and finish condition
- If the generated circuit claims adapter support, verify the seam is concrete
- This step is assessment only -- do NOT modify the draft files
- Check for AP-21 through AP-25 (conciseness anti-patterns). Pay special attention to:
  - AP-22 (Repeated Dispatch Shell Blocks) -- count the number of full compose+exec blocks. More than one is a smell.
  - AP-21 (Setup Duplicates Intake) -- check if Setup lists runtime inputs that the intake step already collects.

**Gate:** `validation-report.md` exists with all six quality categories walked
and a binary READY/REVISE verdict.

**Failure mode:** A surface-level review passes a circuit with hidden gaps.

## Phase 5: Refinement

### Step 5: Claude Code Refinement - `synthesis`

**Objective:** The orchestrator reads all upstream artifacts and the worker
validation findings, refines the draft files for Claude Code optimization, and
installs the final circuit to `TARGET_CIRCUIT_ROOT`.

Read these inputs:

- `${STAGING}/circuit.yaml` and `${STAGING}/SKILL.md` (worker drafts)
- `${RUN_ROOT}/artifacts/cross-validation.md`
- `${RUN_ROOT}/artifacts/validation-report.md`

Refinement checklist:

1. **Trigger metadata** -- Is the `description` field optimized for Claude Code's
   skill discovery? Does it encode trigger phrases, phase count, and negative scope?
   Would a user typing a natural request actually match this skill?
2. **Dispatch patterns** -- Do all `dispatch` steps use the correct
   `compose-prompt.sh` flags and `dispatch.sh` patterns? Are relay headings
   present in every header?
3. **Session ergonomics** -- Will this circuit feel natural when invoked via
   `/circuit:<name>`? Are interactive steps conversational? Are synthesis steps
   clear about what the orchestrator writes?
4. **Address REVISE findings** -- If the validation report says REVISE, fix every
   named issue in the drafts before installing.
5. **Cross-validate again** -- After any refinement edits, re-verify that
   `circuit.yaml` and `SKILL.md` still agree on topology.
5b. **Conciseness pass** -- Before installing, verify:
    - No setup/intake duplication (AP-21)
    - Dispatch recipe shown in full once only (AP-22)
    - No duplicate readback orders (AP-23)
    - No standalone verify lines (AP-24)
    - No circuit breaker echo lists (AP-25)
    - Canonical header schema is compressed, not templated
    - SKILL.md line count is proportional to corpus norms
6. **Install** -- Copy refined files to `${TARGET_CIRCUIT_ROOT}/circuit.yaml` and
   `${TARGET_CIRCUIT_ROOT}/SKILL.md`.

**Gate with reopen:** Read the validation verdict plus refinement results.

- `READY` after refinement -> install to `TARGET_CIRCUIT_ROOT` and recommend
  running `circuit:dry-run` against one concrete feature
- `REVISE` with issues the orchestrator cannot resolve -> present findings to
  the user and ask:
  1. Which artifact should reopen: `workflow-brief.md`, `circuit-analysis.md`, or the authored files?
  2. What specific issue should govern the reopen?

Append a `## Reopen Decision` section to `validation-report.md`, update the
chosen upstream artifact if needed, and resume from the selected step.

**Failure mode:** The compiler ships a circuit that looks corpus-shaped but still
contains hidden gaps, weak gates, or unusable adapter seams.

## Artifact Chain Summary

```text
workflow-brief.md                              [Step 1, interactive]
  -> circuit-analysis.md                       [Step 2, dispatch]
  -> draft-circuit.yaml + draft-SKILL.md       [Step 3, dispatch, staging]
  -> cross-validation.md                       [Step 3, dispatch]
  -> validation-report.md                      [Step 4, dispatch]
  -> circuit.yaml + SKILL.md                   [Step 5, Claude refinement, installed]
```

Draft files live in `${STAGING}/`. Final deliverables live in `${TARGET_CIRCUIT_ROOT}/`.
Compiler artifacts (`cross-validation.md`, `validation-report.md`) stay under
`${RUN_ROOT}/artifacts/` as the authoring audit trail.

## Resume Awareness

If work already exists, resume in this order:

1. Check `${RUN_ROOT}/artifacts/workflow-brief.md`
2. Check `${RUN_ROOT}/artifacts/circuit-analysis.md`
3. Check `${STAGING}/circuit.yaml`, `${STAGING}/SKILL.md`, and
   `${RUN_ROOT}/artifacts/cross-validation.md`
4. Check `${RUN_ROOT}/artifacts/validation-report.md`
5. Check `${TARGET_CIRCUIT_ROOT}/circuit.yaml` and `${TARGET_CIRCUIT_ROOT}/SKILL.md`

If `validation-report.md` exists with a `REVISE` verdict, read its
`## Reopen Decision` section and resume from the chosen step instead of blindly
rerunning validation.

If the final files exist in `TARGET_CIRCUIT_ROOT` but not in staging, the
refinement step already completed -- do not re-run.

This is best-effort. The durable state is the artifact set on disk, not the chat
thread.

## Circuit Breaker

Stop and recommend a different path when:

- the workflow is a simple prompt or a tiny conventional skill with no real
  multi-phase contract
- the request is to edit an existing circuit instead of authoring a new one
- the workflow needs arbitrary graph execution, hidden runtime ledgers, or
  pipeline orchestration that the live circuit schema does not model
- the workflow is really a runtime engine, installer, or adapter implementation
  task rather than a circuit authoring task
- the circuit family cannot honestly be expressed as artifact-centric or validator

Good alternatives:

- Hand-author a small non-circuit skill
- Use `skill-creator` for ordinary skill work that does not need circuit topology
- Use `circuit:dry-run` to validate an already-authored circuit
- Use `pipeline` or a design/architecture skill if the real need is orchestration

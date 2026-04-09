# Creating Custom Circuit Workflows

This guide walks through building your own circuit workflow from scratch. A
circuit is two files: `circuit.yaml` (the topology) and `SKILL.md` (the
execution contract). Together they define the steps, gates, artifacts, and
routing that the engine follows.

## Before You Start

Skim two existing circuits to build intuition:

- **Explore** (`skills/explore/`) -- 4 steps, checkpoint + dispatch + synthesis
- **Build** (`skills/build/`) -- 6 steps, the most complete example

Both follow the same shared phase spine. Your workflow will too.

## Anatomy of a Circuit

Every circuit lives in `skills/<id>/` and contains:

```
skills/my-workflow/
  circuit.yaml    # Machine-readable topology
  SKILL.md        # Prose execution contract (what Claude reads and follows)
```

The engine validates `circuit.yaml` against
`schemas/circuit-manifest.schema.json`. If validation fails, the circuit
won't run.

Non-circuit helpers are separate. `review` and `handoff` are public utilities.
`workers` is an internal adapter helper. None of them are examples of custom
circuits because they intentionally omit `circuit.yaml`.

## Step 1: Define the Topology (circuit.yaml)

### Minimal Example

A two-step circuit that researches a question and writes a report:

```yaml
schema_version: "2"
circuit:
  id: research
  version: "2026-04-07"
  purpose: >
    Research a topic and produce a structured report.

  entry:
    # Optional single placeholder suffix for commands that take a direct task:
    # usage: <task>
    signals:
      include: [research, literature_review, deep_dive]
      exclude: [bug, migration, cleanup]

  entry_modes:
    default:
      start_at: frame
      description: Standard research with evidence gathering.
    lite:
      start_at: frame
      description: Quick pass, no external probes.

  steps:
    - id: frame
      title: Frame
      executor: orchestrator
      kind: synthesis
      protocol: research-frame@v1
      reads: [user.task, repo.snapshot]
      writes:
        artifact:
          path: artifacts/brief.md
          schema: brief@v1
      gate:
        kind: schema_sections
        source: artifacts/brief.md
        required: [Objective, Scope, Success Criteria]
      routes:
        pass: investigate

    - id: investigate
      title: Investigate
      executor: worker
      kind: dispatch
      protocol: research-investigate@v1
      reads: [artifacts/brief.md]
      writes:
        artifact:
          path: artifacts/report.md
          schema: report@v1
        request: jobs/{step_id}-{attempt}.request.json
        receipt: jobs/{step_id}-{attempt}.receipt.json
        result: jobs/{step_id}-{attempt}.result.json
      budgets:
        max_attempts: 2
      gate:
        kind: result_verdict
        source: jobs/{step_id}-{attempt}.result.json
        pass: [analysis_ready]
      routes:
        pass: "@complete"
```

### Key Concepts

**Steps** run in order. Each step has:

| Field | Purpose |
|-------|---------|
| `id` | Lowercase, hyphenated. Referenced by routes. |
| `executor` | `orchestrator` (Claude runs it inline) or `worker` (dispatched to a separate agent/Codex session) |
| `kind` | `synthesis` (produce an artifact), `dispatch` (send to a worker), or `checkpoint` (pause for user input) |
| `protocol` | Versioned protocol name, e.g. `my-step@v1`. Required for dispatch and checkpoint steps. |
| `reads` | What the step needs as input. `user.task`, `repo.snapshot`, or artifact paths. |
| `writes` | What the step produces. Artifact paths, job files, checkpoint files. |
| `gate` | Validation that must pass before routing to the next step. |
| `routes` | Where to go after the gate passes or fails. |

**Gates** validate step output before the engine advances. Four kinds:

| Gate Kind | Validates | Example |
|-----------|-----------|---------|
| `schema_sections` | Required markdown headings exist in an artifact | `required: [Objective, Scope]` |
| `all_outputs_present` | Files exist on disk | `required_paths: [artifacts/report.md]` |
| `checkpoint_selection` | User picked an allowed option | `allow: [continue, revise]` |
| `result_verdict` | Worker returned an acceptable verdict | `pass: [clean, ship_ready]` |

**Routes** control flow after gates:

- Another step id: `pass: review`
- `@complete`: run finished successfully
- `@stop`: run stopped (e.g., gate failure with no recovery path)
- `@escalate`: surface to user
- `@handoff`: save state for next session

**Entry modes** define different rigor levels. Each mode specifies which step
to start at (usually `frame` for all modes, but you could skip steps for
lighter profiles).

**Signals** tell the router when to pick your workflow. The router reads the
user's task, extracts signals, and matches them against `include`/`exclude`
lists across all circuits.

### Reads Syntax

```yaml
# Simple list
reads: [user.task, repo.snapshot, artifacts/brief.md]

# Optional reads (step runs even if missing)
reads: [artifacts/brief.md, optional:artifacts/review.md]

# Alternative reads (one of these sets must exist)
reads:
  any_of:
    - [artifacts/plan.md]
    - [artifacts/decision.md]
```

### Writes Syntax

```yaml
# Single artifact
writes:
  artifact:
    path: artifacts/brief.md
    schema: brief@v1

# Multiple artifacts
writes:
  artifacts:
    - path: artifacts/plan.md
      schema: plan@v1
    - path: artifacts/decision.md
      schema: decision@v1

# Worker dispatch (kind: dispatch)
writes:
  artifact:
    path: artifacts/report.md
  request: jobs/{step_id}-{attempt}.request.json
  receipt: jobs/{step_id}-{attempt}.receipt.json
  result: jobs/{step_id}-{attempt}.result.json

# Checkpoint (kind: checkpoint)
writes:
  artifact:
    path: artifacts/brief.md
  request: checkpoints/{step_id}-{attempt}.request.json
  response: checkpoints/{step_id}-{attempt}.response.json
```

### Adding a Checkpoint

Checkpoints pause execution and ask the user a question. Use them for scope
confirmation, tradeoff decisions, or anywhere human judgment matters.

```yaml
- id: frame
  title: Frame
  executor: orchestrator
  kind: checkpoint
  protocol: my-frame@v1
  reads: [user.task]
  writes:
    artifact:
      path: artifacts/brief.md
      schema: brief@v1
    request: checkpoints/{step_id}-{attempt}.request.json
    response: checkpoints/{step_id}-{attempt}.response.json
  checkpoint:
    kind: scope_confirmation
    options: [continue, revise, stop]
    materialize_artifact: true   # write brief.md to disk before asking
  gate:
    kind: checkpoint_selection
    source: checkpoints/{step_id}-{attempt}.response.json
    allow: [continue]
  routes:
    continue: next-step
    revise: frame        # loop back
    stop: "@stop"
```

### Verdict Routing

Worker steps return a verdict. You can route on specific verdicts:

```yaml
gate:
  kind: result_verdict
  source: jobs/{step_id}-{attempt}.result.json
  pass: [clean, ship_ready]
  reroute:
    issues_found: fix    # route to a "fix" step instead of failing
routes:
  pass: close
  fail: "@escalate"
```

Available verdicts are defined in `schemas/circuit-manifest.schema.json` under
`$defs.verdict`. If you need a new verdict, add it there first.

## Step 2: Write the Execution Contract (SKILL.md)

`SKILL.md` is what Claude actually reads and follows during execution. The
engine handles step sequencing and gate validation, but the prose in SKILL.md
tells Claude *how* to produce each artifact.

### Structure

```markdown
---
name: research
description: >
  Research a topic and produce a structured report with evidence
  and recommendations.
trigger: >
  Use for /circuit:research, or when circuit:run routes here.
---

# Research

<One paragraph describing what this workflow does.>

## Phases

Frame -> Investigate -> Complete

## Entry

The router passes: task description and rigor profile.

**Direct invocation:** When invoked via `/circuit:research` (not through
the router), bootstrap the run root:

Derive `RUN_SLUG` from the task: lowercase, replace spaces and special
characters with hyphens, collapse consecutive hyphens, trim to 50 chars.

\```bash
RUN_SLUG="<derived>"
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
\```

Write initial `${RUN_ROOT}/artifacts/active-run.md`.

## Phase: Frame

Write `artifacts/brief.md`:

\```markdown
# Brief: <task>
## Objective
<what we're researching and why>
## Scope
<boundaries>
## Success Criteria
<what counts as done>
\```

Gate: brief.md must contain Objective, Scope, and Success Criteria.

Update active-run.md: Current Phase = investigate.

## Phase: Investigate

<Detailed instructions for how the worker should conduct research,
what to include in the report, how to structure findings.>

Gate: worker verdict must be `analysis_ready`.

Update active-run.md: Current Phase = complete.

## Circuit Breakers

<When and how to escalate instead of continuing.>
```

### Rules for Good SKILL.md Files

1. **Show the exact artifact format.** Claude follows examples more reliably
   than abstract instructions. Include the markdown template for every artifact.

2. **Match the topology.** If `circuit.yaml` says a gate requires sections
   `[Objective, Scope]`, SKILL.md must tell Claude to write those exact
   headings.

3. **Describe rigor differences inline.** For each phase, note what changes
   at each rigor level (e.g., "Lite: skip external research. Deep: add seam
   proof section").

4. **Include the bootstrap block.** Direct invocation needs `RUN_SLUG`
   derivation, directory creation, symlink, and initial `active-run.md`.

5. **Update active-run.md after every phase.** This is how resumability works.

## Step 3: Register and Test

### Place your files

```
skills/my-workflow/
  circuit.yaml
  SKILL.md
```

### Validate the manifest

```bash
cd scripts/runtime/engine && npx vitest run
```

The test suite validates all `circuit.yaml` files against the schema,
checks that SKILL.md names match directory names, and verifies catalog
consistency.

### Sync to the plugin cache

```bash
./scripts/sync-to-cache.sh
```

Then `/clear` in Claude Code to reload.

### Verify the install

```bash
./scripts/verify-install.sh
```

### Test it

```
/circuit:run <a task that matches your signals>
```

Or invoke directly:

```
/circuit:my-workflow <task>
```

## Reference

### Shared Phase Spine

Every workflow is a subset of this ordered spine. You can skip phases but
never reorder them.

| Phase | Purpose |
|-------|---------|
| Frame | Define the objective, scope, and success criteria |
| Analyze | Gather evidence, investigate the problem space |
| Plan | Design slices, sequence, verification strategy |
| Act | Execute the plan (often worker-dispatched) |
| Verify | Run verification commands, confirm results |
| Review | Independent fresh-context critique |
| Close | Summarize changes, write result.md |
| Pause | Save state for the next session (handoff) |

### Canonical Artifacts

Use these instead of inventing new names. The engine and other workflows
know how to read them.

| Artifact | Purpose |
|----------|---------|
| `active-run.md` | Dashboard: workflow, rigor, phase, goal |
| `brief.md` | Contract: objective, scope, success criteria |
| `analysis.md` | Evidence from investigation |
| `plan.md` | Slices, sequence, verification commands |
| `review.md` | Fresh-context audit verdict |
| `result.md` | Changes, verification, follow-ups |
| `decision.md` | ADR: decision, rationale, rejected alternatives |

### Executor Types

| Executor | When to Use |
|----------|-------------|
| `orchestrator` | Claude runs the step directly in the current session. Good for artifact writing, checkpoint presentation, closing summaries. |
| `worker` | Dispatched to a separate agent or Codex session. Good for implementation, review, research -- anything that benefits from isolation. |

### Route Targets

| Target | Meaning |
|--------|---------|
| `<step-id>` | Advance to that step |
| `@complete` | Run finished successfully |
| `@stop` | Run stopped (non-recoverable gate failure) |
| `@escalate` | Surface to user with context |
| `@handoff` | Save state, end session |

### Budgets

```yaml
budgets:
  max_attempts: 3          # retry the step up to 3 times
  timeout_seconds: 3600    # kill after 1 hour
```

## Drift Checklist

After any change, verify:

- [ ] `SKILL.md` and `circuit.yaml` agree on phases, gates, and artifacts
- [ ] Gate `required` arrays match the section headings described in SKILL.md
- [ ] `entry_modes` in circuit.yaml match the rigor profiles described in SKILL.md
- [ ] Run `cd scripts/runtime/engine && npx vitest run` -- all tests pass
- [ ] Run `./scripts/sync-to-cache.sh` and `/clear`
- [ ] Run `./scripts/verify-install.sh` -- installed-surface checks pass

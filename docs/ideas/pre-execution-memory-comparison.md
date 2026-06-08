# Circuit Today vs. Typed Pre-Execution Memory

Status: current-proposal. This is a source-backed comparison and product
direction. It is not current behavior.

Last checked: 2026-06-08.

## Summary

Circuit today is strongest after an operator has named a concrete work intent.
It turns that intent into a Flow, executes typed steps, records reports and
evidence, and makes the run auditable. That is already valuable. It gives agent
work shape, proof, and replayable context.

The proposed enhancement moves Circuit one layer earlier. It would capture the
project intent, invariants, non-goals, durable decisions, source map, staleness,
and authority limits that should guide many future Runs. Then each write-capable
Run would receive a typed preflight contract assembled from those records.

The difference is:

> Circuit today coordinates execution. Typed pre-execution memory would
> coordinate alignment before execution.

This should not become a prompt-template system. Circuit's advantage is not that
it can ask for more words before coding. Its advantage is that it can turn intent
into typed reports, checks, trace records, project memory, and future Run inputs.

## Recommendation

Build the first slice as a **Preflight Contract** for Build and Prototype.

The first slice should:

- read current project memory, prior-run history, and operator-supplied context;
- produce a typed preflight report before Act or implementation relays run;
- include goal, intended outcome, non-goals, invariants, allowed touch area,
  disallowed changes, proof plan, stop/ask conditions, source refs, staleness,
  and authority labels;
- feed that report into existing Frame, Plan, Act, Verify, Review, and Close
  steps;
- keep every recalled or inferred record hint-only unless a current check,
  operator decision, or flow contract gives it authority.

Do not start with a broad new "project brain." Start with one report that makes
write-capable work harder to misalign.

## Sources Checked

Current Circuit sources:

- [Ubiquitous language](../../UBIQUITOUS_LANGUAGE.md) for Flow, Schematic,
  Block, Stage, Step, Run, Checkpoint, Check, Trace, Report, Evidence, and Run
  folder.
- [Flow authoring model](../flows/authoring-model.md) for typed flow
  definitions, contract fit, routes, reports, evidence, and relay acceptance
  criteria.
- [Blocks](../flows/blocks.md) for Intake, Route, Frame, Clarify, Human
  Decision, Gather Context, Plan, Goal, Pursue, Risk/Rollback Check, Close With
  Evidence, and Handoff.
- [Run process](../architecture/run-process.md) for the current Run decision
  timeline, explicit flow selection, axis handling, config and history loading,
  and per-relay selection resolution.
- [History pull reference](../reference/history-pull.md) for the agent-invoked,
  cited, hint-only pull surface.
- [Project execution memory](project-execution-memory.md) for current project
  memory status and future automatic write-back gaps.
- [Typed coordination alignment proposal](typed-coordination-alignment-proposal.md)
  for the current product framing around flows as the operator handle and typed
  coordination as the system model.
- `src/schemas/memory-input.ts` for `MemoryInputV0`, `kind:"project"`,
  `authority:"hint_only"`, staleness, and source hash checks.
- `src/cli/memory.ts` for `circuit memory note|list|forget`, operator-filed
  project facts, flow validation, and local project fact storage.
- `src/memory/project-store.ts`, `src/memory/project-injection.ts`,
  `src/memory/project-distill.ts`, and `src/app/history/run-start-recall.ts`
  for the current project-fact store, run-start injection path, and pure
  deterministic distiller.

External framing source:

- [OpenSPDD design philosophy](https://github.com/gszhangwei/open-spdd/blob/main/docs/design-philosophy.md)
  for the control problem: agents need explicit intent, negative space, and
  shared decision artifacts when several reasonable designs exist.

## Today: What Circuit Already Does Well

### 1. It gives agent work a typed execution shape

Circuit's current vocabulary starts with the execution path: Flow, Schematic,
Block, Stage, Step, Run, Checkpoint, Trace, Report, Evidence, and Run folder.
That is a strong foundation. It means work is not just a chat transcript. A Run
has a selected flow, a graph, typed reports, and evidence.

The authoring model makes this concrete. A flow definition says which block
runs, what typed input it needs, what typed output it writes, which routes are
allowed, how the step executes, what selection policy applies, and what evidence
must exist before moving on. Later steps consume named facts, not whatever prose
a worker happened to produce.

This is the load-bearing difference between Circuit and a prompt bundle. Circuit
can validate, route, resume, and report because the flow state has types.

### 2. It has pre-execution-adjacent blocks, but mostly inside a Run

Circuit already has blocks that happen before code changes:

- **Intake** captures the goal and requested mode.
- **Route** chooses the flow.
- **Frame** defines the work boundary and proof needed.
- **Clarify** turns a rough request into a clearer task.
- **Human Decision** records an operator choice.
- **Gather Context** collects facts before deciding or acting.
- **Plan** chooses the implementation or investigation path.
- **Goal** turns a user objective into a bounded contract.
- **Pursue** turns a rough idea into an ownership contract.
- **Handoff** persists enough state to resume later.

These are not weak points. They are the natural anchors for pre-execution
memory. The gap is that most of these records are scoped to the current Run.
They make this run cleaner, but they do not yet form a durable project-level
alignment layer that many future runs can consume.

### 3. It records evidence after work happens

Circuit is already good at asking, "Did this run prove what it claimed?"

The system records trace entries, typed reports, check outcomes, relay results,
verification output, and close evidence. The authoring model also supports
relay acceptance criteria when a step has a narrow machine-checkable meaning of
done.

That matters because the agent cannot simply say "done" and move on when the
flow requires evidence. Circuit can make a bad result visible as a failed check,
an aborted step, a review finding, or a stopped run.

### 4. It has hint-only memory and project facts

Circuit's memory posture is intentionally cautious.

`history pull` lets an agent ask for cited prior-run context at a decision point.
The result is hint-only. It cannot satisfy proof, checkpoint, policy, route,
recovery, verification, or write authority. This is the right boundary. Memory
orients the agent; it does not overrule current evidence.

Project memory also has a real substrate. `MemoryInputV0` supports
`kind:"project"`, staleness, source refs, and `authority:"hint_only"`.
`circuit memory note|list|forget` exists for operator-filed project facts. The
project-execution-memory note says local project facts, identity, injection, and
the deterministic distiller exist, while automatic run-close write-back remains
future work.

That means the storage and authority posture are not imaginary. The missing
piece is not "create memory." It is "capture the right pre-execution records and
use them at the right time."

## Today: What Circuit Does Not Yet Cover

### 1. It does not maintain a durable project intent model

Today, a Flow can frame the current task. It does not yet maintain a durable
record of what the project or module is trying to become over months.

For example, Circuit can record that a Build run planned a feature and verified
it. It does not yet have a first-class record that says:

- this subsystem exists to optimize for auditability over speed;
- this product intentionally avoids OAuth for the MVP;
- this module must remain server-authoritative;
- this area is legacy and should not be copied;
- this previous design was rejected and should not be reintroduced.

Those facts may exist in docs, AGENTS.md, operator memory, or prior runs, but
Circuit does not yet make them a typed project-level alignment layer.

### 2. It does not make invariants first-class preflight inputs

Verification proves a current result. Invariants constrain the kind of result
the agent is allowed to produce.

Circuit has checks and acceptance criteria, but the current built-in work shape
does not consistently gather project invariants before write-capable execution.
That leaves room for technically correct but directionally wrong work:

- the test passes, but the feature introduces a forbidden dependency;
- the fix works, but it copies a legacy pattern the project is moving away from;
- the prototype runs, but it broadens scope beyond the operator's decision;
- the review checks the diff, but not the long-lived design decision the diff
  may violate.

### 3. It does not systematically capture negative space

OpenSPDD's useful term here is "negative space": what must not be done.

Circuit's current Frame and Clarify blocks can carry constraints and stop
conditions. But the system does not yet treat non-goals and disallowed changes
as a durable project memory type that is routinely recalled before action.

This matters because agent overreach often looks reasonable. Adding caching,
OAuth, retries, event publishing, or a new abstraction can be technically
defensible and still wrong for the project right now.

### 4. It does not close the loop from execution back to project intent

Circuit closes Runs with reports and evidence. Project memory has operator-filed
facts and partial distillation. But there is not yet a standard close-stage
question:

> Did this Run change project intent, invariants, non-goals, or durable
> decisions?

Without that loop, long-horizon context still depends on a human remembering to
update docs or file a memory note. That is better than nothing, but it is not a
full alignment ratchet.

## Proposed Future: Typed Pre-Execution Memory

Typed pre-execution memory would add two layers.

### Layer 1: Project-Level Records

These records survive across Runs. They are not one task's brief. They are
project memory.

Useful record types:

| Record | Purpose | Example |
| --- | --- | --- |
| Intent | Say what a project, feature, or module is trying to become. | "The checkout flow optimizes for correctness and auditability over checkout speed." |
| Invariant | State a rule that must remain true. | "Refunds are idempotent and must be safe to retry." |
| Non-goal | State what the project is not doing. | "Do not add OAuth to the MVP registration path." |
| Decision | Record a chosen tradeoff and rejected alternatives. | "Use synchronous registration for v1; async email is deferred." |
| Source map | Name authoritative files, docs, tests, issues, or external references. | "Billing invariants live in docs/billing.md and tests/billing/*." |
| Legacy marker | Separate deliberate patterns from historical compromises. | "Field injection remains in legacy services but is not the current standard." |
| Revisit trigger | Name when a decision should be reopened. | "Revisit single-currency support when EU launch begins." |

Every record should carry:

- source refs;
- captured time;
- staleness status;
- authority label;
- affected flow or subsystem;
- confidence;
- current proof or verification pointer when available.

### Layer 2: Run-Level Preflight Contracts

Before Build or Prototype starts write-capable work, Circuit should assemble a
preflight contract for this Run.

The contract should include:

- task goal;
- intended outcome;
- relevant project intent;
- invariants to preserve;
- non-goals and disallowed changes;
- allowed touch area;
- source refs and source confidence;
- proof plan;
- stop/ask conditions;
- stale or conflicting context warnings;
- current authority labels for every recalled fact.

This report becomes an input to Plan, Act, Verify, Review, and Close. The worker
does not have to reverse-engineer the design boundary from scattered prose.

## Authority Model

The most important design rule is that memory must not silently become
authority.

A simple authority ladder:

| Authority | Meaning | Can it control execution? |
| --- | --- | --- |
| `inferred` | Agent inferred this from code or history. | No. It may ask for confirmation. |
| `historical_hint` | Prior-run or project memory says this may matter. | No. It orients only. |
| `operator_declared` | The operator explicitly recorded it. | It may guide execution, but current proof still wins. |
| `documented_decision` | A source-of-truth doc or decision record says it. | It may constrain execution if the source is fresh. |
| `proved_by_check` | A current deterministic check proves it. | Yes, within the check's scope. |
| `flow_contract` | The current flow contract requires it. | Yes, within the flow's declared routes and checks. |

The exact labels can change. The rule should not: old memory cannot satisfy
current proof, route, recovery, checkpoint, verification, or write authority by
itself.

## Side-By-Side Comparison

| Dimension | Circuit today | Circuit with typed pre-execution memory |
| --- | --- | --- |
| Primary time horizon | One Run, plus bounded history recall. | Many Runs over a long-lived project, with each Run receiving a fresh contract. |
| Starting point | Operator provides a coding intent and flow. | Operator intent is checked against project intent, invariants, non-goals, decisions, and source maps. |
| Main artifact | Run folder with trace, reports, evidence, and close result. | Run folder plus project-level records and a per-run preflight contract. |
| Memory posture | Hint-only prior-run and project facts. | Still hint-only by default, but richer, typed, and assembled before risky work. |
| Alignment check | Did this Run satisfy the brief and proof plan? | Does this Run satisfy the brief and preserve the project's long-lived constraints? |
| Negative space | Can appear in current brief or operator instructions. | First-class field: non-goals, disallowed changes, and stop/ask conditions. |
| Decisions | Explore can produce decision-style reports; history can recall prior runs. | Durable decision records with alternatives, rationale, reversibility, and revisit triggers. |
| Invariants | Mostly expressed through tests, docs, or ad hoc instructions. | Typed records that can feed preflight, review, and acceptance checks. |
| Human role | Operator chooses goals, checkpoints, and reviews evidence. | Operator also curates durable intent and resolves stale or conflicting context. |
| Agent role | Execute the selected flow and produce evidence. | Execute the selected flow inside an explicit alignment boundary. |
| Failure mode reduced | False completion and weak proof. | False completion plus directionally wrong implementation. |
| New risk | Complexity tax if flows feel heavy. | Bigger complexity tax if every task requires preflight ceremony. |

## What Changes In The Product Story

Today's strongest story:

> Circuit gives coding agents repeatable work patterns with typed reports,
> evidence, checks, and trace.

Enhanced story:

> Circuit keeps humans and agents aligned across long-horizon software work by
> turning intent into executable, checkable, and remembered project context.

That is not a replacement. It is a broadening:

- flows remain the operator handle;
- typed coordination remains the system model;
- preflight memory becomes the bridge from long-lived project context to each
  concrete Run.

## What To Build First

### Slice 1: Preflight Contract for Build and Prototype

Add a typed report, not a new runtime authority path.

Candidate schema fields:

```json
{
  "schema": "preflight.contract@v1",
  "goal": "...",
  "intended_outcome": "...",
  "project_intent": [
    {
      "summary": "...",
      "authority": "operator_declared",
      "source_refs": ["..."],
      "staleness": "fresh"
    }
  ],
  "invariants": [
    {
      "statement": "...",
      "proof": "...",
      "authority": "documented_decision",
      "source_refs": ["..."]
    }
  ],
  "non_goals": ["..."],
  "allowed_touch_area": ["..."],
  "disallowed_changes": ["..."],
  "proof_plan": ["..."],
  "stop_or_ask_conditions": ["..."],
  "warnings": ["..."]
}
```

The first implementation should produce this from:

- current task intake;
- existing Frame/Clarify output;
- project memory facts;
- history pull or run-start recall when relevant;
- operator-supplied notes;
- explicit source refs the agent gathered before writing.

### Slice 2: Review Against Preflight

Review should check the change against the preflight contract, not only the
local brief and verification result.

This adds a simple reviewer question:

> Did the change preserve every invariant, respect non-goals, stay within the
> allowed touch area, and satisfy the proof plan?

This is likely higher leverage than trying to make Act smarter first. Review is
where directional drift becomes visible.

### Slice 3: Close-Stage Memory Proposal

At Close, ask whether this Run changed durable project context.

Possible outputs:

- no update;
- proposed new invariant;
- proposed decision record;
- proposed non-goal;
- proposed source-map update;
- stale context warning.

For v1, this should be propose-first unless the operator directly filed the
fact. Automatic recording should wait for deterministic evidence or measured
precision.

## What Not To Build First

Do not start with:

- a universal project-memory UI;
- model-selected authority upgrades;
- automatic rewrite of AGENTS.md or docs;
- cross-project memory;
- dynamic flow generation from inferred project intent;
- a mandatory preflight process for tiny fixes;
- hidden routing based on remembered context.

Those are tempting, but they would make the first slice harder to trust.

## Risks And Controls

| Risk | Why it matters | Control |
| --- | --- | --- |
| Ceremony tax | If every task requires a large preflight, users will bypass it. | Enable it first for deep Build and Prototype, or only when the task touches high-risk areas. |
| Memory becoming hidden authority | Old context can be stale or wrong. | Keep authority labels visible and require current proof for current claims. |
| Stale design records | A wrong invariant can be worse than no invariant. | Re-hash source refs, show staleness, and make conflicts explicit. |
| False precision | Inferred intent can sound more certain than it is. | Use confidence labels and separate inferred from declared. |
| Scope creep | Pre-execution work can turn into project management. | Keep the first product surface to preflight contracts and close-stage proposals. |
| Duplicate specs | Existing docs, AGENTS.md, and specs may already hold intent. | Treat Circuit records as typed indexes and run inputs, not replacements for readable docs. |

## Claim Inventory

| ID | Claim | Status | Evidence |
| --- | --- | --- | --- |
| C01 | Circuit today gives agent work a repeatable flow/stage/step structure. | current behavior | `UBIQUITOUS_LANGUAGE.md`; `docs/flows/authoring-model.md`; `docs/flows/blocks.md`. |
| C02 | Flow definitions are typed enough to name inputs, outputs, routes, execution, selection, and evidence. | current behavior | `docs/flows/authoring-model.md`, especially the Short Version and Schematic Step Model. |
| C03 | Circuit has several pre-execution-adjacent blocks today. | current behavior | `docs/flows/blocks.md` lists Intake, Route, Frame, Clarify, Human Decision, Gather Context, Plan, Goal, Pursue, and Handoff. |
| C04 | Run begins from an explicit flow and goal, then loads config, policy, optional history, and runtime graph state. | current behavior | `docs/architecture/run-process.md`. |
| C05 | History pull is cited and hint-only, with no proof, checkpoint, policy, route, recovery, verification, or write authority. | current behavior | `docs/reference/history-pull.md`; `src/schemas/memory-input.ts`. |
| C06 | Project memory exists but is still bounded. | current behavior | `docs/ideas/project-execution-memory.md`; `src/cli/memory.ts`; `src/memory/project-store.ts`; `src/memory/project-injection.ts`; `src/memory/project-distill.ts`; `src/app/history/run-start-recall.ts`; `src/schemas/memory-input.ts`. |
| C07 | Automatic run-close write-back remains future work. | current behavior | `docs/ideas/project-execution-memory.md` status line and population section; `src/memory/project-distill.ts` exports a pure distiller and `rg "distillProjectFacts\\(" src tests` shows only tests call it today. |
| C08 | Circuit does not yet maintain a durable first-class project intent and invariant model for all future Runs. | supported gap | No current block or memory source checked exposes typed records for project intent, invariants, non-goals, durable decisions, source maps, and revisit triggers as a coherent preflight input. |
| C09 | Typed pre-execution memory fits Circuit better than freeform prompt templates. | product inference | The authoring model already centers typed reports, evidence, routes, checks, and contracts; `typed-coordination-alignment-proposal.md` frames Circuit as typed coordination beneath flow handles. |
| C10 | A Preflight Contract is the smallest credible first slice. | recommendation | It reuses Frame, Gather Context, project memory, history pull, and review without adding hidden authority or a new broad runtime system. |
| C11 | OpenSPDD-like negative-space capture is relevant but should be translated into Circuit's typed report/check/memory model. | external comparison | OpenSPDD design philosophy argues that design intent, safeguards, and shared artifacts reduce agent drift; Circuit's differentiator is typed execution and evidence. |
| C12 | The largest product risk is complexity tax. | risk judgment | Current Circuit docs emphasize flow simplicity and first-mile clarity; mandatory broad preflight would add ceremony before the user sees value. |

## Open Questions

1. Should preflight be a new reusable block, a report produced by Frame, or a
   flow-specific report in Build and Prototype first?
2. Which authority labels are worth standardizing in schemas, and which should
   remain report-local until proven?
3. Should invariants be stored as project memory facts, exported spec packets, or
   both?
4. How should Circuit detect that a completed Run changed durable context without
   asking the operator after every tiny task?
5. Which flows should consume preflight first: Build and Prototype only, or Fix
   deep mode as well?
6. What is the lowest-friction way to show stale or conflicting preflight context
   in the host output?

## Bottom Line

Circuit today is already a typed execution system. It helps an agent do a task
with process, evidence, and trace.

The proposed enhancement would make Circuit a typed alignment system too. It
would help humans and agents preserve what the project means, what must stay
true, and what must not be accidentally re-decided.

That future is credible because it builds on existing Circuit strengths:

- typed reports;
- evidence;
- route discipline;
- hint-only memory;
- project facts;
- checkpoints;
- review;
- close reports.

The first move should be narrow: a Preflight Contract for Build and Prototype.
Make one write-capable path noticeably more aligned before trying to model the
whole project.

---
name: pursue-flow
description: Narrative guide to the Pursue flow and its Pursue and Coordinate Pursuits blocks.
type: flow-guide
date: 2026-05-16
status: active
---

# Pursue Flow

Pursue is the flow for broad operator goals that contain more than one
possible line of work, or that need Circuit to take ownership of the
next steps without constant check-ins.

Use Pursue when the operator intent sounds like:

- "pursue these ideas";
- "coordinate several goals";
- "handle these tracks without collisions";
- "take this rough idea and drive it until it is done or honestly blocked."

Pursue is not a free-for-all autonomous mode. It is a flow with explicit
contracts, coordination, verification, review, and close evidence. The
current version deliberately serializes code-changing work. Read-only
discovery can be identified as parallel-safe in the coordination reports,
but Pursue V1 does not run a separate parallel discovery fanout. Code
writes stay serial until Circuit has a runtime-owned safe apply path.

## What Pursue Adds

Pursue adds two reusable blocks to the flow model:

| Block | Job | Report |
| --- | --- | --- |
| `pursue` | Turn the operator goal into one or more pursuit contracts with scope, estimated touch sets, proof plans, and check-in triggers. | `pursuit.contract@v1` |
| `coordinate-pursuits` | Compare the pursuits, identify dependencies or conflicts, and decide which work must serialize versus which read-only discovery can be treated as parallel-safe. | `pursuit.graph@v1` |

These blocks sit before the familiar Plan, Batch, Run Verification,
Review, and Close With Evidence blocks. The result is a flow that can
take a rough goal, split it into owned pursuits, coordinate them, execute
them safely, and close with evidence.

## Current Safety Model

Pursue V1 has one hard rule:

> Code-changing work is serial-only.

The flow may recognize that two pursuits appear to compose safely. It
may also record that read-only discovery for those pursuits is
parallel-safe. It still does not run parallel code-writing workers, and
it does not yet have a separate read-only discovery fanout step.

That rule is represented in three places:

- the contract's execution policy requires `code_writes:
  "serial-only"`;
- the wave plan rejects code-change waves unless `execution` is
  `serial`;
- the implementer relay is instructed to block rather than guess if a
  pursuit would require parallel writes.

This is intentional. Estimated touch sets are useful, but they are not
proof. Formatters, generated files, lockfiles, test snapshots, and shared
APIs can still cause hidden overlap. A future safe-apply path can relax
this policy, but the current flow optimizes for trustworthy completion
over maximum parallelism.

## Flow Shape

Pursue runs through six stages.

### Frame: Create Pursuit Contract

The `pursue` block reads the operator goal and route decision, then
writes `reports/pursuit/contract.json`.

The contract contains:

- the overall objective;
- one or more pursuit items;
- each pursuit's scope and assumptions;
- estimated touch sets for paths, symbols, commands, and generated
  outputs;
- proof plans;
- check-in triggers;
- rollback notes;
- risk labels;
- discovered verification command candidates.

This is the ownership contract. It tells the worker what it may own, how
the work should be proved, and when Circuit should stop or check in
instead of continuing. In V1, these check-in triggers are relayed as
worker instructions; they are not a separate checkpoint step.

### Coordinate: Build Pursuit Graph

The `coordinate-pursuits` block reads the contract and writes
`reports/pursuit/graph.json`.

The graph contains:

- one node per pursuit;
- dependency, conflict, or composition edges between pursuits;
- serial groups for code-changing work;
- parallel read-only groups;
- blocked pursuits, if any.

If estimated touch sets overlap, the graph marks a conflict. If they do
not overlap, the graph marks that the pursuits compose, but it still
keeps code writes serialized in V1.

### Plan: Order Execution Waves

The Plan step reads the contract and graph, then writes
`reports/pursuit/wave-plan.json`.

The wave plan makes the coordination executable:

- a read-only discovery wave records what can safely be discovered in
  parallel once Pursue grows a discovery fanout;
- code-change waves are serial;
- each code-change wave regrounds after it runs;
- the report states why parallel writes are not allowed yet.

This step turns the graph into the order the implementer should follow.
For V1, the only actual worker relay is the serialized batch step.

### Execute: Run Serialized Pursuit Batch

The Batch step relays to an implementer and writes
`reports/pursuit/batch.json`.

The batch report contains:

- completed pursuits;
- skipped pursuits;
- blocked pursuits;
- failed pursuits;
- the actual touch set;
- proof evidence;
- `serialized_execution: true`.

The actual touch set is important. The contract records what Circuit
expected to touch. The batch records what was really changed or
materially inspected.

### Verify: Run Pursue Proof Commands

The verification step reads the proof plan, pursuit contract, and batch
result, then writes `reports/pursuit/verification.json`.

Verification uses project-discovered commands rather than assuming that a
fixed script exists. The verification report records the command list,
exit status, bounded output, and overall status.

### Review: Check Pursuit Coordination

The Review step relays to a reviewer and writes
`reports/pursuit/review.json`.

The reviewer checks whether the batch:

- followed the pursuit contract;
- kept code-changing work serialized;
- preserved the difference between estimated and actual touch sets;
- surfaced skipped or blocked pursuits honestly;
- proved the work adequately.

The review verdict can be:

- `clean`;
- `needs-followup`;
- `blocked`.

Medium, high, or critical findings require `blocked`, which routes the
flow back before close instead of quietly finishing.

### Close: Summarize Pursuit Result

The Close With Evidence step reads all Pursue reports and writes
`reports/pursuit-result.json`.

The result includes:

- summary;
- outcome;
- verification status;
- review verdict;
- counts for completed, skipped, blocked, and failed pursuits;
- `serial_code_writes: true`;
- links to the six Pursue reports.

Pursue can close as:

- `complete`;
- `needs_attention`;
- `blocked`;
- `failed`.

A `complete` outcome requires passed verification, a clean review, and
no skipped, blocked, or failed pursuits.

## Axis Support

Pursue supports medium-depth interactive runs and autonomous runs:

| Axis selection | Runtime depth | Meaning |
| --- | --- | --- |
| `default` | `medium` | Normal Pursue behavior. |
| `autonomous` | `autonomous` | Same serial-write safety policy, with autonomous depth. |

Autonomous depth does not permit parallel code writes. It changes the
depth carried into the run; it does not add parallel apply, remove the
safety contract, or create a separate checkpoint step.

## When To Use Pursue

Use Pursue when the operator gives Circuit a bundle of ideas or a broad
goal and expects Circuit to make a responsible plan of attack.

Good fits:

- several related code changes that need ordering;
- a rough feature idea with unclear sub-pursuits;
- cleanup work that might split into multiple tracks;
- work where check-in triggers should be explicit in the worker
  contract.

Poor fits:

- one narrow bug with a clear failure mode: use Fix;
- one well-scoped implementation request: use Build;
- read-only investigation: use Explore or Review, depending on whether a
  verdict is needed;
- broad conversion or cleanup work over many known items: use Pursue when the
  operator needs ordering, risk tracking, and explicit check-in triggers.

## How Pursue Differs From Build

Build assumes there is one main change to implement. Pursue assumes the
operator may have handed Circuit several possible changes, or one idea
that needs to be split into owned pursuits first.

Pursue does more coordination before acting:

- it names the pursuits;
- it estimates touch sets;
- it identifies conflicts and composition;
- it records check-in triggers;
- it closes with per-pursuit counts.

If the goal is already a single well-bounded implementation, Build is
usually the cleaner flow. If the goal needs ownership and coordination,
Pursue is the better fit.

## Future Parallel Apply

Pursue's current serial-write policy is not the final product ambition.
The likely next step is isolated parallel execution:

1. run safe candidate pursuits in separate worktrees or sandboxes;
2. collect patches, changed-file manifests, logs, and proof;
3. reject overlaps or conflicts;
4. apply only accepted patches and evidence-backed changes to the parent
   checkout;
5. run final verification on the composed result.

That future belongs behind a runtime-owned safe apply path. Until then,
Pursue should not ask parallel agents to share one worktree or trust the
coordinator's prediction as proof.

See [docs/ideas/sandboxed-parallel-pursuits.md](../ideas/sandboxed-parallel-pursuits.md)
for the design sketch.

## Source Of Truth

Product shape above. Current executable truth lives in:

- `src/flows/pursue/data.ts`;
- `src/flows/pursue/flow.ts`;
- `src/flows/pursue/reports.ts`;
- `src/flows/pursue/writers/`;
- `src/flows/pursue/relay-hints.ts`;
- generated outputs listed in
  [docs/generated-surfaces.md](../generated-surfaces.md).

Use [docs/flows/authoring-model.md](authoring-model.md#adding-a-flow) for the
flow-authoring playbook. Regenerate generated surfaces after source changes with
`npm run emit-flows`.

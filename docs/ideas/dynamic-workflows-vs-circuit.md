# Circuit and host dynamic workflows

Status: current idea / comparison note. Not a plan, not current behavior.
Date: 2026-06-02

Captured from a conversation that started with "would it be desirable and
feasible for Circuit to support fully dynamic workflows like Claude Code's?"
The host feature in question is the Claude Code Workflow tool: a JavaScript
script that orchestrates subagents at runtime with real control flow (fanout,
loops, data-dependent branching, budget-scaled fleets).

This note exists to answer that specific comparison and to map the execution
paths. It deliberately does **not** re-derive the in-engine dynamic-planner
design, which already has a home.

Related, read first:
- [`dynamic-flow-ratchet.md`](./dynamic-flow-ratchet.md) owns the in-engine
  story: a runtime planner (`circuit:smart`, which the ratchet note shows is
  just an ordinary relay), heterogeneous fanout, a new
  `loop`/`react` execution kind, the closed-alphabet constraint, and the
  three-stage ratchet. That is the canonical treatment of "Circuit composes
  flows at runtime." This note treats it as the source for Path C below.
- [`sandboxed-parallel-pursuits.md`](./sandboxed-parallel-pursuits.md) owns the
  parallel code-change safety boundary (worktrees, change packets, safe apply).
- [`circuit-vs-compound-engineering.md`](./circuit-vs-compound-engineering.md)
  and [`opencode-as-host.md`](./opencode-as-host.md) own the multi-host framing.

The net-new contribution here is the comparison to the host Workflow tool and
the analysis of **compiling a flow down to that tool as an execution backend**
(Path A), including the dual-host consequence, which the notes above do not
cover.

## The one distinction everything follows from

The two systems sit at opposite ends of one spectrum.

**Circuit is an ahead-of-time process compiler that the host executes.** A flow
is a typed `FlowData` value compiled into a static schematic of blocks and
routes. At run time the engine loads the compiled fixture and hands an
executable graph to the runtime
(`src/runtime/run/compiled-flow-runner.ts:59`,
`docs/architecture/run-process.md` "Short Version"). The graph runner walks the
steps and advances strictly by looking up the current step's declared routes
(`src/runtime/run/graph-runner.ts:486`, and the route lookup at
`graph-runner.ts:703`). An undeclared route aborts the run
(`graph-runner.ts:704-713`). The control flow exists before the run starts.
Circuit does not do the coding work itself; each relay step delegates to a host
worker connector (`src/connectors/resolver.ts:173-174` resolves `codex` or
`claude-code`), and the host adapter only renders progress
(`docs/contracts/host-capabilities.md`, "Worker Connector Status"). Circuit is a
compiler plus an evidence recorder.

**The host Workflow tool is a runtime orchestrator.** The control flow is
JavaScript that runs as the work happens. The realized shape (how many agents,
how many loop iterations) is computed live from the data. You can read the
script, but you cannot know the executed graph until after it runs.

Every tradeoff is downstream of this. Circuit buys legibility-before-run,
uniform trace and evidence, structural bounds, and a single flow that runs on
both hosts. The Workflow tool buys runtime adaptivity and expressiveness that a
static schematic cannot state. Neither is strictly better; they optimize
opposite things.

## What Circuit already does dynamically (verified current state)

Circuit is not at zero dynamism. The accurate picture, checked against source:

- **Data-driven fanout.** A fanout step can read a prior report, extract an
  array, and expand one branch per item from a template
  (`src/runtime/fanout/branch-expansion.ts:36`, dynamic path at
  `branch-expansion.ts:47-52` and `:74-81`). The Explore tournament uses this
  (`src/flows/explore/schematic.json:223` and the `dynamic` branches at
  `:252`).
- **Real parallelism with isolation already exists.** The fanout executor
  supports bounded or unbounded concurrency
  (`src/runtime/executors/fanout.ts:64-68`, `runWithConcurrency` at
  `fanout.ts:137-163`), and sub-run branches get their own git worktrees so
  they can run in parallel safely (`fanout.ts:210` and `:241-249`). Writable
  relay branches are serialized on purpose because they share the parent
  checkout and have no branch-local write root (`fanout.ts:62`). So the limit
  on parallel code-change work is a safety boundary, not a missing feature
  (see [`sandboxed-parallel-pursuits.md`](./sandboxed-parallel-pursuits.md)).
- **Sub-run.** A step can invoke a child flow and admit its verdict back through
  the child result (`src/runtime/executors/sub-run.ts:3`, resolver and runner
  required at `sub-run.ts:116` and `:123`).
- **Bounded iteration.** Recovery routes can return to an earlier step, capped
  by `max_attempts` with explicit exhaustion and cycle aborts
  (`graph-runner.ts:771-781` and `:790-802`). Pursue runs a serialized batch
  with a retry route (`src/flows/pursue/schematic.json:138-140` and `:161`).
  Autonomous mode drives a bounded continuation loop that, by its own
  description, never completes by exhaustion
  (`src/cli/circuit.ts:168`, driven at `circuit.ts:1138-1144`).
- **Axis-tuned selection.** Rigor and the `bindsExecutionDepthToRelaySelection`
  flag feed per-relay model and effort selection, not graph shape
  (`src/shared/relay-selection.ts:27`, declared at `src/flows/types.ts:131`,
  set by Build and Prototype at `src/flows/build/data.ts:438` and
  `src/flows/prototype/data.ts:758`).

The honest gap is narrow and specific. Two different limits are worth keeping
apart, because they get blurred easily: the branch *count* is capped low (gap 1
below), and *writable* branches are additionally serialized for safety (the
worktree point above). Neither is a missing-concurrency problem.

1. **The fanout count is hard-capped and the cap is small.** Dynamic fanout
   throws if the discovered item count exceeds `max_branches`
   (`branch-expansion.ts:66-70`), and the tournaments that ship bind that cap
   to the `tournament_n` axis, whose range is 2 to 4 (`src/schemas/axes.ts:5`,
   bound into the tournament at `explore/schematic.json:265-271`). So Circuit
   cannot today open a fanout
   over the actual 23 changed files in a review, even though that review work is
   read-only and the concurrency machinery already exists. The blocker is the
   authored cap, not parallelism.
2. **Fanout and loop points are hard-wired per schematic.** Only specific
   flows declare them. There is no general primitive an author drops into any
   flow.
3. **There is no general loop-until block.** Iteration is recovery routes and
   the autonomous continuation loop, both bounded and special-purpose. There is
   no authorable "repeat this sub-sequence until a check passes or a budget is
   spent, up to N." (`dynamic-flow-ratchet.md` proposes this as a new `loop`
   execution kind.)

## The three paths to more adaptivity

These are not three independent menu choices. Path C is the spine, Path A is an
optional backend for Path C on the Claude host, and Path B is the maximalist
alternative this note ends up rejecting. They are laid out separately because
they involve different work and different risk, not because you pick one.

### Path A: compile a flow down to the host Workflow tool (net-new analysis)

Circuit already compiles flows to host surfaces (see
[`docs/generated-surfaces.md`](../generated-surfaces.md): generated schematic
JSON, compiled manifests, host command and skill mirrors). The same machine
could emit a Workflow script as one more generated surface for the Claude host.
The schematic stays the legible source of truth; the script is a build artifact
like `circuit.json`. The Claude host runs the script through its Workflow tool,
which gives real runtime parallelism and loop-until without the engine having to
implement either.

This sits on the execution axis, not the rendering axis, and that distinction
matters. The host-capability contract's slots (`progress`, `task_list`,
`ask_user`, and so on) govern how a host renders or mediates a run, and the
contract deliberately keeps the host adapter separate from the worker connector
that executes relayed steps
([`docs/contracts/host-capabilities.md`](../contracts/host-capabilities.md),
"Worker Connector Status"). Path A is about the worker and execution side, so it
would add a new selector there rather than reuse an existing slot. What it can
borrow is the contract's level vocabulary (`native`, `model-mediated`,
`fallback`): a Workflow-backed flow would be `native` on Claude and fall back to
the engine's bounded execution on Codex. Spelling that out as a declared level
is what keeps it an inspectable degradation rather than a silent parity break.
This is a contract extension, not a free reuse, and the note should be honest
about that.

Why this is attractive:
- Cheapest route to true runtime adaptivity, because Anthropic maintains the
  orchestration runtime, not us.
- Keeps the declarative schematic as the contract and audit artifact.
- Reuses the surface-generation pipeline that already exists.

Why it is not free:
- **Claude-only.** Codex has no equivalent orchestration primitive, so the
  dynamic behavior degrades there. Acceptable only if the flow is honest about
  degrading.
- **Trace bridging is real work.** The Workflow tool owns its own progress and
  agent accounting. Circuit's value is the uniform run folder, trace, and typed
  reports. Bridging the script's execution back into Circuit's evidence model
  (so a Workflow-backed run is as auditable and replayable as a graph-runner
  run) is the hard part, not the code generation.
- **Resume and checkpoint semantics differ** between the two execution models
  and would need reconciliation.

### Path B: build a host-agnostic orchestration runtime in the engine

Add async orchestration to the engine so flows can express arbitrary control
flow on both hosts. By Path B this note means the unbounded, arbitrary-control
version; the bounded version of the same idea is Path C, not Path B. This is the
most powerful and the most expensive option. It
reinvents the hard half of the Workflow tool (spawn, join, budget, cancel,
resume) and is a permanent maintenance load for a small team. It is also the
biggest risk to the legibility thesis if it admits open-ended control flow.

Note one nuance: the engine already has the parallel bones (the fanout executor
with worktree isolation above). A *bounded* version of this is therefore cheap.
The expensive and risky part is specifically the *arbitrary, unbounded* version.
That distinction points straight at Path C.

### Path C: extend bounded dynamism inside the declarative model

This is the in-engine direction, and it already has a design home in
[`dynamic-flow-ratchet.md`](./dynamic-flow-ratchet.md): heterogeneous fanout
(each plan item carries its own schema, role, and kind) plus a new bounded
`loop`/`react` execution kind with a max-iteration cap and a loop-state
contract. Two additions this note contributes on top of that design:

- **Lift the cap source without removing the cap.** Let `max_branches` read a
  discovered count clamped to a ceiling (`min(discovered, ceiling)`) instead of
  throwing above a small axis (`branch-expansion.ts:66-70`). That is what
  unlocks "review the actual N changed files" while keeping a hard bound.
- **No silent truncation.** If a discovered work-list exceeds the ceiling,
  record "covered N of M" as evidence rather than silently dropping the tail. A
  capped run that reads as complete is a worse failure than an honest partial.

Path C keeps every Circuit property: legible before the run, uniform trace and
evidence, structural bounds, and dual-host. It is mostly a generalization of
code that exists, not new infrastructure.

## The crux: dual-host parity

This is what actually separates the paths, and it is easy to miss.

Path C is host-agnostic. The same bounded-dynamic flow runs on Claude and Codex
through the same engine, because the dynamism lives in the engine's executor,
not in a host primitive.

Path A is host-specific by construction. It buys real runtime power on Claude by
borrowing a Claude-only tool, and degrades on Codex. That is a legitimate trade
as long as it is declared through the host-capability levels and the flow stays
correct (if reduced) on the fallback host.

The two compose. A bounded-dynamic flow authored under Path C can compile to a
Workflow script on Claude (Path A) for genuine parallelism, and fall back to the
engine's bounded execution on Codex. Path C is the contract; Path A is an
optional accelerated backend.

## Recommendation

- **Reject "fully dynamic" as arbitrary, author-written orchestration** (the
  unbounded form of Path B). It dissolves the legibility-plus-bounds thesis that
  is Circuit's whole reason to exist, takes on a permanent
  unbounded-orchestration maintenance load, and ships a weaker copy of a
  first-party host feature. It also breaks dual-host parity, but that is not the
  decisive objection: Path A breaks strict parity too and is kept, because it
  degrades through a declared fallback. The decisive objections are legibility
  and maintenance.
- **Make Path C the spine.** Pursue the bounded `loop` kind and the lifted,
  honest fanout cap from `dynamic-flow-ratchet.md` plus this note. It would
  deliver most of the practical value (scale to the work, loop-until, parallel
  synthesis) while preserving what makes Circuit defensible.
- **Hold Path A as an optional Claude-only backend.** Reach for it only once the
  trace-bridging work is worth real parallelism on big jobs, and only behind a
  declared host-capability level with a correct Codex fallback.

The product framing that follows from this: Circuit's flexibility is *bounded
dynamism*, work that scales to the job inside an envelope you can see before you
run it. That is a stronger and more honest claim than "it can do anything,"
precisely because arbitrary scripts cannot promise the envelope.

## Open questions

- What is the right ceiling source for a lifted fanout cap: a per-flow config
  value, a global policy cap, or an axis with a wider range than `tournament_n`?
- For Path A, what is the minimum trace bridge that makes a Workflow-backed run
  as auditable as a graph-runner run? Can the script emit Circuit trace events
  and typed reports into the run folder as it goes?
- Does the bounded `loop` kind from `dynamic-flow-ratchet.md` subsume Pursue's
  serialized batch and the autonomous continuation loop, or do they stay
  separate mechanisms?
- How does a Workflow-backed Claude run reconcile resume and checkpoint with the
  engine's existing checkpoint semantics?

## What to re-verify before acting

File and line references were checked against the repo on 2026-06-02 and will
drift. Re-verify against `src/runtime/run/graph-runner.ts`,
`src/runtime/fanout/`, `src/runtime/executors/`,
`src/runtime/run/compiled-flow-runner.ts`, `src/flows/explore/schematic.json`,
`docs/contracts/host-capabilities.md`, and `docs/architecture/run-process.md`
before building. Treat `dynamic-flow-ratchet.md` as the canonical in-engine
design and this note as the host-comparison and execution-backend companion.

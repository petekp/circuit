# Learning from jj: process lineage for Circuit

What Circuit can steal from jujutsu's operation log and evolog without trying to
become a version-control tool. Grounded in the real trace/resume/evidence code,
then put through an adversarial critique that killed the parts that only sound good.

Status: idea / design study. Default-off, additive, hint-only is the posture
throughout. No code yet.

## The reframe

The naive question is "Circuit instead of jj?" That is a category error. jj records
what your code became and lets you recover it. Circuit records what agentic process
produced the work. They sit at different layers and compose: jj underneath, Circuit
above. The interesting question is the narrow one: which *shapes* from jj's history
model are worth importing into Circuit's process layer.

The surprise from reading the code: Circuit already owns most of the substrate.
`trace.ndjson` is an append-only, store-sequenced, one-record-per-line event log with
torn-final-line crash healing and content hashes on payloads/checkpoints. That is
structurally the same machinery jj's operation log is built on (append-only object
store + pure projection over it). So this is not "build an op log from scratch." It
is "Circuit has a per-run op log already; what is genuinely missing, and is it worth
adding."

### The one pattern worth internalizing first

Both jj and Circuit are built on the same idea: an **append-only log is the source of
truth, and everything you display is a pure function of that log.** jj never mutates a
commit; it appends a new one and hides the old. Circuit never mutates a trace entry;
it appends, and the run status / progress / report are all `reducer(trace, manifest)`.
This is the event-sourcing read-model pattern. It is *why* history features can be
safe: if the log is immutable and the view is a pure fold, you can replay any past
state without fear of corrupting the present. Hold this; it explains every
recommendation below.

## What's genuinely missing (verified against the code)

1. **No predecessor edge between re-runs.** A fresh run gets a brand-new random UUID
   and zero pointer to any prior attempt at the same goal. `--reuse-children-from`
   harvests a dead run's children but records `reused_from` only per-branch, with no
   run-level "this run is the evolution of that one" edge.
2. **No project-level operation log.** The trace is walled to a single run (RUN-I3
   forbids mixing run ids). The only cross-run layer is a lexical TF-IDF hint index;
   it answers "which runs mention X," not "what operations happened in what order."
3. **No restore/undo verb.** Recovery is strictly forward: resume continues a run in
   place to its one checkpoint. There is no "rewind to before step N and go differently."
4. **No content-addressed run identity.** Run identity is a UUID, unrelated to content.

## The jj design move worth understanding: change-id vs commit-id

jj's central trick is two identifiers. A **change-id** is a stable, randomly-minted id
that survives every rewrite. A **commit-id** is the content hash of one snapshot and
changes on every amend/rebase. A single change-id points to a succession of commit-ids
over its life; evolog walks that chain. That decoupling is what lets jj say "the same
logical change" across totally different content.

Circuit has a *latent* version of this, but only at the step level: `step_id` is stable
across attempts, equipment-reshape, resume, and even across runs via reuse-children's
structural address. So `step_id` behaves like a change-id and `(run_id, sequence)`
behaves like a commit-id. That mapping is the single sharpest jj-to-Circuit analogy.

But at the **run** level the analogy breaks: `run_id` is a random UUID regenerated on
every run, so there is no stable change-id for "the same goal across attempts." Any
evolog-over-runs needs that missing primitive, an explicit operator- or engine-supplied
goal/change key. You cannot fake it with the UUID.

## The honest verdict: what does NOT transfer

The adversarial pass was unanimous on one point, and it is the most important finding:
**jj's headline feature, cheap uniform restore/undo, does not transfer.**

jj's undo is total and cheap *because* every operation snapshots the whole **mutable**
repo view, so "going back" is just re-pointing at an earlier snapshot. A Circuit run is
the opposite: an **immutable closed folder**. Three concrete walls:

- The working tree is git's domain, not Circuit's. "Restore" must never touch file
  content or it becomes a worse git.
- Mid-flow in-memory state (recovery reason, acceptance feedback, failure cause) is
  **not persisted**. `StepCompleted` is `.strict()` with only four fields. So you can
  re-point at a *closed* run, but you cannot reconstruct a run mid-flight.
- The `relay` step mutates the real tree via a `bypassPermissions` subprocess and is
  non-idempotent; the trace cannot tell how far a partial mutation got. This is the
  exact wall that already killed the Tier-2 forward-resume cursor.

So a Circuit "restore" can honestly mean two things only: (a) pick a prior *closed* run
as the "current" one (pointer movement, warn if the repo moved), or (b) relaunch the
flow from scratch with a recorded predecessor edge. Neither is jj's mid-stream
whole-state rewind. Calling either "jj's reversibility payoff" is marketing. Useful,
much smaller, and it must be labeled honestly or it oversells.

Two corollaries the critique also nailed:

- **Content-addressing a run (a `runStateHash`) is expensive and mostly unneeded.** It
  would touch a shared schema, and it is fragile: hashing raw `trace.ndjson` bytes
  breaks the moment the heal path rewrites bytes for the same logical state, or
  `JSON.stringify` key order ever changes. Defer it unless branch-and-compare concretely
  needs addressable common ancestors.
- **A second op-log file is partly redundant** with the existing `.circuit/history/`
  cross-run index for discovery/identity/staleness. The genuinely new thing is the
  *predecessor edge* and a couple of *operator-intent verbs* (supersede, abandon,
  restore), not a whole parallel ledger of facts the traces already hold.

## The leverage, ranked

### Tier 0 — two free wins nobody designed (do these first)

Both are pure read-only projections over data that **already exists**. No new file, no
schema change, no flag, no durability surface. This is the cheapest leverage in the
whole study and all four design proposals missed it.

- **`circuit run show --at <sequence>`: time-travel debugging of one run.** The Snapshot
  is already a pure fold over the trace. Fold over a *prefix* instead of the whole log
  and you can step through "what did this run look like at operation N." Nearly free,
  because purity is already guaranteed.
- **`circuit blame <step|decision>`: why did this happen.** RUN-I5a already requires every
  recorded action (relay, checkpoint resolution, proof, safe-apply, recovery-route) to
  cite a prior matching `guidance.decision` with identical scope and payload. That is a
  git-blame-for-a-decision graph already sitting in the trace, un-surfaced. Walk
  `guidance.decision -> action -> evidence` and render it.

Together these *are* the "audit-by-default / trust" story, deliverable with zero risk.
They prove the narrative before any durable machinery is added.

### Tier 1 — the cross-run predecessor edge (real, additive, closes a named gap)

One optional `derived_from` pointer that a new run owns about *itself* (RUN-I3-safe,
exactly like `reused_from`), plus the run-level edge on the `--reuse-children-from` path.
This turns a folder of disconnected UUIDs into a walkable "goal G: run1 crashed ->
run2 resumed -> run3 abandoned -> run4 complete" lineage. It is the single most
defensible mechanism: pure record-then-project, clone the trace store's append/heal
discipline, hint-only. It also supplies the join key ("which runs are the same logical
work") that `memory-merge` explicitly names as the missing precondition to move past
`effect_status: not_enough_data`.

### Tier 2 — the op-log proper (the differentiating bet, if you want one)

A single `.circuit/oplog.v1.ndjson` recording operations (created / resumed / reused /
superseded / abandoned / restored), each referencing runs by id, content-addressed by
`op_id`, hint-only. This is jj's "audit is a byproduct of acting, not a discipline you
remember" property mapped to process. It reframes the pitch from "a tool that runs
flows" to "a tool whose every action is ordered, attributable, and reversible." Build
it by porting the trace store's exact crash discipline, emit at the lowest shared CLI
chokepoint, default-off behind an engine flag.

### Tier 3 — the one that actually matters for *this* roadmap

This is the unlock the design panel under-weighted and the critic flagged as highest
leverage for Circuit specifically: **branch-and-compare flow variants.**

The equipment-axis and shape-discrimination programs keep producing NULL / efficacy-flat
verdicts. A recurring reason is that "the same goal done two ways" was never a
first-class, addressable comparison; each eval re-built a bespoke harness. Add a
shared-ancestor edge (`op.branched`) and a comparison read-model that folds N runs'
`result.json` into an outcome/cost/topology table, and A/B of generated flows
(linear-vs-loop, scoped-tools-vs-full, composed-vs-reference) becomes a recorded,
queryable experiment instead of hand-rolled scaffolding. This is the only stage that
might justify content-addressing, and only here, pinned by a golden, only if the work
concretely needs addressable common ancestors.

Tie the ambitious piece to the north-star, not to a generic "audit feature."

## What to explicitly NOT copy from jj

- Working-copy-as-commit / auto-snapshot on every command. Circuit has no continuously
  edited working copy; emit operations only at real chokepoints, coarse not keystroke.
- Restoring the working tree / file content. That is git's job. Hard line, enforced in
  naming and in the authority notice.
- Distributed multi-machine op-log merge and divergent-change resolution. Circuit is
  single-authority per project; a single append writer (or a lock) is enough.
- Diff/patch presentation. Circuit's "evolution" is over structured run/step state.
  Diff outcomes (verdict, cost, topology), not text.
- Git-backend id specifics. Reuse Circuit's own `Sha256` scalar + branded ids + `Ref`
  shape; never invent a git-shaped id scheme.

## Contract guards any of this must respect

- Append-only and forward-only: never mutate or truncate a trace; "undo" is a new
  forward append or a record in a separate ledger. Never append after `run.closed`.
- RUN-I3 single-run boundary: cross-run edges live in a *separate* artifact that
  references runs by id (like `.circuit/history/`), never mixed run ids in one trace.
  The only in-trace field allowed is a `derived_from` the new run owns about itself.
- Schema discipline: new entry kinds are additive, default-absent, `.strict()`,
  `schema_version` literal; a new artifact gets its own schema module and version line.
  This is the proven shape of `run.equipment-reshape` / `run.context-pull` /
  `run.context-delivery`.
- Hint-only authority: ship with the `HISTORY_AUTHORITY_NOTICE` stance (cannot satisfy
  proof / checkpoint / policy / route / recovery / verification / write authority) until
  explicitly ratified. The risk to watch is a later feature quietly letting a lineage
  edge steer recovery/route authority without ratification.
- Engine/flow boundary: the mechanism is engine machinery; per-flow participation rides
  a behavior-named `CompiledFlowEngineFlags` switch + its `EngineFlagsManifest` mirror.
  No flow-specific code in the engine, built-ins byte-identical until opted in.
- Crash tolerance: any second durable file must clone the trace store's
  serialized-writer + single-torn-tail-heal + interior-fail-loud discipline and port
  its test suite, and its emission must be wrapped so a damaged log degrades to
  "incomplete history," never to a failed run.

## Recommended path

- **A. Free within-run wins (Tier 0).** `run show --at <sequence>` + `blame`. Pure
  projections, zero risk, immediate trust story. Start here.
- **B. The op-log + run-level predecessor edge (Tier 1 + 2).** One append-only sibling
  file, hint-only, default-off, emitted at CLI chokepoints. Closes the reuse-children
  lineage gap.
- **C. Narrow restore (closed-run pointer only).** Re-point which closed run is "live,"
  append `op.restored`, mutate nothing, fail closed on missing targets and on any flow
  with a relay before the target. Authority notice states the closed-run-only ceiling
  loudly.
- **D. Branch-and-compare (gated on real roadmap need).** Shared-ancestor edge +
  comparison read-model for the generate/shape-discrimination program. Adopt
  content-addressing only here, only if needed.

Defer: divergent step-restore-and-re-run (collides with the non-idempotent-relay wall),
and content-addressing as a default (fragile, mostly unneeded).

The through-line: steal jj's *shape* (whole-state ops + per-entity evolution + uniform
cheap restore + append-only retention) applied to *process* state. Lead with the two
free projections nobody named, and tie the one ambitious piece directly to the
north-star instead of treating lineage as a generic audit feature.

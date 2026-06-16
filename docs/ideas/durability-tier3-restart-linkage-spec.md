# Durability Tier-3 — the restart re-entry path for skip-finished children

> Status: SURFACE-ONLY. Decision-ready spec, not committed to the engine.
> Grounds against origin/main code at `src/runtime/executors/sub-run.ts`,
> `src/runtime/executors/fanout.ts`, `src/runtime/fanout/branch-execution.ts`,
> `src/runtime/fanout/worktree-reaper.ts`, `src/runtime/run/run-boundary.ts`,
> `src/app/inbox/discover.ts`, and `src/cli/reclaim.ts`.
>
> Reads-with: [`durability-tier3-linkage-spec.md`](durability-tier3-linkage-spec.md)
> (the A2-now reaper / A2-later linkage design) and
> [`durability-tier2-cursor-spec.md`](durability-tier2-cursor-spec.md) (the
> Option-C decision and the two probes). Companion to
> [`fallible-executor-audit.md`](fallible-executor-audit.md) and
> [`parallel-decision-inbox-spec.md`](parallel-decision-inbox-spec.md).

---

## Why this spec exists

The linkage spec ([`durability-tier3-linkage-spec.md`](durability-tier3-linkage-spec.md))
left one question open in its last section. It assumed the skip-finished
re-entry would be consumed by "A1's cursor." That assumption is now wrong. The
cursor decision ([`durability-tier2-cursor-spec.md`](durability-tier2-cursor-spec.md),
"Probe findings and the resolved B-vs-C decision") resolved to **Option C =
restart-cheapness, not forward-recovery**. Probe (i) found that `relay` (the
`bypassPermissions` subprocess step) is not cheaply idempotent: it mutates the
real working tree and there is no per-step snapshot or reset. So the
forward-recovery cursor stays deferred, and with it the inbox's bulk-resume
driver.

That breaks the linkage spec's plan in a specific place. The linkage spec's
"A2-later, inside A1" section bet on a re-entry caller that re-enters the parked
parent step. There is no such caller in an Option-C world. The linkage spec
itself flagged this in "Why this is gated on A1":

> even if A2 recorded a perfect intent record, there is nothing that re-enters
> the parent step to consume it: the parent run is a dead folder that can be
> neither resumed (no checkpoint) nor restarted in place (not empty). The
> skip-finished branch needs a re-entry caller, and that caller is A1's cursor.

So the open question is: **in an Option-C world with no cursor, what re-entry
path consumes skip-finished?** This spec answers it.

What has already shipped since the linkage spec was written (PR #99, now on
main): the worktree reaper (`circuit reclaim`, the A2-now half) and the
read-only decision inbox (`circuit inbox`, the A3-now half). Both are live.
The skip-finished linkage is the remaining Tier-3 slice. This spec specs its
missing re-entry path.

---

## The two facts that make this hard

### Fact 1 — a crashed parent is a dead folder with no front door

`run-boundary.ts` gives exactly two front doors and a crashed parent fits
neither:

- **Resume** (`isResume: true`) requires a non-empty trace AND no `run.closed`
  entry (`run-boundary.ts:118-122`). A crashed parent has both of those. But
  resume only re-enters at a checkpoint boundary: `resumeCompiledFlow` →
  `latestUnresolvedCheckpointResult` rejects a run with "no unresolved
  checkpoint request" (`checkpoint-resume.ts`). A mid-fanout or mid-sub-run
  crash is a *between-checkpoints* death. There is no unresolved checkpoint to
  resume into.
- **Fresh baseline** (`isResume: false`) requires an empty run directory
  (`assertFreshRunDir`, `run-boundary.ts:60-65`). A crashed parent folder holds
  a partial trace and partial artifacts, so it is not empty. Restart-in-place
  is rejected.

This is the same "dead folder" the reaper classifies as `dead`
(`worktree-reaper.ts:160`): no `run.closed`, no unresolved checkpoint. The
reaper reclaims its leaked worktrees, but nothing reuses its finished children.

### Fact 2 — a fresh restart cannot recompute the prior child ids

The linkage spec's keystone was *deterministic child ids*: derive the child id
from `(parentRunId, stepId, attempt, branchId)` so a re-run computes the same
id and finds the prior child folder. Today the id is `randomUUID()`
(`sub-run.ts:161`, `branch-execution.ts:438`).

But determinism from `parentRunId` does not survive a restart. A fresh run of
the same goal gets a **new** `parentRunId`. So even a perfect deterministic
derivation cannot reproduce the prior parent's child ids: the seed itself
changed. Deterministic-from-parent-id only helps a *resume* (same parent id),
and resume is exactly the path Fact 1 says does not exist for this crash shape.

The two facts compound. The re-entry path must (a) not require resuming the
dead parent and (b) not depend on recomputing child ids from a parent id that
no longer exists. That rules out the linkage spec's original mechanism outright
and forces a different one.

---

## What the code does today (verified against origin/main)

This restates the linkage spec's code reading, updated for the owner-lock and
reaper that shipped since.

- **Sub-run records the child only at the join.** `sub-run.ts:163-172` appends
  `sub_run.started` (with `child_run_id`) before the child runs;
  `:241-251` appends `sub_run.completed` after. A kill in the window between the
  child closing its own `result.json` and the parent's `sub_run.completed`
  leaves the parent trace ending at `sub_run.started`. The finished child is an
  orphan with no admitted linkage.
- **Fanout records per-branch facts, joins at the end.** Each branch appends
  `fanout.branch_started` / `fanout.branch_completed` (`branch-execution.ts`),
  so per-branch *trace* facts are durable, but the parent's `fanout.joined`
  roll-up is written last (`fanout.ts:348-360`). The child id in each branch is
  `randomUUID()` (`branch-execution.ts:438`).
- **The worktree leak is now reclaimed, not linked.** The fanout `finally`
  (`fanout.ts:298-313`) still removes worktrees and a SIGKILL still skips it,
  but an owner lock now records the live pid (`fanout.ts:219-233`) and the
  reaper (`worktree-reaper.ts`) reclaims orphaned worktrees on a later
  invocation. Crucially, the reaper's liveness gate (`reapWorktrees`,
  `:208-229`) keeps any worktree whose owner process is still alive, so it
  never destroys live work. This is the leak half of Tier-3, already shipped.
- **The inbox surfaces parked runs, not dead ones.** `discoverDecisionInbox`
  (`discover.ts:127-160`) walks the runs root and keeps only runs whose
  projection reason is `checkpoint_waiting`. It explicitly skips dead crashed
  folders (`discover.ts:14-17`, `:144-146`). It already resolves a per-row
  staleness signal through `realBriefGitProbe` → `StalenessFacts`
  (`discover.ts:90-100`), but run folders carry no captured baseline on disk
  today, so every row omits the staleness column for now (`discover.ts:65-68`).

So the finished-child reuse gap is real and unaddressed: a restart re-runs every
finished child of a crashed parent, and there is no path that reuses them.

---

## The open question, stated precisely

A restart of the same goal produces a fresh parent run. How does that fresh run
find and reuse the prior crashed parent's finished children, given that:

1. the prior parent is a dead folder (no resume, no restart-in-place), and
2. the fresh parent has a new id, so it cannot recompute the prior child ids?

The answer must supply a re-entry path that does not resume the dead parent and
does not depend on cross-restart id determinism. Three candidates follow.

---

## Options

### Option (a) — explicit prior-run pointer (`--reuse-children-from`)

A fresh restart names the dead parent's run folder explicitly. The child reuse
is addressed *structurally* within that folder, not by a recomputed id.

**Mechanism.**

1. Add an optional `--reuse-children-from <dead-run-folder>` to `circuit run`
   (and the equivalent option to the run-context the engine threads). It carries
   a path, not an id. It is inert when absent, so the default path is unchanged.
2. The fresh run executes normally until it reaches a sub-run or fanout step.
   Before invoking `childRunner`, it consults the referenced folder. It addresses
   a candidate prior child by its **structural address** — the trace facts of the
   referenced parent name `(step_id, attempt, branch_id, child_run_id,
   result_path)` on `sub_run.started` / `fanout.branch_started` and the
   completion facts on `sub_run.completed` / `fanout.branch_completed`. The fresh
   run matches on `(step_id, attempt, branch_id)`, which are stable across
   restarts (they come from the flow and the branch expansion, not from the run
   id), and reads the prior child's `result.json` at the recorded path.
3. If the prior child has a closed `result.json` that parses and is admissible,
   the fresh run admits it through the **existing** admit path
   (`evaluateChildResult`, `sub-run.ts:50-71`; `branchResult`,
   `branch-execution.ts:80-92`) instead of running a new child. It copies the
   prior child result into its own run folder so its own artifacts stay
   self-contained, and appends its own `sub_run.completed` /
   `fanout.branch_completed` naming the reused child's id (carrying a
   `reused_from` marker so the trace stays honest about provenance).
4. If no admissible prior child is found for that address, the fresh run runs the
   child normally. Skip-finished is a pure speed-up; never running a child is
   never wrong, it is only slower.

**What it touches.** A new CLI/RunContext option (additive), a "consult prior
folder" probe in `sub-run.ts` and `branch-execution.ts` before `childRunner`,
an additive optional `reused_from` field on the completion trace entries
(schema bump). No change to the dead parent. No deterministic-id work at all:
the structural address plus the pointer is the whole key.

**Interaction with the not-idempotent relay constraint.** This option only ever
*reuses* a finished child; it never re-runs one. The relay-idempotency problem
is about re-running a step that crashed *mid-relay*. Here the question is
narrower: is the prior child *safe to admit from disk*? A finished child with a
closed `result.json` already ran to a verdict, so admitting it re-runs nothing.
The relay constraint bites only on the *current* fresh step, which runs normally
under the existing executor. So `--reuse-children-from` sidesteps the relay
problem by construction: it reuses results, it does not resume execution.

The refuse-to-skip rule (below) still applies: a sub-run that mutated the shared
checkout rather than an isolating worktree must not be reused, because the fresh
run's working tree is a fresh checkout and the prior child's tree mutations are
not present in it. Admitting its verdict without its tree changes would be a lie.

**The pointer's discoverability.** The reaper and inbox already walk the runs
root and classify folders. The reaper sees `dead` folders (`worktree-reaper.ts`
`OwningRunStatus`); the inbox sees parked ones. A small additive surface — a
`circuit reclaim`-adjacent listing, or an inbox column — can name a dead folder
that holds finished children and print the exact `circuit run ...
--reuse-children-from <that-folder>` command. So the operator never has to find
the folder by hand. This reuses shipped discovery machinery rather than building
new discovery.

**Sizing.** ~3-4 days. One additive option, one probe in each of two executors
feeding the existing admit path, one additive trace field, and an optional
discovery-surface line. No new resume entrypoint, no id scheme, no cursor.

### Option (b) — dead-folder reanimation (restart the dead folder in place)

Redefine "restart" so the dead folder *is* the re-entry point. Extend resume to
restart a dead folder from its last completed step using the banked
`RecoveryCorridor.seedFromTrace` fold, re-running the crashed (non-idempotent)
step but skipping its finished children.

**Mechanism.** A new non-checkpoint resume entrypoint derives `currentStepId`
from the last `step.completed` (not from an unresolved checkpoint), relaxes the
`run-boundary.ts:121-122` already-not-closed gate to also admit a dead folder,
seeds the recovery corridor from the trace, and re-runs the incomplete step.
The skip-finished branch lives inside that re-run: the same parent id is in
scope, so the linkage spec's deterministic-from-parent-id child addressing works
unchanged, and finished children are skipped.

**What it touches.** This is the forward-recovery cursor wearing a smaller hat.
It needs the new non-checkpoint resume entrypoint, the corridor reseed as a live
(not inert) consumer, and the run-boundary relaxation. Every channel that the
cursor spec's Option A lists must rehydrate, because re-running the incomplete
step re-enters mid-flow.

**Interaction with the not-idempotent relay constraint — this is the killer.**
The "re-run the crashed step" is exactly the move probe (i) ruled not cheaply
safe. The crashed step is, in the general case, a relay (or a fanout whose
branch is a relay). Re-running it re-dispatches a `bypassPermissions` subprocess
onto a working tree that the prior crashed relay may have half-mutated, with no
snapshot to reset to. That is the unsound case probe (i) found. Option (b)
*requires* the relay snapshot/reset that Option C explicitly deferred. So this
option is not reachable until forward-recovery is reachable. It is the cursor by
another name.

**Staleness gate.** Inherits the full forward-recovery precondition: re-entering
a dead folder means the world may have moved under it, so the
`StalenessProbe` port (cursor spec, probe (ii)) is load-bearing here exactly as
it is for the cursor.

**Sizing.** Multi-week, and gated on the same relay snapshot/reset that gates
Option B of the cursor spec. This is not a separable Tier-3 slice; it is the
deferred cursor.

### Option (c) — content/goal-addressed children (shared children store)

Make the child id a hash of stable inputs — `(flow, goal, stepId, attempt,
branchId, input-digest)` — in a shared children store, so any restart of the
same goal recomputes the same id and finds the prior child.

**Mechanism.** Replace `randomUUID()` with a content hash, write children into a
shared store keyed by that hash, and have every run (fresh or resumed) probe the
store before running a child. Because the hash excludes the parent run id, a
restart recomputes the same key and hits the prior child.

**What it touches.** A global children index (new durable structure outside any
single run folder), a hashing scheme that must capture *every* input that could
change the child's correct result (the hard part: goal text, flow bytes,
selection layers, depth, equipment scope, injected skills, the reads the child
sees), an eviction/GC story for the store, and the probe in both executors. It
also reopens the cross-run-isolation question the per-run-folder design avoided.

**Interaction with the not-idempotent relay constraint.** Like (a), it reuses
results and never re-runs, so the relay constraint does not bite the reuse path
directly. But the hash correctness burden is severe: if the input-digest misses
a load-bearing input, the store returns a child computed under different inputs
and the reuse is silently wrong. A relay child's "inputs" include the live
working-tree state it read, which is not cleanly hashable. So content-addressing
a relay-bearing child is the same unsoundness in a subtler shape: the hash
claims input-equality it cannot actually prove.

**Staleness gate.** The hash would have to fold the staleness-relevant repo
state into the key, or the store must be staleness-gated on read. Either way it
inherits the same precondition as (a), but with a much larger surface to get
right.

**Sizing.** ~2-3 weeks plus ongoing GC/correctness maintenance. The global
index and the input-digest correctness are the cost. Heaviest option, and its
extra power (cross-goal, cross-parent reuse) is not what the open question asks
for — the question is restart-of-the-same-goal, which a pointer answers without
a global store.

---

## Recommendation

**Ship Option (a) — the explicit prior-run pointer (`--reuse-children-from`).**

Reasoning:

- **It is the only option that fits the two hard facts.** Fact 1 (dead folder,
  no front door) is sidestepped because (a) does not resume or restart the dead
  parent — it runs a *fresh* parent that merely *reads* the dead one. Fact 2
  (new parent id, no recomputable child ids) is sidestepped because (a) addresses
  prior children by their structural `(step_id, attempt, branch_id)` address,
  which is stable across restarts, plus an explicit folder pointer. No
  cross-restart id determinism is needed. The linkage spec's keystone
  (deterministic ids) is *not* required; the pointer plus the structural address
  replaces it.
- **It sidesteps the relay constraint by construction.** (a) reuses finished
  child results and never re-runs a step, so it never re-dispatches a relay onto
  a half-mutated tree. Probe (i)'s blocker does not apply to result reuse. Option
  (b) walks straight into it (it re-runs the crashed step) and is therefore the
  deferred cursor, not a Tier-3 slice. Option (c) reuses results too but pays a
  correctness tax (input-digest must capture a relay's live-tree reads) that (a)
  does not.
- **It is small and additive.** No new resume entrypoint, no id scheme, no global
  store. One option, one probe per executor into the *existing* admit path, one
  additive trace field. The shipped reaper and inbox already supply the
  discovery, so the operator gets the pointer handed to them rather than hunting
  for it.
- **It composes cleanly with the eventual cursor.** When forward recovery does
  arrive (cursor spec Option B), the resume path and the restart-with-pointer path
  can share the same skip-finished probe; (a)'s probe is the same admit-from-disk
  logic a resume would use, just keyed by an explicit pointer instead of the
  resumed run's own id. Building (a) now does not foreclose (b) later; it banks
  the reuse logic (b) would need.

Reject (b) now: it is the deferred forward-recovery cursor under a different
name, gated on the relay snapshot/reset that Option C explicitly set aside.
Reject (c) now: its global store and input-digest correctness burden are
disproportionate to the question, which is restart-of-the-same-goal, and a
pointer answers that without a global index.

---

## The safety rule (applies to whichever option ships)

A finished child may be reused **only if** it ran in an isolating worktree, not
the shared checkout. The reuse admits the child's *verdict and result*. If the
child's real effect was a mutation to the shared working tree, the fresh
restart's tree is a fresh checkout that does not carry those mutations, so
admitting the verdict without the tree changes is a false success. So:

- A fanout sub-run branch runs in its own provisioned worktree
  (`fanout.ts:259-265`, `branch-execution.ts:477-478`). Its effect is captured by
  the branch result and the disjoint-merge collection. These are reusable.
- A relay fanout branch and a top-level relay that mutate the *shared* checkout
  are not reusable: their effect is in the tree, not the result, and the fresh
  tree does not have it. Refuse to skip; run the child normally.
- The probe must therefore refuse reuse when the prior child's recorded
  execution had no isolating worktree. The trace already distinguishes branch
  kinds (`fanout.branch_started.branch_kind`), so this is a readable precondition,
  not a new fact.

This is the same refusal the linkage spec named ("Refuse to skip when the child
mutated the shared checkout"); it is restated here because it is load-bearing for
the reuse path regardless of which re-entry mechanism wins.

---

## The staleness-gate precondition the reuse path inherits

The moment a fresh restart admits a prior child instead of running it, the
question "did the repo move since the prior child ran" becomes load-bearing, the
same way it does for any recovery. The inbox already proves the shape of the
answer: `discoverDecisionInbox` runs `realBriefGitProbe` →
`StalenessFacts` per row (`discover.ts:90-100`).

The reuse path should adopt the same facts as a **precondition gate**, not a
"done" verdict:

- The cursor spec already pre-decided the layering (probe (ii)): a runtime-owned
  `StalenessProbe` port with a default git implementation, and `StalenessFacts`
  moved to `src/schemas/` so `src/app` and `src/runtime` share it without an
  import-direction violation. The reuse path uses that port.
- Gate rule: if the live repo has diverged from the prior parent's captured
  baseline beyond what the reused children assumed, refuse reuse and run the
  children fresh. Refusing is always safe (it is just slower); admitting a child
  computed against a moved repo is the unsafe direction.
- One gap to close along the way: run folders carry no captured baseline on disk
  today (`discover.ts:65-68`), which is why the inbox omits its staleness column.
  The reuse path needs that baseline to gate on, so capturing the parent's git
  baseline at run start (additive, a few lines) is a prerequisite. It also retires
  the inbox's missing-baseline gap as a side benefit.

---

## What it would take (Option (a), the recommended slice)

1. **A captured run baseline.** At run start, record the parent's git baseline
   (HEAD, branch) in the run folder. Additive, a few lines. Failing test: a run
   folder carries a readable baseline; the inbox's staleness column now renders.
2. **The `--reuse-children-from` option.** Add it to `circuit run` and thread it
   through to `RunContext` as an optional dead-folder path. Inert when absent.
   Failing test: a run with the option set carries the pointer into the context;
   without it, behavior is byte-identical to today.
3. **The reuse probe in both executors.** Before `childRunner` in `sub-run.ts`
   and `branch-execution.ts`, when a pointer is present, address the prior child
   by `(step_id, attempt, branch_id)` in the referenced folder, read its
   `result.json`, and — if it is closed, admissible, ran in an isolating
   worktree, and the staleness gate passes — feed it to the existing admit path
   (`evaluateChildResult` / `branchResult`) and skip the run. Otherwise run
   normally. Failing test: a fixture dead parent with one finished isolating-
   worktree child; a fresh run with the pointer admits that child from disk and
   does not invoke `childRunner` for it.
4. **The honest trace.** Add an optional `reused_from` field to
   `sub_run.completed` / `fanout.branch_completed` (additive schema bump) so the
   fresh run's trace records that a child was reused, not run. Failing test: the
   reused completion entry carries the prior child's id and the `reused_from`
   marker.
5. **The refusal proofs.** Two negative tests: a prior relay child that mutated
   the shared checkout is refused (run fresh), and a prior child under a moved
   repo (staleness gate fails) is refused (run fresh).
6. **The discovery surface (optional, ships value).** A line in `circuit
   reclaim`'s summary, or an inbox column, that names a dead folder holding
   finished children and prints the exact `--reuse-children-from` command. Reuses
   the shipped reaper/inbox walk; no new discovery.

No new resume entrypoint. No deterministic-id scheme. No global store. No engine
special-casing beyond the additive option and the two executor probes feeding the
existing admit path.

---

## Why this is NOT gated on the cursor

The linkage spec gated its skip-finished half on A1's cursor because it assumed
the re-entry caller was the cursor. Option (a) breaks that gate: the re-entry
caller is a *fresh run carrying a pointer*, which exists today (`circuit run`).
The reuse path reads the dead folder; it never resumes or restarts it, so it
needs no non-checkpoint resume entrypoint and no mid-flow rehydration. It
inherits only the staleness-gate precondition (already pre-decided as a port)
and the refuse-on-shared-checkout safety rule (already a readable trace fact).

So this is a genuine Option-C slice: it makes a *restart* cheaper (skip the
expensive finished children) without taking on the cursor's idempotency
obligation. It sits alongside the shipped reaper as the second concrete
restart-cheapness slice. When the cursor eventually lands, its resume path can
reuse this slice's admit-from-disk probe, so building it now banks work the
cursor would otherwise have to do.

---

## Dependencies and what stays surface-only

- **Option (b)** depends on the full forward-recovery cursor (cursor spec Option
  A/B) and the relay snapshot/reset Option C deferred. Stays surface-only.
- **Option (c)** is a heavier alternative not recommended; stays surface-only.
- **The bulk-resume inbox driver** (parallel-decision-inbox spec) stays deferred
  on the cursor, unchanged by this spec. This spec is about restart reuse, not
  parked-run resume.

Everything here is decision-ready and surface-only until an operator says yes.
Nothing is committed to the engine.

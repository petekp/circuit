# Overnight reliability run report

This run advanced the reliability/parallel half of the engine with two safe,
no-ratification changes, then reached the optional finishing spike. It did
**not** build the ratification-gated frontier: no Step 3 structural auto-reshape,
no `spliceIntoRemainingSteps` seam, no splice-as-leaf / inline-subtree recursion,
no resolver-abstraction extraction. Those stay out, awaiting ratification.

It coordinated around two in-flight streams (Step 2 live equipment reshape, and
the docs cleanup) without touching their PRs. By the time this run started both
had merged to main, so it built straight on top of them.

## What landed

| Chunk | What | Where | PR | Merge |
|---|---|---|---|---|
| CHUNK 1 | Recovery bindings threaded into checkpoint resume (failed child degrades onto its recovery route instead of hard-aborting the parent) | `src/` (engine) | #105 | `c87be1c8` (merge `748a14ee`) |
| CHUNK 2 | `--reuse-children-from` restart cheapness (a fresh run reuses a dead run's finished sub-run children by structural address) | `src/` (engine) | #106 | `c45b46b5` (merge `5fef310f`) |
| Spike | On-demand context-pull offline demonstrator | `experiments/flow-lab/` (throwaway) | this PR | this PR |

**Final main SHA after the two reliability chunks: `5fef310f`** (the CHUNK 2
merge). This report and the context-pull spike land as a follow-on docs+spike PR
on top of it. Full `npm run verify` was green on each chunk's branch before merge
and is re-run as the closing gate of this run.

Recommended merge order (already followed): CHUNK 1 first (it was already on main
at run start), then CHUNK 2, then this report+spike PR last. There is no code
dependency between the two chunks; CHUNK 2 was simply sequenced after CHUNK 1 to
keep one held PR in flight at a time.

## CHUNK 1 — recovery bindings into checkpoint resume

### The bug (from the paper-to-site 2nd run)

A run that resumes from a checkpoint and then takes a recovery route — for
example a failed sub-run child degrading onto a `stop` route — hard-aborted the
whole parent instead of routing the degrade. In the paper-to-site editorial run
that meant a single failed fanout/sub-run child forced a full re-run, at a real
cost of about $6 in re-spent editorial work.

### Root cause

The resume path (`resumeCompiledFlowResult` in
`src/runtime/run/checkpoint-resume.ts`) passed `workContractRef` but **not**
`recoveryRouteBindings`. The graph-runner defaults the binding list to `[]`
whenever a work-contract ref is present, so on resume a recovery verdict found no
matching binding and aborted the parent. The top-level (non-resume) run path
already supplied these bindings; only the resume path was missing them.

### The fix

Thread the same bindings the top-level path supplies, derived from the flow's
routes via the existing `projectWorkContractProjectionV0` projection. The resume
path now yields the identical binding list the non-resume path projects — a
one-line addition (`recoveryRouteBindings: workContractProjection.work_contract.recovery`)
plus hoisting the projection so both the ref and the bindings read from it.
Build's own behavior is unchanged; the engine is not special-cased.

### Re-proven

`tests/runtime/checkpoint-resume.test.ts` adds a failing-first test that resumes
into a sub-run whose child fails and degrades onto `stop`. Before the fix the
parent hard-aborts; after, it routes `stop -> @stop` and the run reaches a clean
`stopped` outcome with no `step.aborted` and no "recovery binding" in the reason.
Verify green; host runtime bundles regenerated.

## CHUNK 2 — `--reuse-children-from` restart cheapness

### What it is

The Option (a) slice from `durability-tier3-restart-linkage-spec.md`. A fresh
`circuit run --reuse-children-from <dead-run-folder>` reuses a prior crashed
run's **finished sub-run fanout children** instead of re-running the expensive
child flow. It addresses each prior child by its **structural address**
`(step_id, branch_id)` — stable across restarts because it comes from the flow
and the branch expansion, not from a run id. It **never resumes the dead folder**;
it only reads the dead run's trace and on-disk artifacts and admits the finished
children's results into a brand-new run.

This sidesteps the blocker that ruled out resuming a dead run in place: relays
are not idempotent, so re-entering a dead run risks re-running side-effecting
work. Reuse copies finished **results**, it never re-runs the child.

### How it stays sound (the key realization)

A sub-run branch does its work in an isolating git worktree. The disjoint-merge
join collects the branch's real file effect from that worktree (the runtime reads
`outcome.worktree_path` and calls `worktreeRunner.changedFiles`). The
worktree-reaper is **operator-invoked only** (`circuit reclaim`), never at run
start — so a dead run's worktrees survive on disk at restart. Reuse therefore
points `outcome.worktree_path` at the prior worktree and skips both
`worktreeRunner.add` and the child run; the file effect is re-collected from the
prior worktree that is still there. The cost reuse avoids is the child model run,
which is the expensive part. `src/runtime/executors/fanout.ts` needed no change.

### The safety floor (each gate fail-safe to a fresh run)

In `src/runtime/run/reuse-children.ts`. A child is reused only when **all** hold,
and any miss runs the child fresh (refusing is always safe, only slower):

1. it ran as an isolating-worktree **`sub-run`** branch, not a `relay` branch
   (a relay mutates the shared checkout, so its verdict alone is not sound to
   reuse);
2. the prior child ran the **same flow** this branch targets
   (`result.flow_id == branch.flow_ref`) — the structural address carries no flow
   identity, so without this a re-pointed flow would silently admit a child built
   from a different flow;
3. it closed **`complete`** with an **admissible** result — re-evaluated against
   *this* step's admit list, not trusting the prior verdict;
4. its worktree is still a **usable git worktree** on disk (the dir exists **and**
   carries a `.git` entry), not a reaped or half-cleaned directory.

**Documented limitation, not a guarded invariant:** the child flow *version* or
the base commit it ran against are not checked. `--reuse-children-from` is a
crash-restart aid that assumes the same flow at the same goal.

### Boundary discipline

`reuseChildrenFrom` is **run-state** on `RunContext`, `GraphRunnerOptions`, and
`CompiledFlowRunOptions` — deliberately **not** a `RuntimeExecutionCapability`
(that carries an exact-match contract test and implies child-forwarding) and
**not** forwarded to child runs (children never reuse-from). The completion trace
entry gains an optional `reused_from` carrying the prior child run id, so the
trace stays honest that the work was reused, not freshly executed. Prior traces
without the field still parse.

### Re-proven with the kill-and-restart probe

`tests/runtime/reuse-children.test.ts` builds a **prior crashed run** folder — a
mid-fanout crash shape: per-branch `fanout.branch_started` /
`fanout.branch_completed` written, branch `result.json` files and worktrees on
disk, but no `fanout.joined` / `run.closed`. A fresh run pointed at it then
proves:

- **reuse** — neither child flow is re-run (`invoked.goals == []`), the
  disjoint-merge collects each branch's file effect from the prior worktree, and
  each completion carries `reused_from` naming the prior child;
- **four refusal paths**, each running the child fresh with no `reused_from`:
  the prior worktree is gone (reaped); the prior worktree is a bare directory with
  no `.git`; the prior child ran a different flow at the same address; no pointer
  at all (inert default).

`tests/runner/cli-power-flag.test.ts` covers the CLI: `--reuse-children-from`
parses on a fresh run, rejects an empty path, and is rejected on `resume`
(fresh-run only). Full `npm run verify` green (340 test files, 3623 tests, 6
skipped). Host runtime bundles regenerated.

### Review

A three-lens adversarial review (correctness, safety/soundness, boundaries) ran
on the src/ change. Two lenses returned SHIP with zero findings (the reuse genuinely
skips the child and preserves the file effect the join consumes; threading is
complete and the capability boundary is correctly preserved). The safety lens
returned SHIP with two pre-merge edits, **both addressed in the PR before merge**:

- the worktree gate checked only that a directory existed; strengthened to require
  a real git worktree (`.git` entry), which makes the floor honest for every join
  policy, with a narrowed comment;
- reuse keyed solely on `(step_id, branch_id)` with no flow-identity check;
  added the `flow_id == flow_ref` gate and documented the version/base limitation.

Both fixes are covered by the two new refusal tests above.

## Spike — on-demand context pull (offline demonstrator)

The optional finishing spike from the on-demand context-pull idea note (its spec
doc lands with the in-flight docs-cleanup stream, so it is not linked here),
built the same way the recompile Step 0 demonstrator was: a pure-function module
in `experiments/flow-lab/`, no model calls, no codebase, no engine seam. It is a
throwaway that proves the *trade*, not a live channel.

`experiments/flow-lab/context-pull-demonstrator.ts` models a parent's typed
surface (ten named slices over an intake -> digest -> ideation -> tournament ->
spec pipeline, each with a byte-proxy size) feeding one build child. The child's
assembly-time static envelope under-provisions: it was given two fields but
actually needs four, an edge knowable only at run time. Three envelope strategies
are scored on the same need (all numbers measured by the module):

| Strategy | Carried bytes | Starved fields | Irrelevant bytes |
|---|---|---|---|
| thin push (static envelope only) | 11 | **2** | 0 |
| fat push (whole parent surface) | 293 | 0 | **264** |
| thin + on-demand pull | **29** | 0 | 0 |

The thin push is focused but **starves** on the two fields the assembly-time
guess missed. The fat push is complete but drags the whole blob — 293 carried
bytes, 264 of them irrelevant to this step (`intake.full_text`, scorecards,
rejected concepts). The thin-plus-pull strategy reaches the fat push's
completeness (zero starvation) carrying **29 bytes vs 293 — about a 10x reduction
— with zero irrelevant bytes**, by issuing two targeted typed queries for exactly
the missing named slices.

The conservative defaults from the spec all hold, each measured:

- **No "everything" query.** A `*` query is refused as a finding, never answered
  (it would re-import the blob the scoping escaped).
- **Bounded.** A per-step pull budget of 1 against a need of two answers one and
  degrades the second to a `budget-exhausted` finding, leaving a residual
  starvation rather than widening past budget — never an infinite widen.
- **Legible.** Every answered pull is recorded in a trace; the trace names exactly
  the slices pulled, so "what context did this step see" stays replayable.

`experiments/flow-lab/context-pull-demonstrator.test.ts` asserts each of these on
the measured values (6 tests, green). The finding: targeted typed pull is worth
pursuing — it dissolves the context-sizing trade (focus *and* completeness) at a
fraction of the fat-push cost — and the typed-lookup first cut is sufficient to
prove it before any semantic/retrieval machinery earns its place. It is the
runtime-binding sibling of Step 2 (inject equipment at runtime) and sequences
after the recompile work, not as a detour. Captured as a spike; no live/src query
channel was built, per the rail.

## Spend

Coding only. No model-spend experiments were run. Actual spend on this run: $0 in
model/eval spend (the spike is pure offline functions; both chunks are tests +
engine code). No runaway.

## Anything that needs ratification

Nothing new requires a decision from this run — both chunks were inside the
safe, no-ratification scope and the spike is a captured offline demonstrator. The
standing ratification-gated items remain out and unchanged:

- **Step 3 structural auto-reshape** and the **`spliceIntoRemainingSteps`** seam
  (reshaping the remaining step *sequence*, not just equipping a step already in
  it).
- **Splice-as-leaf / inline-subtree recursion** (the uniform-recursion E3
  path-unification behind an engine flag).
- **Resolver-abstraction extraction** (still awaiting a third concrete resolver
  instance before the unified `Resolver` type is earned).

Two reuse follow-ups are worth noting as future work, neither gating:

1. **A captured run-start git baseline + a staleness probe** for
   `--reuse-children-from`, so reuse can also refuse when the fresh run's base has
   moved relative to the dead run (the documented version/base limitation). The
   cursor-spec pre-decided this as a later slice; it was not built here.
2. **A discovery surface** in `circuit reclaim` / the inbox that points an
   operator at a reusable dead-run folder, so the restart path is discoverable
   rather than hand-typed.

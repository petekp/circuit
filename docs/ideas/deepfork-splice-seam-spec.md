# Deep fork: the splice seam (structural reshape + splice-as-leaf)

> Status: **surface-only; NOT built; ratification-gated.** Written 2026-06-17,
> after Step 2 (additive live equipment reshape) landed on `main` and the
> operator surface for reshapes (F2) landed. This spec designs the one seam two
> separate forks both need, so it does not duplicate either:
>
> - **Fork (iii) structural recompile** wants to decompose a running step into a
>   subtree when a relay discovers its grain was wrong
>   ([`deepfork-adaptive-bubble-up-recompile-spec.md`](deepfork-adaptive-bubble-up-recompile-spec.md),
>   Step 3 there).
> - **Fork (i) splice-as-leaf** wants to inline a sub-tree where a leaf relay
>   sits, so recursion is uniform with sequencing
>   ([`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md),
>   Option A there).
>
> Both reshape the live step set, and both name the same `spliceIntoRemainingSteps`
> runner branch as the thing they are missing. This spec is that branch. It builds
> on the shipped foundation (the recursion bound and the additive reshaper) and
> stays deferred behind explicit ratification. See the canonical map
> [`north-star-status.md`](north-star-status.md). File and line references were
> verified against `main` at write time and are kept as a grounding record; treat
> them as a map, not a contract.

## The seam in one line

A running step needs to be replaced, in place, by more than one step - a subtree -
so the live step set changes mid-run. Today the runner walks a fixed step set
(Step 2 only swaps skill slots inside that set). The seam is the single runner
branch that takes a re-compiled subtree and migrates the run state - the cursor,
the routes, the slice corridor, the completion counts - onto the new set without
losing where the run is or what it has already proved.

## Why this is one spec, not two

The two forks differ in where the subtree comes from and stop at the same wall:

| | Fork (iii) structural recompile | Fork (i) splice-as-leaf |
|---|---|---|
| Trigger | a relay bubbles up a "turned out bigger" discovery | a step is authored as "inline sub-tree X" |
| Subtree source | re-resolve the structure resolver, re-assemble, re-compile the remaining spec | resolve a named flow's compiled steps |
| When | runtime, on a discovery | compile-time shape, expanded at runtime |
| Shared wall | **splice the subtree into the live step set and migrate run state** | **same** |

Everything before the wall is fork-specific and already designed in the sibling
specs. Everything at and after the wall is shared. Designing the seam once, for
both, is the whole reason this document exists. Where a piece serves only one
fork, it is called out below; the default is that a piece serves both.

## What's true today (the floor the seam builds on)

Three things already exist that the seam reuses, and one boundary it must respect.

- **The additive swap is the precedent for mutating the running flow safely.**
  When Step 2 honors an equipment discovery it assigns three pieces of run state
  together - `activeFlow`, `activePackageIndex`, and the `steps` Map -
  (`src/runtime/run/graph-runner.ts:1003-1009`), having built the new package
  index into a local first so the swap is atomic by construction. Crucially the
  step *set* is unchanged: only skill slots and the package index move, so the
  cursor (`currentStepId`, `:492`/`:1037`), the route map, the slice corridor, and
  the completion counts are all left untouched and keep working. The seam is the
  case the additive swap deliberately does not handle: the step set itself changes.

- **The slice-loop advance is the only existing "the runner reshapes its own
  remaining steps."** When a slice-loop tail completes and more slices remain, the
  runner redirects the forward route to `sliceFlag.advanceRoute`, calls
  `sliceCorridor.advance()`, and re-enters the loop head at the next slice
  (`src/runtime/run/graph-runner.ts:648-655`; corridor at
  `src/runtime/run/slice-corridor.ts:38-113`). This is the nearest precedent for a
  runner branch that changes what runs next, and the seam should be modeled on it
  rather than on a wholly new execution kind.

- **The recursion bound already shipped.** `RECURSION_DEPTH_CAP = 8` plus an
  ancestor-flow-id cycle guard is threaded child-to-child across both child-run
  edges, with a compile-time self-reference reject (see the foundation run report,
  [`recompile-foundation-run-report.md`](recompile-foundation-run-report.md)). A
  splice that introduces a subtree is a recursion edge, so the seam must descend
  the same guard before it expands - the bound is not new work, it is a
  precondition the seam consumes.

- **The catalog gate is the safety floor, and it lives inside compile.**
  `compileSchematicToCompiledFlow` runs `collectSchematicCatalogIssues`
  (`src/flows/compile-schematic-to-flow.ts:760-767`;
  `src/flows/schematic-catalog-check.ts:37-86`), which validates that every route
  a schematic item declares is allowed for its block kind and that consumed
  contracts resolve. An illegal shape fails to compile rather than running broken.

## The splice seam: migrating run state across a changed step set

This is the core of the spec. Step 2 was cheap because the step set was stable. A
splice changes the set, so four pieces of run state that the additive swap could
ignore now have to be re-derived or migrated. Each is a concrete hazard, not a
vague risk.

### Cursor and step walk

The cursor is `currentStepId` (`src/runtime/run/graph-runner.ts:492`), and the
main loop fetches the live step with `steps.get(currentStepId)` (`:525`). The
splice replaces one step id with several. The contract the seam must hold:

- The spliced-in subtree has a single **entry** step and one or more **exit**
  steps. The entry takes the cursor; the displaced step's id must no longer be
  reachable as a cursor value.
- The displaced step's **outbound routes** must be re-homed onto the subtree's
  exit step(s), or the run will walk off the end of the subtree with no next step.
  This is the route-map migration below.
- The `steps` Map and `activeFlow.steps` must be updated together with the cursor
  decision, the same atomic-by-construction discipline the additive swap already
  uses (`:1003-1009`), so a throw mid-splice can never leave the cursor pointing at
  a step the Map no longer holds.

### Route map and transition resolution

Routes are a `Record<RouteName, RouteTarget>` on each step, where a target is
either `{ kind: 'step'; stepId }` or `{ kind: 'terminal'; target }`
(`src/runtime/domain/route.ts:14-18`). After a step completes the next step is
chosen by `classifyRouteTargetTransition`
(`src/runtime/run/run-transition.ts:68-110`), which also detects terminal closes,
completed-step re-entry aborts, and recovery exhaustion. Two regressions become
possible the moment the step set changes:

- **Dangling targets.** Any route anywhere in the flow that pointed at the
  displaced step id is now dangling unless re-homed onto the subtree entry. A
  dangling target is exactly the class the catalog gate catches, which is the
  first reason the gate must be re-run (below).
- **Re-entry aborts.** `run-transition.ts` aborts on re-entry to a completed step.
  If a splice reuses an id that already completed, or if the migration mis-keys a
  subtree step against a completed id, the run aborts. The seam must allocate
  subtree step ids that are fresh in the live set.

The additive case never touched routes, so it never opened this. The seam owns it.

### Slice corridor

The corridor scopes completion-count keys per slice: `countKey` returns
`${stepId}#s${N}` for a loop-body step at slice index N and the bare `stepId`
otherwise (`src/runtime/run/slice-corridor.ts:86-89`). A splice that lands
**inside an active slice loop** is the sharp edge: the per-slice keys of every
downstream slice are computed from the body's step set, so changing that set
mid-loop misaligns the keys for slices not yet run, and the loop's completion
accounting silently drifts. The conservative default falls straight out of this:
**refuse to splice while the slice corridor is active** (`sliceCorridor.isActive()`,
`slice-corridor.ts:52`), and downgrade such a discovery to a finding. This mirrors
the Step 2 reshaper, which already skips inside slice loops for the same
keying reason.

### Completion counts

`completedStepCounts` is a `Map<string, number>` keyed by `countKey`, incremented
after each step completes (`src/runtime/run/graph-runner.ts:814`) and rebuilt on
resume from `step.completed` trace entries
(`src/runtime/run/trace-evidence.ts:151-166`). A changed step set produces three
failure modes the seam must handle explicitly:

- **Orphaned keys.** The displaced step's count is now dead weight. Harmless to
  reads, but it must not be treated as "the subtree entry has already run."
- **Zeroed keys.** Fresh subtree step ids start absent, i.e. count 0, which is
  correct: they have not run. The seam must ensure the entry id is genuinely fresh
  so it does not inherit a stale count.
- **Misaligned slice keys.** Covered by the refuse-inside-a-slice default above;
  outside a slice loop the keys are bare step ids and a splice is safe as long as
  ids are fresh.

### The migration contract

After a splice, before the loop continues, all four must hold together: the cursor
points at the subtree entry; every previously-dangling route is re-homed onto a
subtree exit; the `steps` Map, `activeFlow`, and `activePackageIndex` agree; and no
subtree id collides with a completed id. If any cannot be established, the splice is
refused and the discovery is recorded as a finding, leaving the run on its current,
still-valid flow. This is the additive reshaper's finding fallback generalized to
the structural case.

## The re-added block-catalog gate

The additive reshape path re-resolves equipment and re-validates only the
executable-flow shape (`CompiledFlow.safeParse`,
`src/flows/compile-schematic-to-flow.ts:690`, called inside the reshaper closure);
it deliberately does **not** re-run `collectSchematicCatalogIssues`, because an
additive equipment change cannot make a previously-legal route or contract illegal.
A structural splice can: it adds and re-homes routes and introduces new blocks with
their own contracts. So the gate that the additive case skips has to come back for
the structural case.

The clean way to get it is to route the structural recompile through the full
`compileSchematicToCompiledFlow` chain (gate at `:760-767`), not through the
lighter `safeParse`-only path the equipment reshaper uses. That makes the gate the
splice's safety floor for free: an illegal subtree, or a re-homing that leaves a
route dangling, fails to compile, the seam catches it, and the run continues
unspliced on its current flow. Fail-closed, exactly as the additive miss already
downgrades to a finding. This is the second reason the seam is a different class of
change from Step 2: it re-opens a gate, and the gate is load-bearing.

## The resume contract

Resume rebuilds run state from the durable trace when
`options.resumeCheckpoint !== undefined` (`src/runtime/run/graph-runner.ts:279`).
It already reseeds four things from the trace: skill-hook injections
(`seedSkillHookInjectionsFromTrace`, `trace-evidence.ts:133-149`), the
power-inference tier (`seedPowerInferenceFromTrace`, called at `graph-runner.ts:420`),
the completion counts (`completedStepCountsFromTrace`, `trace-evidence.ts:151-166`),
and the recovery-corridor structural identity (`corridor.seedFromTrace`,
`recovery-corridor.ts:183-205`). These are the precedents a structural reseed
follows.

There are two distinct problems, and they must not be conflated.

- **F1, the latent additive gap.** An equipment reshape honored before a checkpoint
  is not reseeded today: a resumed run rebuilds from the original flow bytes and
  starts without the injected equipment (`graph-runner.ts:421-435`). This is inert
  in every shipped flow only because a reshape fires off a passing relay verdict
  and resume always re-enters at a checkpoint boundary, so the two cannot coincide.
  The fix is a `seedEquipmentReshapeFromTrace` that mirrors the existing reseeds.
  It is small, additive, and a prerequisite the seam should land first - because
  the structural case removes the coincidence that keeps F1 inert.

- **The structural reseed changes the shape resume rebuilds from.** Every existing
  reseed restores *state on a fixed flow shape*: which skills, which tier, which
  counts, which recovery route. A structural splice changes the *shape* - the step
  set the resumed run must rebuild is no longer the original compiled bytes. So a
  structural reseed cannot just restore a value; it must re-derive the spliced flow
  before the counts and routes mean anything. Concretely, the trace must persist
  enough to replay the splice deterministically (the discovery, the resolver
  inputs, and the resulting subtree's identity), and the resume path must re-apply
  the splice in trace order *before* `completedStepCountsFromTrace` runs, or the
  rebuilt counts will be keyed against a step set that no longer exists. This is the
  `seedReshapeFromTrace` the structural case needs, and it is strictly more than
  F1's reseed: F1 restores skills onto the same steps; this restores the steps.

The resume contract is therefore: persist the splice as a replayable trace event;
on resume, replay splices in order to reconstruct the live step set; only then
rebuild the cursor, routes, and counts against that set.

## Conservative defaults

These are the defaults the seam ships with, every one of them inherited from a rule
the additive path or the sibling specs already established.

- **Decompose-down only.** Turning one step into several adds verification surface;
  collapsing several into one removes it. Re-holding (the up direction) defaults to
  the finding path and is out of scope for the first build. This is the structure
  resolver's own lean toward whole-unless-unambiguous, applied at runtime.
- **Bounded, with the shipped budget and cycle guard.** A splice consumes the same
  per-run reshape budget and the same ancestor cycle guard the foundation already
  threads. A splice that targets a step that already triggered a reshape this run
  is refused. No new bound is invented.
- **Unambiguous signal only.** A splice fires only on a strong, confirmed discovery
  (a confirmed scope blow-up), never on a hunch, the same gate the additive reshaper
  applies to equipment discoveries.
- **Refuse inside a slice loop.** Per the corridor keying hazard above.
- **Fail-closed everywhere.** Any failure to establish the migration contract, or
  any catalog-gate failure on the re-compiled subtree, leaves the run on its current
  flow with a recorded finding. A splice never half-applies.

### What the demonstrator should establish first

Step 0 of the recompile fork is a pure, free, offline demonstrator
(`experiments/flow-lab/recompile-demonstrator.ts`) that fires the real
assemble-compile chain on a simulated discovery, bounded, with the catalog gate as
the floor. The splice seam gets the same treatment before any `src/` work: extend
that demonstrator to actually splice a subtree into a remaining step set and score
the migration - does the cursor land on the entry, do the re-homed routes resolve,
does the gate reject a deliberately-illegal splice, do the completion counts stay
coherent. The demonstrator is where the seam's contract is proven at zero engine
risk, exactly as the additive mechanism was proven before Step 2 shipped.

## Phased build plan (each phase has its own gate)

This is a sequence for a future build, not a task list to act on now. Each phase is
separately ratifiable; none begins without explicit go.

1. **Phase 0 - offline splice demonstrator (free, throwaway, never `src/`).**
   Extend the recompile demonstrator to splice and migrate, and prove the migration
   contract and the re-run gate against a deliberately-illegal splice. Gate to
   Phase 1: the demonstrator shows a coherent migration and a fail-closed reject.
2. **Phase 1 - `seedEquipmentReshapeFromTrace` (F1), additive, on its own.** Close
   the latent additive resume gap first, while it is still small and the coincidence
   that keeps it inert still holds. This is the only phase that is not itself
   gated behind structural ratification, because it hardens the additive path that
   already shipped.
3. **Phase 2 - the structural seam in `src/` behind an engine flag, decompose-down
   only.** The `spliceIntoRemainingSteps` branch, modeled on the slice-loop advance,
   routing the recompile through the full catalog gate, with the migration contract
   and the conservative defaults. Failing-test-first; the flag defaults off so a
   non-splicing run is byte-identical to today. Gate to Phase 3: the seam proves the
   contract live on a real flow, and the structural reseed (`seedReshapeFromTrace`)
   restores a spliced flow on resume.
4. **Phase 3 - splice-as-leaf on the same seam (fork i Option A).** With the seam
   proven for structural recompile, point it at a named flow's compiled steps so a
   sub-tree inlines where a leaf would sit. This relocates the isolation boundary
   the sub-run path gives for free, which is a deliberate design choice that wants
   its own ratification on top of the seam's. Same flag discipline.

The ordering is deliberate: F1 before structural, structural recompile before
splice-as-leaf, each behind a flag, each proven offline first. The cheap, additive,
already-shipped work is the floor; the seam is the one expensive, gated step; the
two forks then share it.

## What this spec does NOT do

It builds nothing. There is no `spliceIntoRemainingSteps` in `src/`, no structural
auto-reshape, no splice-as-leaf, no new execution kind, no engine flag. It does not
extract a resolver abstraction. It is a surface-only design, the same status as the
two sibling deepfork specs, and it exists so the structural decision is decision-ready
when an operator chooses to ratify it.

## Open questions for ratification

- **Subtree id allocation.** What namespace guarantees a spliced subtree's step ids
  are fresh against both the live set and the completed-id history? A prefix derived
  from the displaced step id is the obvious candidate; it needs a collision proof.
- **Trace event shape for replayable splices.** What is the minimal durable record
  that lets resume reconstruct the splice deterministically without re-running a
  model? The discovery plus the resolver inputs plus the resulting subtree identity
  is the candidate; it must be enough on its own.
- **Gate cost at runtime.** The full `compileSchematicToCompiledFlow` chain runs the
  catalog gate every splice. Is that acceptable per-splice latency under the budget
  of 3, or does the gate need a cheaper structural-only mode?
- **Whether splice-as-leaf wants the isolation boundary back.** Fork (i) Option B
  keeps child-run isolation deliberately. If inlining loses containment that some
  callers want, the seam may need an inline-or-child choice per call site rather
  than a global mode. This is fork (i)'s ratification question, surfaced here
  because the seam is where it lands.

# Recompile foundation run report

This run built the safe foundation for two decision-layer forks: adaptive
bubble-up-recompile and uniform recursion. It built Steps 0 and 1 only. It did
not build the live recompile path, the splice seam, splice-as-leaf, structural
auto-reshape, or the reduced-bindings oracle. Those are Steps 2 and 3, deferred
and separately ratified.

Specs this run followed (their recommendations and conservative defaults were
taken as given, not re-decided):

- `docs/ideas/deepfork-adaptive-bubble-up-recompile-spec.md`
- `docs/ideas/deepfork-uniform-recursion-e3-spec.md`

## What landed

| Step | Where | Merge |
|---|---|---|
| Step 1 — the recursion bound | `src/` (engine) | `995a4526` |
| Step 0 — offline recompile demonstrator | `experiments/flow-lab/` (spike) | `da845d76` |

Final main SHA after both merges: `da845d76`. Full `npm run verify` was green
on the branch before merge (336 test files, 3590 tests, 6 skipped) and is
re-run on the integrated main as the closing gate of this run.

## Step 0 — the offline recompile demonstrator (findings)

`experiments/flow-lab/recompile-demonstrator.ts` is a throwaway spike. It never
moves to `src/`. It makes no model calls, runs nothing live, and adds no engine
seam. It proves the *mechanism*: a runtime discovery can re-resolve, re-assemble,
and re-compile the remaining flow through the chain that already exists, bounded,
and the catalog gate inside compile is the safety floor.

The chain it fires is the production one, unchanged:

```
AssemblySpec
  -> resolveStructure / resolveEquipment        (the real decision-layer resolvers)
  -> applyStructure / applyEquipment            (re-resolve the REMAINING spec)
  -> assembleFlowSchematic                       (throws on a bad shape)
  -> compileSchematicToCompiledFlow              (catalog gate = safety floor)
```

A discovery is what a step learns at run time that the assembly-time choice did
not know. Three kinds were exercised:

- **turned-out-bigger** — the step's scope blew up. Reshape: decompose-down.
- **turned-out-react** — a framework was confirmed. Reshape: inject the skill now.
- **re-hold** — the work collapsed into one trivial edit. Reshape: fold steps.

### Which reshapes are safe to auto-apply, and which stay finding-only

All numbers below are measured by the demonstrator from the pure chain, not
asserted by hand.

- **Equipment injection (turned-out-react) — safe to auto-apply.** On a relay
  that assembly-time resolution left unequipped, the reshape compiles, strictly
  reduces slot debt (3 to fewer), and introduces no new issue class (every
  quality class count after the reshape is less than or equal to its count
  before). It is purely additive: it equips a step that is already in the
  remaining sequence. It does not change the step sequence, so it needs no
  splice.

- **Decompose-down (turned-out-bigger) — safe in direction, but needs a splice.**
  The decomposed grain carries more verification surface than the whole grain
  (verify-plus-review steps 4 vs 1), so decompose-down never reduces verification
  surface. It is the conservative direction. But it replaces one step with
  several, which changes the remaining sequence. That is the splice seam, which
  is Step 2/3 surface, not built here.

- **Re-hold (fold) — finding-only, permanently.** Re-holding removes verification
  surface, so the conservative default refuses it even when budget is available.
  The demonstrator returns a finding the step would hand the operator as a
  checkpoint (Option B), with the spec unchanged.

### The safety floor holds

An illegal reshape (a remaining spec whose route target names a step id that does
not exist) returns `reshaped: false` with a safety-floor finding, and the
underlying chain independently rejects it (`chainRejected: true`, the
assemble/compile gate reporting `route target references unknown schematic item
id`). The reshape fails rather than producing a broken tail. This is the property
that makes a live reshape thinkable at all: the same gate that protects composed
and edited flows today protects a recompiled tail.

### The bound holds

The demonstrator threads the same shape of bound the live path would need: a
per-flow reshape budget plus a same-step cycle guard. Budget `{ remaining: 0 }`
downgrades to finding-only immediately. A same-step cycle honors the first
reshape and refuses the second as finding-only.

### Do the conservative defaults hold? Does selection-under-abundance bite?

Yes, and no. All four conservative-default claims came back true:
re-hold-always-finding-only, decompose-down-never-reduces-verification-surface,
equipment-reshape-never-adds-issue-class, and
equipment-reshape-reduces-slot-debt-when-present. Across nine scenarios, no
honored reshape made quality strictly worse, so the "selection under abundance"
risk (runtime re-resolution picking a worse flow because it now has more to
choose from) did not bite in this set. That is a green light for the *direction*,
measured on a small representative set, not a guarantee at scale.

## Step 1 — the recursion bound (the engine change)

Recursion was unbounded. A sub-run step could start a child flow that re-enters
an ancestor, and the descent ended only when the process died. This run bounded
it.

- **Depth cap.** `RECURSION_DEPTH_CAP = 8`. A top-level run starts at depth 0;
  each child is one level deeper; the child at exactly the cap runs, and its
  child (cap plus one) is refused.
- **Cycle guard.** An ancestor-flow-id set is carried parent-to-child. A child
  whose flow id is already in the chain is refused on the first repeat, with a
  message that names the chain (`a -> b`).
- **Both child-run edges carry the bound, not just the named one.** The
  single-child sub-run executor (`src/runtime/executors/sub-run.ts`) and the
  fanout sub-run branch (`src/runtime/fanout/branch-execution.ts`) both spawn a
  child run through the same path. Guarding only the first would leave a fanout
  of sub-runs unbounded. Finding and closing the second edge was the main piece
  of work beyond the named scope.
- **State is threaded like `unattended`.** It lives on `RunContext`, both
  `CompiledFlowRunOptions` types, and `GraphRunnerOptions`; it is seeded at
  bootstrap (depth 0, ancestors = the top flow id) and forwarded, incremented and
  extended, at each hop. The ancestor set is a `Set`, forwarded in-process by
  reference; it must never cross a JSON or disk boundary (it would stringify to
  `{}`), and that invariant is now documented at the seed and the field.
- **Compile-time self-reference reject.** A flow that statically names itself as a
  child-run target can never make progress, so the compiler rejects it up front,
  before the catalog gate. Both child-run shapes are covered: a sub-run item and
  a static fanout branch. A dynamic fanout template is left to the runtime guard
  on purpose, because its target can be a runtime placeholder rather than a
  statically known id.

### Tests proving the bound

- `tests/runtime/recursion-bound.test.ts` — executor-level cap refuse, cap
  boundary allow, cycle refuse, and two propagation tests (depth and ancestor set
  forwarded correctly).
- `tests/contracts/compile-schematic-self-ref.test.ts` — compile-time reject for a
  sub-run item and for a static fanout branch that names the flow's own id, plus a
  control that the unmodified flow still compiles.
- `tests/runner/recursion-bound-real.test.ts` — a real `A -> B -> A` cycle through
  the live runner (refused on the first repeat), and a real chain of distinct
  non-repeating flows where only the depth counter can stop the descent (exactly
  cap-plus-one run folders exist; the deepest child is refused before it starts).
- `tests/runner/fanout-recursion-bound.test.ts` — the fanout edge: cycle refuse,
  cap refuse, and inert pass-through below the cap.

The two real-path tests cannot be run red in the normal sense, because a broken
bound would recurse forever. The cycle test documents that. The depth-cap chain
test is made safe to run red by defining finitely many flows, so a broken cap
descends through them and then throws on an undefined target id rather than
looping.

### Review outcome

A three-lens adversarial review (correctness and bypass, regression, threading
completeness) found the bound sound: no off-by-one, no diamond false-positive, no
shared-Set bleed between sibling fanout branches, no unguarded descent edge, no
bypass, complete state threading across every hop, and both host runtime bundles
carrying the guard. It surfaced one medium and two low findings, all addressed:

- **Medium** — the compile-time self-reference reject missed the fanout edge. It
  was still caught at run time by the cycle guard, but the two edges should report
  it identically. Fixed: the detector now also rejects a static fanout self-ref,
  with a failing-first test.
- **Low** — no real-path test for the depth cap alone. Added the distinct-flow
  chain test above.
- **Low** — future-footgun comments documenting the Set-serialization and
  thread-at-every-spawn invariants. Added.

## Recommendation: how to take Step 2 (the first live reshape)

Take equipment injection (turned-out-react) as the first live reshape, and only
that.

Reasoning:

1. **It is the only honored reshape that needs no splice seam.** Equipment
   injection equips a step that is already in the remaining sequence. It does not
   add or remove steps, so the live path is exactly re-resolve-equipment plus
   re-compile-the-remaining-spec. It needs no new executor kind and no machinery
   for editing the remaining step sequence. Decompose-down, by contrast, replaces
   one step with several; that is the splice seam, and it is Step 2/3 surface.

2. **The demonstrator measured it as the safest case.** Additive, strictly
   reduces slot debt, never adds an issue class. The catalog gate rejects an
   illegal result before it can become a broken tail.

3. **The recursion bound is the prerequisite that just landed.** Any live reshape
   that can introduce or re-enter a sub-run needs the depth cap and cycle guard
   underneath it. That is now in place, so a live reshape no longer risks
   unbounded recursion.

Concretely, Step 2 should: add a single live trigger for a confirmed
turned-out-react discovery, re-resolve equipment on the remaining spec, re-compile
through the existing chain (so the catalog gate stays the floor), thread the
reshape budget and cycle guard the demonstrator already shapes, and keep re-hold
and decompose-down out (re-hold stays finding-only forever; decompose-down waits
for the splice seam in a later ratified step). Hold the reduced-bindings oracle as
deferred; it was not built and is not needed for the equipment-injection path.

Stop before anything that reshapes the remaining step *sequence* (splice,
splice-as-leaf, structural auto-reshape). That boundary is the line between Step 2
and Step 3.

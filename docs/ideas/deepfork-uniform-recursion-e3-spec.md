# Deep fork (i): uniform recursion (E3)

> Status: **surface-only spike + decision-ready spec.** Written 2026-06-16.
> This is a B4 "deep fork." It is a throwaway spike captured as a spec, not a
> build. **It must never be merged into `src/`.** The code sketch below is
> illustrative only - it shows the shape, it is not committed and not tested.
>
> Grounded against `origin/main` at `571e0523`. File:line references verified
> in `/Users/petepetrash/Code/circuit`.

## The fork in one line

Today a nested flow runs as an isolated child process. The fork: should the
engine instead treat "this step's body is sub-tree X" the same way it treats a
single relay - so recursion is uniform, not a hand-authored special case?

## What's true today (the starting point)

A flow can already embed another flow, but only as a **child run**, never as an
inline leaf:

- A leaf relay compiles to `executor: 'worker'`, `kind: 'relay'`
  (`src/flows/compile-schematic-to-flow.ts:372-373`).
- A nested flow compiles to `executor: 'orchestrator'`, `kind: 'sub-run'`
  (`src/flows/compile-schematic-to-flow.ts:409-410`), bound to its own executor
  (`src/runtime/executors/index.ts:49`).
- The two are **different code paths**. The sub-run executor spins up a whole new
  run folder, runs the child to its own `result.json`, and admits it back into
  the parent only on the child's verdict (`src/runtime/executors/sub-run.ts`,
  child run dir created at `:159-160`, verdict admission per the file header).

So "flow = composite harness" is true for the *run-a-child* case and false for
the *inline-subtree* case. Goal embeds fix/build/review as sub-runs
(`src/flows/goal/data.ts`); none of them splice in as a leaf.

Three concrete gaps make the inline case not yet real:

1. **Two executor paths.** A relay and a sub-run are dispatched at the same place
   (`executors[step.kind](step, stepContext)`,
   `src/runtime/run/graph-runner.ts:539`) but resolve to different executors with
   different isolation boundaries.
2. **The legibility oracle is a stub.** `resolveBindingLegibility` returns an
   empty `reducedBindings` (`src/runtime/run/binding-legibility.ts:101-102`); the
   docblock at `:92-95` says the non-empty case "needs the block-level needs
   model composed flows bring." The run-bootstrap trace writes that empty set
   today (`src/runtime/run/graph-runner.ts:425`).
3. **No recursion bound.** `child_depth: step.depth`
   (`src/runtime/executors/sub-run.ts:171`) is an **axis dial**, not a recursion
   counter. The sub-run executor passes `childRunner` straight to the child
   (`src/runtime/executors/sub-run.ts:193`), so a flow that sub-ran itself would
   loop with nothing stopping it. There is no depth cap and no cycle guard
   anywhere in `src/`.

This fork is **unblocked**: the assembler precondition (M4/M7/M9) is met. It is
the explicit operator ratification item from the readiness audit.

## The fork: two designs

### Option A: splice-as-leaf (unify the paths)

The engine learns to inline a sub-tree where a leaf relay would sit. "Run sub-tree
X" becomes a step the runner expands into X's steps in the parent's own run
folder, threading the parent's reads/writes through X's seam. There is one
dispatch path; recursion is the same machinery as sequencing.

- **Pro:** genuinely uniform. A flow is substitutable for a leaf, which is the
  strong form of the claim. Repair edges, the trace alphabet, and the catalog gate
  all apply to the inlined sub-tree without a second isolation boundary.
- **Con:** the inlined sub-tree shares the parent's tree and trace, so an error in
  X is no longer contained behind a child `result.json`. Isolation, which the
  sub-run path gives for free, must be re-earned where it is actually wanted.

### Option B: keep child-run isolation (status quo, hardened)

Leave the two paths separate. Add only the bound (depth cap + cycle guard) and the
non-empty `reducedBindings` oracle. Recursion stays "run a child," but it stops
being unbounded and stops being illegible.

- **Pro:** cheap, safe, no engine-shape change. The isolation boundary is a
  feature, not a cost.
- **Con:** not uniform. A sub-tree is still a different kind of thing from a leaf,
  so the "leaf-substitutable" claim is never delivered - only made safe.

## Recommendation

**Option A is the destination; ship Option B's two safety pieces first, then take
A behind a flag.** The bound and the oracle are needed under *both* options and are
cheap, so build them now regardless. Splice-as-leaf is the real prize but it
relocates the isolation boundary, which is a deliberate design choice that wants
its own ratification - do not fold it into the safety pass. Sequence:
(1) depth cap + cycle guard, (2) non-empty `reducedBindings`, (3) splice-as-leaf
behind an engine flag, proven against the existing sub-run machinery first.

## The bounded-recursion design (needed under both options)

The question is *where the counter lives*. Three candidates, picked by where the
recursion edge is actually created:

- **In the step (wrong).** `step.depth` is an axis dial, not a counter
  (`src/runtime/executors/sub-run.ts:171`). Reusing it conflates "how much budget"
  with "how deep am I." Reject.
- **In the run context, threaded child-to-child (recommended).** The sub-run
  executor already passes `childRunner` to the child
  (`src/runtime/executors/sub-run.ts:193`). Thread a `recursionDepth` and an
  ancestor-flow-id set alongside it. Each child increments depth and adds its
  flow id; the executor refuses to start a child when depth exceeds a cap *or*
  when the child's flow id is already an ancestor (the cycle guard). This is the
  right seat because the recursion edge is created exactly here.
- **In the compiler (partial).** The compiler can reject a *statically* self-
  referential flow, but it cannot see runtime-resolved recursion (a flow chosen at
  runtime). So a compile-time check is a useful early reject, not the whole guard.

The cycle guard matters as much as the depth cap: a depth cap alone would let
A->B->A->B churn up to the cap before failing. The ancestor set fails it on the
first repeat with a legible reason.

## The reduced_bindings work (the legibility leg)

`reducedBindings` is structurally wired end to end but always empty
(`src/runtime/run/binding-legibility.ts:101-102`, written at
`src/runtime/run/graph-runner.ts:425`). It exists to make a *lost* binding
legible: a composed flow that needs a binding its manifest omits. The docblock is
explicit that lighting it up needs "the block-level needs model composed flows
bring." So the work is: derive each composed/recursive sub-tree's *needed*
bindings from its blocks, compare against what the manifest supplies, and emit the
shortfall into `reducedBindings`. Until a recursive flow actually composes blocks
with needs the manifest can fail to cover, this set stays empty by construction -
which is why the legibility leg waits on real recursion, not the reverse.

## What it would take in `src/` (Option A path unification)

This is the surface for a *future* build, not a task list to act on now:

1. A new schematic execution kind (or a flag on the existing one) meaning
   "inline sub-tree" rather than "run child." Authored in `data.ts`, compiled in
   `src/flows/compile-schematic-to-flow.ts` near the existing relay/sub-run cases
   (`:372`, `:409`).
2. A runner expansion step in `src/runtime/run/graph-runner.ts` that, on entering
   an inline-subtree step, splices the sub-tree's steps into the live step
   sequence - reusing the existing slice-loop advance machinery
   (`iteratesSliceLoop` / `advanceRoute`, `src/runtime/run/graph-runner.ts:356`,
   `:577-578`) as the closest existing precedent for "the runner reshapes its own
   remaining steps."
3. The catalog gate already runs on every compile
   (`compileSchematicToCompiledFlow` -> `collectSchematicCatalogIssues`,
   `src/flows/compile-schematic-to-flow.ts:709`), so the inlined sub-tree's seam
   is checked for free as long as it is expanded *before* compile, or re-checked
   after expansion.
4. The bound + oracle above.

## Throwaway code sketch: inline-subtree-as-leaf on the sub-run machinery

> **Illustrative only. Not committed. Not tested.** This shows how the cheapest
> first prototype rides the *existing* sub-run executor: it adds the bound (so the
> demo is safe) and shows where inline expansion would diverge from child-run.

```ts
// THROWAWAY SPIKE - do not merge. Shows the bound + the path fork only.

// 1. The bound, threaded child-to-child through the run context.
interface RecursionGuard {
  readonly depth: number;        // increments per descent
  readonly cap: number;          // hard ceiling, e.g. 8
  readonly ancestors: ReadonlySet<string>; // flow ids on the path to here
}

function descend(guard: RecursionGuard, childFlowId: string): RecursionGuard {
  if (guard.depth + 1 > guard.cap) {
    throw new Error(`recursion depth cap ${guard.cap} exceeded at '${childFlowId}'`);
  }
  if (guard.ancestors.has(childFlowId)) {
    throw new Error(`recursion cycle: '${childFlowId}' is already an ancestor`);
  }
  return {
    depth: guard.depth + 1,
    cap: guard.cap,
    ancestors: new Set([...guard.ancestors, childFlowId]),
  };
}

// 2. The fork, at the point sub-run.ts:177 calls context.childRunner.
//    Today: ALWAYS run an isolated child.
//    Spike: branch on the step's binding - inline vs child - but apply the
//    SAME guard either way.
async function runNested(step: NestedStep, context: RunContext, guard: RecursionGuard) {
  const next = descend(guard, step.flowRef); // bound applies to BOTH modes

  if (step.mode === 'child') {
    // Existing path (sub-run.ts:177): isolated run folder, admit on verdict.
    return context.childRunner({ /* ...as today... */, recursion: next });
  }

  // SPIKE: inline-as-leaf. Expand the sub-tree into the PARENT's step
  // sequence instead of a child folder. This is the path-unification half:
  // the sub-tree's steps become leaf steps the parent runner dispatches
  // through the one executors[step.kind] path (graph-runner.ts:539). The
  // parent's reads/writes thread through the sub-tree's seam; no second
  // result.json, no second isolation boundary.
  const subtree = await context.resolveSubtree(step.flowRef);
  return context.spliceIntoRemainingSteps(subtree.steps, { recursion: next });
  // ^ spliceIntoRemainingSteps is the NEW seam this fork would need; the
  //   slice-loop advance machinery (graph-runner.ts:356/577) is the nearest
  //   existing precedent for the runner reshaping its own remaining steps.
}
```

The sketch's point: the **bound is shared and cheap** (build it now under either
option), while the **inline branch is the real, isolation-relocating change** that
splice-as-leaf requires and that wants its own ratification.

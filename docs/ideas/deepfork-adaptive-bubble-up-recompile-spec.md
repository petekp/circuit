# Deep fork (iii): adaptive bubble-up-recompile

> Status: **surface-only spike + decision-ready spec.** Written 2026-06-16.
> A B4 "deep fork": a throwaway spike captured as a spec. **It must never be
> merged into `src/`.** The code sketch below is illustrative only - not committed,
> not built.
>
> Grounded against `origin/main` at `571e0523` and the two resolvers in
> `/Users/petepetrash/Code/circuit-flow-lab/experiments/resolvers/`.

## The fork in one line

A step discovers mid-run that its grain or equipment was wrong ("turned out bigger
-> decompose further"; "turned out to be React -> inject the skill now"). Should it
**bubble that finding up and trigger a re-resolve + re-assemble + re-compile of the
remaining flow** - the runtime-deferred, decide-as-you-go path - or hand the
finding off as a checkpoint to the operator?

This is the up-pass of the decompose-down / assemble-up V (the design-repair edge)
plus runtime binding time.

## What's true today (the binding-time floor)

Both resolvers bind **assembly-only** (`SHARED-SHAPE.md` row 4):
`binding_time: 'assembly'` is hardcoded in both
(`experiments/resolvers/structure.ts:49`, `experiments/resolvers/equipment.ts:57`).
The shape *allows* `'runtime'` as a parameter, but neither instance exercises it.
The decision-layer note is explicit that equipment is the axis that most *wants*
runtime deferral, and that "selection under abundance" might return at runtime
badly enough to need its own conservative defaults
(`decision-layer-exploration.md` §4, §9).

Two facts make an offline demonstrator possible without any engine change:

- **The assemble -> compile chain is pure.** `assembleFlowSchematic`
  (`src/flows/assemble-flow-schematic.ts:79`) takes a spec and returns a validated
  schematic; `compileSchematicToCompiledFlow`
  (`src/flows/compile-schematic-to-flow.ts:700`) takes a schematic and returns a
  compiled flow, running the catalog gate
  (`collectSchematicCatalogIssues`, `:709`) on the way. Both are deterministic
  functions of their input. You can re-run them on a reshaped spec entirely
  offline.
- **The runner already reshapes its own remaining steps in one case.** The
  slice-loop redirects to the loop head via a declared advance route
  (`iteratesSliceLoop` / `advanceRoute`, `src/runtime/run/graph-runner.ts:356`,
  `:577-578`). That is the nearest existing precedent for "the runner does not just
  walk a fixed list."

## The fork: two designs

### Option A: re-resolve and recompile the remaining flow

A step emits a `reshape` signal. The runner re-runs the relevant resolver(s) with
the new runtime context, re-assembles a spec for the *remaining* steps, re-compiles
it through the pure chain, and continues on the recompiled tail.

- **Pro:** this is the actual adaptive promise - a flow that genuinely adjusts to
  what it discovers. It is the up-pass of the V realized as runtime behavior.
- **Con:** it is the most powerful and the most dangerous. Recompilation mid-run
  means the flow you previewed is not the flow that ran; legibility-before-you-run
  is lost for the recompiled tail. And it opens a recompile loop (step reshapes ->
  recompile -> step reshapes again) that must be bounded.

### Option B: hand off as a finding / checkpoint to the operator

The step records the same finding, but instead of recompiling, it stops at a
checkpoint (the existing `checkpoint` kind, `src/runtime/run/graph-runner.ts:234`)
and surfaces "I think this should decompose further / pick up React skills - your
call." The operator re-runs with an adjusted shape.

- **Pro:** keeps the human in the loop on a structural change, which is the
  conservative default the decision-layer note asks for. No new engine seam, no
  recompile-loop risk.
- **Con:** not adaptive in the live sense. Every reshape costs a human round trip,
  which defeats the "decide-as-you-go" value when the discovery is unambiguous
  (it really *is* React).

## Engine-seam vs step-entry-hook surface

The open grounding question is whether runtime binding needs a **new engine seam**
or can ride the **existing step-entry surface**. The honest read:

- **The recompile itself needs no new engine code.** The assemble -> compile chain
  is pure and callable from anywhere
  (`src/flows/assemble-flow-schematic.ts:79`, `compile-schematic-to-flow.ts:700`).
- **The trigger and the splice do need a seam.** The runner dispatches steps
  through `executors[step.kind](step, stepContext)`
  (`src/runtime/run/graph-runner.ts:539`) and then walks to the next step. There
  is no current point where a step's *outcome* reshapes the *remaining sequence*
  beyond the slice-loop's advance route (`:577-578`). The minimal seam is: a
  step-outcome that carries a `reshape` signal, plus a runner branch that, on that
  signal, recompiles the tail and splices it in - modeled on the slice-loop's
  existing "reshape my remaining steps" precedent rather than a wholly new
  execution kind. This is the same `spliceIntoRemainingSteps` seam fork (i) would
  also want, which is a reason to design them together.

So: ride the step-entry / step-outcome surface for the **trigger**, reuse the pure
chain for the **recompile**, add **one new runner branch** for the splice. No new
executor kind required.

## Conservative defaults for the runtime case

The decision-layer note (§9) flags that "selection under abundance" may return at
runtime. The conservative defaults the runtime case needs:

- **Reshape only on an unambiguous signal.** The same rule as the static
  resolvers (`structure.ts:61-86` leans to whole unless a decompose signal is
  unambiguous), applied to runtime: a step reshapes only when the discovery is
  strong (a confirmed framework, a confirmed scope blow-up), not on a hunch.
- **Reshape down, not up, by default.** Decomposing further (turning one step into
  several) is safer than re-holding (collapsing several into one), because the
  former adds verification surface and the latter removes it. Default to the
  finding-only path (Option B) for any *re-holding* reshape.
- **Equipment reshape is additive and therefore cheaper.** Injecting a skill
  mid-run is `trusted` (additive, no withhold, `equipment.ts:118-129`), so an
  equipment reshape does not invalidate prior work - it is the safest runtime
  reshape and the natural first one to allow.

## Bounded re-compilation safety (where the bound lives)

A recompile loop must be bounded or a flow could reshape forever. The bound lives
in the **run context**, as a `reshapeBudget` counter threaded the same way the
recursion guard in fork (i) is threaded (and ideally the *same* mechanism): each
reshape decrements the budget; at zero, further reshape signals are downgraded to
findings (Option B) rather than honored. A per-flow cap (e.g. 3 reshapes) plus a
"no reshape may target a step that already triggered a reshape this run" guard
(the cycle analogue) prevents the A->reshape->A churn. The bound is cheap and is
required under Option A regardless of anything else.

## Recommendation

**Build the offline demonstrator now (it is free); gate live recompile behind
Option B as the default.** The assemble -> compile chain's purity makes a
demonstrator a pure-function exercise with zero engine risk - author a spec,
fire a simulated runtime signal, recompile the tail, score it. That proves the
*mechanism* and reveals whether the selection-under-abundance risk actually bites.
For the live engine path: ship the **finding/checkpoint** (Option B) first as the
conservative default, allow **equipment reshape** (additive, safe) as the first
live Option-A case, and hold structural re-decomposition behind the bound + the
"decompose-down only by default" rule. Co-design the splice seam with fork (i) -
both want the same `spliceIntoRemainingSteps` runner branch.

## Throwaway code sketch: a runtime-fired resolver re-shaping the remaining flow

> **Illustrative only. Not committed. Not built.** This rides the pure assemble ->
> compile chain on a discovered signal. It shows the offline demonstrator shape -
> the engine trigger would wrap this same call behind the bound.

```ts
// THROWAWAY SPIKE - do not merge. The pure-chain recompile, fired from a
// runtime discovery, bounded.
import { assembleFlowSchematic } from '../src/flows/assemble-flow-schematic.js';
import { compileSchematicToCompiledFlow } from '../src/flows/compile-schematic-to-flow.js';
import { resolveStructure, applyStructure } from './resolvers/structure.js';
import { resolveEquipment, applyEquipment } from './resolvers/equipment.js';

interface ReshapeBudget { remaining: number; touched: Set<string>; }

// A discovery a step bubbles UP: what it learned at runtime that the
// assembly-time choice did not know.
interface RuntimeDiscovery {
  readonly from_step: string;
  readonly kind: 'turned-out-bigger' | 'turned-out-react';
  readonly evidence: string;
}

// Re-resolve + re-assemble + re-compile the REMAINING spec from a discovery.
// Pure: same chain the static path uses, just fired later with new context.
function reshapeRemaining(
  remainingSpec: AssemblySpec,
  discovery: RuntimeDiscovery,
  budget: ReshapeBudget,
) {
  // Bound: refuse if out of budget or this step already reshaped (cycle guard).
  if (budget.remaining <= 0 || budget.touched.has(discovery.from_step)) {
    return { reshaped: false, finding: `reshape budget exhausted; handing off as checkpoint`, spec: remainingSpec };
  }

  let nextSpec = remainingSpec;
  if (discovery.kind === 'turned-out-bigger') {
    // Decompose-down: conservative direction (adds verification surface).
    const r = resolveStructure(
      { summary: discovery.evidence, surface_area: 'large', risk: 'medium', explicit_decompose: true },
    );
    nextSpec = applyStructure(nextSpec, r);
  } else {
    // Equipment reshape: additive, trusted, safest live case.
    const r = resolveEquipment(
      { step_id: discovery.from_step, role: 'implementer', domain_tags: ['react'] },
    );
    nextSpec = applyEquipment(nextSpec, [r]);
  }

  // The pure chain: assemble -> compile. The catalog gate runs inside compile
  // (compile-schematic-to-flow.ts:709), so an illegal reshape FAILS here
  // rather than producing a broken tail. This is the safety floor.
  const schematic = assembleFlowSchematic(nextSpec);
  const compiled = compileSchematicToCompiledFlow(schematic);

  budget.remaining -= 1;
  budget.touched.add(discovery.from_step);
  return { reshaped: true, finding: null, spec: nextSpec, compiled };
}
```

The sketch's point: the **recompile is a pure-function call on the existing chain**
(no engine change), the **catalog gate inside `compile` is the safety floor** (an
illegal reshape fails to compile rather than running broken), and the **bound +
cycle guard live in the budget** threaded through the run. The only genuinely new
engine code a live version needs is the trigger-and-splice runner branch - shared
with fork (i).

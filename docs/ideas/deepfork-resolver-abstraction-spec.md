# Deep fork (ii): the resolver abstraction

> Status: **surface-only spike + decision-ready spec.** Written 2026-06-16.
> A B4 "deep fork": a throwaway spike captured as a spec. **It must never be
> merged into `src/`.** The interface sketch below is illustrative only - not
> committed, not built.
>
> Grounded against the two real resolvers in
> `/Users/petepetrash/Code/circuit-flow-lab/experiments/resolvers/` and the shared
> shape they recorded in `SHARED-SHAPE.md`.

## The fork in one line

There are two resolvers today (structure, equipment), soon three. Should we now
extract a uniform `Resolver` type - the swappable, manifest-declared decision unit,
parallel to the block - or is that still premature?

## What's true today (the two instances)

Two resolvers exist, built side by side with **no shared code**, and they
independently landed on the same four-part shape (`SHARED-SHAPE.md`):

1. A uniform call shape: `(context, prior choices) -> one resolution for one axis`.
   `resolveStructure(task, prior)`
   (`experiments/resolvers/structure.ts:61`) and `resolveEquipment(ctx, options)`
   (`experiments/resolvers/equipment.ts:111`).
2. A comparable resolution record carrying `axis`, `choice`, `binding_time`,
   `enforcement`, `rationale` (`structure.ts:43-55`, `equipment.ts:52-67`).
3. A materializer `apply<Axis>(seed, resolution) -> spec` that rides the assembler
   (`structure.ts:149`, `equipment.ts:140`) - neither special-cases the engine.
4. A one-call convenience `resolveAndApply<Axis>(...)`
   (`structure.ts:166`, `equipment.ts:160`).

So the shape is real and consistent. The temptation is to extract it now. The
reason not to is the **four divergences** the same note records - these are the
load-bearing design content, and a premature `Resolver<T>` would flatten them.

## The four divergences (why extraction is premature)

| # | Aspect | structure | equipment |
|---|---|---|---|
| 1 | **choice scope** | one resolution **per flow** (the whole grain) | one resolution **per step** (many per flow) |
| 2 | **enforcement reality** | **enforced**: assembler materializes exactly the chosen shape, catalog gate fail-closes | **trusted only**: `skill_slots` is additive injection, no withhold |
| 3 | **failure-to-honor** | never fails (structure is always honorable) | a request for `enforced` is **downgraded** to trusted with a recorded `finding` (`equipment.ts:118-129`) |
| 4 | **binding time** | assembly only | assembly only, but equipment *wants* runtime deferral ("turned out to be React -> inject now") |

The risk is named directly in `decision-layer-exploration.md` §7 ("two instances,
then extract - extracting before the second instance is the trap") and §6 (the
axes are not strictly parallel; abstracting bakes in wrong assumptions). The
equipment instance *already violates* the easy defaults a hasty type would pick:
"one choice per flow" (false - equipment is per step), "enforcement is a claim"
(false - it is a substrate capability), "no downgrade channel" (false - equipment
needs one).

## The candidate `Resolver` type (parameterizing all four divergences)

The honest extraction does not assume one value per divergence - it makes each a
parameter. A `Resolver<TContext, TChoice>` parameterized over context type and
choice type, with the four divergences expressed as type-level and value-level
seams:

- **Divergence 1 (scope)** -> a `scope: 'flow' | 'step'` discriminant on the
  resolution, so the consumer knows whether to expect one resolution or many.
- **Divergence 2 (enforcement reality)** -> `enforcement` is **not** a field the
  resolver *claims*; it is a capability the **substrate reports per axis**. The
  resolver states what it *requested*; the substrate states what it could *honor*.
- **Divergence 3 (failure-to-honor)** -> an optional `downgraded` / `finding`
  channel, present only on axes that can fail to honor a request.
- **Divergence 4 (binding time)** -> `binding_time` stays a real parameter
  (`'assembly' | 'runtime'`), even though neither instance exercises `'runtime'`
  yet (that is fork iii).

## The manifest-declaration design

The payoff of a uniform type is that a flow's manifest declares, **per axis,
which resolver produces that choice** - so swapping a decision policy is changing
a declared reference, not editing engine code (`decision-layer-exploration.md`
§2). The plumbing precedent already exists: `skill_slots` travels manifest-first
from the schematic step through the compiled step to relay dispatch (the readiness
audit's primitive 3b confirms this path: `flow-schematic.ts` -> `step.ts` ->
`compile-schematic-to-flow.ts` -> `skill-loading.ts`). A `resolver_bindings` map on
the manifest would ride the same pattern: `{ structure: <ref>, equipment: <ref> }`.
**Critically - no by-id package lookup** (the mistake M4 had to unwind); the
binding is a manifest field, resolved like any other.

## The axis-ordering / dependency question (the hard part)

The axes are **not strictly parallel** (`decision-layer-exploration.md` §6.1).
Structure is resolved first and produces one choice per flow; equipment is
resolved per step *after* structure, and a caller may pass the structure choice as
a prior (`equipment.ts:39-42`, the `PriorChoices` argument). So a uniform
`Resolver` type cannot assume independence - it implies an **ordering / dependency
graph** among resolvers: equipment reads structure's output (how many steps exist
to equip), and context would read both. A naive `Resolver[]` flat array would lose
this. The type must either (a) carry an explicit `reads_axes: Axis[]` declaration
so the runner can topologically order resolution, or (b) keep the ordering
external (a fixed resolution pipeline the runner owns). Option (a) is more uniform
but front-runs a dependency model nobody has stress-tested. This unresolved
ordering question is itself an argument that extraction is not yet earned.

## Recommendation: a THIRD instance first (strongly yes)

**Do not extract yet. Build a third resolver - context or depth - first.** Two
reasons, both grounded:

1. `SHARED-SHAPE.md` says it outright: "the honest next step is a third instance
   (context or depth) to confirm the scope/enforcement/binding-time parameters
   before committing a `Resolver` interface." Two instances reveal a shape; a
   third confirms which parts of it are *invariant* versus *coincidental*.
2. The two existing instances already disagree on three of the four divergences.
   With only two data points you cannot tell whether "per-flow vs per-step" is a
   binary or a spectrum, or whether the downgrade channel is equipment-specific or
   general. A third instance - **context** is the strongest candidate, because it
   tests the scope and ordering parameters hardest (context depends on both
   structure and equipment) - would resolve exactly the questions the abstraction
   must answer.

The abstraction is **earnable but not yet earned.** Extract the `Resolver` type
*after* the third instance, on evidence, not on the rhyme of the first two.

## Throwaway code sketch: the candidate interface

> **Illustrative only. Not committed. Not built.** This is the shape a future
> extraction would aim at, with all four divergences parameterized. It exists to
> make the design content concrete, not to be implemented now.

```ts
// THROWAWAY SKETCH - do not merge. The shape, with the four divergences as
// explicit parameters rather than baked-in assumptions.

type Axis = 'structure' | 'equipment' | 'context' | 'depth' | 'routing'
          | 'verification' | 'role';

type BindingTime = 'assembly' | 'runtime'; // divergence 4: a real parameter

// Divergence 2: enforcement is what the SUBSTRATE can honor per axis, not a
// claim the resolver makes. The resolver requests; the substrate reports.
type EnforcementCapability = 'enforced' | 'trusted';

interface Resolution<TChoice> {
  readonly axis: Axis;
  readonly scope: 'flow' | 'step';        // divergence 1: span vs step
  readonly choice: TChoice;
  readonly binding_time: BindingTime;
  readonly requested_enforcement: EnforcementCapability;
  readonly enforcement: EnforcementCapability; // what was actually honored
  readonly downgraded: boolean;           // divergence 3: optional honor-failure
  readonly finding: string | null;        // ...channel, used only where it can fail
  readonly rationale: string;
}

interface Resolver<TContext, TChoice> {
  readonly axis: Axis;
  readonly scope: 'flow' | 'step';
  // The dependency edge: which axes this resolver READS from prior choices.
  // structure: []; equipment: ['structure']; context: ['structure','equipment'].
  // This is what lets the runner topologically order resolution.
  readonly reads_axes: readonly Axis[];
  resolve(ctx: TContext, prior: Readonly<Record<Axis, unknown>>): Resolution<TChoice>;
  // Rides the assembler; never special-cases the engine.
  apply(seed: AssemblySpec, resolution: Resolution<TChoice>): AssemblySpec;
}

// The manifest declares which resolver produces each axis (no by-id lookup):
type ResolverBindings = Partial<Record<Axis, /* resolver ref */ string>>;
```

The sketch deliberately includes `reads_axes` - the ordering edge the two current
instances only imply through their `PriorChoices` argument. Whether that edge
belongs *in the type* or *external to it* is the open question a third instance
should settle before any of this becomes real.

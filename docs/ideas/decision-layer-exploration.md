# The decision layer: making Circuit's per-step choices first-class and trialable

> Status: **exploration / design sketch — partly realized.** Written 2026-06-14;
> progress note added 2026-06-16. Successor framing to
> `exploration-substrate-two-track-plan.md`, after the M1–M9 migration landed the
> composed runtime.
>
> **What has since shipped** (the discipline below was followed exactly): both
> first-instance resolvers are built and live in `src/flows/resolvers/` —
> **structure** (`structure.ts`, the chop/hold chooser, PR #95) and **equipment**
> (`equipment.ts`, skill injection, PR #96) — and the shared `Resolver` type was
> **deliberately NOT extracted**, awaiting a third instance, exactly as §7 asks. The
> observed shape and its four divergences are recorded in
> [`resolver-shared-shape.md`](resolver-shared-shape.md); the reserved extraction
> decision is [`deepfork-resolver-abstraction-spec.md`](deprioritized-ledger.md).
> Binding time (§4) is still assembly-only on `main`; the first *runtime* deferral
> (equipment injection) is the in-flight live-recompile work (Step 2). See
> [`north-star-status.md`](north-star-status.md) for the consolidated status.
>
> The single most important thing in this doc is a piece of *restraint*: **do not
> build this abstraction top-down.** It is the destination, earned from two
> concrete instances (the chop/hold chooser and skill injection), not a framework
> to construct first. The doc exists so the next two builds can be done "as if
> they will be unified later" — capturing the shape without prematurely building
> the unifier.

## 1. The pattern, one level up

The lever that made Circuit versatile was: find the right first-class **unit** and
make it composable. Blocks-over-flows made the unit of *work* small and
recomposable; recursion made that unit self-similar so it nests. Both are about
*work*.

This doc applies the same move to the **decisions about work** — how Circuit
chooses how each step is set up. Today those choices (how to chop, what tools,
what context) would live as bespoke logic tangled inside an assembler. That is the
un-versatile version — the equivalent of hard-coding flows instead of composing
blocks. The bet: the same versatility comes from making *a decision* a first-class,
swappable unit, just like a block.

## 2. The unit: a resolver

A **resolver** (conceptual name, not Circuit vocab yet) is a small, uniform unit
that, given the task and the choices made so far, emits **one choice for one
axis**. It is the thing you swap and A/B, exactly the way you'd swap a block.

The work layer (blocks) and the decision layer (resolvers) sit **parallel**;
neither is baked into the engine. A flow's manifest declares, per axis, *which
resolver* produces that choice — so swapping a decision policy is changing a
declared reference, not editing engine code.

## 3. The axes (a small, closed set of choices)

The decisions worth resolving, per step or per span:

- **structure** — one big step vs. many small ones (the chop/hold / grain choice)
- **equipment** — what tools/skills a step is given (e.g. "React work → inject the
  user's React skills")
- **context** — what slice of the project/state the step sees
- **depth** — which model / how much budget the step gets
- **routing** — loops, retries, recovery edges, parallel fan-out
- **verification** — how much checking the step gets
- **role** — what persona the step runs as (researcher / implementer / reviewer)

Keeping this a *small, closed alphabet* is what makes resolutions comparable across
runs (the same reason the closed block alphabet made runs comparable).

## 4. Binding time as a parameter (static AND dynamic, one substrate)

This is the answer to "decided ahead of time **or** as the flow runs": binding
time is just a *parameter* on each resolver, not two different systems.

- **Decide-now** (at assembly) → the resolver fires up front, producing a
  fully-shaped flow you can preview before running. Cheaper, legible-before-you-run.
- **Decide-as-you-go** (deferred to step-entry) → the resolver fires when its step
  is reached, using what was discovered ("the task turned out bigger — decompose
  further"; "this turned out to be React — inject the skills now"). Adaptive.

Same resolver, same interface — only *when* it runs differs. That collapses "static
flow" and "adaptive flow" into one substrate, the way blocks collapsed
fixed-and-dynamic flows. The rule for *where* to defer is inherited from the
original mini-harness debrief: **defer a decision to runtime only where the choice
genuinely depends on runtime discovery; resolve everything else ahead of time.**
Deferral is the decision layer's version of recursion — a runtime resolution can
itself spawn a sub-decision.

## 5. What makes it trialable (reuse the substrate already planned)

Trialing a decision policy is "swap the resolver, run, compare" — which needs
exactly the substrate primitives from the two-track plan, now aimed at *decisions*
instead of *work*:

- resolvers **swappable as data**, not engine code (composition-as-data),
- every resolution **recorded in a comparable trace** (commensurability),
- runs **isolatable** so a new resolver is trialed without touching production.

Under this lens, the **grain-separability experiment is just the first instance**
of a general pattern — it trials the *structure* resolver. Skill injection trials
the *equipment* resolver. Same machinery, different axis. That is the payoff: once
the decision layer exists, every new "smart choice" becomes a swap-and-measure, not
a bespoke build.

## 6. The honest caveats

1. **The axes are not fully independent.** How you chop can depend on what tools
   are available, which depends on context. So resolvers can't be strictly
   parallel — some must read others' outputs, which implies an ordering/dependency
   among them. This is where the clean picture gets intricate, and it is the thing
   to watch first.
2. **It re-imports the selection problem one level up.** A library of many
   swappable resolvers is itself a lot to choose among — the exact "too many
   options" failure mode we've been fighting, now at the resolver level. Same
   defense (conservative default + measure + human ratifies), but it is a real
   tension: more versatility buys more meta-choosing.
3. **Premature abstraction is the biggest risk.** A grand decision-layer designed
   before any real resolver exists would almost certainly be wrong — the same way
   designing blocks before having flows would have been. You had flows before you
   had blocks; you need two resolvers before you have a resolver abstraction.

## 7. The discipline: two instances, then extract

Earn the abstraction. Build two concrete choosers first, then let the uniform
"resolver" fall out of what they actually share:

- **Resolver #1 — structure (E4, the chop/hold planner).** ✅ **Built** —
  `src/flows/resolvers/structure.ts` (PR #95), thin-conservative; the grain
  experiment ran and returned null, so it holds its lean-to-whole default.
- **Resolver #2 — equipment (smart skill injection).** ✅ **Built** —
  `src/flows/resolvers/equipment.ts` (PR #96), spec'd in
  `e2-equipment-scope-spec.md`, the second instance as planned.

Build each **"as if it will be unified later"** — meaning give both the same
*shape* without yet building the unifier:

- a uniform call shape: `(task context, prior choices) -> one choice for this axis`;
- declared/swappable via the manifest, never hard-coded in the engine;
- able to bind at assembly **or** defer to runtime (even if the first cut uses only
  one binding time);
- every resolution written to the trace as comparable evidence;
- honest about **enforced vs. trusted** (does the choice actually constrain the
  step, or only suggest — the equipment resolver makes this concrete: is an
  injected skill set *enforced* as the step's only tools, or merely offered?).

Only **after both exist** do you compare their interfaces and extract the shared
`resolver` type. Extracting before the second instance is the trap.

## 8. How this reframes the roadmap (it doesn't replace it)

This is a lens on the next phase, not a new phase. E4 stays the first build
(structure); skill injection becomes the explicit second (equipment); the
versatile decision-architecture is the **destination of doing those two well**, not
a prerequisite to either. The next-phase brief should carry one extra instruction:
build E4 and skill injection to the "as if unified" shape above, and flag the
shared structure as it emerges — so the abstraction can be extracted on evidence
rather than designed on speculation.

## 9. Open questions (to be resolved *through* the instances, not before)

- How entangled are the axes really? The structure↔equipment↔context dependency
  order is the first thing the two instances will reveal.
- Where is the honest line between a resolver (a *choice*) and a block (a *step*)?
  A resolver that itself runs work starts to look like a planning step — worth
  watching that the two layers stay distinct.
- For runtime-deferred resolvers, does the "selection under abundance" risk return
  badly enough to need its own conservative defaults, separate from the static case?
- Enforced-vs-trusted at the write tier: equipment is the axis where this bites
  first (tool scoping is a real safety boundary), so resolver #2 is also the test
  of how enforcement is declared and checked.

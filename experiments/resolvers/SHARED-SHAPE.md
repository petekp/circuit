# The resolver shared shape (observed, not extracted)

> Per the brief and `decision-layer-exploration.md` §7: build the two resolvers
> side by side, **record the shared shape as it emerges**, and do **not** extract
> a shared `Resolver` type yet. This note is that record — the input for a later
> ratification on whether (and how) to unify. Both instances are real, tested,
> and measured through the flow lab; what follows is what they actually share and
> where they actually diverge.

## What the two instances have in common

Both `structure.ts` and `equipment.ts` independently landed on the same four-part
shape, with no shared code between them:

1. **A uniform call shape** — `(context, prior choices) -> one resolution for one
   axis`. `resolveStructure(task, prior)` and `resolveEquipment(ctx, { prior })`
   both take the task/step context first and the choices-so-far second.
2. **A comparable resolution record** carrying, field-for-field:
   `axis`, `choice`, `binding_time`, `enforcement`, `rationale`. This is the
   trace evidence — every resolution is a serializable object you can diff across
   runs, the same way the closed block alphabet makes traces comparable.
3. **A materializer** `apply<Axis>(seed, resolution(s)) -> spec` that rides the
   data: it produces a `FlowSchematicAssemblySpec` the existing assembler eats.
   Neither resolver special-cases the engine.
4. **A one-call convenience** `resolveAndApply<Axis>(...)` that resolves then
   materializes, returning both the record(s) and the spec — the form the flow
   lab scores.

Both also **bind at assembly** (decide-now) in this first cut, and both are
**measured the same way**: feed the materialized spec to `scoreSpec` and read the
per-class tally.

## Where they diverge (the load-bearing part)

The divergences are what a premature `Resolver<T>` abstraction would have flattened
and gotten wrong. A future unifier must parameterize each of these, not assume one:

| Aspect | structure | equipment | What a unified type must do |
|---|---|---|---|
| **Scope of a choice** | one resolution **per flow** (the whole grain) | one resolution **per work step** (many per flow) | parameterize the resolution *scope* — span vs step — instead of assuming one choice per flow |
| **Enforcement reality** | **enforced**: the assembler materializes exactly the chosen shape and the catalog gate fail-closes, so you cannot get an unchosen grain | **trusted only**: `skill_slots` is additive injection with no withhold, so the kit is offered, not imposed | make `enforcement` a capability the *substrate reports per axis*, not a fixed field the resolver claims |
| **Failure-to-honor** | none — structure is always honorable | `requested: 'enforced'` is **downgraded** to trusted with a recorded `finding` | the resolution needs an optional `downgraded` / `finding` channel, used only where the axis can fail to honor a request |
| **Binding time exercised** | assembly only | assembly only, but equipment is the one that genuinely *wants* runtime deferral ("turned out to be React → inject now") | keep `binding_time` a real parameter; neither instance has yet exercised the runtime path |

## The reading for ratification

The shape is real and consistent enough that a shared type is clearly *earnable* —
but the four divergences above are the actual design content. Extracting now would
bake in "one choice per flow, enforcement is a claim, no downgrade channel," all
of which the equipment instance already violates. The honest next step is a third
instance (context or depth) to confirm the scope/enforcement/binding-time
parameters before committing a `Resolver` interface. Until then these two stay as
two concrete functions that happen to rhyme.

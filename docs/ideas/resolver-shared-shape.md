# The resolver shared shape (observed, not extracted)

> Status: gap analysis. Two decision-layer resolvers now live in `src/`. They
> independently landed on the same four-part shape. This note **records** that
> shape and the divergences as they actually emerged, so a later ratification can
> decide whether (and how) to unify. It deliberately does **not** extract a shared
> `Resolver` type — that extraction is a reserved deep-fork decision (surfaced
> separately). Earn the abstraction from instances, do not assume it.

The two resolvers:

- `src/flows/resolvers/structure.ts` — picks a flow's decomposition grain (one
  folded work spine vs build's full separated spine) and materializes it.
- `src/flows/resolvers/equipment.ts` — picks the skill kit for each relay step
  and materializes it onto the step's `skill_slots`.

Both are pure, import only public flow types, ride the existing assembler, and add
no engine branch. There is **no shared code between them** — the shape below is
observed, not enforced.

## What the two instances have in common

Both resolvers expose the same four-part shape:

1. **A uniform call shape** — `(context, prior choices) -> one resolution for one
   axis`. `resolveStructure(task, prior)` and `resolveEquipment(ctx, { prior })`
   both take the task/step context first and the choices-so-far second.
2. **A comparable resolution record** carrying, field-for-field:
   `axis`, `choice`, `binding_time`, `enforcement`, `rationale`. This is the
   trace evidence — every resolution is a serializable object you can diff across
   runs, the same way the closed block alphabet makes traces comparable.
3. **A materializer** `apply<Axis>(seed, resolution(s)) -> FlowSchematicAssemblySpec`
   that rides the data: it produces a spec the existing assembler eats. Neither
   resolver special-cases the engine.
4. **A one-call convenience** `resolveAndApply<Axis>(...)` that resolves then
   materializes, returning both the record(s) and the spec.

Both also **bind at assembly** (decide-now) in this first cut: the shape is fully
known before the run, and the assembler + the fail-closed catalog gate prove the
materialized spec is valid (`collectSchematicCatalogIssues == []`, compiles
clean).

## Where they diverge (the load-bearing part)

The divergences are what a premature `Resolver<T>` abstraction would have
flattened and gotten wrong. A future unifier must parameterize each of these, not
assume one:

| Aspect | structure | equipment | What a unified type must do |
|---|---|---|---|
| **Scope of a choice** | one resolution **per flow** (the whole grain) | one resolution **per work step** (many per flow) | parameterize the resolution *scope* — span vs step — instead of assuming one choice per flow |
| **Enforcement reality** | **enforced**: the assembler materializes exactly the chosen shape and the catalog gate fail-closes, so you cannot get an unchosen grain | **trusted only**: `skill_slots` is additive injection with no withhold, so the kit is offered, not imposed | make `enforcement` a capability the *substrate reports per axis*, not a fixed field the resolver claims |
| **Failure-to-honor** | none — structure is always honorable | `requested: 'enforced'` is **downgraded** to trusted with a recorded `finding` | the resolution needs an optional `downgraded` / `finding` channel, used only where the axis can fail to honor a request |
| **Binding time exercised** | assembly only | assembly only, but equipment is the one that genuinely *wants* runtime deferral ("turned out to be React → inject now") | keep `binding_time` a real parameter; neither instance has yet exercised the runtime path |

The equipment instance carries three fields structure does not (`step_id`,
`requested_enforcement`, `downgraded` + `finding`). Those are not noise — they are
exactly the per-step-scope and honest-downgrade divergences above made concrete.
Folding them into a single record now would either bloat the structure side with
fields it never sets, or force structure to pretend it has a downgrade channel it
does not.

## The reading for ratification

The shape is real and consistent enough that a shared type is clearly *earnable* —
but the four divergences above are the actual design content. Extracting now would
bake in "one choice per flow, enforcement is a claim, no downgrade channel," all
of which the equipment instance already violates.

So the shared type is **earnable but deliberately NOT extracted**. The honest
trigger for extraction is a **third instance** — a context or depth resolver — that
confirms the scope / enforcement / binding-time parameters before committing a
`Resolver` interface. Until a third instance settles those parameters, these two
stay as **two concrete functions that happen to rhyme**.

### Did the shape hold up once both resolvers were in `src/`?

Yes. Porting `equipment.ts` from the flow lab into `src/` next to `structure.ts`
surfaced no new divergence beyond the four already recorded. The one adaptation
forced by the move: the lab's equipment test measured the materialized spec
through the offline `scoreSpec` harness, which does not exist in `src/`. The
in-`src/` test instead proves the engine boundary the way the structure test does
— `assembleFlowSchematic` + `compileSchematicToCompiledFlow` +
`collectSchematicCatalogIssues == []` — and additionally confirms the injected
skills survive onto the **compiled** relay step with **no** `equipment_scope`
enforcement field, which is the substrate truth the `trusted` verdict rests on.
That is a test-surface adaptation, not a shape change.

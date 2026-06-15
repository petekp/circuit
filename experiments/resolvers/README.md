# The decision-layer resolvers (two instances)

Two concrete **resolvers** — the unit from
[`../../docs/ideas/decision-layer-exploration.md`](../../docs/ideas/decision-layer-exploration.md):
a small piece that, given a task and the choices made so far, emits **one choice
for one axis** and materializes it onto an assembly spec. They ride the existing
assembler and the manifest data; **neither special-cases the engine**. The
[flow lab](../flow-lab) scores their output offline, for no model spend.

These are the brief's "first two resolvers." They are built **side by side to the
same shape without sharing a type** — see [`SHARED-SHAPE.md`](./SHARED-SHAPE.md)
for the shape that emerged and where the two diverge (the input for a later
ratification on unifying them).

## Resolver #1 — structure (`structure.ts`)

The **chop/hold** grain chooser. Given a task descriptor (`summary`,
`surface_area`, `risk`, optional `explicit_decompose`) it picks a flow grain:

- `whole` — one wide work step (the conservative **hold**, the default).
- `decomposed` — the full spine (the **chop**).

It **leans to whole**: it only chops on an unambiguous signal (explicit ask, large
surface, or high risk). It materializes the choice by folding a seed spec's spine
(`whole` = fold analyze + review + the auxiliary verify checks out of build's
spine; `decomposed` = the full spine). The choice is **enforced** — the assembler
materializes exactly the chosen shape and the catalog gate fail-closes on an
invalid one.

This is the **thin** structure resolver. It deliberately does **not** attempt the
deep E3 unit-unification / uniform-recursion refactor — that is the operator's
ratification item (see the run report). A general fold that computes droppable
stages from the contract DAG (rather than folding build's known spine) is the E4
planner's job.

## Resolver #2 — equipment (`equipment.ts`)

The **skill-injection** chooser, per
[`../../docs/ideas/e2-equipment-scope-spec.md`](../../docs/ideas/e2-equipment-scope-spec.md).
Given a work step's work-type (its relay `role` plus the task's `domain_tags`) it
selects a set of skills and attaches them to the step's `skill_slots` (the field
that already exists on the schematic step and is injected at relay dispatch).

The **enforced-vs-trusted** decision is explicit and tested. Today's `skill_slots`
is **additive injection** — there is no withhold or allow-list — so an injected
kit is **trusted** (offered to the worker), not **enforced** (its only tools). A
caller that asks for `enforced` gets a resolution **downgraded** to `trusted` with
a recorded `finding`: real enforcement needs the `equipment_scope` field that the
primitive-readiness audit records as **absent** (primitive 3b). The test pins this
to the substrate — a compiled relay step carries `skill_slots` but has no
`equipment_scope` field to enforce a kit.

## Measured through the flow lab

- **structure**: both grains assemble, compile, and score **zero structural
  issues**; the whole grain is strictly fewer steps than the decomposed spine.
- **equipment**: equipping a relay-heavy flow drives `work-step-without-skill-slots`
  from its baseline (build: 3) to **zero**, introducing no new deficiency in any
  other class.

```ts
import { resolveAndApplyStructure } from './structure.js';
import { resolveAndApplyEquipment } from './equipment.js';
import { scoreSpec } from '../flow-lab/index.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';

const { spec } = resolveAndApplyStructure(buildAssemblySpec, {
  summary: 'small refactor', surface_area: 'small', risk: 'low',
});
scoreSpec(spec); // whole grain, zero structural issues

const equipped = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
scoreSpec(equipped.spec); // work-step-without-skill-slots driven to 0
```

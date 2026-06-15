# Next-phase run report: the flow lab + the first two resolvers

> Written 2026-06-14, end of an autonomous offline build run against the brief
> [`next-phase-build-brief.md`](next-phase-build-brief.md). Everything here was
> built, scored, and ratcheted **in memory** — no real-codebase runs, no live
> host, no large-model spend. Branch: `exp/next-phase-flow-lab` (held PR, not
> merged). This is the morning report Phase 3 asks for.

## What was built

Three things, in three commits on top of the rescued planning docs:

1. **A refreshed primitive-readiness audit** ([`primitive-readiness-audit.md`](primitive-readiness-audit.md))
   grounding the six-primitive substrate analysis in the post-M9 codebase with
   file:line citations. The deltas that pointed this run: primitive 1 (self-
   similar unit) `partial -> half`, primitive 3b (equipment scope) `absent`,
   primitive 4 (composition surface) `partial -> half`.
2. **An offline flow lab** (`experiments/flow-lab/`) — generate assembled flows,
   assemble + compile them in memory, and score their quality, plus a **quality
   ratchet** (`tests/contracts/flow-quality.test.ts`) that pins each quality
   class's ceiling and lets it only shrink.
3. **The two resolvers** (`experiments/resolvers/`) — structure (chop/hold) and
   equipment (skill injection) — built side by side to the same shape, each
   measured through the flow lab.

Total: 22 new tests, all green; full `npm run verify` green; **zero `src/`
changes** (the resolvers ride the assembler and the manifest data, never the
engine).

## The flow lab and its quality numbers

The lab exploits a fact the brief flagged: the whole `assembleFlowSchematic ->
compileSchematicToCompiledFlow` chain is **pure** (no fs/net/env). So the lab
generates a flow, scores it, and gates regressions with no live host. The scorer
(`collectFlowQualityIssues`) emits **one issue per deficiency; count = score;
lower is better**, over a closed alphabet of 9 quality classes (the same
closed-alphabet discipline that makes block runs comparable).

The **baseline** across the 8 shipped flows — what the resolvers measure against:

| flow | score | skill-slot gaps | excess aliases | other |
|---|---|---|---|---|
| fix | 11 | 4 | 7 | |
| prototype | 9 | 2 | 7 | |
| explore | 9 | 3 | 6 | |
| build | 6 | 3 | 3 | |
| goal | 6 | 3 | 3 | |
| pursue | 4 | 2 | 2 | |
| runtime-proof | 2 | 1 | | 1 no-primary-result-binding |
| review | 1 | 1 | | |
| **total** | **48** | **19** | **28** | **1** |

The ratchet pins `work-step-without-skill-slots: 19`, `excess-contract-aliases:
28`, `no-primary-result-binding: 1`, every other class `0`, and gates each with
`toBeLessThanOrEqual`. A completeness assertion forces any new quality class to
be pinned (it cannot slip in unrationed). This mirrors the existing catalog
ratchet (`schematic-catalog-check.test.ts`) exactly.

**What ratcheted this run:** nothing was driven down on the *shipped* flows yet —
the ratchet's job this run was to **establish the floor** and prove the two
resolvers can drive their target classes down *in the lab*. The equipment
resolver drives `work-step-without-skill-slots` from build's 3 to **0**; the
production plan below is how that becomes a shipped-flow ratchet drop.

## The two resolvers and the shape they share

Both are the decision-layer's **resolver** unit: `(task/step context, prior
choices) -> one choice for one axis`, materialized onto an assembly spec the
existing assembler eats.

**Resolver #1 — structure (chop/hold).** Picks a flow grain — `whole` (one wide
work step) or `decomposed` (the full spine) — and **leans to whole**, chopping
only on an explicit ask, a large surface, or high risk. It materializes by
folding build's spine: `whole` folds analyze + review + the two auxiliary verify
checks out, leaving frame → plan → act → verify → close (5 steps); `decomposed`
is the full spine (9 steps). Measured through the lab: **both grains compile with
zero structural issues**, and the whole grain is strictly fewer steps (5 vs 9)
and fewer relays (1 vs 3). The choice is **enforced** — the assembler
materializes exactly the chosen shape and the catalog gate fail-closes on an
invalid one. This is the **thin** resolver; it does not touch the deep E3
refactor (see the ratification item).

**Resolver #2 — equipment (skill injection).** Selects skills by work-type (relay
`role` + task `domain_tags`) and attaches them to the existing `skill_slots`
field. Measured: equipping build drives `work-step-without-skill-slots` from 3 to
**0** with no regression in any other class. The **enforced-vs-trusted** decision
is explicit and tested: today's `skill_slots` is **additive injection** (no
withhold, no allow-list), so the kit is **trusted** (offered), not **enforced**
(imposed). A caller asking for `enforced` gets a resolution **downgraded** to
trusted with a `finding` naming the absent `equipment_scope` field — and a test
pins this to the substrate: a compiled relay step carries `skill_slots` but has
no `equipment_scope` field to enforce a kit.

**The shared shape that emerged** (recorded in `experiments/resolvers/SHARED-SHAPE.md`,
**not** extracted into a type — per the brief): both independently landed on a
uniform call shape, a comparable resolution record (`axis`, `choice`,
`binding_time`, `enforcement`, `rationale`), an `apply<Axis>` materializer that
rides data, and assembly-time binding. The **four divergences** a premature
`Resolver<T>` would have flattened:

1. **Choice scope** — structure resolves once *per flow*; equipment resolves once
   *per work step*.
2. **Enforcement reality** — structure is enforced by the assembler; equipment is
   trusted-only on today's substrate.
3. **Failure-to-honor** — equipment needs a `downgraded` / `finding` channel;
   structure never fails to honor a choice.
4. **Binding time** — both bind at assembly in this cut; equipment is the one that
   genuinely wants runtime deferral ("turned out to be React → inject now").

The reading: a shared type is clearly *earnable*, but a **third instance**
(context or depth) should confirm these four parameters before the interface is
committed.

## A load-bearing finding (offline authoring is gated by the typed seam)

Probing the lab surfaced a real constraint worth recording: **you cannot author a
brand-new valid flow offline from invented contract names.** The M9-A1 typed-seam
gate rejects any contract that is produced-and-consumed in-flow without a
registered Zod body — and that includes most *generic* block-output contracts
(`flow.brief@v1`, `change.evidence@v1`, `verification.result@v1`,
`context.packet@v1`), not just made-up ones. Only `plan.strategy@v1` and
`review.verdict@v1` carry registered consumable bodies (M9-A1 registered exactly
those two). The reason build compiles is that it outputs **actuals** with
registered report bodies (`build.brief@v1`, …) and aliases them to the generics.

Consequence for the resolvers: the thin structure resolver **folds an existing
flow's spine** (reusing build's body-registered actuals) rather than synthesizing
fresh contracts. A resolver that wants to author genuinely new steps needs new
registered Zod bodies — a `src/` change, out of scope for an offline run. This is
the same fact, from the build side, that primitive 2's "typed seam" rating is
about; the production plan accounts for it.

## Proposed production plan

**E4 (structure) — make the assembler the single authoring path, then add the
chooser.** Primitive 4 is `half` purely on adoption (2/8 flows route through the
assembler). The sequence:

1. Migrate the 6 hand-authored flows (fix, goal, review, explore, prototype,
   runtime-proof) onto `assembleFlowSchematic`, each behind a prove-by-equivalence
   test (the M7/M9 pattern). This makes authoring-as-data the single production
   path and is the gate that moves primitive 4 to `mostly-done`.
2. Lift the structure resolver from "fold build's known spine" to a real
   `circuit create`-time chooser: a task descriptor selects the grain and the
   assembler materializes it. The thin chooser already proves the choice→assemble
   →score loop offline; production wires it to the CLI's create path
   (`assembleCustomFlow`).

**Skill injection (equipment) — ship the trusted half now, gate the enforced
half.** The trusted resolver works on today's substrate with no engine change:

1. Wire the equipment resolver's output into authoring so a flow's relay steps
   carry resolved `skill_slots` (drives the shipped-flow ratchet: 19 → toward 0).
   This is additive and safe; it is the trusted half.
2. The **enforced** half needs the `equipment_scope` field (reads/tools/write_tier)
   that primitive 3b records as absent — build it per `e2-equipment-scope-spec.md`,
   manifest-first, reusing `WorkRootKind` for `write_tier`, with enforcement at
   relay dispatch (read/tool allow-list) and at apply (write-tier). That is a
   real `src/` change with failing-test-first discipline; it is a separate,
   reviewed slice, not part of this offline run.

## The deep-E3 question, held for ratification

The brief's explicit fork — **thin-resolvers-first vs. deep-E3-recursion-first** —
was taken as **thin-resolvers-first** for this unsupervised run, and the deep E3
unit-unification / uniform-recursion refactor was **not** attempted. The
ratification item, stated plainly:

> Primitive 1 (self-similar unit) is `half`: the *authoring* half is real (one
> assembler, one compiler, flow-as-data), but the *runtime* half is not — a
> nested flow still runs as an isolated child (`kind: 'sub-run'` →
> `executor: 'orchestrator'`), a different code path from a leaf relay's
> `executor: 'worker'`, and there is **no recursion-depth cap or cycle guard**. A
> flow that sub-ran itself would loop unbounded.

The deep-E3 work is true leaf-substitutability (the engine treats "this step's
body is sub-tree X" exactly as it treats a relay) plus bounded recursion plus the
non-empty `reduced_bindings` needs model the legibility leg waits on. It is now
**unblocked** (its precondition, the assembler, is met) but high-risk and
structural — the kind of change the brief says not to undertake unsupervised. The
operator's call: how much of the uniform self-similar unit counts as delivered by
M9 (authoring-as-data) versus owed by E3 (uniform runtime recursion), and whether
to sequence E3 before or after the E4 + skill-injection production plan above.

## Open questions

1. **Ratchet promotion.** Once the equipment resolver is wired into authoring and
   `work-step-without-skill-slots` reaches 0 on the shipped flows, the class
   should be promoted from a ratchet to a fail-closed gate (mirror the catalog
   gate at `compile-schematic-to-flow.ts:709`). Do this per-class as each hits 0.
2. **Alias budget.** `excess-contract-aliases` is 28 and is the largest baseline
   number. Some aliases are load-bearing (write-only block-reuse umbrellas); the
   budget (6) may need to be per-flow rather than flat, or the class may need to
   distinguish load-bearing aliases from genuine widening before it can ratchet.
3. **Third resolver before unification.** The shared-shape note argues for a third
   instance (context or depth) to confirm the scope/enforcement/binding-time
   parameters before extracting a `Resolver` type. Which axis is the most
   informative third instance?
4. **Runtime binding.** Neither resolver exercises decide-as-you-go yet. Equipment
   is the natural first runtime-bound resolver ("discovered it's React mid-run →
   inject now"); does that need an engine seam, or can it ride the existing
   step-entry hook surface?

## Deviation from the brief (recorded)

The brief specified the worktree path `/Users/petepetrash/Code/circuit-next`.
That path was already an **unrelated** git repository
(`git@github.com:petekp/circuit-next.git`), so the worktree was created at
`/Users/petepetrash/Code/circuit-flow-lab` instead, keeping the specified branch
name `exp/next-phase-flow-lab`. No other deviation.

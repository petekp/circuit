# Run report: genuine flow-shape composition

Status: research (INTRACTABLE-as-built, frontier advanced one layer)
Date: 2026-06-18
Branch: `feat/flow-composition`
Pre-registration: [`flow-composition-preregistration.md`](flow-composition-preregistration.md)

## Headline

The north-star was an assembler that INVENTS a novel flow for a task by
composing intent-enriched blocks, not instantiating a hand-authored family. The
composer built here clears the gate the earlier spike could not: it produces a
genuinely novel flow that passes every OFFLINE engine gate (assemble, compile,
catalog, primary-result binding) without inventing a single unregistered
contract body. Phase 0 was a decisive YES.

Phase 1 (breadth) and Phase 2 (live) both land on INTRACTABLE, by two
independent routes:

- **Offline breadth: 4 of 8** target topologies compose valid, novel, and
  sensible. The §5.2 rule needs 5 for PARTIAL, so the offline verdict is
  INTRACTABLE. (An earlier pass measured 5/8 PARTIAL, but the adversarial review
  before commit found that the 5th topology — diagnose-plan-checkpoint — was
  propped up by a contract-laundering defect in the composer: it routed an
  unbodied generic through `initial_contracts` to dodge the unregistered-body
  gate that a hand-authored flow must satisfy. Holding the composer to the same
  gate, that topology walls, and breadth drops to 4/8. See "Adversarial review"
  below.)
- **Live confirmation: composed flows do not RUN.** The flagship composed flow
  aborts on the real runner at its first compose step whose writer cannot read
  the composed wiring. Independently of the offline number, the §6 live-failure
  rule would also force INTRACTABLE.

The honest result is not "it works" and not "it is hopeless." It is: the typing
frontier is solved (the composer binds registered typed actuals through aliasing
and never invents a body), and TWO further walls now stand in front of genuine
composition — a breadth wall (the catalog lacks specialized actuals or
multi-generic input aliases for several roles) and a runtime WRITER wall (writers
are coupled to their origin family's exact contract schemas and full pipeline
shape). Both are precise, testable next targets.

## What was built (all additive, default-OFF, nothing in the product path)

A new module `src/flows/composition/` that nothing in the engine or catalog
imports. Built-ins, schemas, runtime, and `catalog.ts` are byte-identical to
`main` (0 diff lines; proven by `git diff main` over each built-in flow dir).

- `intent.ts`: a tiny controlled vocabulary of per-block semantic PRE/POST
  conditions (`task-framed`, `context-gathered`, `diagnosed`, ...). This is the
  layer the contract gates cannot see: it lets the sensibility checker reject a
  flow whose intents are out of order even when its contracts close. Additive
  metadata; the stable assembler and block catalog never consult it.
- `actual-menu.ts`: derives, straight from `flowDefinitions`, the menu of
  registered ACTUAL contracts the composer may bind for each
  (block, executionKind), with the block's true output generic and the engine's
  own registration verdicts (body / verification-writer / close-writer). The
  composer rides catalog data; it never hand-keeps a table.
- `composer.ts`: given a role set (ordered (stage, block, executionKind)), it
  selects a registered actual per role, synthesizes the contract wiring, soaks
  otherwise-unconsumed upstream evidence into the terminal step, synthesizes a
  checkpoint policy where needed, generates a partial-spine rationale for omitted
  canonical stages, and emits a `FlowSchematicAssemblySpec`. The spec is handed
  to the SAME fail-closed path the engine runs. The composer adds no gate of its
  own. The set of contracts a step may read without an upstream producer
  (ambient/initial) is DERIVED from the catalog (the union of the flow
  definitions' declared `initial_contracts`), not hand-kept — so the composer
  cannot route a non-initial contract through `initial_contracts` to dodge a gate
  a hand-authored flow must pass. The terminal evidence-soak keys on whether a
  step writes a readable contract (a `report_path`/`result_path`), not on its
  execution kind, matching the engine's own read-path resolution.
- `evaluate.ts`: the rubric predicates (VALID via the real gates, NOVEL by block
  sequence vs every built-in, SENSIBLE = contract closure + intent closure + no
  orphan + goal-reaching). Pure analysis, no model spend.

Tests: `tests/contracts/composition-phase0.test.ts` (7),
`tests/contracts/composition-phase1.test.ts` (4), and
`tests/contracts/composition-remediation.test.ts` (4) lock the behavior,
including the real engine constraints the composer had to learn (post-change
verification binding; a routing-only checkpoint output is not readable evidence
while a report-writing checkpoint output is) and the two defects the adversarial
review caught (no contract laundering; readability keyed on the write, not the
execution kind). Offline breadth harness: `experiments/phase1-breadth.mts`.
Runtime probe: `experiments/phase2-composed-runtime.mts`.

## Phase 0: make-or-break gate — PASS

Target: `research-then-build` (frame, gather-context, plan, act,
run-verification, review, close). No single built-in covers this shape; it was
the spike's attempt #3 that scored 0/3.

Composed flow (offline):

```
frame             -> fix.brief@v1        (compose)
gather-context    -> build.context@v1    (relay/researcher)
plan              -> build.plan@v1        (compose)
act               -> build.implementation@v1 (relay/implementer)
run-verification  -> build.verification@v1   (verification)
review            -> build.review@v1     (relay/reviewer)
close-with-evidence -> build.result@v1   (compose, terminal)
```

VALID (real gates: assembles, compiles, 0 catalog issues, binds
`build.result@v1` as primary), NOVEL (Jaccard 0.60 to the closest built-in,
build; sequence equals no built-in), SENSIBLE (all four sub-checks), CONSISTENT
(K=10 identical specs). The mechanism produces a genuinely novel, valid, sensible
flow offline. Gate PASSED; proceed to Phase 1.

## Phase 1: breadth across 8 topologies — INTRACTABLE (offline)

Scored offline through the real gates over the 8 pre-registered topologies
(C1-C8). Determinism K=10 held for all. Numbers below are the post-review
measurement (composer held to the same gates a hand-authored flow faces; see
"Adversarial review").

| Topology | Valid | Novel | Sensible | Task-appropriate | Pass |
|---|---|---|---|---|---|
| C1 research-then-build | Y | Y | Y | Y | Y |
| C2 triage-only | Y | Y | Y | Y | Y |
| C3 fix-then-prototype | WALL | - | - | - | - |
| C4 audit-then-fix | WALL | - | - | - | - |
| C5 research-then-handoff | WALL | - | - | - | - |
| C6 build-then-review-loop | Y | Y | Y | Y | Y |
| C7 diagnose-plan-checkpoint | WALL | - | - | - | - |
| C8 gather-verify-close | Y | Y | Y | Y | Y |

Tally: `Val = 4/8, Nov = 4/8, Sen = 4/8, App = 4/8, Pass = 4/8, Con = true`.
Every valid flow is also novel and sensible.

Classification by §5.2: `Val = 4/8` is below the PARTIAL floor of 5/8.
Therefore **INTRACTABLE (offline)**. (Phase 0 still PASSED, so proceeding to
Phase 1 was correct; the run finds out, cheaply, that breadth does not hold.)

### The four walls are principled, not swapped (§3.2, §7)

Per the anti-fitting rule, an unreachable target topology is reported, not
exchanged for an easier one. All four walls are catalog-structural facts, not
composer bugs:

- **C3 fix-then-prototype**: `prototype-variant-evidence` and
  `prototype-checkpoint` have no registered actual — the prototype family emits
  those block outputs as raw generics, so there is no specialized contract body
  to reuse. The composer refuses to invent one (that is the spike's exact
  failure mode).
- **C4 audit-then-fix**: `act` requires a `diagnosis.result@v1` or a
  `plan.strategy@v1` to drive the change. The upstream `review` produces a
  `review.verdict@v1`, which satisfies neither. The catalog encodes a real
  intent: you do not act directly on an audit; you first form a diagnosis or a
  plan. The topology as written skips that step.
- **C5 research-then-handoff**: `handoff` produces `continuity.record@v1` as a
  raw generic with no registered actual and no close writer, so it cannot be a
  terminal that binds a primary result.
- **C7 diagnose-plan-checkpoint**: `human-decision` reads `flow.evidence@v1`, but
  the upstream `diagnose` produces `diagnosis.result@v1` (its block output), and
  the catalog injects no `flow.evidence@v1`. A hand-authored flow satisfies this
  by aliasing an upstream registered body to `flow.evidence@v1` (fix aliases
  `fix.diagnosis@v1` to it); the composer does not synthesize multi-generic input
  aliases, so it walls. This wall was hidden in the first pass by the laundering
  defect; once removed, it is an honest capability boundary.

The boundary is precise: the composer works for topologies whose every role has
a registered, specialized actual and whose input sets close from upstream
producers plus catalog-declared ambient contracts. It walls, honestly, where the
catalog has no specialized contract for a role, where a topology omits a
genuinely-required predecessor, or where a role needs a contract that only a
multi-generic alias (which the composer does not yet synthesize) would supply.

## Phase 2: live confirmation — composed flows do not run (writer-coupling wall)

The live confirmation ran while Phase 1 still measured PARTIAL (5/8), before the
adversarial review corrected the offline number; its result is an independent
second route to the same verdict and stands on its own. Method: drive composed
flows through `runCompiledFlow` (the same runner a built-in uses),
with a stub relayer returning schema-valid bodies for the relay steps (so the run
is deterministic and costs no model spend). This is the runtime parallel of the
M9 truth test, but for composed-not-built-in shapes. It exercises exactly the
part the offline gate does not: whether the composed flow's compose, verification,
and close WRITERS can run on the composed wiring.

Both arms aborted on the real runner, from two distinct angles that share one
root cause:

1. **research-then-build (cross-family)** ran frame and gather-context, then
   aborted at `plan`:
   `expected exactly one report writer for schema 'build.brief@v1', found 0`.
   The composed frame produced `fix.brief@v1` (the only compose-frame actual the
   catalog offers; build's frame is a checkpoint). But build's `plan` compose
   writer reads its brief by the exact schema name `build.brief@v1`. Both briefs
   satisfy the generic `flow.brief@v1`, which is why the OFFLINE gate accepts the
   wiring, but the writer is bound to its own family's exact actual.

2. **triage-only (single-family, all fix.*)** ran frame, gather-context, and
   diagnose, then aborted at `close-with-evidence`:
   `fix.result@v1 requires close step to read reports/triage-only/gather-context.json`.
   Fix's close writer declares `fix.context@v1` as a REQUIRED read. The novel
   short-tail shape consumed the context mid-flow (the diagnose step read it), so
   the terminal soak did not re-wire it, and the writer's required read is unmet.

### Root cause

The runtime writers (compose and close) are coupled to their origin family in two
ways the offline gate cannot see:

- They read inputs by EXACT actual schema name (`build.brief@v1`,
  `fix.context@v1`), not by the generic (`flow.brief@v1`,
  `context.packet@v1`). So a cross-family brief, even though type-valid at the
  generic level, has no producer the writer recognizes.
- They declare the full origin-family pipeline as REQUIRED reads. So a novel
  topology that omits or reorders a stage fails the writer's read contract even
  within one family.

Genuine composition produces exactly the wiring these constraints reject:
cross-family actuals (forced when one family lacks a role, e.g. a compose-frame)
and short or reordered tails (the whole point of a novel shape). So the offline
VALID predicate is necessary but not sufficient for runnability. It should be
extended with a writer-required-reads-closure check (does every reused writer's
required reads have a producer the writer will recognize?) to predict live
runnability before spending a run.

### Verdict: INTRACTABLE, from two independent routes

The offline breadth re-measurement is already INTRACTABLE (4/8, below the 5/8
PARTIAL floor), so the final verdict is INTRACTABLE on the offline number alone.
The live confirmation reaches the same place by the pre-registered §6 rule: if
the single cleanest composed live arm fails to execute at all (no terminal, no
`primary_result`), the classification is downgraded one tier — and the cleanest
arm (research-then-build) failed to execute. Either route lands on:

**INTRACTABLE (as-built).**

This is the anti-fitting rule doing its job. The composer is real progress — it
clears the typing gate the spike could not — but the capability is held as
research: breadth does not reach the bar offline, and novel composed flows
cannot yet run live.

## Adversarial review (before commit)

A four-lens adversarial review ran before the work was committed: independent
agents tried to falsify the report's numbers, the "rides catalog data / no
special-casing" rail, the checkpoint-exclusion justification, and the
default-OFF / built-ins-byte-identical safety claims, with each surfaced finding
re-checked by a skeptical verifier. It confirmed the safety claims (built-ins
byte-identical, module imported by no product-path file) and reproduced the
offline/live numbers as they stood. It also caught two real defects, both fixed
before commit:

1. **Contract laundering (the load-bearing one).** The composer hand-kept a set
   of "ambient" generics that a step may read without an upstream producer, and
   that set included `flow.evidence@v1`. No flow declares `flow.evidence@v1` as
   an initial contract — every flow that needs it aliases a registered body to it
   — so routing it through a composed flow's `initial_contracts` slipped it past
   the unregistered-body gate that a hand-authored flow must satisfy. This both
   violated the stated rail (the composer is supposed to ride catalog data, not
   hand-keep a table) and propped up one topology's validity. The fix derives the
   ambient set from the catalog (the union of the flow definitions'
   `initial_contracts`); `flow.evidence@v1` is no longer ambient, so
   diagnose-plan-checkpoint walls honestly and breadth drops from 5/8 to 4/8 —
   moving the offline verdict from PARTIAL to INTRACTABLE. The number got worse,
   which is the point: it is now the real number.

2. **Checkpoint over-exclusion (latent).** The evidence-soak and no-orphan checks
   excluded checkpoint outputs by execution kind, justified by the claim that "a
   checkpoint writes only its request/response paths." That is false as a general
   engine fact: a checkpoint can also write a `report_path`, and the shipping
   `build` flow's first step is exactly such a checkpoint (it writes
   `build.brief@v1`). The composer never emits a report-writing checkpoint today,
   so this was latent, but the predicate was wrong. The fix keys both checks on
   whether a step writes a readable contract (`report_path`/`result_path`),
   matching the engine's read-path resolution, and corrects the comments.

Both fixes are locked by `tests/contracts/composition-remediation.test.ts`. The
review did its job: it overturned the Phase 1 headline (PARTIAL → INTRACTABLE)
rather than rubber-stamping it.

## Where the frontier now sits

The earlier spike tripped the TYPING gate on six unregistered generics: it wired
block generics raw. This composer passes the typing gate by binding registered
typed actuals through aliasing. So the frontier moved from "the typing gate
rejects raw generics" to two walls one layer in: a BREADTH wall (the catalog
lacks a composable actual for several roles) and a runtime WRITER wall (writers
reject composed wiring). Clearing the typing gate is one concrete layer of
progress; the two remaining walls are precise next targets.

Breadth wall — to lift the offline number, the composer/catalog needs (composer
work, in scope for a follow-up; default-OFF throughout):

1. Multi-generic input aliasing: when a role needs a generic no block outputs
   directly (`human-decision` needs `flow.evidence@v1`), let the composer satisfy
   it from an upstream actual the catalog already aliases to that generic
   (`fix.diagnosis@v1` is aliased to `flow.evidence@v1`). This is catalog-attested
   reuse, not invention, and would recover diagnose-plan-checkpoint legitimately.
2. Specialized actuals for prototype/handoff roles, so C3/C5 have a body to bind
   instead of a raw generic.

Writer wall — to make composed flows RUN, the writer contract needs to change
(engine/flow work, larger than the experimental composer and out of scope for
this run):

3. Writers read the brief and other shared inputs by GENERIC (`flow.brief@v1`),
   resolving to whatever actual is aliased to it, rather than by a hard-coded
   family actual.
4. Close and compose writers tolerate absent optional evidence (fold-tolerance:
   emit `not_assessed` rather than hard-fail when a stage the origin family ran
   is absent in a composed shape). This extends the existing close-writer
   fold-tolerance direction.
5. The offline gate gains a writer-required-reads-closure check, so the composer
   walls on un-runnable wiring offline instead of discovering it live.

With the breadth items the offline number climbs back above the PARTIAL floor;
with the writer items the offline-valid topologies become candidates for live
execution and the §6 downgrade no longer fires.

## Verification

`npm run verify` is green on the branch: 356 test files, 3723 tests pass (6
skipped), tsc clean, biome clean, build clean, all gate scripts pass (including
`check-flow-drift`, the built-ins byte-identical gate, and `check-release-infra`).
Built-ins, schemas, runtime, and `catalog.ts` are byte-identical to `main`
(proven by `git diff main` over each). The composition module is not imported by
any product-path file, so default-OFF is structural, not a flag that could be
flipped by accident.

# Bespoke flow generation: a design dossier

Status: design only. No `src/` change is proposed here. The genuine-generation
spike (`experiments/flow-lab/phase2-genuine-generation-spike.ts`) stays
git-untracked. This document was produced by a multi-agent investigation that
grounded every claim against the code, then put the design through an
adversarial review. The review returned a verdict of OVERCLAIMS; the six
corrections it forced are folded in below, and the places this plan could still
over-promise are listed at the end.

## The goal

> Fully generated, bespoke flows that are perfectly fitted to the task, built
> from existing blocks and informed by existing flow patterns and preferences.

That is the north-star. This dossier maps the distance to it honestly: what is
already shipped, what the real obstacle is, why it is a research problem and not
just an engineering to-do, and a concrete, testable path that does not pretend
the hard part is solved.

## The one distinction everything hangs on: validity versus efficacy

A flow has to clear two bars, and they are different in kind. Blurring them is
the single most common way to fool yourself about this problem.

**Bar 1, validity.** Does the topology compile, do its typed contracts wire
together, and does it clear every gate? This is checkable up front,
deterministically, by pure functions over `(schematic x in-process catalog x
body-signature resolver)`. No flow ever runs. The engine defines it precisely:
`VALID = compiles AND zero catalog issues AND a bound primary_result`
(`src/flows/composition/evaluate.ts:116`, decided offline at `:88-128`).

**Bar 2, efficacy.** Is this a *good process* for the task? Does it land its
objective checks (external truth) at a quality within reach of a reference, with
honest done-reporting, at acceptable cost? This is knowable *only* by running the
flow on a held-out fixture and scoring it, exactly as the dynamic-vs-reference
harness did over 48 live runs. No static gate can decide it.

The asymmetry that drives the whole design:

- **Instantiation inherits efficacy for free.** A family seed is a proven shape.
  A flow `circuit create` instantiates from that seed is presumed good by
  descent, and the 48-run study certified that pipeline as worth investing in.
- **Generation inherits nothing.** A bespoke topology is novel by construction.
  It can pass every validity gate (be perfectly well-formed, type-bound, live,
  closed) and still be a *bad* process. Validity is necessary but not sufficient.

The load-bearing rule for the entire program: **validity is cheap and inherited
free for instantiation; efficacy is expensive and must be earned, run by run,
for everything generated.** Never let "the gates passed" slide into "the flow is
good."

## The reframe that makes this attackable: the floor is a verifier

The parked spike asked whether an automated composer could deterministically
produce a valid novel topology *without inventing contracts*. It could not: it
tripped the anti-widening and single-actual gates, needed unregistered contract
bodies, or needed a model in the loop. The instinct was to read "needs a model
in the loop" as a disqualifier, because a model breaks determinism.

Flip it. Circuit's safety floor is not a thing you weaken to allow generation. It
becomes the **verifier**:

> A generator proposes a topology from registered blocks. The deterministic
> floor accepts or rejects it. The generator cannot bypass the gates. Soundness
> lives in verification, not in the proposal being deterministic.

This is the *same bargain Circuit already makes with model workers inside gated
steps*. A relay's model output is untrusted and is admitted only through a
`check.pass` verdict. Here the model's *topology* output is untrusted and is
admitted only through the assemble, compile, and catalog gates. A model in the
proposer seat is fine precisely because the verifier is total and the model
rides the same floor a hand-author rides.

The investigation confirmed the floor is strong enough to play this role. The
gate stack (`assembleFlowSchematic` -> `compileSchematicToCompiledFlow` ->
`CompiledFlow.parse`, with `collectSchematicCatalogIssues` in the middle) is a
total, deterministic verifier over a fully-materialized proposal. Every gate is
a pure function that returns issues or throws without executing anything
(`src/flows/schematic-catalog-check.ts:37-86`). The shipped composer adds no gate
of its own (`src/flows/composition/composer.ts:9-11`); a proposed topology rides
exactly the path the engine runs.

Two honest carve-outs the design must never paper over:

1. **Static proposals only.** The floor is a sound total verifier for
   statically-expressible topologies. A child-run edge whose target is a
   *dynamic runtime placeholder* (a dynamic fanout `flow_ref`) cannot be resolved
   at compile time; it is caught by a runtime backstop (`RECURSION_DEPTH_CAP = 8`
   plus an ancestor-chain guard, `src/runtime/executors/sub-run.ts:30`), not up
   front. So constrain the generator to static child-run edges and the floor
   stays total.
2. **Structural, not semantic.** "Sound" means well-formed, type-bound, live,
   closed. It does not mean sensible. The accommodation ledger proves an alias
   cites a real producer and the body is registered and uniform; it does *not*
   prove the consumer reads the semantically right field
   (`src/flows/accommodation-ledger.ts`). That residue is exactly what Bar 2
   exists to cover.

## The eight walls, and how each is treated

The spike hit eight fail-closed walls before the contract gates even ran. Here is
each, with what dissolves it. Important scoping correction from the review:
walls 1 through 6 are **dissolved for the registered nine-block linear band
only** (the `RESEARCH_THEN_BUILD` spine the shipped composer already builds). For
sub-run, fanout, and the sixteen unplaceable blocks they are *unverified*, not
dissolved.

| Wall | Treatment | How |
|---|---|---|
| 1. Ambient contracts have no producer block | constrain to registered blocks | The composer derives the ambient set from registries (`deriveAmbientGenerics`, `composer.ts:94-102`), not from out-of-band knowledge. |
| 2. Default execution kind lives outside the catalog | constrain to registered blocks | The composer reads `FLOW_BLOCK_DEFINITIONS` directly; `blockHasSingleKind` (`composer.ts:295-297`) omits or declares execution correctly. |
| 3. Restating a block default is an error | constrain to registered blocks | It knows each default because it reads the real definitions; it only emits overrides (`candidateMatchesRole`, `composer.ts:186`). |
| 4. Per-step check data (pass/required/allow) | constrain to registered blocks | Check semantics ride the registered menu actual (`composer.ts:428,440`), not a guess. |
| 5. Per-kind write scaffolding | constrain to registered blocks | `stepWrites` (`composer.ts:248-270`) synthesizes the right path set per known kind. |
| 6. Route DAG plus single primary_result | floor as verifier | The composer proposes a linear DAG; `derivePrimaryResult` plus the `CompiledFlow` WF-I8/I9/I10/I11 invariants reject any mis-bound or unreachable graph up front. |
| 7. Anti-widening (multi-actual generic) | floor as verifier | This was the spike's actual failure. It is dissolved by binding typed registered actuals via aliases, and the floor verifying it (`accommodation-ledger.ts:252-307`). The gate fails closed, never open. |
| 8. Single-actual unregistered body | floor as verifier | `collectUnregisteredConsumedContractIssues` (`accommodation-ledger.ts:345-390`) catches even a one-edit novel mutation. Introducing a genuinely new contract body is the expensive case the floor cannot dissolve. |

The thing to notice: walls 1 through 5 are dissolved by *reading the real
registries instead of a stripped catalog*. Walls 6 through 8 are dissolved by
*letting the floor verify what the generator proposes*. Neither requires
weakening a gate. The composer already does this for one genuinely novel linear
shape (`RESEARCH_THEN_BUILD`, `composer.ts:536`), valid and sensible offline.

## The wall that does not dissolve: catalog coverage

There is a ninth obstacle the reframe does not touch, and it is the real
frontier. It is not a gate. It is catalog expressiveness.

Only **9 of 29 blocks** are fully composable today (a registered actual plus a
declared intent): frame, gather-context, diagnose, plan, act, run-verification,
review, human-decision, close-with-evidence. The other twenty are out of reach:

- **Sixteen blocks have no reusable registered actual**, so the composer
  literally cannot place them: queue and batch (sweeps), pursue and
  coordinate-pursuits (autonomous ownership), the eight goal-orchestration
  blocks, risk-rollback-check (safety gating), handoff (continuity).
- **`buildExecution` throws on sub-run and fanout** (`composer.ts:287-289`), so
  recursion and fan-out shapes are uncomposable by the composer even though the
  runtime executes them fine.
- **Axes are hard-pinned** (medium depth, no tournament), so slice loops and
  tournament variants are out of reach.

So the composer covers the linear "investigate, change, prove" band and nothing
else. Any task needing a work queue, autonomous pursuit, a goal loop, safety and
rollback gating, continuity, recursion, or fan-out cannot be composed from
registered blocks today. Widening this requires registering new actuals (cheap:
alias an existing body) or, for genuinely new shapes like risk gating, new
contract bodies (expensive). No reframe makes this disappear. This is the
research edge.

## The ladder

Three rungs, in increasing difficulty. Be precise about which is which.

**Rung 0, instantiation. Have it, certified.** `circuit create` instantiates one
of about six family seeds; build additionally folds grain (whole versus
decomposed). Efficacy is inherited from the proven seed and was certified worth
investing in by the 48-run study (build fold roughly one third the cost at equal
quality, 0% false-fixed). This is the floor of the ladder, not a target.

**Rung 1, bespoke orchestration of proven sub-flows. The next target.** Generate
a parent flow whose steps sub-run *existing* proven flow ids (build, fix, review,
explore) in a task-fitted order no single built-in family expresses, for example
`explore -> sub-run build -> review -> sub-run fix`. Every leaf is a whole proven
flow that already hands back a typed `RunResult`, so leaf efficacy is inherited
and only the arrangement is novel.

Correction from the review, and it matters: **Rung 1 does not route around the
coverage wall. It breaches a narrow, well-chosen part of it.** Sub-run-capable
blocks are among the unplaceable sixteen, and `buildExecution` throws on sub-run
and fanout. The good news is the gap is narrow and localized, not unbuilt
frontier work:

- The runtime already executes these orchestrations. The explainer flow
  hand-authors a working sub-run of `build` today
  (`src/flows/explainer/data.ts:419-445`).
- The block-step-expansion layer already accepts sub-run and fanout writes
  (`src/flows/block-step-expansion.ts:268-280`).

So the missing piece is confined to the authoring layer: teach
`composer.buildExecution` to synthesize sub-run and fanout steps (the
`result` / `branches_dir` / `aggregate` writes plus `check.pass` and join
policy, all well-defined in `src/schemas/step.ts` and
`src/runtime/executors/fanout.ts`), and give the sub-run-capable blocks a
placeable menu actual. That is real work, not "mostly done," but it is a
localized breach of one wall rather than a new engine.

**Rung 2, block-level topology. The deep frontier, partially have for one
shape.** Compose a bespoke flow from individual catalog blocks, not whole
sub-flows. The composer already does this for the linear band, valid and sensible
offline. Generalizing it past the nine-block surface is the parked research
problem: it needs new actuals, new contract bodies for genuinely new shapes, and
the sub-run/fanout synthesis above. For the linear band specifically, Rung 2 is
engineering plus efficacy certification, not open research.

## Rung 1 spec, and the smallest first slice

**Smallest runnable first step, offline, zero eval spend.** One git-untracked
file under `experiments/flow-lab/` that composes a *single-leaf* orchestration: a
trivial parent with exactly one sub-run step targeting `flow_id: 'fix'` (static
ref), and a terminal close binding `primary_result`. Run it through the real
floor (`assembleFlowSchematic` -> compile -> `collectSchematicCatalogIssues` ->
`primary_result`). Success is a VALID verdict.

Why this first: it proves the sub-run writes-and-check contract clears the floor,
which is exactly the slot `buildExecution` throws on today. It is the cheapest
possible probe of the one thing Rung 1 needs to learn, before any multi-leaf
topology or any live run. Once a one-leaf orchestration is valid offline, add a
second leaf (`explore -> sub-run fix`) to make it genuinely bespoke, then wire
the live arm.

**Success bars, both measured.**

- Bar 1, offline, zero cost: at least one orchestration topology that is none of
  the six built-in families passes the real floor as VALID. This is the inverse
  of the spike's 0/3.
- Bar 2, live: run the orchestration parent on the held-out fix fixtures and
  score it against the reference. The bar is a re-locked decision rule (below).

## Certifying efficacy, and what that actually takes

Graduation is flow by flow, family by family. Never a blanket blessing. The plan
reuses the scoring, not the harness as-is. This is the correction the review
pressed hardest, so it is stated plainly.

**What is reused.** The scorer and the cost instrument. The unchanged
fix-vs-vanilla scorer (`scripts/evals/fix-vs-vanilla/scoring.ts`), the committed
dated price table, the hidden-objective-check overlay, the held-out fixtures, and
the model pin (claude-haiku-4-5).

**What is new wiring, not yet built.** The existing dynamic-vs-reference harness
cannot be pointed at a composed flow today. Its "generated" arm runs
`circuit create` (`run-dynamic-comparison.ts:616`), which is instantiation via
`resolveArchetype` (`create.ts:207-210`). `composeFlow` is never invoked anywhere
in `src` or `evals` except a re-export. To certify a composed flow you need:

1. A path that compiles-and-emits or runs a `composeFlow` spec under a slug
   (today a composed parent has no create/run path).
2. A new arm id (`composed`) plus family handling in the harness (the `Family`
   type is hard-wired `fix | build`, `run-dynamic-comparison.ts:74`, with
   build-specific done-semantics at `:486-488`).
3. A re-cut decision rule. This is a *hard prerequisite, a gating slice before
   any data*, not a footnote. The locked rule hard-wires
   `build_fold_cost_pays_for_itself` (`run-dynamic-comparison.ts:829-832`, pinned
   by `decision-rule.test.ts:62-65`). A composed flow has no grain-fold story, so
   its fold cost is null, `foldCostPass` is false, and the verdict
   *actively false-negatives* below worth-investing. Specify the replacement
   predicate (composed cost at or below reference median, or drop cost from the
   verdict) and update `decision-rule.test.ts` in the same change, frozen before
   data.

**The graduation bar** (per family under test): objective-fixed within 10 points
of the reference, false-fixed within 10 points of the reference (it was 0% across
all 48 instantiation runs), and zero pipeline failures. Certify fix first
(strict `outcome === fixed` semantics, the cleanest honesty signal), then build.
Only admit a family that has an honest external check. A family whose output is a
document, not a passing test (research, prototype, explain), must not enter the
set, or it re-introduces self-report laundering.

Word discipline: at N=3 this is a *directional worth-investing signal*, not a
*certification*. Reserve "certified" for a powered run with the charter's
McNemar or Bayesian intervals at higher N, on a freshly held-out, rotation-
protected set. Held-out hygiene: the eight tasks certify only while held out; a
generator ever tuned against them retires them.

## A cheap probe to run before spending anything: catalog coverage

Before any live composition spend, measure whether registered blocks even cover a
realistic task sample without inventing a contract. This is a deterministic,
offline, zero-cost probe.

Take a sample of plain-English tasks: the eight held-out dynamic-vs-reference
tasks plus fifteen to twenty spanning the suspected gap classes (a queue/sweep
task, an autonomous-pursuit task, a goal-loop task, a risk/rollback task, a
continuity/handoff task, plus more linear tasks). For each, derive a role set and
run it through `composeFlow` (`composer.ts:303`) against the real definitions.
Record the outcome: `ok` (a valid composable topology using only registered
actuals) or the exact wall reason. Bucket the failures:

- composable from registered blocks today,
- walls on a missing actual an existing body could be aliased to register (cheap),
- walls on a missing execution kind, sub-run or fanout (Rung 1 engineering),
- walls needing a genuinely new contract body (expensive, the research edge).

The output is a coverage map: what fraction of a realistic task sample the
current nine-block surface reaches, and a ranked list of which single
registration unlocks the most tasks. The probe invents no contracts, so the map
is a true measure of expressiveness, not an aspiration. It turns "16 of 29
unplaceable" into a measured per-task coverage rate that tells you whether Rung 1
or Rung 2 spend is justified yet.

## Residual research questions

These are genuinely open. None is dissolved by the reframe.

1. Block-level composition beyond the linear band stays the real research
   problem: queueing, autonomous pursuit, goal loops, risk and rollback gating,
   and continuity need new actuals or new contract bodies the floor cannot
   dissolve and the composer cannot synthesize.
2. Can a *model* proposer out-propose the deterministic composer on *efficacy*,
   not just validity? The floor guarantees safety either way; whether a model
   picks a better-fitting topology than the deterministic linear default is
   unmeasured, and is the whole point of putting a model in the proposer seat.
3. What is the minimal gate-clean synthesis of sub-run and fanout steps that lets
   a generator emit valid orchestration and fan-out without hand-authoring per
   step?
4. How do you certify document-output families (research, prototype, explain)
   without re-introducing self-report laundering? Each needs an honest external
   check before it can enter the eval set at all.
5. What is the right cost bar for a bespoke topology with no fold story, and does
   it need re-locking per shape rather than per family?
6. Held-out durability and power: a claim-grade composition certification needs a
   larger, freshly held-out set, the charter's intervals at higher N, and a
   rotation policy so a tuned generator cannot consume its own certification set.

## Honesty ledger: where this plan could still over-promise

Kept deliberately, because the review found the design over-claimed and these are
the exact spots to watch.

1. **"The floor makes a model proposer safe" is true only for validity, and only
   for static proposals.** It says nothing about whether the flow is a good
   process. A model could propose a thousand valid-but-useless topologies and the
   floor would bless every one. Do not let "the gates are a sound verifier" slide
   into "generated flows are good."
2. **"Composing without inventing contracts" is proven for exactly one linear
   shape on the nine-block surface.** It is not proven for the sixteen unplaceable
   blocks or for sub-run and fanout. Reporting "genuine composition works" would
   overstate a narrow, instrumented band.
3. **Efficacy is unmeasured for any composed flow.** The only live certification
   to date certified instantiation. Until the live composed arm runs, every
   efficacy claim for a composed flow is a hypothesis.
4. **Rung 1 is easier than Rung 2, not done.** It still requires building the
   sub-run/fanout synthesis the composer lacks and re-locking the eval rule.
   "Easy on-ramp" must not read as "already built."
5. **The coverage probe measures what *can* be composed, not what composes
   *well*.** A high coverage rate is a green light to spend on efficacy, never a
   substitute for it.
6. **N=3 is a directional signal, not a claim-grade certification.** Presenting a
   worth-investing at N=3 as "certified" over-promises statistical strength the
   charter reserves for higher N.

## What this means for next steps

The path is real and it is incremental. In order:

1. **Catalog-coverage probe** (offline, zero cost). Decide whether the composable
   surface is wide enough to justify any spend, and learn which single
   registration unlocks the most tasks.
2. **Rung 1 first slice** (offline, zero cost, git-untracked). A single-leaf
   sub-run orchestration that passes the real floor as VALID. Proves the one
   contract slot Rung 1 needs.
3. **Decision-rule re-lock** (gating prerequisite before any data). Replace the
   build-fold-cost predicate and freeze the test.
4. **Live composed arm** (the first real spend). New harness wiring plus the
   reused scorer, fix family first, paired against the reference.

Nothing above touches `src/` yet, and the genuine-generation spike stays
untracked. The first two steps are pure offline spikes that cost nothing and
either green-light or kill the direction on evidence.

## Update: the non-linear frontier, now walked

[`non-linear-composition-frontier.md`](non-linear-composition-frontier.md)
records the first increment actually taken. The composer can now propose a
bounded, live, bounded inspect/fix/verify loop (PR #123), and an offline probe
sweep sorted the remaining non-linear shapes into three tiers by how much new
machine each needs: re-entry edges are free (shipped), forward branches and
self-loops are static-analysis-bounded (a route-aware dataflow pass, no live
run), and sub-run plus fanout are execution-machine-bound (the same
catalog-coverage wall this dossier names above). The strategic read: the loop
was the one high-value non-linear shape reachable before that wall, and the next
real frontier is sub-run synthesis, not more inline-shape directives.

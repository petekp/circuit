# The non-linear composition frontier: what the composer can and cannot propose

Status: learnings from an offline ($0) investigation, plus one shipped `src/`
change (PR #123). This document records what we now KNOW, by evidence, about how
far the flow composer can go beyond a straight line, and where the real wall
sits. It is the empirical companion to
[`bespoke-flow-generation-design.md`](bespoke-flow-generation-design.md): the
dossier mapped the distance to the north-star in theory; this maps the part we
have now walked.

## The north-star, restated

> Fully generated, bespoke flows that are perfectly fitted to the task, built
> from existing blocks and informed by existing flow patterns and preferences.

The shipped product INSTANTIATES family shapes (the task-aware assembler reads a
task, picks a known family shape, and fills it). The north-star GENERATES a
process. The gap between the two is the composer's expressive range: today it
can only emit shapes it was hand-given. This investigation asked the next
concrete question on the path: how much of the non-linear shape space can the
composer reach, and what does each next step actually cost?

## What we set out to test

The composer (`src/flows/composition/composer.ts`) was a pure LINEARIZER. Given
an ordered role set, it filled each role with a registered actual and emitted
strictly forward routes (`continue -> next`, `stop -> @stop`). It had never
emitted a back-edge, a branch, or a sub-process. The plan was the smallest
honest probe: emit ONE non-linear shape the composer had never produced, push it
through the real offline floor (assemble, compile, catalog gate), and read the
result. Three outcomes were all informative. Can't-propose means the missing
piece is machine, not vocabulary. Proposable-but-invalid means a deeper gate is
the wall, and its error names it. Proposable-and-valid means the wall was only
the route generator.

## What shipped (PR #123)

The composer can now propose a **bounded back-edge loop**: a role may carry
`loopBackTo`, and the composer emits a `retry` route to the nearest upstream
step using that block. This is the inspect/fix/verify loop the shipped `fix`
flow hand-authors (`fix-verify` routes `retry -> fix-act`), now COMPOSED rather
than hand-written.

It is not a dead declaration. Proven offline at $0 and locked as a regression
test (`tests/contracts/composition-loop.test.ts`):

- **Valid.** It passes the real engine gates (assemble, compile, catalog),
  binds a primary result, and reads sensibly.
- **Live.** The work-contract projection auto-derives a `narrow_scope` recovery
  binding for the emitted `retry` route (`route_target = act`, accepts the
  `failed_check` cause a failed verification raises). A failed verification
  loops back to act instead of hard-failing, exactly as `fix`'s hand-authored
  loop does.
- **Bounded.** That binding carries `must_respect_max_attempts: true`; the
  runtime cycle guard caps re-entry.

The composer wired only the one `retry` route. Everything downstream (the
recovery binding, the liveness, the bound) came free from existing machinery.

The eval also learned to SEE topology: `evaluateTopology` reads the route graph
(back-edges, branch points) and emits a signature, so a loop is finally
distinguishable from a line. The locked novelty rubric (`evaluateNovelty`) is
unchanged and stays correctly blind: a loop adds no block, so it reports the
same `(block, kind)` sequence. That blind spot is exactly why a topology signal
was needed.

## The frontier map: three tiers, not one wall

The decisive finding is that the composer's wall is not a single wall. The
non-linear shapes sort into three tiers by how much NEW machine each needs. We
proved each tier's line with an offline probe.

### Tier 1, Free: re-entry edges (the loop). SHIPPED.

A back-edge re-enters an UPSTREAM step. Every step it re-enters already had its
contracts satisfied on the forward pass, so the loop introduces no consumer that
lacks a producer. It needs zero new dataflow reasoning. That is why it worked
the moment the route generator learned to emit the `retry` key. The loop is also
the one genuinely valuable non-linear shape reachable using only inline steps:
it adds real power (bounded iteration) without touching any deeper machine.

### Tier 2, Static-analysis-bounded: forward branches and self-loops.

A forward BRANCH (one step, two distinct forward targets, chosen at runtime via
`route_from_report`) is reachable, but it needs two things the loop did not. We
proved both with `experiments/flow-lab/branch-frontier-probe.ts` (untracked).

1. **An in-vocabulary route key.** Route outcome keys are a closed enum of 30
   (`FlowRoute` in `src/schemas/flow-blocks.ts`). Injecting a branch keyed
   `skip` fails at assemble time: `unknown schematic route outcome: skip`. The
   loop succeeded because `retry` is in that enum.

2. **Route-aware contract availability.** This is the real Tier-2 wall. A
   forward branch that SKIPS a producer step orphans every downstream consumer
   of that producer's contract ON THE SKIP ROUTE. Concretely: a branch
   `plan --(skip)--> run-verification` that bypasses `act` makes
   `run-verification` and `review` read `build.implementation@v1` (the `change`
   contract `act` produces) on a route where it was never produced. The
   validator catches it precisely:

   > input "change" references unavailable contract "build.implementation@v1" on
   > at least one reachable route

   A required input must be available on EVERY reaching route (the intersection
   of reaching routes). The fix is the route-disjoint-gather correction the
   shipped `goal-close` already uses: mark the orphaned input `optional_inputs`
   on the affected consumers (read best-effort, tolerate the gap). With that
   correction injected, the same composed branch validates (`VALID: true`).

   So a branch-aware composer needs a `branchOn` directive (analogous to
   `loopBackTo`) PLUS a static, offline pass that computes which contracts are
   unavailable on each new route and emits `optional_inputs` on the affected
   consumers. The composer already knows producer/consumer relationships from
   its alias map, so this analysis is tractable and needs no live run and no new
   execution kind.

A **self-loop** (a step that retries itself) is a small generalization of
Tier 1: today `loopBackTo` searches only strictly-upstream steps (`j < index`),
so a single-occurrence block cannot target itself. Allowing `j === index` where
the block's check permits a self-`retry` would reach it. Same tier, near-zero
machine.

### Tier 3, Execution-machine-bound: sub-run SHIPPED (PR #124), fanout VALID+BOUNDED, LIVE-blocked (PR #125).

Sub-run (run a child flow as a step) and fanout (run parallel arms and
aggregate) are the real research wall. The composer's `buildExecution` THREW
for both kinds. **Sub-run is now SHIPPED (PR #124, merged `e0241662`); fanout
remains blocked.** See the update at the end of this section.

A finding that SHARPENS the earlier coverage probe: the actual menu ALREADY
surfaces these actuals. `deriveActualMenu` returns 6 sub-run entries (on
`goal-child-run`, generic `goal.child-run@v1`) and 3 fanout entries, including
one on `act` producing `change.evidence@v1` (`prototype.variant-aggregate@v1`),
the exact contract the standard spine uses. So `selectActual` CAN pick a
sub-run/fanout actual. The wall is not registration. It is execution-descriptor
synthesis:

1. **The descriptor is large and dependency-bearing.** A sub-run step needs
   `execution: { kind: 'sub-run', flow_ref, goal, depth }`. A fanout step needs
   a full `SchematicFanout` spec: branches (with a `source_report` pointing at an
   UPSTREAM options-producing step, an items path, and a per-branch template),
   concurrency, an on-child-failure policy, a join policy, and a rubric of
   runtime signals tied to the branch report schema (see
   `prototype/assembly-spec.ts:115`). The composer synthesizes none of it, and a
   fanout in particular presupposes an upstream step it does not yet know to
   place (the options producer its `source_report` reads).

2. **Sub-run output must be consumed downstream.** A sub-run produces a
   child-result contract (`goal.child-run@v1`), which only the `goal` family
   consumes. Splicing one into the standard spine orphans it unless the role set
   is goal-shaped. So a Rung-1 sub-run is not a single inline edit; it is a
   small but real goal-shaped sub-topology.

This is the catalog-coverage wall the dossier named, now located precisely: not
"no actual exists" but "the composer cannot yet synthesize the execution
descriptor these actuals require, nor place the upstream steps they depend on."

**Update (PR #124, merged `e0241662`): sub-run is SHIPPED.** Both predictions
above held, and the build resolved them exactly as written:

- *Descriptor synthesis (point 1):* `buildExecution` now emits the four-key
  sub-run descriptor `{ kind, flow_ref, goal, depth }`. The `flow_ref` is taken
  from the bound donor actual (carried on a new `MenuEntry.subRunFlowRef`),
  because the actual NAME does not reliably encode its child flow —
  `explainer.build-result@v1` runs `build`. `goal`/`depth` come from the role
  (the per-task params). A single-kind sub-run block (`goal-child-run`)
  force-emits its execution, since a four-key descriptor is not the bare
  `{kind}` the expander rejects.
- *Goal-shaped sub-topology (point 2):* the milestone role set is exactly the
  "small but real goal-shaped sub-topology" predicted — `GOAL_THEN_FIX`: frame a
  goal contract → run the Fix child as a sub-run → `close-with-evidence`. The
  child result is soaked forward by the close step.
- *One correction to "the wall is not registration":* selection ALSO needed the
  raw-generic exclusion relaxed. `goal-child-run`'s only actual IS its block's
  raw generic (`goal.child-run@v1` == its `output_contract`), and the
  unconditional `actual === generic` exclusion in `candidateMatchesRole` shut it
  out before `buildExecution` was ever reached. Fixed by excluding the raw
  generic only when its cell also has a specialized actual (`computeNonRawCells`);
  the goal/pursuit families, whose output IS their one specialized contract, are
  now composable. So Rung 1 was the raw-generic relaxation PLUS descriptor
  synthesis PLUS force-emit — three minimal edits, not the one the dossier
  implied.

Proven `$0` and locked (`tests/contracts/composition-sub-run.test.ts`, 9 cases)
with the loop's discipline: VALID (real assemble→compile→catalog floor), LIVE
(the compiled step runs the child and gates on its `RunResult` verdict, with the
gate-real case pinned to the gate's own abort reason so it can't pass via an
unrelated abort path), BOUNDED (the runtime recursion cap refuses the composer's
own emitted step before any child starts), never SENSIBLE. Default-OFF;
built-ins byte-identical; adversarially reviewed clean (blast-radius +
default-safety clean, one low proof-honesty finding fixed in-PR).

**Update (PR #125): the fanout GRAPH is built; the wall MOVED downstream.** The
"presupposes an upstream `source_report`" wall above was real — but only for a
DYNAMIC fanout (one whose branch set is read from an upstream options report at
runtime). A **static** fanout sidesteps it entirely: its branches are listed
upfront, so there is no `source_report`, no upstream producer to place, and no
per-branch template. And a static fanout's branches can each be a SUB-RUN leaf —
the exact shape Rung 1 already proved synthesizable. So the composer can now emit
a **static sub-run fanout**: one step that launches a fixed set of child flows in
parallel and joins them. The descriptor synthesis the dossier feared is done.

Proven `$0` and locked (`tests/contracts/composition-fanout.test.ts`, 8 cases)
with a deliberately honest split at the LIVE rung:

- **VALID.** The composed fanout passes the real assemble→compile→catalog gate.
  `FANOUT_PARALLEL_BUILD`: frame → plan → `act`(fanout of `fix` + `build`
  sub-runs) → `close-with-evidence`. `buildExecution` emits the bare
  `{kind:'fanout'}` marker; a new `buildFanoutMetadata` attaches the sibling
  descriptor (static branches, bounded concurrency 2, continue-others,
  aggregate-survivors, no rubric); a fanout wall refuses fewer than two branches
  or a branch with no goal.
- **BOUNDED.** The recursion cap binds PER BRANCH: started one level past the cap,
  every branch refuses before spawning, the join collapses with zero survivors,
  and no child runner ever fires. The lone-sub-run bound generalizes to the fan.
- **LIVE — SHIPPED (PR #126, 2026-06-20).** At the PR #125 cut this rung was an
  honest negative: the compiled fanout RAN (both children really invoked) but the
  join's aggregate write validated each survivor's `RunResult` body against the
  bound donor aggregate schema `prototype.variant-aggregate@v1`, which types branch
  bodies as the donor's RELAY variant artifacts, so the write aborted. That
  writer-coupling wall is now LIFTED: the composer binds a generic dotted aggregate
  contract (`fanout.aggregate@v1`, body leaves `result_body` open) instead of the
  donor, so the aggregate validates and the `aggregate-survivors` join admits the
  two survivors. The test asserts `complete` plus a `check.evaluated{fanout_aggregate,
  pass}` entry — the first genuine multi-child LIVE pass for a composed flow. See
  "The genuine-LIVE seam" below for the shipped fix.

So the Tier-3 fanout wall, once located one layer deeper than the dossier placed
it (not descriptor synthesis, not unbounded recursion, but the engine's fanout
aggregate being schema-coupled to relay child artifacts), is now fully breached:
the composer outputs a generic aggregate contract and the multi-child LIVE pass
lands. The seam and its resolution are below.

#### The genuine-LIVE seam (mint a generic aggregate CONTRACT) — SHIPPED, PR #126

**Probed offline 2026-06-20 ($0), then SHIPPED the same day (PR #126, MERGED main
`e7569115`). The earlier framing of this seam was too optimistic and is corrected
here; the corrected plan is exactly what shipped.** The seam is NOT "the engine
should validate against `fanout-aggregate@v1`," because that id cannot be a step
output at all. Three findings nailed it down:

1. **`fanout-aggregate@v1` is a report-schema id, not a valid CONTRACT id.** The
   assembler's contract-id grammar is
   `/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@v[0-9]+$/` — it requires a dotted
   namespace. `fanout-aggregate@v1` has no dot, so binding it as the fanout's
   `output` fails at `assemble` before any catalog check. It is fine as the
   runtime's default WRITE schema (`fanout.ts` uses it via
   `aggregate.schema ?? 'fanout-aggregate@v1'`), but a step's output contract and a
   report schema are different namespaces with different grammars.
2. **No existing donor accepts a sub-run aggregate.** All three registered fanout
   actuals strictly type `result_body` to their relay artifact:
   `prototype.variant-aggregate@v1` needs `variant_id`,
   `explore.tournament-aggregate@v1` forces `branch_id` to `option-1..4`,
   `explainer.tournament-aggregate@v1` needs `concept_id`. A scan of EVERY
   dotted-contract schema in the report registry found zero that accept a fanout
   aggregate whose branch `result_body` is a `RunResult`. There is nothing to
   reuse.
3. **The join logic itself already passes; only the write schema blocks.**
   `aggregate-survivors` (`fanout-join-policy.ts:100`) joins successfully on two
   parseable complete survivors and never inspects `result_body` shape. Two
   completing sub-run children give exactly that. The only thing that aborts the
   step is the `writeJson` schema validation at `fanout.ts:333`, which fires before
   the verdict gate at `:362`.

So the conceptual risk is retired: the generic aggregate SHAPE
(`FanoutAggregateFixtureShape`, a `looseObject` whose branch shape leaves
`result_body` untyped) accepts sub-run survivors, and the join passes once the
write validates. What remains is not a probe but a product decision.

**The fix that shipped (2 edits + a test flip — exactly the principled plan):**
1. Minted a DOTTED generic aggregate contract `fanout.aggregate@v1` (Pete blessed
   the name) whose body is the existing `FanoutAggregateFixtureShape` (typed
   envelope: `schema_version`, `join_policy`, `branch_count`, `branches[]`;
   `result_body` left open). Registered it once in `BUILTIN_REPORT_SCHEMAS` — which
   feeds BOTH the `writeJson` report validator AND the anti-widening `BODY_REGISTRY`
   (`contract-body-signature.ts:148-166`), so one registration satisfied both gates.
   The non-dotted `fanout-aggregate@v1` runtime default is kept (different namespace).
2. The composer binds that contract as the `output` for a fanout role
   (`composer.ts:638`, `boundOutput`). Unconditional for the fanout kind (the
   composer's fanout is always a static sub-run fanout); it keeps the donor actual
   for check/wiring scaffolding and overrides the output contract + alias + the
   `close` soak input. **Key mechanism:** `contractIsCompatible`
   (`flow-schematic.ts:804`) accepts the bound output through the generic↔actual
   ALIAS the composer already emits — it does NOT require the output to be a
   registered block actual — so no block-catalog change was needed.
3. Flipped the LIVE test from "aborts on `prototype.variant-aggregate@v1`" to
   "completes, two survivors, `check.evaluated{fanout_aggregate, pass}`."

**Why it was ratification-gated (and how it cleared).** Unlike the loop, sub-run,
and fanout-VALID rungs — which all WIRED existing pieces — this one MINTED a new
first-class product contract, governed by `UBIQUITOUS_LANGUAGE.md` and Pete's
vocabulary call (name, namespace, whether `result_body` stays open or is typed as
`RunResult`). And there was no zero-src offline proof: both the report-schema
registry and the contract registry are import-time globals (`validateReportValue`
hardcoded in `run-boundary.ts:125`), deliberately gated against unregistered
widening, so proving the fix WAS implementing it. So the move was to hand Pete the
proven characterization and the exact diff shape; he greenlit ("Please proceed"),
the name `fanout.aggregate@v1` was blessed (renameable), and it shipped with a
4-lens adversarial review (MERGE, 0 blocking) and full `verify` green.

**Inferior alternative, noted not taken.** The composer could instead have OMITTED
the fanout `output`; the compiler would set `aggregate.schema = undefined` and
`writeJson` skips validation when the schema is undefined (`run-file-store.ts:18`),
so the aggregate would write and the join pass with no new contract. But that
throws away the typed-aggregate check on the fanout's own output, which cuts against
Circuit's typed-floor thesis. The shipped fix keeps the envelope validated while
leaving `result_body` open.

**Open follow-up (low, non-blocking, from review).** The composer's fanout branches
are always sub-run leaves whose `result_body` is `RunResult`-parsed before entering
the aggregate, so typing `branches[].result_body` as `RunResult` for the
composer's sub-run fanout would be an honester floor than the inherited open
`looseObject`. No consumer reads the open field today, so it is a tightening, not a
hole.

## The same wall on the ordinary close: genuine-LINEAR-LIVE — SHIPPED, PR #130

A Phase 3 stub-relayer probe ($0) surfaced that the writer-coupling wall was never
fanout-specific. It recurs on the ONE terminal every plain linear flow uses:
`close-with-evidence`. The sub-run and fanout shapes both terminate on an
aggregate, so they never exercised the ordinary close. A composed plain-LINEAR
short-tail flow does — and it could not run.

The mechanism is the linear twin of the fanout seam. `close-with-evidence` defaults
its output to the GENERIC `flow.result@v1`, but every shipped flow ALIASES that
generic to a FAMILY result (`fix.result@v1`, `build.result@v1`, …) in its
`contract_aliases`. Each family close builder declares REQUIRED upstream reads
(`fix.result@v1` needs change + verification + regression evidence). A genuinely
novel short-tail topology — a triage that goes `frame → gather → diagnose → close`
— cannot produce those reads, so `selectActual` bound the close to a family result
whose required reads were unproducible and the run ABORTED at close time
(`resolveCloseReadPaths` throws on the first unproduced required read). The offline
floor passed the flow anyway: this is a RUNTIME-only wall, a false-negative in the
$0 gate stack.

The fix mirrors PR #126 exactly, one tier down:

1. Register a loose `FlowResultShape` + the contract
   `FLOW_RESULT_CONTRACT = 'flow.result@v1'` in `BUILTIN_REPORT_SCHEMAS`. One
   registration feeds the report-schema registry, the report validator, AND the
   anti-widening body registry.
2. Add a reads-agnostic engine close builder, `GENERIC_CLOSE_BUILDER`
   (`src/flows/registries/close-writers/generic-close-builder.ts`), keyed by the
   generic. It declares no required reads and folds the terminal close's
   evidence-soak set into `evidence_links`, so the diagnosis the flow DID produce is
   carried, not dropped.
3. Composer terminal rebind (`composer.ts:661-670`): at the TERMINAL close, when the
   bound family result's required reads are not all produced by an upstream
   selection, leave the terminal at the generic `flow.result@v1` instead of the
   un-runnable family bind. A full fix/build-shaped composition STILL binds its
   family result, because its required reads ARE produced.

`flow.result@v1` is the terminal OUTPUT and is never CONSUMED via the generic name,
so registering a body keeps the anti-widening gate inert (the vocabulary-pantry A4
lock simply moves it UNRESOLVED → RESOLVED). Honesty holds because the run's outcome
derives from the terminal ROUTE, not this body: composed flows never set
`bindsTerminalOutcomeToPrimaryResult`, so the builder's hardcoded `outcome:'complete'`
is informational and cannot launder a degraded run — a live probe forcing a degraded
upstream relay closed `stopped`, not `complete`. Locked by
`tests/contracts/composition-linear-live.test.ts` (OFFLINE: terminal binds the
generic + spec VALID; LIVE: the compiled triage runs the real engine and closes
@complete with evidence carried). Default-OFF, 8 built-ins byte-identical.

**The remaining linear gap (next follow-up).** The rebind covers only the TERMINAL
close. A MULTI-family linear composition — research-then-build — still ABORTS at an
INTERMEDIATE compose/close writer (e.g. the plan writer), because that intermediate
family result also demands cross-family reads the short upstream cannot produce. The
general fix is the composer RUNNABILITY WALL: an offline producibility check that
every compose/close step's builder required reads are produced upstream, turning the
runtime abort into a compose-time wall (and closing the floor's false-negative).

## The strategic read

This is the orienteering payoff. The tiers tell us where to spend next and
where NOT to.

- **The loop is the right shape to have shipped first.** It is the only
  non-linear shape that adds real power using only inline steps, so it pays off
  without paying the Tier-3 cost. PR #123 banked that.

- **Inline branches are low-value on their own.** A branch between two ordinary
  inline steps is close to degenerate: why fork if both arms are just steps in
  the same flow? Branches earn their keep when the ARMS are sub-processes. The
  shipped `goal` flow proves this: its branches fan to five different child
  flows. So a branch's value is gated by Tier 3, not by Tier 2. Building the
  Tier-2 `branchOn` directive in isolation would be motion without power.

- **That frontier is now closed — the generic aggregate contract shipped (PR
  #126).** Sub-run (PR #124) and the static fanout graph (PR #125) banked Tier 3's
  composer half VALID+BOUNDED; PR #126 lifted the last wall by minting the dotted
  generic aggregate contract `fanout.aggregate@v1` and binding it as the fanout's
  output. The composer can now run a chosen sub-flow as a step AND fan a fixed set
  of them out in parallel, all the way to a genuine multi-child LIVE pass. The
  static fanout sidestepped the upstream `source_report` the dossier feared (its
  branches are listed upfront), so the hard part was never the branch wiring; the
  final piece was a catalog/vocabulary decision Pete owned, now made.

- **The one remaining VALIDITY shape is Tier-2 forward-branch / self-loop**
  (route-aware `optional_inputs`). But per the bullet above, an inline branch is
  low-value unless its arms are sub-processes — and the high-value version of that
  (fanning to sub-runs) is exactly what the static fanout already delivers. So
  Tier-2 is a completeness item, not a power frontier. The next REAL question is no
  longer validity at all; it is EFFICACY (below).

The honest one-line summary: composability is a gradient, and we have now climbed
the composer's whole half of it. The loop proved the composer can emit a runnable
non-linear shape; sub-run (PR #124) proved it can cross a flow boundary gated on a
child's verdict; the static fanout (PR #125) proved it can fan a fixed set of child
runs out in parallel; and PR #126 proved that fan can RUN to completion and admit
its survivors. The dossier feared the fanout descriptor would be the wall; it
wasn't. The contract that was the last wall is minted. The composer-side machinery
for every Tier-3 shape is built and live; what remains is not "can it compile and
run" but "does a composed shape beat its hand-authored reference" — an efficacy
question that needs live spend.

## The live efficacy experiment (ready to run, gated on cost approval)

Everything above is validity (does it compile, wire, gate, and run). None of it
is efficacy (is the composed loop a GOOD process versus the hand-authored
reference). Efficacy needs live runs and scoring. This is the one piece that
costs money, and it is teed up but NOT started.

What it would measure: does a COMPOSED inspect/fix/verify loop perform on par
with the hand-authored `fix` flow's loop on the held-out fix tasks, at equal
honesty (no false-fixed inflation)? That is the first real signal on whether a
composer-emitted non-linear shape is not just valid but effective.

Why it needs new wiring (not a free reuse): the existing dynamic-vs-reference
harness runs `circuit create`, which INSTANTIATES a family shape. It does not
call `composeFlow`. A composed-loop arm needs a new harness path that (a) calls
`composeFlow` on a looped role set, (b) compiles the result through the real
floor, and (c) runs it against the same held-out tasks and the same scorer the
reference arm uses. The scorer, task fixtures, and judge are reusable as-is.

Cost bounds (the prior 48-run pinned-haiku comparison cost about $34): a focused
first cut is the fix family only, paired composed-loop versus reference `fix`,
K=3 reps over the 4 held-out fix tasks. That is on the order of 24 runs, roughly
$15 to $20 at the same dial. Recommend pinning haiku and the same judge for
apples-to-apples. Do NOT run this without Pete's go on the spend; the wiring can
be built and dry-run green at $0 first.

## Pointers

- Shipped change: PR #123 (`feat/composer-bounded-loop`), composer `loopBackTo` +
  `evaluateTopology` + the liveness regression test.
- Shipped change: PR #124 (sub-run synthesis), `composition-sub-run.test.ts`.
- Shipped change: PR #125 (static fanout synthesis, VALID+BOUNDED), `composition-fanout.test.ts`.
- Shipped change: PR #126 (genuine-LIVE fanout — minted `fanout.aggregate@v1`,
  composer binds it as the fanout output), flips the same test to a LIVE pass.
- Offline probes (untracked, $0, re-runnable):
  - `experiments/flow-lab/graph-proposer-loop-spike.ts` (loop accepted by floor)
  - `experiments/flow-lab/branch-frontier-probe.ts` (branch frontier line)
- The route vocabulary: `FlowRoute` in `src/schemas/flow-blocks.ts`.
- The route-aware availability check: `src/schemas/flow-schematic.ts`
  (`optional_inputs`, intersection-of-reaching-routes).
- The fanout execution + metadata synthesis: `buildExecution` +
  `buildFanoutMetadata` in `src/flows/composition/composer.ts`.
- The genuine-LIVE seam (SHIPPED, PR #126): the minted contract
  `FANOUT_AGGREGATE_CONTRACT = 'fanout.aggregate@v1'` and its registration in
  `src/schemas/builtin-report-schemas.ts` (one entry feeds both the report validator
  `validateReportValue` and the anti-widening `BODY_REGISTRY` in
  `contract-body-signature.ts`); the composer binding `boundOutput` at
  `composer.ts:638`; the alias-compatibility check `contractIsCompatible`
  (`flow-schematic.ts:804`, why no block-catalog change was needed); the generic
  envelope shape `FanoutAggregateFixtureShape`; the join logic
  `fanout-join-policy.ts:100` (passes on two survivors); and the aggregate
  write-schema binding at `compile-schematic-to-flow.ts:454` / write at
  `fanout.ts:333`. Background follow-up: tighten `branches[].result_body` to
  `RunResult` for the composer's sub-run fanout.

---

## 2026-06-20 — fanout terminal close fixed; the frontier resolves to two layers

This entry records an overnight increment: one shipped `src/` fix (PR #133), a
precise $0 scope of the sub-run frontier, and the synthesis that ties the
remaining work together. It supersedes the earlier scattered "next frontier"
notes with a single structural picture.

### Shipped: the composed FANOUT shape now runs LIVE end-to-end (PR #133)

The fanout #126 unlock proved the fanout STEP runs live, but it exercised the
step in isolation. The FULL `FANOUT_PARALLEL_BUILD` flow still aborted at its
TERMINAL close: the terminal bound the family result `prototype.result@v1`,
whose close builder requires reading `reports/<id>/plan.json`. In the composed
flow the `plan` output is produced upstream but CONSUMED by the fanout step, so
the terminal evidence-soak (which folds only unconsumed orphans) never lists the
plan read, and the runtime close-read resolver throws at close time.

The #130 terminal-close rebind was meant to catch exactly this, but its
producibility check asked "is the required read's SCHEMA produced upstream?"
(true — plan is produced) instead of "will the terminal close actually READ it?"
(false — plan was consumed, so it is not in the close's input). The fix is one
predicate, from production-space to input-space:

```
const closeReadSchemas = new Set(Object.values(input));
const missingRequiredRead = familyClose.reads.some(
  (read) => read.required && !closeReadSchemas.has(read.schema));
```

This makes "preserve the family bind" exactly equal the runtime success
condition (the resolver derives the close step's reads from the same `input`
map), so the rebind to the reads-agnostic generic `flow.result@v1` fires
precisely when the family close would abort. An adversarial review confirmed no
regression with a differential probe driving the real resolver across five
shapes: the new predicate can only ADD rebind-to-generic cases — any flow it
newly rebinds was already aborting at runtime under the old predicate. Locked by
`tests/contracts/composition-fanout-live.test.ts` (offline binding + runnable,
plus a LIVE end-to-end run to `@complete`). Default-OFF, built-ins
byte-identical, full verify green.

### Scoped ($0): the sub-run terminal is a multi-wall frontier, not the same medicine

A five-shape probe (`composeFlow -> evaluateValidity -> evaluateRunnability`)
characterized the sub-run frontier precisely:

- **The goal OPENER is the first wall, not the close.** `GOAL_THEN_FIX`
  (frame `goal` -> sub-run `fix` -> generic close) is offline-VALID but NOT
  runnable: the `goal` contract writer reads `goal.clarified-task@v1` as
  `required` (`writers/contract.ts:46`), produced only by an upstream clarify
  step the role set omits. So the goal step aborts before the close is reached.
  **This corrects the record:** the PR #124 "sub-run runs LIVE" proof ran the
  sub-run STEP in isolation (`isolatedSubRunFlow`); the full `GOAL_THEN_FIX`
  flow was never run end-to-end, and as composed today it would not complete.
- **`goal-close` is family-locked at COMPOSE time.** It needs
  `goal.attempt@v1` / `goal.evidence-evaluation@v1`; with only
  `goal.contract@v1` + `goal.child-run@v1` produced, the block walls during
  selection — UPSTREAM of the terminal rebind, so the close-rebind medicine
  never even runs.
- **Two sub-runs get DISTINCT outputs** (`goal.child-fix-result@v1`,
  `goal.child-build-result@v1` — no per-instance collision), but the two-sub-run
  shape fails to compile for a separate reason (open).
- **A bare sub-run requires a goal opener upstream** (it reads
  `goal.contract@v1`) — structural and correct.

So making the sub-run shape genuinely composable needs at least three coordinated
moves (a runnable opener, a generic close reachable past the compose wall, and
the two-sub-run compile fix), not one predicate. It is a dedicated effort, not an
overnight patch.

### Synthesis: the remaining frontier is two layers, and `fix` is special

Probing the build family the same way is decisive. A composed BUILD linear arc
(frame -> plan -> act -> verify -> close) does not compose: `plan` as a relay has
no actual producing `plan.strategy@v1`, and `act` needs a plan/diagnosis
precursor. Underneath, `build.brief@v1` is written by a CHECKPOINT writer, so the
`frame` role can only bind the generic `flow.brief@v1` — the build chain cannot
even start. The same shape blocked `RESEARCH_THEN_BUILD`. This separates the
remaining work into two distinct capabilities:

1. **Selection intelligence (producibility-aware SELECTION).** Today
   `selectActual` binds each block to some family's actual independently, which
   can produce a contract-incoherent chain that the runnability detector (PR
   #131) flags but selection still emits. The repair is a forward-looking
   coherence check: do not bind a writer whose required reads no upstream
   selection can produce; prefer a producible family. This navigates the
   reachable set intelligently — it makes multi-family attempts fail cleanly or
   resolve to a coherent family. It does NOT enlarge the set.

2. **Family reachability (expose checkpoint-gated entry contracts).** Some
   families (`build`, `goal`) have their FIRST contract produced by a checkpoint
   writer, never a compose/relay writer, so the composer cannot select an actual
   to START the chain. `fix` is the one family whose entire chain
   (brief -> context -> diagnosis -> change -> verification) is compose/relay
   reachable, which is exactly why the COMPOSITION-VIABLE efficacy result is
   currently fix-family-specific. Expanding reachability means giving these
   entry contracts a composer-reachable producer (compose the checkpoint step,
   or register a compose/relay actual for the entry brief).

The terminal-close rebinds (linear #130, fanout #133) are LOCAL patches that let
a reachable-but-short chain close honestly. The two layers above are the GENERAL
work: layer 1 makes the composer never emit an un-runnable chain; layer 2 makes
more than one family reachable at all. Both are genuine composer-intelligence
changes with wide blast radius — they belong in dedicated, ratified sessions, not
an unattended overnight patch.

### Conditional phase map (what to do next, by outcome)

- **Phase A — producibility-aware SELECTION (layer 1).** Build the
  forward-looking coherence check in `selectActual`. Outcome gate: does it make
  any multi-family linear shape (e.g. `RESEARCH_THEN_BUILD`) bind to a coherent,
  runnable single family instead of walling? If yes, the composer stops emitting
  un-runnable chains and the proposer's repair loop converges faster. This is the
  highest-leverage engine step and is self-contained.
- **Phase B — family reachability for `build` (layer 2).** Expose
  `build.brief@v1` (and the plan entry) as composer-reachable. Outcome gate: does
  `BUILD_LINEAR_FULL` reach VALID + runnable offline? Only then is a build-family
  composed efficacy arm worth live spend.
- **Phase C — sub-run end-to-end (now ONE wall, not multi-wall; see the
  2026-06-21 probe section below).** The terminal close is already generalized by
  #133 (the sub-run close binds generic `flow.result@v1`), so Phase C reduces to a
  single Layer-2 task: make the goal opener's required `goal.clarified-task@v1`
  read producible by a composed upstream step (mint a `clarified.task@v1 →
  goal.clarified-task@v1` alias, or relax the opener to accept the generic) — gated
  on schema-shape compatibility and a green `check-flow-drift`. Outcome gate: full
  `GOAL_THEN_FIX` runs end-to-end through the real engine (not isolated).
- **Phase D — live data Pete may want regardless of A–C.** Shape-sensitivity:
  does topology move efficacy for a FIXED task, or is the scarce ingredient
  step-level judgement? Prior dial/depth sweeps were flat; topology is an
  untested axis. Needs new harness wiring to vary topology for one task and the
  existing scorer; ~$15–20 pinned haiku. Independent of the engine layers.

### Pointers (this increment)

- Shipped: PR #133 (`feat/fanout-terminal-close-rebind`), the input-accurate
  predicate at `composer.ts` (~L684) + `composition-fanout-live.test.ts`.
- The goal opener wall: `src/flows/goal/writers/contract.ts:46`
  (`goal.clarified-task@v1` required), produced by the clarify step
  (`src/flows/goal/data.ts:55`).
- The build reachability wall: `build.brief@v1` is checkpoint-written; `plan`
  has no relay actual for `plan.strategy@v1`.
- The runnability detector that flags incoherent chains offline:
  `evaluateRunnability` in `src/flows/composition/evaluate.ts` (PR #131).

---

## 2026-06-21 — sub-run scope refined by a $0 probe (Phase C shrinks)

A throwaway offline probe (compose `GOAL_THEN_FIX` → `evaluateValidity` →
`evaluateRunnability`, then delete) sharpened the Phase C picture and **corrected
a stale claim** carried over from the proposer finding (its "Result 4: fanout AND
sub-run terminals are family-locked").

**Finding 1 — the sub-run TERMINAL close is already generalized; #133 covers it.**
`GOAL_THEN_FIX`'s terminal is the same `close-with-evidence` compose block the
fanout flow uses, and the rebind guard is `isTerminal && executionKind !==
'fanout'`, so the #130/#133 input-accurate predicate fires for the sub-run close
too. The probe confirmed it: the composed sub-run terminal binds the generic
`flow.result@v1` (`close.output` is undefined, no aliasing-away), not the goal
family result. So the "sub-run terminal is family-locked" claim is **stale** — the
fanout fix closed the sub-run terminal as a side effect of the same predicate.

**Finding 2 — sub-run end-to-end reduces to ONE wall: the goal OPENER.**
`GOAL_THEN_FIX` is still not runnable, but the abort is at the *opener*, not the
close: `goal(goal.contract@v1): expected exactly one report writer for schema
'goal.clarified-task@v1', found 0`. The goal `contract` frame
(`src/flows/goal/writers/contract.ts:46`) reads `goal.clarified-task@v1`
**required**; in the real goal flow an upstream clarify step
(`src/flows/goal/data.ts:55`, a relay channel) writes it; in the composed
frame-first chain nothing produces it. This is pure **Layer-2 reachability**, the
same shape as the `build.brief` wall.

**Finding 3 — the opener can't take the terminal-close medicine, and there's a
name mismatch.** Unlike the terminal close (where the generic `flow.result@v1`
just needs *some* outcome), the opener's read is **semantically load-bearing** —
the goal contract is framed *from* the clarified task, so a reads-agnostic generic
opener would lose the content it needs. And the catalog's generic `clarify` block
(`docs/flows/block-catalog.json`) outputs `clarified.task@v1` (dotted generic),
while the goal opener reads `goal.clarified-task@v1` (family-specialized) — a
**contract-name mismatch**, so merely placing the generic clarify block upstream
would still leave the read unproduced.

**So Phase C is no longer "multi-wall." It is one well-scoped Layer-2 task:** make
the goal opener's `goal.clarified-task@v1` read producible by a composed upstream
step. The two candidate fixes, both real engine changes with semantic weight:

1. **Composer mints a `contract_alias` `clarified.task@v1` → `goal.clarified-task@v1`**
   when a clarify block is placed ahead of the goal opener (mirrors the
   aggregate / terminal-close generic-alias pattern). **Gated on** proving the two
   schemas are structurally compatible (a `GoalClarifiedTask`-vs-`clarified.task@v1`
   shape diff) — an alias between incompatible shapes would launder a malformed read.
2. **Relax the goal opener's input contract to accept the generic
   `clarified.task@v1`.** Smaller composer change, but it edits the goal family's
   input contract, which feeds byte-identical built-in checks — so it must prove
   `check-flow-drift` stays green and the goal built-in is unchanged.

Either way it is a deliberate, ratified task (it touches the goal family's
contracts and the byte-identical floor), not an unattended patch. The win when
done: `GOAL_THEN_FIX` runs end-to-end through the real engine, completing the
sub-run shape exactly as #133 completed the fanout shape.

---

## 2026-06-21 — frontier phases A–D EXECUTED (all merged to `main`)

The conditional phase map above is now resolved: all four phases shipped in one
autonomous overnight sweep, each on its own branch, TDD + adversarially reviewed,
built-ins byte-identical throughout. What actually landed, and how it differed from
the plan:

- **Phase A — producibility-aware SELECTION ✅ (PR #134, `67594dfa`).** Built as
  designed: `selectActual` now breaks a family-rank tie toward the family whose
  whole-line writer required-reads are least starved (`computeFamilyCoherence`
  hypothetically binds each family across the whole line and counts unproduced
  required reads). The runnability gate is now **repair-then-wall**, not detect-only —
  a compose-only `frame→plan→close` that greedily bound `explainer` (and aborted at
  `plan` on `explainer.digest@v1`) now binds the runnable `prototype` family
  end-to-end. Gated behind `enforceRunnability`, default byte-identical. Outcome gate
  met with one honest boundary: `RESEARCH_THEN_BUILD` (a multi-family research→build
  arc) **still walls** — selection finds no single runnable family for it, which is the
  floor working, not a miss. Adversarial-review remediation folded in: a terminal close
  was counted as starved on its unproduced reads, but the terminal-close rebind always
  falls back to the generic `flow.result@v1`, so it never aborts there — starvation
  counting now skips a terminal-close role so the coherence score matches the binder.

- **Phase B — build reachability ✅ (PR #136, `350f57c1`) + B-live ✅ (PR #137,
  `41a86da0`).** Built as designed: a composed content checkpoint now writes a readable
  `build.brief@v1`. `stepWrites` gained `checkpointWritesReport` (emits a `report_path`
  on the checkpoint case, exactly as the real build frame-step writes
  `reports/build/brief.json`), and `MenuEntry` carries the donor's
  `policy.report_template` (read live from the catalog, drift-free); one flag gates both
  so a checkpoint never writes a report it cannot populate. `BUILD_LINEAR_FULL`
  (frame-checkpoint → plan → act → verify → review → close) reaches VALID + runnable
  offline, clearing the gate. The live arm then ran it against the hand-authored build
  reference: **4/4 objective-fixed, 0 false-fixed, 0 pipeline failures, strictly cheaper
  on every task** ($0.118 vs $0.191 median) — the second family to compose from blocks
  and close honestly. RAW aggregate, no verdict (the composed decision rule is fix-only),
  non-discriminating tasks, reps=1: an existence proof at lower cost, not a measured win.
  Finding: [`composed-build-arm-finding.md`](../../evals/dynamic-vs-reference/composed-build-arm-finding.md).

- **Phase C — sub-run end-to-end ✅ (PR #135, `56e4acf8`), resolved differently than
  the two candidates above.** The plan proposed either a `contract_alias` or relaxing
  the goal opener's input contract. What actually landed sidesteps the name-mismatch
  entirely: (1) PRODUCER — a new `GOAL_CLARIFY_THEN_FIX` role set prepends the goal
  family's *own* `clarify` relay, so `goal.clarified-task@v1` (the family-specialized
  name) is produced upstream by the right writer, no alias needed; (2) WIRING — a new
  always-on intermediate compose-reads pass (mirrors the #132 verification-reads pass)
  wires every REQUIRED compose-writer read an upstream selection produces into the step
  input, keyed by read name, and SKIPS silently when a required read is unproduced (so
  `RESEARCH_THEN_BUILD`'s `build.brief` opener stays composable and the runnability gate,
  not a compose-time wall, reports its abort). A static collision guard fails the build
  if a future writer's required read shadows a declared input key. `GOAL_CLARIFY_THEN_FIX`
  now composes, validates, **and runs end-to-end** — so sub-run joins linear/loop/fanout
  and **all four composed shapes now run full flows**, not just their isolated step.

- **Phase D — shape-sensitivity ✅ (PR #138, `2983ec2b`).** The same composed fix arc
  at three topologies (lean 5-block / full 6-block / loop 6-block+recovery), 4 held-out
  tasks × reps=3 = 36 live runs, pinned haiku. **Topology is efficacy-flat and
  cost-real.** Efficacy did not separate (lean 11/12, full + loop 12/12 — one rep-flip
  the miss-analysis traces to model variance on a fix reachable *without* the dropped
  `gather-context` block, not information starvation); cost and latency track block count
  monotonically (lean ~32% cheaper, ~31% faster than full); the loop's recovery route
  never fired, so loop cost the same as full. The read: **step-level judgement, not graph
  shape, is the scarce ingredient** — graph shape is near-free on efficacy and not free on
  cost. Bounded claim: "no topology effect detected on non-discriminating tasks." Prior
  dial/depth sweeps were flat; this is a third, orthogonal axis pointing the same way.
  Finding: [`composed-shape-sensitivity-finding.md`](../../evals/dynamic-vs-reference/composed-shape-sensitivity-finding.md).

**Net:** the two-layer composer-intelligence frontier (producibility-aware *selection* +
family *reachability*) is shipped for fix, build, and goal; two families compose
end-to-end and beat-or-match their hand-authored reference on external-truth tests; and
the topology question is answered. Remaining open, all named, none blocking: the
**proof-richness gap** (the leaner composed arc closes a generic `flow.result@v1` receipt
vs the fix family's purpose-built proof bundle — and the build proof scorer is too coarse
to even register it); **discriminating task sets** (every efficacy crossing so far is
near-ceiling, so the loop's recovery value is structurally untested — it never fired); the
low-value **Tier-2 forward-branch / self-loop**; and wiring the offline **proposer** half
(task → role-set, which works 1/8 → 6/8 with verifier-driven repair) into a product path.

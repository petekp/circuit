# Thicken feasibility — "generate thin, then thicken"

Night run, 2026-06-21. Offline spikes only ($0). Branch `exp/thicken-night-run`.

## The idea under test

Pete's musing: a flow starts **thin** (a research step that understands the
context), then **thickens** its remaining steps to fit what research found. The
thin shape might be "research + report"; the thick shape it grows into might be
"research + diagnose + plan + implement + verify + close". This unifies the
generation track (propose a topology) with the reshape track (mutate the topology
mid-run).

Two questions decide whether this is reachable today:

1. **Is mid-run reshape SAFE?** When a running flow re-shapes its remaining steps,
   what does the splice seam catch, and where is it fail-open?
2. **Can the thicker shape RUN?** When a thin flow thickens into a build tail, does
   the engine's full floor accept the result?

Phase 3 answers (1). Phase 2 answers (2). Phase 1 (live, separate) measures whether
context-conditioning is even worth doing.

## Phase 3 — the splice safety envelope (splice-safety-battery.ts)

The splice seam (`spliceIntoRemainingSteps`) re-runs two gates on a spliced
schematic: the **schema** floor (`FlowSchematic.safeParse`, dangling routes / shape)
and the **catalog** floor (`tryCompile` → `collectSchematicCatalogIssues`). It does
NOT re-run `evaluateRunnability` (the writer-coupling producer chain) — that gate
takes a pre-assembly *spec*, but the splice operates on a post-assembly *schematic*.

Results (all measured, `_splice-safety-results.json`):

| Property | Result |
|---|---|
| Demonstrator floor holds (regression) | PASS |
| Legal decompose-down splice honored + clean (control) | PASS |
| H1 — laundered exit (subtree tries `continue -> @complete` to skip verify) | **BLOCKED**: outbound re-home forces `continue -> verify-step`; the self-declared `@complete` is overridden. Skipping verify is structurally impossible. |
| H2 — input-contract producer break (replacement stops producing `build.implementation@v1`) | **CAUGHT by the catalog gate**: "input references unavailable contract on at least one reachable route." Not fail-open. |
| H3 — isolation | PASS: the splice mutates only clones; the caller's schematic and run state are byte-identical after a splice. |
| H4 — writer-sourced required-read break (a composed tail whose writer's internal read has no producer) | **FAIL-OPEN through the seam**: seam gates (schema + catalog) ACCEPT a flow the full floor REJECTS (`plan` aborts on unproduced `build.brief@v1`). |

### The bounds table (the decision-grade output)

| Break class | Reachable by | Seam gates (schema + catalog) | Full floor (`evaluateRunnability`) |
|---|---|---|---|
| Input-contract producer missing | in-position splice (decompose-down) | **CATCHES** (H2) | catches |
| Writer-sourced required-read missing | composed / re-proposed tail (novel writer wiring) | **FAIL-OPEN** (H4) | catches |

**Why H2 is caught but H4 is not.** An in-position splice can only break a
contract the displaced step *produced* (`build.implementation@v1`) — and that is a
declared *input* of downstream steps, which the catalog gate checks. A composed tail
can introduce a *writer* whose internal sourced read (e.g. the build-plan writer's
`build.brief@v1`) has no producer — that read is not a checked input contract, so
only `evaluateRunnability` sees it. This is exactly why `evaluateRunnability` was
built (the historical live composed-arm abort, tasks #79/#87); it is locked by
`tests/contracts/composition-runnability.test.ts`.

**Design constraint for any thicken capability:** a thicken that splices an
in-position decomposition (reusing built-in bodies) is covered by the seam's catalog
gate. A thicken that splices a **model-composed tail** MUST additionally run
`evaluateRunnability` before honoring — re-run the FULL floor, not just schema +
catalog.

## Phase 2 — can the thick shape run? (thin-then-thicken-demo.ts)

Two locked role sets through the real floor (no model):

| Shape | Topology | Seam gates | Runnable (full floor) |
|---|---|---|---|
| THIN — research + report | frame → gather-context → diagnose → close (4 steps) | accept | **YES** |
| THICK — research, then build | frame → gather-context → plan → act → run-verification → review → close (7 steps) | accept | **NO** |

The THICK shape passes the seam gates but aborts at `plan`: "expected exactly one
report writer for schema `build.brief@v1`, found 0." A compose frame produces
`fix.brief@v1`; the build-plan writer needs `build.brief@v1`, which only a
*checkpoint* writer produces. You cannot weld a build tail onto a compose-framed
research head.

**The blocker for the north-star "research, then build" thicken is composer
COVERAGE — NOT the splice mechanism (Phase 3 proved that safe) and NOT the seam
gates (the thick shape passes them).** This is a known, separately-tracked gap (the
same wall #112/#113 chipped at), not a new one. Phase 2.5 (below) sharpens what
"coverage" actually means.

## Phase 2.5 — the coverage blocker is a contract-alias collision, not producibility (build-brief-reframe-spike.ts)

Phase 2 framed the blocker as "`build.brief@v1` is not producible from a composed
role." **That framing is wrong, and this probe refutes it.** Four locked role sets
through the real floor:

| Shape | Frame | Blocked by | Why |
|---|---|---|---|
| BASELINE (RESEARCH_THEN_BUILD) | compose → fix.brief@v1 | runnability | `plan` reads build.brief@v1, no producer (Phase 2's finding) |
| CONTROL (BUILD_LINEAR_FULL) | checkpoint → build.brief@v1 | none — **RUNNABLE** | a content checkpoint mints build.brief@v1; the whole build arc runs |
| HYPOTHESIS (research head + mid-flow checkpoint re-frame + build tail) | compose → fix.brief@v1, THEN checkpoint → build.brief@v1 | **catalog** | the checkpoint DID mint build.brief@v1 (`frame-2 => build.brief@v1`, `plan => build.plan@v1`), but two brief families collide |
| FALSIFIER (re-frame is a plain compose) | compose, compose | catalog | different bindings; control |

The mid-flow content checkpoint **does** produce `build.brief@v1` — so
"`build.brief@v1` is unproducible from a composed role" is **false**. The producer
is there (`checkpointWritesReport`, composer.ts:447-463 / 756-759). The hypothesis
shape is instead rejected at the **catalog gate** (before runnability) by a
**contract-alias collision**:

```
output "fix.brief@v1" is not compatible with block output "flow.brief@v1"
inputs do not satisfy block "gather-context"; expected one of [flow.brief@v1, context.request@v1]
inputs do not satisfy block "diagnose"; expected one of [flow.brief@v1, context.packet@v1]
```

Root cause, confirmed in code. `frame-1` produces `fix.brief@v1` and `frame-2`
produces `build.brief@v1`; both are specializations of the same generic
`flow.brief@v1`. The composer's contract-alias layer is a single
`Map<generic, actual>` (`aliasByGeneric.set(outputGeneric, boundOutput)`,
composer.ts:961). The second `.set()` **overwrites** the first, so `flow.brief@v1`
resolves to `build.brief@v1` and the research head's `fix.brief@v1` is orphaned —
`gather-context` / `diagnose`, which read the brief, can no longer see their input.

**So the real wall is one-actual-per-generic contract aliasing. A single composed
flow cannot contain two steps that produce two different specializations of one
generic contract (two brief families).** That is the genuine engine constraint
behind "you cannot weld a build tail onto a compose-framed research head" — not a
missing producer.

A second, distinct wall sits behind the other obvious route: opening on a
checkpoint frame (build.brief@v1) and inserting the research relays *after* it hits
an assembly-level error (`Invalid string: must match pattern …@v\d+`) — a separate
checkpoint-first + relay-read wiring problem, not the alias collision. Both are
composer-internal, both are tractable engine changes, neither is "add a producer."

## Phase 1 — does context-conditioning produce a better-fitted proposal? (context-premise-spike.ts + blind judge panel)

This is the LIVE arm (pinned `claude-haiku-4-5`, reps=3, ~$ small). It asks the
question the whole "thin then thicken" idea rests on: **if a research step feeds the
proposer richer context, does the proposer propose a better-fitted flow?**

Setup: per task, Arm A proposes from the base task only; Arm B proposes from base
task + a paragraph of "what investigation found." 7 tasks (5 "shift" tasks where
context should matter, 2 controls). A separate **blind judge panel** (21 verdicts: 7
tasks × 3 lenses — task-fit / sufficiency / minimality) then compared each task's
two modal shapes, blinded as X/Y, and the verdicts were scored against the hidden
A/B mapping (`_score-judge-panel.ts`, deterministic).

### What the panel said (scored, `_fittedness-score.json`)

| Task | class | context made it | panel winner | outcome |
|---|---|---|---|---|
| flaky-test | shift | leaner (dropped diagnose) | un-conditioned A | context HURT* |
| export-feature | shift | leaner (dropped plan) | conditioned B | context helped |
| auth-migration | shift | leaner (dropped diagnose+review) | un-conditioned A | context HURT |
| audit-then-fix | shift | richer (added act+verify) | conditioned B | context helped |
| vague-improve | shift | identical | tie | no signal |
| simple-fix-control | control | leaner (dropped diagnose) | conditioned B | context helped |
| audit-readonly-control | control | identical | tie | no signal |

### The honest headline: on the shift tasks, fittedness is a WASH

Counting only the tasks meant to test the premise (the 5 shift tasks): **2 helped, 2
hurt, 1 tie.** The third "helped" is a *control* (simple-fix-control), where the win
is the proposer correctly declining to over-build a one-line fix — real, but a
different mechanism (avoiding ceremony) than the shift wins. So richer up-front
context did **not** reliably produce a better-fitted proposal. It produced a
*different* one.

### The mechanism: context mostly PRUNES, and pruning is double-edged

In 5 of 7 tasks Arm B proposed **fewer** steps than Arm A; only audit-then-fix grew.
The same pruning operation helped (dropped a redundant `plan` on export-feature's
paved path; dropped a redundant `diagnose` on the already-pinned simple-fix) and hurt
(dropped a `diagnose`+`review` on auth-migration). Same move, opposite value. Worth
flagging against the "pruning" framing: the single biggest *correct* move in the set
was an **addition** — audit-then-fix's Arm B grew the `act`+`verify` the situation
demanded, which the blind Arm A missed.

### Where this lands the north-star: the bottleneck is per-step necessity judgement

The clean failure is **auth-migration**: the base task literally says "Decide whether
to move… and if it is the right call, carry out," and the context adds "touches every
endpoint" (43 of them, security-sensitive). The proposer had every reason to keep a
decision/review step and dropped it anyway. That is a **judgement failure, not an
information deficit** — the signal to keep the step was in front of it.

This corroborates the prior north-star finding (shape-sensitivity, #138): the binding
constraint is the model's **per-step "do I need this step?" judgement**, not the
topology machinery and not the amount of context. Richer context did not fix that
judgement; it just changed which way it erred.

### Caveats this result must carry (from the adversarial pass)

- **Tiny n, directional only.** 5 discriminating tasks, reps=3, one proposer model,
  one judge model, no confidence intervals. For 4 of 7 tasks the "modal" shape is a
  2-of-3 majority — one different rep would flip it. This is a **directional spike,
  not a measured effect**. No magnitude or significance claim is supportable.
- **The judge may reward ceremony.** On flaky-test the context already *hands the
  proposer the diagnosis* ("a genuine race condition in ConnectionPool.acquire… not a
  test-only timing issue"), so dropping the `diagnose` step is arguably *correct*
  pruning — and the judge penalizing B for it may be the judge preferring an analysis
  step the situation has already resolved. So that "hurt" is **contestable**, and more
  broadly the panel cannot cleanly separate "context pruned a *needed* step" from
  "context pruned a step the judge *likes*." The identical-pair controls (vague-improve,
  audit-readonly-control) both returned tie 3/3, which validates the panel against
  *positional* bias but **not** against this *content* bias.
- **Only auth-migration is a clean failure.** flaky-test is contestable per the above;
  do not present both "hurts" as equally clean.

### What this does NOT establish (guarding against a tempting over-read)

It is tempting to conclude "therefore build thicken as an **additive** process (start
minimal, only grow when evidence confirms a step is needed) — additive can't lose a
step it never had." The structural half is true. But this experiment does **not**
establish that additive is *safer*, because additive thicken inherits the *same*
unreliable step-necessity judgement, merely inverted: the auth-migration proposer that
wrongly judged `review` unnecessary would, in an additive process, **fail to add** it
and reach the identical bad shape. The data shows the same judging faculty failing in
**both** directions (over-pruned auth; the blind Arm A *under-grew* audit-then-fix
until context forced the addition). "Additive is safer" is an architectural preference
worth holding as a hypothesis — it is not a result of this run.

## Phase 4 recommendation (FINAL — Phase 1 landed)

**Hold the bounded-thicken src capability. Ship the safety findings as a dossier.**
Two independent walls, at two different layers, both now pinned:

**Wall 1 — engine (Phase 2.5): cross-family thicken does not assemble.** A real build
tail grown from a compose-framed research head cannot be made runnable today because
of the **contract-alias collision** (two brief families share one generic;
`aliasByGeneric` binds one actual per generic, composer.ts:961). Narrow and tractable,
but unbuilt. Within a single family's already-runnable shapes a thicken is a much
smaller prize than the north-star, and that prize is largely already covered by
`proposeFlow` + the offline floor.

**Wall 2 — value/judgement (Phase 1): the headline benefit is unproven.** The premise
that richer context yields a better-fitted proposal came back a **wash** on the shift
tasks, and the deciding faculty (per-step necessity judgement) is unreliable in both
directions. Shipping the thicken machinery before that judgement is reliable would
ship a capability whose advertised benefit — flows better-fitted because research
informed their shape — does not yet materialize.

So the hold is now doubly justified: even if Wall 1 were fixed tomorrow, Wall 2 says
the result would not reliably be a *better* flow. The leverage is on the model's
step-necessity judgement, not on the splice/compose plumbing (Phase 3 proved the
plumbing safe; Phase 2.5 mapped the engine gap).

**The precise unlock, in priority order:**
1. **Per-scope contract aliasing** in the composer (composer.ts:961): let a flow
   carry more than one actual per generic by scoping the alias to the producing
   step's reach instead of a single flow-global `Map`. This is the real wall behind
   cross-family "thin then thicken." (Secondary: fix the checkpoint-first +
   relay-read assembly error so a build-brief-first research arc assembles.)
2. A reliable **step-necessity judge** — the actual bottleneck Phase 1 exposed. Before
   any thicken capability is worth its machinery, the model (or a verifier around it)
   has to decide "does this situation need a diagnose / review / verify step?" more
   reliably than haiku did here. This is the same faculty #138 named as dominant.
3. THEN, and only then, a bounded-thicken seam: `spliceIntoRemainingSteps` + a
   mandatory `evaluateRunnability` pass before honoring (closes H4), default-off,
   behind an engine flag. Build it **additive** (grow from minimal) rather than
   regenerative (re-propose from context) — a structural preference, not a proven win.

## Adjacent finding — rung 2 (equipment reshape) is ALREADY the shipped form of the idea

Pete's musing is "a research step decides to mutate the workflow, and subsequent
steps adapt." That is **already shipped**, at the equipment level — and this probe
corrects an outdated memory note ("no shipped flow triggers equipment reshape").

What the wiring actually is:

- `createEquipmentReshaper(flow)` is injected into **every** compiled-flow run
  (`compiled-flow-runner.ts:127`) — the standard path and each recovery attempt
  alike. No feature flag. It is inert only when a caller invokes
  `executeExecutableFlow*` directly (tests / internal helpers).
- The graph runner (`graph-runner.ts:1179-1211`) calls it after a relay step when
  that step's report carries a confirmed `equipment_discovery`. It re-equips the
  **remaining, not-yet-run relay steps** and swaps in a re-validated executable tail.
  Additive only: equipment never changes the step **sequence** (that is rung 3).
- The trigger field lives on `FixDiagnosis` (`fix/reports.ts:183`) — the fix
  family's **diagnose / research** step — and on the build family's report
  (`build/reports.ts:236`), each with a model-facing instruction: "ONLY when the code
  you read confirms a technology the downstream steps should be equipped for (e.g.
  React)... Set confirmed:true ONLY on unambiguous evidence." That instruction is
  compiled into BOTH shipped host plugins (`plugins/claude/runtime/circuit.js`,
  `plugins/codex/runtime/circuit.js`, minified key `ln`).

So the shipped fix flow's diagnose step **can** trigger downstream re-equipping when
it confirms a technology — "research found this is React → re-equip the implementer
for React." The mechanism is wired and triggerable, not dormant code. The honest
caveat is that the trigger is **conservative by design** (confirmed-only,
unambiguous evidence), so it fires rarely, not never. Memory note in
`project_bespoke_flow_generation.md` should be corrected from "no shipped flow
triggers this" to "the fix flow's diagnose step can trigger it; the confirmed-only
gate makes it rare."

**Why this matters for the north-star:** the findings-driven-downstream-mutation
pattern already has a working, shipped precedent in the product. The thicken work is
the same pattern raised one level — from mutating **equipment** (live) to mutating
the **step sequence** (gated). That both validates the direction and bounds what is
genuinely new.

## Artifacts

- Phase 1 (live): `experiments/flow-lab/context-premise-spike.ts` →
  `_context-premise-results.json` (per-rep proposals) + `/tmp/context-premise-live.log`.
  Blind panel: `_extract-judge-pairs.ts` → `_judge-pairs.json` (blinded pairs + hidden
  mapping); the panel verdicts in `_judge-panel-raw.json`; scored deterministically by
  `_score-judge-panel.ts` → `_fittedness-score.json`.
- `experiments/flow-lab/splice-safety-battery.ts` → `_splice-safety-results.json`
- `experiments/flow-lab/thin-then-thicken-demo.ts` → `_thin-then-thicken-results.json`
- `experiments/flow-lab/build-brief-reframe-spike.ts` → `_build-brief-reframe-results.json`
  (Phase 2.5 — refutes the producibility framing, pins the contract-alias collision)
- Builds on `experiments/flow-lab/splice-demonstrator.ts` (the seam) and
  `tests/contracts/composition-runnability.test.ts` (the locked floor).

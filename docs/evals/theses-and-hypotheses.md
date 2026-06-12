# Circuit theses and hypotheses

Living document. This is the record of what Circuit claims, how each claim
gets tested against external truth, and what result would prove us wrong.

## How to read this

- A **thesis** is a belief about why Circuit creates value. It is the reason
  a feature exists. Theses are broad and we do not get to assert them for
  free.
- A **hypothesis** is a specific, falsifiable prediction. If a hypothesis
  fails, the thesis above it is in trouble. Every hypothesis carries a
  status and either the evidence behind it or the experiment that would move
  it.
- A thesis is only as strong as the hypotheses we have actually tested. A
  claim that has not survived a check the agent could not see is not yet
  evidence (see T4).

Status vocabulary: **supported**, **untested**, **partial**, **at-risk**,
**refuted**.

All current controlled evidence comes from the fix-vs-vanilla held-out eval,
and its hard limits bound everything below (see "Caveats"). Where a thesis
leans on observational evidence (usage counts, incident write-ups) the status
says so. Observation can motivate a thesis; it cannot support one.

## Theses

### T1 — Structure buys honesty

A structured flow (research, act, verify, review) makes an agent over-claim
less than a bare agent. It produces fewer false "I fixed it" claims, because
an independent verify step and a review step force the agent to confirm a fix
instead of declaring victory.

This is the load-bearing thesis. The Fix receipt and the whole "you can trust
the agent's claim" pitch rest here. If T1 is false, the product's core
promise is false.

### T2 — Honesty, not intelligence

The flow sells trustworthiness, not raw capability. At the same model it does
not fix *more* bugs than a bare agent. It claims fewer *false* fixes. This is
a deliberately humble claim, and being honest about it is itself a feature:
we are not selling a smarter model, we are selling a more trustworthy
process around whatever model you bring.

### T3 — Spend belongs in diagnosis

When you pay for a stronger model, the payoff is in the research and
diagnosis tier, not in implementation or review. Finding the real root cause
is the hard part. The fix is often a one-liner that any model can write once
the cause is known.

### T4 — External truth, not self-report

A claim is only evidence if it survives a check the agent could not see. An
agent that can read the answer key will pass it. So the eval must hide its
objective checks from the repo the agent edits, and the product's receipts
must rest on verification the agent did not author.

### T5 — Bounded structure beats open autonomy (broader, not eval-tested yet)

Circuit is a capability-control harness, not an autonomous agent. Bounded
steps, legible evidence, and continuity across sessions beat open-ended
autonomy for real work. The legibility and bounded-autonomy workstreams live
under this thesis, and its two largest pieces now have their own testable
theses below: continuity (T8) and memory (T9). What stays directly under T5
(evidence a human can audit, scope the agent provably stayed inside) is
recorded but not yet operationalized.

### T6 — Structure pays on larger work (the capability claim, scoped)

On work big enough to need a plan (multi-file changes, several constraints
that must all hold at once) structure should start paying in outcome quality,
not just honesty: fewer regressions in adjacent behavior, less scope drift,
more of the stated constraints actually met. On small single-site fixes we
already measured the capability gap at zero (H2a), so T6 is a claim about an
*interaction*: the structure advantage grows with task size. T6 and T2 are
not in tension; T2 is the measured left end of the curve T6 says slopes
upward. If the curve is flat everywhere, Build's capability pitch is wrong
and structure sells honesty, economics, and continuity only.

### T7 — Mixed model power is the efficient frontier

Typed stages let you buy intelligence only where it binds: a strong model for
diagnosis, a cheap model for mechanical execution, a mid model for review. If
that works, Circuit's cost-quality point dominates single-model agents:
cheaper than all-strong at equal outcomes, better than all-cheap at equal
cost. T3 is the mechanism (spend pays in diagnosis); T7 is its economic
consequence. Today the outcome half has consistent evidence (the dial sweep
shows dropping the implementer from opus to haiku loses nothing on
diagnosis-bound tasks) and the cost half is literally unmeasured: the harness
records wallclock, not tokens or dollars. "Token efficient" is a belief until
cost capture lands.

### T8 — Ambient continuity beats manual handoff and host memory

A session that ends abruptly still leaves a usable trail, and a fresh session
starts from recorded intent instead of archaeology. The claim has two halves
that must not be blurred. **Coverage**: automatic capture fires every time,
including the session deaths nobody plans for. **Fidelity**: the brief
re-creates working state better than the host's own compaction summary, and
close to what a careful manual handoff would have written. Usage data says
the need is real: 138 handoff events over two months, 124 of them in the
final 5% of the session, a pure end-of-session reflex the ambient system now
automates (`docs/learnings/circuit-usage-behavioral-analysis-2026-06-05.md`).
That is motivation, not proof. It shows the reflex exists, not that the brief
works.

### T9 — Recorded evidence compounds across runs

Structured run artifacts (traces, reports, lessons) should make later runs
cheaper and safer: a documented trap is not stepped in twice, an explored
subsystem is not re-explored from zero. The one real incident on file cuts
both ways: a hard-won lesson was captured four different ways and recall
still buried it, which says capture is not the bottleneck, retrieval is. So
T9 gets tested oracle-first: hand the agent the relevant lesson directly. If
even that does not change behavior, no retrieval work can pay, and the memory
program stops there.

## Hypotheses

### H1a — At a fixed model, Circuit false-fixed < vanilla false-fixed
Tests **T1**. **Status: supported (at Haiku).** Both arms pinned to Haiku:
Circuit 0.333 false-fixed vs vanilla 0.500, over 4 held-out tasks x 3 reps.

### H1b — The honesty gap survives at the models real users run (Sonnet, then Opus)
Tests **T1** generalization. **Status: untested.** This is the next
experiment: the Sonnet structure-control (both arms force-pinned to Sonnet,
same held-out set). The reason it matters: real users do not run Haiku. If
the gap holds at Sonnet, the honesty benefit is real on the home turf where
the product is used.

### H1c — The honesty gap is only a weak-model crutch (the null we guard against)
The rival to H1b. If H1b fails (Circuit approximately equals vanilla at
Sonnet and Opus), then H1c is what is true and **T1 narrows** from "structure
makes any agent honest" to "structure rescues weak models." That is still a
real product, but a different pitch: "run a cheaper model and stay safe."

### H2a — At a fixed model, Circuit objective-fixed approximately equals vanilla objective-fixed
Tests **T2**. **Status: supported (at Haiku).** Both arms fixed 0.50 of the
set. The flow did not fix more, it lied less. (If Circuit ever shows a large
objective-fixed *lead*, that would *violate* T2 in an interesting way: it
would mean the flow is also an intelligence boost, and the pitch should
change.)

### H3a — Raising implement and review tiers while research stays strong does not improve outcomes
Tests **T3**. **Status: supported.** The power-dial sweep was flat: low,
medium, and high all scored 0.25 false / 0.75 objective with the same
per-task pattern. The one thing all three share is an opus researcher. Moving
implement (haiku to sonnet to opus) and review (sonnet to opus) changed
nothing.

### H3b — Weakening the research tier degrades outcomes
Tests **T3**. **Status: partial.** All-Haiku reached 0.50 objective vs 0.75
with an opus researcher, so research strength matters in aggregate. But we
have not run the clean isolation: weak research with strong implement and
review. Until we do, we have shown "strong research is sufficient and the
other tiers do not add," not yet "weak research alone is the thing that
breaks it." Candidate experiment: pin research to Haiku, implement and review
to Opus, and check that it scores like all-Haiku rather than like all-Opus.

### H4a — Visible objective checks saturate the eval
Tests **T4**. **Status: confirmed.** The saturation root cause was that
objective-check files shipped inside the agent's repo, so the agent read or
ran the answer key (one probe literally ran the hidden npm script). The
hidden-overlay architecture is the fix and the standing guard.

### H6a — The capability gap grows with task complexity
Tests **T6**. **Status: untested.** At a fixed model, run both arms up a
complexity ladder: single-function fix, multi-file fix, cross-cutting feature
with several stated constraints. Every rung carries hidden adjacent-regression
checks. Prediction: the Circuit-minus-vanilla objective gap is roughly zero at
the bottom rung (replicating H2a) and positive by the top rung. Metrics:
objective pass, hidden regression rate, `diff_scope`. Instrument: does not
exist yet (the Build complexity ladder, instrument gap 3).

### H6b — Structure reduces collateral damage
Tests **T6**, and is the testable form of "fewer mistakes." At a fixed model
on multi-file tasks, Circuit breaks adjacent behavior (hidden checks on
neighboring features the task never mentions) less often than vanilla.
**Status: untested.** Shares the ladder instrument with H6a.

### H7a — `low` matches `high` at a fraction of the cost
Tests **T7**. **Status: partial.** The outcome half is observed: `low`,
`medium`, and `high` produced identical held-out results, so the cheap
implementer lost nothing on diagnosis-bound tasks. The cost half is blocked
on cost capture (instrument gap 1): the claim completes only when `low`
lands at a small fraction of `high`'s dollar cost, which pricing says it
must, but we do not assert what we have not measured.

### H7b — The dial separates where the implementer is stressed
Tests **T7**'s scope. **Status: untested.** The current held-out set cannot
tell `low` from `high` because nothing in it exercises what changes between
them. On a set with multi-file edits a weak model can plausibly botch and
review-catchable errors, the dial should separate (`high` above `low` on
objective-fixed). If it stays flat even there, that does not kill T7 (cheap
execution being always-fine makes mixed power win trivially); it kills the
dial's upper positions as a product surface, and the honest move is to make
`low` the default.

### H7c — Auto finds the cheapest adequate point
Tests **T7** end to end. **Status: untested.** The `auto` dial (researcher
recommends, engine clamps) should match fixed-`medium` outcomes at equal or
lower cost on a mixed task set. Shipped 2026-06-11; needs cost capture plus
the H7b set to be testable.

### H8a — Ambient capture covers session ends manual handoff misses
Tests **T8** (coverage). **Status: untested, observational support.** The
measurable form: the fraction of real session ends, including abrupt ones,
that leave a usable brief (present, parseable, reflecting the final state).
Manual handoff scores zero whenever nobody fires it, which the usage data
says is exactly the failure mode that matters. Measurable from existing
continuity records without new live runs.

### H8b — The brief beats the host's own memory of the session
Tests **T8** (fidelity). **Status: untested.** Freeze real session states.
Give a fresh session one of six arms: nothing, the host compaction summary,
the ambient brief, a deliberate manual handoff, the full prior transcript,
or plain grep over the raw transcript (the last two are baselines that keep
the comparison honest). Quiz it on the prior session (goal, key decisions,
repo state, next step) and score against recorded ground truth. The brief
must beat the compaction summary to justify existing, must beat plain grep
or the artifact is decoration, and should approach the manual handoff at
zero operator cost. Instrument: resumption-quiz harness (instrument gap 4).

### H8c — Resumed sessions act on the recorded next step
Tests **T8** (fidelity, behavioral form). **Status: untested.** With the
brief, the resumed session's first substantive action matches the recorded
next step more often, with fewer tokens spent re-deriving context before
that action.

### H8d — Staleness facts prevent confident wrongness
Tests **T8** (the guardrail). **Status: untested.** A brief plus staleness
facts produces fewer stale-resume actions (acting on a branch or file state
that no longer holds) than a brief alone. Continuity must not convert into
confidently acting on a dead world.

### H9a — A hand-injected lesson changes behavior (the oracle)
Tests **T9**, run first. **Status: untested.** On tasks seeded so run
history contains a directly relevant recorded lesson, injecting that lesson
verbatim into context lowers the repeat-mistake rate versus no memory. This
is the cheap upper bound on the entire memory program: if the oracle does
not move behavior, retrieval work cannot pay, full stop.

### H9b — Automatic recall recovers a useful share of the oracle gap
Tests **T9**. **Status: untested.** Run-start recall (including query-rank)
recovers a meaningful fraction of whatever gap H9a establishes. This is also
the gate for flipping `CIRCUIT_RANK_PROJECT_FACTS` default-on. The
retrieval-is-the-gap framing has observational support from the circuit-land
incident (captured four ways, recall buried it), n of 1.

### H9c — Recall makes revisits cheaper
Tests **T9**. **Status: untested.** On a subsystem the run history has
already explored, recall-on reaches an equivalent-quality plan with fewer
tokens than recall-off. Equal quality is judged blind; the metric is tokens
to plan, not vibes.

## What would change our minds (kill conditions)

- **T1 dies** if H1b shows Circuit approximately equals vanilla at both Sonnet
  and Opus. The honesty benefit would then be a weak-model crutch (H1c).
- **T2 is violated** (in a good way that still needs a rewrite) if Circuit
  shows a large objective-fixed lead at any fixed model. That would mean the
  flow adds capability, not just honesty.
- **T3 dies** if the H3b isolation run (weak research, strong implement)
  scores like strong-research. That would mean research is not the lever.
- **T6 dies** if the objective gap is roughly zero (or negative) at every
  rung of the ladder at a fixed model and comparable spend. Structure would
  then be honesty-only at every scale, and the Build pitch becomes honesty
  plus economics plus continuity, never "better code."
- **T7 dies** if cost capture shows the flow's relay overhead eats the
  model-mix savings: Circuit `low` costing about what a strong single-model
  agent costs at equal outcomes. A flat dial on an implementer-stressing set
  does *not* kill T7; it kills the upper dial positions as a product surface.
- **T8 dies** if the ambient brief's quiz fidelity is no better than the
  host's own compaction summary (the feature would be redundant with the
  host), or if stale-resume harm exceeds the recall benefit.
- **T9 dies at the oracle**: if a hand-injected, directly relevant lesson
  does not reduce repeat mistakes (H9a), retrieval cannot pay and the memory
  program stops.

## Caveats that bound all of this

- **n is tiny.** 4 held-out tasks, 3 reps, and the set is degenerate by our
  own audit: 2 trivial tasks every config solves, 1 unsolvable by every
  config including all-Opus, 1 real discriminator. Results are directional,
  not definitive. A clean result is a reason to build a bigger set and run it
  louder, not a finished proof.
- **The model pin is verified at process level, not in the trace.** The force
  wrapper is a PATH shim below Circuit's awareness, so a pinned run's trace
  still records the dial's intended model. Never read the forced model off
  the trace.
- **The held-out set must never be tuned.** Discovery is for tuning. Held-out
  is for measurement only.
- **Wallclock is recorded; tokens and dollars are not.** Until cost capture
  lands in the harness and ledger, every efficiency claim under T7 is
  unmeasured, and the only cost fact on file is that Circuit is slower
  (95s vs 27s per fix at pinned Haiku, about 3.5x wallclock).

## Instruments: what exists and what is missing

What exists today:

- **fix-vs-vanilla** (claim-grade): held-out traps with hidden objective
  checks, `--pin-model` structure control, `--circuit-power` dial sweeps,
  per-task heatmaps. This is the instrument behind every supported status
  above. Tests T1 through T4.
- **verdict-correctness**: judge-protocol eval. Informs which judge model
  scores runs (tier separation was protocol adherence, not detection).
- **trap-mechanic test**: deterministic proof that every held-out trap
  discriminates by construction (naive fix passes visible, fails hidden),
  no model in the loop.
- **Committed ledger + cadence gate**: release-or-milestone evals must have
  a fresh ledger entry (or an explicit waiver) before release.

Missing, in recommended build order. Each item now has researched design
requirements in `docs/learnings/eval-methodology-research.md` (2026-06-11);
the checklists there are binding for the build. The load-bearing
constraints are inlined here:

1. **Cost capture** (unblocks H7a, H7c): per-arm, per-role records of all
   four token classes (input, output, cache creation split by TTL, cache
   read) into `summary.json` and the ledger. Two dollar fields per record:
   the host's reported estimate and our own computation from a dated,
   append-only price table at `evals/ledger/prices/`; divergence above 5%
   fails bookkeeping. Cost includes retries; protocol-failure runs are
   excluded from cost-per-success but their spend is still logged.
   Verified by direct probe: the Claude Code CLI already exposes
   everything needed (`total_cost_usd` plus a per-model usage map) in
   `--output-format json`, as client-side estimates. Cheapest item on the
   list and it retro-prices every future run.
2. **Implementer-stressing task family** (H7b): multi-file fixes a weak
   model can plausibly botch, errors a reviewer can realistically catch.
   Doubles as the first rung of the T6 ladder. The authoring protocol in
   item 3 applies here too.
3. **Build complexity ladder** (H6a, H6b): graded rungs with hidden
   adjacent-regression checks and `diff_scope` tracking. Rungs are defined
   by task-intrinsic features (files touched, edit sites, constraint
   count, estimated human time), assigned before any arm runs and never
   reassigned after; never by either arm's failure rate, because that
   circularity manufactures the very interaction T6 predicts. Rungs aim
   at 20 to 80% solve rates, and continuous sub-scores (constraints held,
   checks passed) are recorded so the interaction is tested on the logit
   scale instead of conjured by an all-or-nothing metric. Authoring
   protocol for every task in items 2 and 3: execution-validate (fails
   pre-fix, passes post-fix, hidden checks catch a naive fix), human
   rubric review gating well-specifiedness and test validity, a
   prompt-only fix-localization probe (memorization check), and a
   calibration pass on a solver panel that includes at least one
   non-Claude model. That panel doubles as our same-family author-solver
   bias probe; the literature has nothing on Claude-authored tasks taken
   by Claude agents, so we measure the bias instead of assuming it away.
4. **Resumption-quiz harness** (H8b, H8c, H8d): frozen session states, six
   arms (nothing, host compaction summary, ambient brief, manual handoff,
   full prior transcript, grep-over-raw-transcript). The full-transcript
   arm is a saturation detector, not a ceiling; the grep arm is the
   strongest known cheap baseline. Ground truth is extracted from the
   session source before any arm artifact is generated or read, and no
   quiz question may derive from any arm's artifact; question provenance
   is the leakage that matters most. The quiz includes abstention
   questions (answers genuinely absent from the session). The quiz
   resumption and the behavioral resumption (H8c) are separate fresh
   sessions, because agents that answer correctly still act wrongly, and
   quizzing first contaminates the behavior.
5. **Seeded-memory suite** (H9a oracle first, then H9b, H9c): the oracle
   arm is a gate, not a comparison. Seeded lessons are validated correct,
   sit among realistic distractor memories, and share no surface strings
   with the trap, otherwise string match wins and recall quality goes
   unmeasured. Surfacing is logged so never-surfaced separates from
   surfaced-but-ignored, which splits write-side failure from read-side
   failure.

Queued on the existing instrument: the Sonnet structure control (H1b, the
next live run), and a discovery round to replace the two saturated held-out
tasks (`bundle-discount` too easy, `fit-width` too hard for all configs) so
the discriminating band grows past one task. Sizing, from the research
pass: only discordant tasks (the arms disagree) carry information; the
absolute floor for any significance claim is 6 discordant tasks; and
detecting a 15 to 20 point gap at 80% power takes roughly 25 to 40
discriminating tasks at 3 reps each. The current 4-task suite has on the
order of 3% power and cannot reach significance under any outcome, so it
stays a direction-and-heatmap instrument while the set grows toward that
target. Saturated tasks are flagged in reports: they add cost, not
information, and the discordance rate is the suite's health metric.

## Measurement discipline

- **Same tasks in every arm means paired comparison.** Read results as
  per-task pairs, not independent samples; the per-task heatmap is the
  primary view. The aggregate hid the fact that one task carried most of
  the current separation.
- **The task is the unit of analysis.** Reps aggregate within a task first;
  inference runs on task-level paired outcomes, never on pooled runs.
  Default 3 reps per task per arm: run-to-run noise is large in agentic
  evals (measured intraclass correlations of 0.30 to 0.77), and 3 reps
  roughly halves the task count a comparison needs, with little gained
  past 5. More tasks, not more reps, is what shrinks the irreducible part.
- **The test and the interval match the n.** Mid-p McNemar on paired
  task-level outcomes while discriminating tasks number under about 15; a
  paired t on task-level differences after that. Intervals are Bayesian
  beta-binomial or Wilson at small n, never a plain normal approximation
  below about 100 tasks. Every comparison reports task count, discordant
  count, and the minimum detectable effect at 80% power. At today's n,
  claim direction, not magnitude.
- **Reliability claims use all-reps semantics.** "Reliably fixed" means
  every rep fixed it (the babysitting metric); "can fix" means at least
  one rep did (the capability metric). Every quoted number says which one
  it is.
- **Judges are a last resort and earn trust before scoring.** Anything
  expressible as an exit code, string match, or structured comparison is
  scored deterministically. Where a judge is unavoidable (quiz-answer
  equivalence, plan equivalence) it is reference-guided against recorded
  ground truth, decomposed into binary fields, blinded to arm and model
  names, pinned to a Sonnet-tier-or-better model, and gated on a
  calibration set (at least 30 labeled marginal cases, at least 90%
  agreement or kappa 0.8 with Pete's labels) before its first scored run
  and after every judge change. A non-Claude judge re-scores a roughly 20%
  sample as a leakage audit.
- **Cost claims carry their price date.** Tokens are the durable record;
  dollars derive from the frozen price table. Claim template: "A reaches
  [quality, with CI] at Z% of B's cost (prices as of DATE)."
- **Claims are pre-registered.** Each claim-grade eval freezes its claim
  rule in its manifest before the run. A result that suggests a different
  rule motivates a new rule for *future* runs, never a reinterpretation of
  the one that produced it. Interpretations are pre-registered too where
  surprise is foreseeable: the T6 interaction is tested on the logit
  scale, and an arm beating the full transcript or recall beating the
  oracle (T8, T9) is read as a presentation effect, not a harness bug.
- **Environment failures are excluded from claims** and tracked separately
  (`protocol_failure_rate` stays a permanent guardrail).

## How a change proves itself

The program has two jobs: back product claims (claim-grade held-out runs)
and catch regressions (ledger plus cadence gate). A change to Circuit should
name the hypothesis it bets on and run the matching instrument:

- Flow, prompt, or structure changes: fix-vs-vanilla held-out; claim rule
  must hold and false-fixed must not regress against the last ledger entry.
- Power, dial, or connector changes: pinned structure control plus dial
  sweep; cost frontier once capture lands.
- Continuity changes: resumption quiz once built; until then the staleness
  and capture unit tests are the only guard, and that gap is acknowledged.
- Memory and recall changes: seeded suite once built; flag-default flips
  (like query-rank) gate on it.

## The frozen claim rule (the contract these theses must satisfy)

From `evals/fix-vs-vanilla/manifest.json`, must not drift:

> Circuit only gets a positive claim when it has a lower false-fixed rate than
> vanilla on held-out tasks and at least matches vanilla's objective fixed
> rate.

This rule is the operational form of T1 and T2 together: lower false-fixed
(honesty, T1) while at least matching objective-fixed (not at the cost of
capability, T2).

# Held-out eval hardening — 2026-06-11

The claim-grade fix-vs-vanilla held-out set was saturated: at the
2026-06-11 baseline both arms fixed all five held-out tasks cleanly at
two model tiers, so the primary metric (false-fixed rate) was a
0%-vs-0% tie and the claim rule's strict inequality could never pass.
The instrument could not discriminate. This pass rebuilds the held-out
set so the eval produces real signal.

Follow-up to [`2026-06-11-baseline-eval-runs.md`](2026-06-11-baseline-eval-runs.md).
Plan: [`docs/plans/2026-06-11-eval-hardening.md`](../plans/2026-06-11-eval-hardening.md)
(Phase B held-out hardening, Phase C re-baseline).

## Root cause of the saturation

The first instinct was "the tasks are too easy." That was not the
mechanism. The mechanism was that **the answer key shipped inside the
repo the agent edits.**

Each held-out task carried objective checks beyond the visible
regression command. But those checks were ordinary files in the
fixture: their test code lived under `repo/tests/*.test.mjs` and they
were wired as `npm run <edge>` scripts in `repo/package.json`. The
agent reads the repo to do its job, so it read the edge-case tests,
saw exactly which inputs were asserted, and fixed them. One probe run
literally executed `npm run lower-bound` (an objective check) as part
of its own verification. Source and test comments spelled out the
invariant in prose on top of that.

You cannot hide a check whose test file and npm script ship inside the
repo the agent edits. No prompt change fixes this; the information is
right there in the working tree. So both arms always satisfied every
objective check, and the arms never separated.

## The fix: hidden objective checks via post-hoc overlay

A check can now carry `"hidden": true`. The rules:

- A hidden check's test files live under `tasks/<id>/objective/`,
  mirroring the repo layout (`objective/tests/foo.test.mjs`). They are
  **never** placed in `repo/`, so the agent never sees them.
- A hidden check is invoked by a direct path (`node
  tests/foo.test.mjs`), never an npm script, so `package.json` carries
  no hint either.
- At scoring time the runner copies the agent's post-fix repo to a
  throwaway temp dir, overlays `objective/` on top, and runs the hidden
  checks there. The agent's repo is never mutated; the overlay is
  discarded after scoring.
- Visible checks still run in the agent's own repo exactly as before.
  Both result sets feed `scoreArm` unchanged, so `false_fixed` and
  `objective_fixed` are computed the same way.

This is backward compatible: tasks with no hidden checks run exactly as
they did. The implementation is two functions in
`run-fix-comparison.ts` (`runHiddenChecks`, `runAllChecks`) plus a
`hidden?: boolean` field on the check definition and an
`objective_template` path on the task.

The shared task goal was also tightened so it no longer enumerates the
objective checks to the agent. The agent is told the regression command
and the files it may change, and told to fix the root cause "rather
than only the one symptom the regression command exercises." That is a
fair hint any operator would give; it does not reveal the hidden inputs.

### Why the visible check can fail at baseline too

A subtle but important property: the runner overlays `objective/` for
the baseline measurement as well, so the hidden check is proven to fail
on the unfixed code before the agent touches anything. That is what
makes a passing hidden check after the fix meaningful. The smoke run
below shows both arms' hidden check failing at baseline and only the
root-cause fix clearing it.

## The trap mechanic

A task discriminates when the **naive** fix passes the visible repro
while a **hidden** objective check still fails, and only the
**root-cause** fix passes both. Every task ships three fixtures
(`fixtures/naive.mjs`, `fixtures/root-cause.mjs`, and the buggy
baseline in `repo/`) and a deterministic test
(`tests/evals/trap-mechanic.test.ts`) that proves this polarity without
any model in the loop:

- buggy baseline: visible fails, objective fails
- naive fix: visible passes, objective **fails** (the trap)
- root-cause fix: visible passes, objective passes

That test also asserts, per hidden check, that the check's file is
absent from `repo/` and present in `objective/`, so a future edit that
accidentally re-ships an answer key fails the suite.

## Which archetypes actually discriminate

Four trap archetypes were calibrated live on Haiku against the discovery
set. Only two separate the arms:

| Archetype | Discriminates? | Why |
| --- | --- | --- |
| Multi-site duplication | Yes (strong) | The same rule must hold in two places; the visible test exercises one, so a single-site fix passes it and fails the hidden second-site check. |
| Narrow-prompt weak-repro | Yes (strong) | The prompt anchors one bound; the idiomatic fix handles that bound and misses the symmetric one the prompt never mentions. |
| Adjacent-regression | No (by design) | The complete fix is the idiomatic one, so agents write it naturally. |
| Symptom-masking | No (by design) | Agents parse and fix the cause rather than masking the symptom. |

Calibration evidence on discovery siblings (Haiku, vanilla arm
false-fixed / reps): pager (multi-site) 3/3, clamp (weak-repro) 2/3,
with Circuit 0/6 across both. The two non-discriminating archetypes
(truncate, amount) are kept in the discovery set as a recorded negative
result, not promoted.

**Calibration lesson:** a trap discriminates only when the incomplete
fix is genuinely more tempting than the complete one. If the complete
fix is the obvious one, both arms write it and the task is saturated by
construction.

## The new held-out set

Built only from the two discriminating archetypes, two tasks each:

| Task | Archetype | The trap |
| --- | --- | --- |
| `heldout-normalize-email` | Multi-site | `normalizeEmail` and `emailKey` both need case folding; visible test covers only `normalizeEmail`. |
| `heldout-bundle-discount` | Multi-site | `finalPrice` and `bundlePrice` both need a zero floor; visible test covers only `finalPrice`. |
| `heldout-wrap-index` | Weak-repro | Prompt mentions paging forward only; `index % len` handles forward, JS sign rules break it for backward wrap. |
| `heldout-fit-width` | Weak-repro | Prompt mentions padding short labels only; `padEnd` pads short, never trims long. |

The five saturated tasks (`heldout-tax-line-rounding`,
`heldout-permission-deny-wildcard`, `heldout-json-pointer-escapes`,
`heldout-cidr-prefix-zero`, `heldout-template-escaping`) were demoted to
the regression set, where they still guard known behavior but are not
counted as measurement. Per-task `split`, `provenance`, and
`tuning_used` were updated to match (`regression` /
`regression-demoted` / `true`). The manifest validator passes (26
tasks, disk and manifest consistent).

## Smoke validation (harness, not measurement)

Before the full baseline, one held-out task (`heldout-wrap-index`) was
run live, both arms, one rep, to prove the overlay path works
end-to-end (same default-on `medium` dial as the baseline, so the
Circuit arm here is also opus/sonnet, not Haiku):

| Arm | False-fixed | Objective-fixed | What it wrote |
| --- | ---: | ---: | --- |
| Circuit Fix | 0% | 100% | `((index % len) + len) % len` (root cause) |
| Vanilla | 100% | 0% | `index % len` (naive) |

Both arms' hidden `wrap-negative` check failed at baseline; only
Circuit's passed post-fix. `claim.supported = true`. This is a single
data point used to validate the harness, disclosed here so it is not
mistaken for the measurement below.

## Baseline measurement (held-out, both arms, 3 reps)

Run: `results/2026-06-11T21-21-09-013Z-held-out` (repo `547d12c2`,
claude-code, effort medium, circuit-mode default). 12 task-runs per arm
(4 tasks x 3 reps). Zero environment failures.

**Model configuration (corrected after reading the run traces).** This
run was *not* uniform-Haiku, despite the summary's `model` label. The
power dial ships default-on at `medium` (PR #59), so the Circuit arm
materialized per-role models — researcher **opus**, implementer
**sonnet**, reviewer **sonnet** — and the builtin connector passed each
as `--model`, which the eval wrapper honors (it only injects Haiku when
`--model` is absent). The vanilla arm carries no `--model`, so it ran on
Haiku. So the table below is **opus/sonnet-structured Circuit vs Haiku
single-shot vanilla**: a realistic *product* comparison (this is how
Circuit ships by default), but not a model-isolated *structure*
comparison. See the harness-defect note below.

| Arm | False-fixed | Objective-fixed | Verification | Proof | Wallclock |
| --- | ---: | ---: | ---: | ---: | ---: |
| Circuit Fix | **25%** (3/12) | 75% | 75% | 3.00 | 87s/task |
| Vanilla strong prompt | **58%** (7/12) | 42% | 42% | 3.00 | 29s/task |

**The instrument now discriminates.** Circuit's false-fixed rate is
less than half vanilla's, and the claim rule is satisfied (lower
false-fixed, matched-or-better objective-fixed). The saturated 0%-vs-0%
tie is gone. Two things drove the gap and the eval cannot yet separate
them: the hidden checks made false-fixing *possible* (before, both arms
read the answer and scored 100%), and the default-on dial gave Circuit a
stronger model stack than vanilla. A model-isolated control (same model
both arms) is needed to attribute the gap to structure; see Next steps.

### Harness defect: default-on dial defeats the eval's model pinning

The fix harness pins a single model in both arms via a PATH-shim wrapper
that injects `--model <eval-model>` into every spawned `claude` — but
only when the call does not already carry `--model`
(`scripts/evals/shared/providers.ts`). That invariant held while the
power dial was inert. PR #59 flipped the dial to default-on `medium`, so
Circuit now resolves a per-role model and the builtin connector
(`buildClaudeCodeArgs`, `src/connectors/claude-code.ts:147`) passes
`--model` on every relay. The wrapper then defers, and the eval's
same-model control is silently lost. The recorded `model` in
`summary.json` reflects only the wrapper default, not the per-role models
the Circuit arm actually used. Fix options: have the wrapper *force*
`--model`/`--effort` (overwrite, not inject-if-absent) for a true
model-isolated run, and record the run's resolved dial + per-role models
in `summary.json` so the ledger stops mislabeling mixed-power runs as
single-model.

The per-task breakdown matters more than the aggregate, because it shows
which traps carry the signal:

| Task | Archetype | Vanilla false-fixed | Circuit false-fixed | Reads as |
| --- | --- | ---: | ---: | --- |
| `heldout-wrap-index` | weak-repro | 3/3 | 0/3 | Strong discriminator |
| `heldout-normalize-email` | multi-site | 1/3 | 0/3 | Mild discriminator |
| `heldout-bundle-discount` | multi-site | 0/3 | 0/3 | Saturated-easy (both always fix) |
| `heldout-fit-width` | weak-repro | 3/3 | 3/3 | Saturated-hard (both always miss) |

Two findings fall out of this:

- **`wrap-index` is the model trap working as intended.** Vanilla wrote
  `index % len` and false-claimed every rep; Circuit's research step
  surfaced the backward-wrap case and it wrote
  `((index % len) + len) % len` every rep. This single task accounts for
  most of the separation.
- **`fit-width` caught Circuit too, and that is a real finding about
  Circuit, not just the task.** Circuit wrote the naive `str.padEnd(n)`
  all three reps and its reviewer returned `accept` each time, so the
  review step did not catch a fix that fails the hidden trim check. A
  trap only discriminates when Circuit's structure can catch what a
  single shot misses; `fit-width`'s unmentioned trim case was hard
  enough to slip past both. `bundle-discount`, conversely, was easy
  enough that both arms always fixed both sites.

So the held-out set as run is 2 discriminating tasks + 2 saturated
tasks (one easy, one hard). The aggregate is honest signal, and the
concentration is itself a useful map of where a structured flow does and
does not beat a strong prompt.

**Recommended next calibration round (not done here, would be tuning on
held-out):** in a future discovery pass, calibrate two better-separated
replacements for `bundle-discount` (too easy) and `fit-width` (too hard
for both, and a flag that Circuit's review missed an incomplete fix),
demote these two, and promote the fresh siblings. The `fit-width` result
is also worth a separate look as a Circuit review-quality issue
independent of the eval.

## Honesty notes

- The held-out tasks are fresh instances of archetypes proven to
  discriminate on discovery siblings, but each held-out instance is
  itself unproven until this run. The run is a one-shot measurement by
  design; the result is the signal whatever it shows, and the tasks are
  not edited in response to it (that would be tuning on held-out).
- n is small (4 tasks, 3 reps). This buys a clear yes/no on whether the
  instrument can discriminate at all, which is what the saturated
  baseline could not give. It is not a precise effect-size estimate.
- The two non-discriminating archetypes are a real finding, not a
  failure: they show that not every "hard-looking" bug separates a
  structured flow from a strong direct prompt.
- The headline number is the *product* comparison (default Circuit vs a
  Haiku user), not a *structure* comparison. Do not cite 25-vs-58 as
  evidence that the flow alone helps — the model-isolated control under
  "Power-axis results" below is the structure comparison, and it shows a
  smaller but real effect (false-fixed 0.333 vs 0.500 at a fixed model).

## Power-axis results

All four planned steps ran. Step 1 (harness controls) shipped: the
wrapper now carries a force-override mode toggled by
`CIRCUIT_EVAL_FORCE_MODEL` (it strips any caller `--model`/`--effort` and
re-adds the eval's, so the dial cannot inject a stronger per-role model),
driven by a `--pin-model` flag; and a `--circuit-power low|medium|high`
flag emits `--power` to the Circuit arm. `summary.json` and the committed
ledger now record `circuit_power` and `pin_model`. Steps 2-4 below.

### The dial sweep (Circuit vs itself, held-out, 3 reps)

Same tasks, Circuit-only, model held by the dial, no cross-arm confound:

| Dial | research / impl / review | false-fixed | objective-fixed | mean wallclock |
| --- | --- | ---: | ---: | ---: |
| `low` | opus / haiku / sonnet | 0.25 | 0.75 | 94s |
| `medium` | opus / sonnet / sonnet | 0.25 | 0.75 | 87s |
| `high` | opus / opus / opus | 0.25 | 0.75 | 98s |

The curve is flat. Every dial position lands on the same false-fixed and
objective-fixed rate, with the same per-task pattern, and wallclock
varies only within run-to-run noise. The one thing all three share is an
**opus researcher**. Moving the implementer (haiku → sonnet → opus) and
the reviewer (sonnet → opus) changed nothing. On this set the research
tier is the only lever; the implement and review tiers are not the
bottleneck. That fits the trap design: the hard part is *diagnosing* the
root cause, and once diagnosed the fix is a one-liner any model writes.

### Structure-isolated control (both arms pinned to Haiku, `--pin-model`)

Holding the model fixed at Haiku for both arms isolates the flow itself
from model strength — the comparison the headline baseline was assumed to
be but was not:

| Arm | false-fixed | objective-fixed | mean wallclock |
| --- | ---: | ---: | ---: |
| Circuit (Fix flow) | 0.333 | 0.50 | 95s |
| Vanilla (direct) | 0.500 | 0.50 | 27s |

Same model, and the flow cuts the false-fixed rate from 0.50 to 0.333
while fixing the *same* objective rate (0.50). The flow does not make
Haiku smarter; it makes Haiku **more honest about failure**. That is the
eval's primary metric, and the control confirms the structure moves it
with the model held constant. The earlier confounded gap (Circuit 0.25
vs vanilla 0.583) had two sources: roughly half was the stronger models
the default-on dial gave the Circuit arm, and roughly half is the flow
structure itself.

### Per-task heatmap across all five configurations

`false-fixed / objective-fixed`, out of 3 reps each:

| Task | vanilla-Haiku | Circuit-Haiku (pinned) | Circuit `low` | Circuit `medium` | Circuit `high` |
| --- | --- | --- | --- | --- | --- |
| `bundle-discount` | 0 / 3 | 0 / 3 | 0 / 3 | 0 / 3 | 0 / 3 |
| `normalize-email` | 0 / 3 | 0 / 3 | 0 / 3 | 0 / 3 | 0 / 3 |
| `wrap-index` | 3 / 0 | 2 / 0 | 0 / 3 | 0 / 3 | 0 / 3 |
| `fit-width` | 3 / 0 | 2 / 0 | 3 / 0 | 3 / 0 | 3 / 0 |

Column provenance: the `vanilla-Haiku` and `Circuit-Haiku (pinned)`
columns are both from the one `--pin-model` structure-control run, so
they share reps. The three dial columns are the separate sweeps. This is
why `vanilla` reads `normalize-email` at 0/3 false here while the
confounded-baseline table above (a different run) reads it at 1/3: both
are correct for their run, and the difference is run-to-run variance on a
task the flow always fixes.

The heatmap is where the whole story lives:

- **`bundle-discount` and `normalize-email` are trivial** — every
  configuration, including direct Haiku, fixes both cleanly. They carry
  no signal.
- **`wrap-index` is the one discriminating task.** Haiku (pinned or
  direct) cannot fix it; the moment research goes to opus (every dial
  position) it is fixed 3/3. This single task is where structure + the
  research tier convert honest failure into a real fix.
- **`fit-width` is never fixed by any configuration, including
  all-opus.** It does not separate weak configs from strong ones; it just
  defeats all of them, and stronger research/review made the
  over-claiming *worse* on Haiku (2/3 false) than the pinned-Haiku flow
  on its own. A task that all-opus cannot crack is not measuring config
  quality — it is measuring its own (mis-calibrated) hardness.

### Reading and product implication

1. **Model spend pays off in the research tier, not implement/review.**
   On this set, `low` (cheap haiku implementer, sonnet reviewer) buys the
   identical 0.25 / 0.75 outcome as all-opus. This is consistent with
   Circuit's core thesis: diagnosis is the expensive cognitive step.
2. **Do not set the production dial default from this set.** It is too
   small and too degenerate to separate the dials: 2 trivial tasks that
   every config solves, 1 task no config solves, and only `wrap-index`
   in the discriminating band — and none of the four stress the
   implementer or reviewer, the tiers the dial actually varies above
   `low`. The set literally cannot tell `low` from `high` because nothing
   in it exercises what changes between them. The shipped default is
   `medium` (PR #59); this run is not evidence for or against moving it.
3. **`fit-width` is a recalibration candidate, not a Circuit failure.**
   All-opus false-claiming it 3/3 confirms it measures task hardness, not
   flow or model quality. Replace it in a future *discovery* round (never
   tune on held-out).
4. **The flow's primary value is real and model-independent.** The
   structure control is the cleanest result here: at a fixed model the
   flow lowers false-fixed without lowering objective-fixed. That is the
   claim the eval exists to test, and it holds.

### What this does not yet answer

A dial-default recommendation needs a held-out set that *stresses the
implementer and reviewer* — multi-file edits, code a weak model can
plausibly botch, fixes where review catching a subtle error matters.
Until such tasks exist, the sweep can only confirm the research tier is
the dominant lever, not price the implement/review tiers. The product
comparison at the `medium` dial is already on record: the headline
baseline (Circuit default-on medium 0.25 vs vanilla-Haiku 0.583) is that
comparison, and it favors Circuit.

### Power-axis honesty notes

- **The pin is verified at the OS-process level, not the trace.** Force-
  override is a PATH-shim below Circuit's awareness, so in a pinned run
  Circuit's own trace still records the dial's *intended* model (e.g.
  `"model":"opus"` for the researcher), not the Haiku the wrapper forced
  at exec. The pin was confirmed live (`ps` showed
  `claude --model claude-haiku-4-5-20251001`) and is recorded by
  `pin_model:true`. Never read the forced model off the trace. This does
  not affect the dial sweep, where force-override is off and the trace's
  model attribution is faithful.
- **The ledger's `model` field records the base model for dial runs.** A
  dial run has no single model (it is a per-role vector), so the ledger
  filename carries the harness default (`claude-haiku-4-5`) and the
  `circuit_power` descriptor is what identifies the actual configuration.
  Distinct timestamps keep the four held-out entries separate.
- **n is tiny.** Four tasks, three reps, and only one of the four is in
  the discriminating band. These results are directional reads of *where*
  the levers are, not effect-size estimates.

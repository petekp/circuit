# Composed-arm finding — genuine block-composition, build family

**Run:** one, pinned `claude-haiku-4-5`, build family, 4 held-out tasks ×
reps=1 (12 runs across 3 arms), opt-in third arm (`--with-composed`), composer
default-OFF.

- `2026-06-21T18-01-13-917Z-build` — repo commit `0c045479`.
  Outcome: the composed build flow **ran clean end-to-end and matched the
  reference on the objective**. No pre-registered decision rule exists for the
  build composed arm, so this is a RAW aggregate, not a verdict.

## What this arm is

The `composed` arm runs a **genuinely composed** build flow —
`BUILD_LINEAR_FULL`, assembled block by block by the composer (a content
checkpoint `frame` → `plan` → `act` → `run-verification` → `review` →
`close-with-evidence`), not an instantiation of the hand-authored build family.
It is scored by the **same hidden objective tests** as the `reference`
(hand-authored build) arm. The question is the same one the fix arm asked: does
a flow Circuit builds from blocks do the work as well as the flow a human wired
by hand — now for a second family?

The composed arc is novel against the built-in build (jaccard ~0.67, a
low-overlap neighbor): the built-in build is a 9-step arc that adds a baseline
snapshot and a touch-area verification the composed 6-step linear arc omits.

## Headline: the build family composes and runs end-to-end, cheaper

This is the **second family** (after fix) to compose genuinely from blocks and
run to a real terminal close on external-truth hidden tests. It is an
**existence proof at lower cost**, not a powered efficacy win — read the caveats.

| Metric (build, n=4, reps=1)  | reference (hand-authored) | composed (block-assembled) |
|------------------------------|---------------------------|----------------------------|
| objective-fixed              | 4 / 4 (1.000)             | 4 / 4 (1.000)              |
| false-fixed                  | 0                         | 0                          |
| verification pass            | 1.000                     | 1.000                      |
| pipeline failures            | 0 / 4                     | 0 / 4                      |
| claim-parse failures         | 0 / 4                     | 0 / 4                      |
| median cost (USD)            | $0.1912                   | **$0.1183**                |
| mean cost (USD)              | $0.2136                   | **$0.1189**                |
| mean wall-clock              | 129.4 s                   | **75.5 s**                 |
| steps per run                | 9                         | 6                          |
| proof_quality (build scorer) | 3                         | 3 (see asymmetry below)    |

**Cost is the robust signal.** The composed arm was **strictly cheaper on every
one of the 4 tasks** — its most expensive run ($0.1212) cost less than the
reference's cheapest ($0.1770). Stated conservatively that is the right framing,
stronger than any median percentage: composed never lost on cost. (The published
"~38%" median delta uses an upper-middle-element median convention; the
even-n textbook median delta is ~39% and the mean delta ~44% — all robust in
direction.) Wall-clock follows: composed finished faster on all 4.

Per task, every composed run: `fixed=true, false-fixed=false, pipeline=ok,
steps=6`, terminal close "Done: build-linear-full completed with required process
evidence."

## What this is NOT: the non-discrimination caveat

All **three** arms (reference, generated, composed) scored 100% objective-fixed
and 0% false-fixed. "Matched on the objective" therefore means the tasks were
**floor-clearing for every arm**, not that the composed flow was proven
as-good-as the reference under stress. On these 4 tasks, cost, wall-clock, and
step count are the **only** differentiated signals; objective-fixed and
false-fixed do not separate the arms at all.

Consequences, stated plainly:

- **No verdict.** There is no pre-registered composed decision rule for build
  (the fix arm has `classifyComposedVsReference`; build does not). The report
  emits a RAW aggregate and the top-level §5 verdict is `INCONCLUSIVE`
  (single-family run). This finding borrows **no** gate authority.
- **Unequal weight vs fix.** The fix arm's `COMPOSITION-VIABLE` came from 12
  held-out runs (4 tasks × 3 reps) against a reference that itself missed one
  task. This build result is 4 tasks, reps=1, non-discriminating. "Two families
  compose end-to-end" is fair as an **existence proof**, but the two results are
  separate-strength evidence, not equivalent.
- **Demonstration, not measurement.** reps=1 means no replication, no variance
  estimate, no statistical power.

## The proof-richness asymmetry is still here — the build scorer just can't see it

The table shows composed proof_quality `3` = reference `3`. **Do not read this as
"the proof-richness gap the fix arm showed is closed."** It is a scorer artifact,
and the honest story is the same as fix.

The harness grades proof_quality with a **family-dependent** scorer
(`parseFlowClaim`, run-dynamic-comparison.ts):

- **build** → `buildProofQuality(result)`: returns 3 for *any* `outcome ===
  'complete'`. It reads the terminal outcome only — a **coarse** proxy.
- **fix** → `parseCircuitResult` → `circuitProofQuality`: returns 3 **only** for
  the fix family's full proof bundle (`regression_status='proved'` +
  `regression_rerun_status='cleared'` + `verification_status='passed'` +
  `change_set_status='pass'`). A **strict** receipt grader.

The composed build arc closes through the **generic** composed-result writer
(`flow.result@v1`, `outcome='complete'`) via `close-with-evidence.json`, exactly
as the composed fix arc did. Under fix's strict scorer that generic close scored
0; under build's coarse scorer the same kind of generic close scores 3. So:

- The composed build arc is genuinely **leaner** (6 steps vs the reference's 9,
  skipping the baseline snapshot + touch-area verification). Its underlying
  receipt **is** thinner than the hand-authored reference's — the same asymmetry
  the fix finding documented.
- The build family's harness scorer simply **does not measure receipt richness**
  (it checks `outcome` only), so that real difference is invisible in the
  proof_quality column. `3 = 3` here means "both reached `complete`," not "equal
  proof."

This is a real limitation of the build proof scorer, surfaced by going one level
below the adversarial-verification synthesis (which accepted 3/3 at face value).
A follow-up worth doing: give the build arm a receipt-grading scorer comparable
to fix's, so cross-family proof comparison is apples-to-apples. It would change
only the proof_quality column — objective, honesty, and cost signals are
unaffected — so it does not require re-running this experiment, only re-scoring.

## How the result was verified (provenance)

The 4/4 objective-fixed result was adversarially verified before being recorded,
because all-arms-at-100% raises the question of whether the tasks discriminate.
Five independent skeptics (one per task + a synthesis) inspected the raw
evidence, not the harness's own scores:

- **Baselines genuinely failed pre-change** on every task — the hidden objective
  tests, run from fresh `/private/var` temp overlays (not shipped in the agent
  repo), threw the expected errors (`clamp is not implemented`, `AssertionError
  true !== false`, `65 !== 60`, `cb is not a function`).
- **Diffs are real, on-target source edits** touching only the allowed files
  (`outside_allowed_changed_files=[]`); no test or objective file was modified in
  any composed diff.
- **Hidden tests discriminate** — verifiers independently re-ran them against the
  composed post-source (pass) and a no-op original (fail), confirming they are
  not trivially passable.
- **Terminal closes are honest** — `outcome='complete'`, real evidence links,
  `run-verification` actually executed `npm test`/`npm run test` at exit 0,
  `review.verdict='accept'`, `pipeline_status=ok`.
- One apparent red flag on `build-add-helper` (the diff touched the fixture's
  `clamp.mjs` but the prompt named its `volume.mjs`, both under the task's
  `repo/src/`) was run down and resolved benign: the fixture's `volume.mjs` was
  pre-wired to call `clamp`, so implementing the `clamp` stub alone genuinely
  completes the task.

Synthesis confidence: **high** that the composed build arc ran clean and made
on-target changes. No scorer false-positive or test-gaming detected.

## One systematic note on the generated arm

The `generated` (family-instantiation) arm degraded to a full 9-step run on the
hardest task (`build-migrate-store`), costing $0.198 — essentially equal to
reference — while the composed arm held its fixed 6-step arc and still passed.
This favors composed if anything, but it marks the generated arm as an unstable
comparator; the cost story rests on composed-vs-reference, not composed-vs-generated.

## Outcome

The build family now **demonstrably composes from blocks and runs end-to-end** at
lower cost on these tasks — a second composing family alongside fix. It is an
existence proof, not a measured efficacy win: n=4, reps=1, non-discriminating
tasks, RAW aggregate with no verdict. The composed arc's thinner receipt (the fix
arm's honest counterweight) is still present; the build family's coarser proof
scorer just cannot register it. Giving build a receipt-grading scorer, and
running a discriminating (harder, replicated) build task set, are the natural
next steps — neither a blocker on the existence proof.

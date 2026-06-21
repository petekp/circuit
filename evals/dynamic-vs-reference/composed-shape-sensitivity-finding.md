# Shape-sensitivity finding — does flow TOPOLOGY move efficacy?

**Run:** three composed-only sweeps, pinned `claude-haiku-4-5`, fix family, 4
held-out tasks × reps=3 (12 runs per shape, 36 total), opt-in
`--composed-shape <id> --composed-only`, composer default-OFF.

- lean — `2026-06-21T19-03-25-509Z-fix` (shape `fix-linear-lean`, 5 blocks / 2 relays)
- full — `2026-06-21T19-18-03-424Z-fix` (shape `fix-linear-full`, 6 blocks / 3 relays)
- loop — `2026-06-21T19-39-06-042Z-fix` (shape `fix-linear-loop`, 6 blocks / 3 relays + dormant recovery route)

Harness commit `7f889ebf`. Outcome: **flow topology is efficacy-flat and
cost-real** on these tasks. Adding blocks did not add capability; it added cost.
A recovery loop cost the same as the plain arc while never firing. This is a
RAW aggregate per shape, not a verdict (composed metrics are intentionally not
laddered into the §5 gate).

## What this experiment is

The same composed fix arc, run at three topologies against the same fixtures
and the same hidden objective tests. Only the graph shape changes:

- **lean** (`fix-linear-lean`) — `frame → diagnose → act → run-verification →
  close`, 5 blocks. Drops the `gather-context` block. It keeps `diagnose`
  because the composer's `act` block requires an analysis precursor (the
  writer-coupling wall): a bare `frame → act` walls at `act`. So lean is the
  **shortest fix arc that still runs** — the low end of the sweep.
- **full** (`fix-linear-full`) — `frame → gather-context → diagnose → act →
  run-verification → close`, 6 blocks. The mid arc.
- **loop** (`fix-linear-loop`) — full plus `loopBackTo: 'act'` on the
  verification step: if verification fails, route back to `act` and retry
  (bounded). 6 blocks with a recovery branch.

All three are genuinely composed block by block (no family template), VALID,
RUNNABLE, and NOVEL against every built-in (closest neighbor is the `fix` flow,
not a match). The question is the one the dial and depth sweeps never isolated:
**does the wiring between steps move the outcome for a fixed task, or is the
judgement inside a step the scarce ingredient?**

## Headline: topology is efficacy-flat, cost-real

| Metric (fix, n=12 reps/shape)   | lean (5 blk) | full (6 blk) | loop (6 blk + retry) |
|---------------------------------|--------------|--------------|----------------------|
| objective-fixed                 | 11 / 12 (0.917) | 12 / 12 (1.000) | 12 / 12 (1.000) |
| false-fixed                     | 0            | 0            | 0                    |
| verification pass               | 0.917        | 1.000        | 1.000                |
| pipeline failures               | 0 / 12       | 0 / 12       | 0 / 12               |
| outside-allowed changes         | 0            | 0            | 0                    |
| median cost (USD)               | **$0.1066**  | $0.1565      | $0.1582              |
| mean cost (USD)                 | **$0.1071**  | $0.1605      | $0.1584              |
| p90 cost (USD)                  | $0.1163      | $0.1632      | $0.1673              |
| mean wall-clock                 | **72.2 s**   | 104.3 s      | 102.3 s              |
| relays per run                  | 2            | 3            | 3                    |
| proof_quality (fix scorer)      | 0            | 0            | 0 (see receipt note) |

Two clean reads and one non-read:

1. **Efficacy does not separate.** lean 11/12, full and loop 12/12. The entire
   "difference" is **one rep-flip at n=12** — `fix-off-by-one` rep-01 on the
   lean arc. That is noise-range, not a topology effect (see the miss analysis).
2. **Cost and latency track block count, monotonically and robustly.** lean is
   **~32% cheaper** (median $0.1066 vs $0.1565) and **~31% faster** (72 s vs
   104 s) than full. The ~50% lean→full cost step is exactly the 5→6 block /
   2→3 relay jump. This is the one real, re-verified signal.
3. **loop ≈ full because the recovery route never fired.** loop's median
   ($0.1582) sits on top of full's ($0.1565); the ~$0.0002 gap is per-run model
   output variance. Across all 12 loop runs there is **no `attempt:2`** anywhere
   — 72/72 `route_taken=pass`, `max_attempt=1` on every step. A recovery loop is
   **pure overhead until verification actually fails**.

## The one lean miss is rep noise, not a gather-context effect

This is the load-bearing claim, so it was investigated directly rather than
inferred. `fix-off-by-one` is a designed surface-patch-vs-root-cause trap: the
**visible** test exercises only the upper clamp (`clampPage(9, 5) === 4`); the
**hidden** objective test, overlaid at scoring from a fresh temp dir, also
asserts the lower clamp (`clampPage(-3, 5) === 0`).

- lean rep-01 emitted `Math.min(index, pageCount - 1)` — fixes the upper bound
  only. It passed the visible test, self-closed `complete / accept`, and the
  hidden check then failed identically to baseline (`-3 !== 0`). Honest miss.
- lean rep-02 and rep-03 emitted `Math.max(0, Math.min(index, pageCount - 1))`
  — both ends — and **passed the hidden check**.

So the correct root-cause fix is **fully reachable on the lean topology**:
lean produced it on 2 of 3 reps of the *same task* with *no gather-context
block*. The miss has a model-variance signature (a partial fix), not an
information-starvation one that a research/recall block would cure
(`attributable_to_missing_gather_context: no`, confidence high). The full arc
got all 3 reps right on this task, but at n=12 that 3/3-vs-2/3 delta is a single
run with no significance. **Adding `gather-context` did not buy correctness
here; it bought cost.**

## Fit with the standing thesis

Phase D corroborates the thesis the dial and depth sweeps already pointed at:
**step-level judgement, not graph shape, is the scarce ingredient.** The thing
that moved the one outcome was *what the implementer step produced* (a full vs a
partial clamp), not *which graph it sat in* — the identical lean topology
yielded both the correct and the incomplete fix. Richer topology bought cost and
(separately) a thicker-or-thinner receipt, not correctness. Graph shape is close
to free on efficacy and not free on cost.

The actionable corollary: **prefer the leaner arc when the task is within
reach.** A recovery loop earns its added cost only on tasks where first-try
verification fails — which never happened here. Its value proposition is
therefore *structurally untested* by this run, not disproven.

## What this is NOT: the non-discrimination caveats

Read these before quoting any number above as a topology finding.

- **Near-ceiling, non-discriminating tasks.** All three arms sit at 11–12/12.
  With outcomes pinned near the ceiling, this experiment **cannot detect a
  topology effect even if one exists** — it can only say none was visible here.
  Absence of evidence, not evidence of absence.
- **n=12 per shape; the efficacy "difference" is one run.** Do not quote
  11/12 vs 12/12 as a topology result. It is a single rep-flip the miss analysis
  traces to model variance on a reachable fix.
- **Single family (fix), 4 tasks, pinned haiku.** No generalization to
  build/goal/explainer families, other models, or harder tasks.
- **The loop is untested where it matters.** Its recovery branch never fired
  because nothing failed first-try. Its worth can only be shown on a task set
  where verification fails and the retry catches it.
- **Proof-richness gap (disclosed, not a defect).** All three arms close the
  generic `flow.result@v1` writer with `mean_proof_quality=0` — a leaner receipt
  than the fix family's full proof bundle (`regression_status`, rerun, change-set).
  The fix evidence is real and present in `run-verification.json`; the *receipt*
  is thinner. Honest because `claimed_fixed=false`, so 0 false-fixed is not
  laundered. This is the same asymmetry the fix and build composed findings
  documented, not a new gap.

## How the result was verified (provenance)

All 36 runs were adversarially verified from raw evidence (not the harness's own
scores) before this finding was recorded, because all-arms-near-100% raises the
question of whether the tasks discriminate or whether the scorer is
false-positive-prone. Six independent skeptics (one per shape, a dedicated
miss-investigator, a cost/structure analyst, and a synthesis) inspected the
artifacts:

- **Baselines genuinely failed pre-change** on every run — the hidden objective
  tests, run from fresh `/private/var` temp overlays (not shipped in the agent
  repo), threw the expected errors (`-3 !== 0`, `TypeError ... reduce`,
  `1 !== 50`, `'2026-11-7' !== '2026-11-07'`).
- **Diffs are real, on-target source edits** touching only the one allowed file
  per task (`outside_allowed_changed_files=[]` everywhere); no test or objective
  file was modified in any of the 36 diffs.
- **Closes are honest, not laundered.** The scorer derives `objective_fixed`
  from an independent hidden-check overlay copied over the agent repo at scoring
  time. The decisive independence proof: lean off-by-one rep-01 self-closed
  `complete / accept / proven` yet was correctly scored `objective_fixed=false` —
  a false-positive-prone scorer cannot produce an honest negative on a
  self-accepted run.
- **Cost delta is real, not a measurement artifact.** Three runs were
  re-priced token-by-token against the committed price table and matched the
  stored figures to 1e-7. Per-trace step/relay counts are cleanly bimodal by
  block count (lean 5/2, full 6/3, loop 6/3).
- **loop retry never fired** — verified across all 12 loop traces: no
  `attempt:2`, `max_attempt=1` on every step, 72/72 `route_taken=pass`.

Synthesis confidence: **high** on genuineness (35/35 fixed runs are real, no
scorer false-positive). The efficacy claim is deliberately bounded: **"no
topology effect detected on non-discriminating tasks," never "topology doesn't
matter."**

## Outcome

On clean-passing single-family fix tasks at n=12, **flow topology is
efficacy-flat and cost-real**: extra blocks reliably cost more (lean ~32% cheaper
and ~31% faster than full), and a recovery loop costs the same as the plain arc
while never firing. The lone 11/12 is a rep-flip traced to model variance on a
fix reachable without the dropped block. This reinforces the standing thesis —
**the judgement inside a step, not the wiring between steps, is the scarce
ingredient** — and gives the practical rule: prefer the leaner arc within reach,
and spend blocks only where the task stresses them. The natural next step is a
*discriminating* (harder, failure-inducing) fix set where the loop's recovery
branch can actually fire, which is the only way to measure topology's value
rather than its cost.

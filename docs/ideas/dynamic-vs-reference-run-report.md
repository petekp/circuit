# Run report — dynamic-vs-reference live experiment

> Status: **complete.** Verdict **WORTH-INVESTING**. This report applies the
> decision rule locked in
> [`dynamic-vs-reference-experiment-brief.md`](dynamic-vs-reference-experiment-brief.md)
> §5 to the measured numbers. The brief (task set, metrics, rule) was committed
> before any eval data; the inputs below are shown, not asserted.

- **Ran at:** 2026-06-19 (UTC). **Repo commit:** `4e065975`.
- **Model:** `claude-haiku-4-5-20251001`, pinned on both arms (`--pin-model`),
  effort `medium`.
- **Runs:** 8 held-out tasks × 2 arms × 3 reps = **48 live runs**, all completed.
- **Results:** `evals/dynamic-vs-reference/results/2026-06-19T05-21-21-320Z-all/`
  (`summary.json` + `report.md`, gitignored).
- **Ledger row:**
  `evals/ledger/dynamic-vs-reference/2026-06-19T06-58-15-200Z-claude-haiku-4-5-20251001.json`.

---

## The question

When you generate a flow from a plain-English task (`circuit create`) and run it,
does it finish **as well as** the hand-authored reference flow, and at what cost?
Both arms are Circuit runs, same pinned worker model, same task, same fixture repo,
scored identically. The only difference is the flow they run:

- **reference** — the hand-authored built-in (`fix` / `build`).
- **generated** — the flow `circuit create` instantiates from the task text, then
  publishes and runs under a custom slug, in its **default mode only**.

So the comparison isolates **flow shape + the generation pipeline**, not model power.

---

## Headline

**WORTH-INVESTING.** The generated path matched the hand-authored bar on quality
and honesty on both families, the build fold paid for itself (and then some), and
every one of the 48 runs produced a publishable, runnable flow. Spend on
broadening the dynamic direction is justified by the locked rule.

The single most important number: across all 48 runs, **false-fixed stayed at 0%**.
Not one run — reference or generated — claimed it was done when the hidden checks
said it was not. The one generated quality miss (below) was an *honest* miss.

---

## Per-family numbers

### fix (4 tasks × 3 reps = 12 runs per arm)

| Arm | Objective-fixed (Q) | False-fixed (FF) | Verification | Median cost | Mean wallclock | Pipeline failures |
|---|---:|---:|---:|---:|---:|---:|
| reference | 100% (12/12) | 0% | 100% | $0.1828 | 135.7 s | 0 |
| generated | 91.7% (11/12) | 0% | 91.7% | $0.1891 | 140.5 s | 0 |

The generated fix flow **instantiates the fix seed**, so it is structurally the
same shape as the reference: **13 steps on both arms**, every rep. This family is a
pipeline-plus-cost confirmation, and it held: the full generation path (text →
signals → archetype → compile → per-mode package → publish → run under a custom
slug, through the trust gate) added no honesty regression and no cost blow-up.

The one miss was `fix-null-guard` rep 2: the generated arm reported `partial`
(review verdict `accept-with-fixes`), the hidden objective check failed, and it
did **not** claim it was fixed — `false_fixed = false`. That is the system working
as designed: it told the truth about an incomplete fix rather than laundering it
into a "done." Cost on `fix` is effectively a wash — the generated arm ran ~3%
dearer at the median ($0.1891 vs $0.1828), inside run-to-run noise.

### build (4 tasks × 3 reps = 12 runs per arm)

| Arm | Objective-fixed (Q) | False-fixed (FF) | Verification | Median cost | Mean wallclock | Pipeline failures |
|---|---:|---:|---:|---:|---:|---:|
| reference | 100% (12/12) | 0% | 100% | $0.1872 | 134.1 s | 0 |
| generated | 100% (12/12) | 0% | 100% | $0.0600 | 69.2 s | 0 |

This is where the dynamic direction earns its keep. The generated build flow
**chooses its grain from the task signals**, and the choice matched the
pre-registration exactly:

| Task | Size/risk | Reference steps | Generated steps | Generated grain |
|---|---|---:|---:|---|
| `build-add-helper` | small / low | 9 | **5** | whole (folded) |
| `build-validate-input` | small / low | 9 | **5** | whole (folded) |
| `build-feature-flag` | medium | 9 | **5** | whole (observed) |
| `build-migrate-store` | large / high | 9 | **9** | decomposed (full) |

On the small/low tasks the generated arm folds to a **thinner** 5-step flow and
finishes the same work for about **a third of the cost at equal quality**. On the
large/high task it keeps the full decomposed 9-step shape, matching the reference.
The fold is selective, not a blanket discount: it thins where the task is small and
holds the full rigor where the task is large.

---

## The decision rule, applied (inputs shown)

The locked §5 rule, evaluated on the numbers above:

**WORTH-INVESTING** requires, for *both* families:

| Predicate | fix | build |
|---|---|---|
| `Q_gen ≥ Q_ref − 0.10` (quality within margin) | 0.917 ≥ 0.90 ✓ | 1.00 ≥ 0.90 ✓ |
| `FF_gen ≤ FF_ref + 0.10` (honesty within margin) | 0.00 ≤ 0.10 ✓ | 0.00 ≤ 0.10 ✓ |
| zero unexplained pipeline failures | 0 ✓ | 0 ✓ |

Plus, on `build`, the fold must pay for itself on the small/low tasks (B1/B2):

- `C_gen ≤ C_ref` on B1/B2: **$0.0579 generated ≤ $0.1856 reference** ✓

All predicates hold:
`{quality_fix_within_margin, quality_build_within_margin, honesty_fix_ok,
honesty_build_ok, pipeline_fix_clean, pipeline_build_clean,
build_fold_cost_pays_for_itself}` = all **true**.

→ **WORTH-INVESTING.** No tier boundary was close on the wrong side: the only
sub-100% number (fix generated quality, 91.7%) sits 1.7pp above the 90% floor, and
it is an honest miss, not a false-fixed.

### Pipeline-integrity override — did not trip

The override caps the verdict at NOT-YET if any generated run fails to produce a
publishable, runnable flow (create error, publish error, default-mode trust-gate
reject, or no primary result). **All 24 generated runs reached a terminal with a
parsed primary result; pipeline failures = 0.** The custom-slug trust path, the
per-mode package, and publish all held end-to-end.

---

## Measurement integrity

Every integrity counter the brief asked for is reported and clean, per family per
arm (no silent undercount):

- `relays_missing_usage` / `usage_missing_count`: **0**
- `price_table_miss_count`: **0**
- `cost_divergence_flag`: **0** (computed cost matched reported cost to ~1e-16)
- `claim_parse_failure_count`: **0**
- `outside_allowed_changed_files`: **0** across all 48 runs (every run touched only
  its allowed files)
- `baseline_failed_as_expected` / `fixture_commits_match`: **true** for every task
  (the fix fixtures genuinely failed before the fix; the build fixtures started
  from the locked commit)

Cost is the **computed** per-relay figure summed from each run's trace, using the
committed price table — the same instrument fix-vs-vanilla uses, on both arms,
since both arms are Circuit.

---

## Honest reads and limits

- **N = 3 is a confirmation, not a powered study.** This is the fix-vs-vanilla
  held-out cadence; it bounds spend and answers "does it hold," not "by exactly how
  much." The quality numbers are 11/12 and 12/12, not a distribution.
- **The fix win is a wash, not a saving.** On `fix` the generated arm is ~3% dearer
  at the median. That is expected — the fix flow instantiates the same seed, so
  there is no thinner shape to fold to. The cost win is entirely on `build`, and it
  comes from the **grain choice**, not from the pipeline being cheaper.
- **Default mode only.** The generated arm ran its default depth/mode by design, to
  stay clear of the per-mode runtime-trust gap (closed separately in Brief #1). A
  non-default mode of a generated flow is out of scope for this experiment.
- **Held-out hygiene.** These eight tasks are claim-eligible only while held out. Do
  not reuse them to tune the assembler without retiring them and adding fresh ones.
- **One mis-specification check:** none. No §5 predicate was mis-stated relative to
  the data; nothing had to be disclosed-and-discounted.

---

## What this means

The task-aware assembler previously scored VIABLE by *instantiation* — it picks a
family and instantiates a proven seed. This experiment adds the missing half: a
flow generated from plain English **runs as well as the hand-authored reference**,
on the two cleanest families, at no honesty cost and (on build) at a real cost
saving from the grain fold. The dynamic / JIT direction is worth more investment.

What this does **not** yet show, and is the honest frontier:

- **Genuine block-composition** (assembling a novel flow from the block catalog,
  not instantiating a seed) remains the parked RESEARCH PROBLEM. This experiment
  measured the *instantiation* path only.
- **Breadth.** Two families, eight tasks. The next dynamic-direction step is more
  families and harder tasks, not a deeper dive on these two.

The follow-up direction is sketched in
[`dynamic-vs-reference-followup.md`](deprioritized-ledger.md).

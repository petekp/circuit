# Dynamic-vs-Reference Eval

Status: discovery-grade internal pilot. Pre-registered in
[`docs/ideas/dynamic-vs-reference-experiment-brief.md`](../../docs/ideas/dynamic-vs-reference-experiment-brief.md).

This eval asks one question:

> When you generate a flow from a natural-language task and run it, does it
> finish **as well as** the hand-authored reference flow, and at what cost?

It is confirmatory and comparative, with real model budget, against a rule that
is **locked before any data** (section 5). If the data lands outside these
thresholds, the verdict follows the rule, not the hope.

## The two arms

Both arms are Circuit runs, same worker model (pinned), same task, same fixture
repo, scored identically. The only thing that differs is the flow they run.

- **reference** — the hand-authored built-in. `circuit run fix|build --goal …
  --flow-root generated/flows …`.
- **generated** — the flow `circuit create` instantiates from the task text.
  `circuit create --description … --publish --home <tmp>`, then `circuit run
  <slug> --flow-root <tmp>/flows --goal … …`.

The generated arm runs in its **default mode only**. A non-default mode of a
published custom flow hits the per-mode runtime-trust gap, which is out of scope
for this experiment; pin depth to the default and the default mode is blessed by
construction.

Both arms are pinned to one model with `--pin-model` so the comparison isolates
**flow shape plus pipeline**, not model power.

## What each family tests

- **build is a genuine divergence.** The generated build flow's grain is chosen
  from the task signals: a small/low task folds to **whole** (about 5 steps), a
  large/high task stays **decomposed** (about 9 steps). The reference is the
  full build flow. So on a small task the generated arm runs a thinner flow. The
  question is whether the fold finishes the work at lower cost without losing
  correctness.
- **fix is a pipeline plus cost confirmation.** The generated fix flow
  instantiates the fix seed, so it is structurally close to the reference. Here
  the experiment confirms that the end-to-end generation pipeline (text →
  signals → archetype → compile → per-mode package → publish → run under a custom
  slug, through the trust gate) adds no quality regression and no cost blow-up
  versus running the reference directly.

## Task set (locked, held-out)

Eight tasks, four per family, held out. Fresh tasks, not reused from the
assembler's pre-registered set or the fix-vs-vanilla discovery/regression sets,
so there is no tuning contamination. Each is a real coding task on a small
fixture repo with a `package.json` test script.

| id | Family | Expected generated grain |
|---|---|---|
| `fix-off-by-one` | fix | fix (instantiated) |
| `fix-null-guard` | fix | fix (instantiated) |
| `fix-async-race` | fix | fix (instantiated) |
| `fix-format-bug` | fix | fix (instantiated) |
| `build-add-helper` | build | build / whole (small/low) |
| `build-validate-input` | build | build / whole (small/low) |
| `build-feature-flag` | build | build / whole or decomposed (medium, observed) |
| `build-migrate-store` | build | build / decomposed (large/high) |

Each fixture follows the `evals/fix-vs-vanilla/tasks/<id>/` shape: `task.json`
(id, prompt, hidden objective checks, `allowed_changed_files`), a `repo/`
template the worker edits, and an `objective/` overlay the worker never sees.

Run N = 3 reps per task per arm: 8 tasks × 2 arms × 3 = **48 live runs**.

### Held-out hygiene

These eight tasks are claim-eligible only while held-out. Do not reuse them to
tune the assembler later without retiring them and adding fresh held-out tasks.

## Metrics

Scored with the existing fix-vs-vanilla machinery
(`scripts/evals/fix-vs-vanilla/scoring.ts`) and the committed cost instrument
(`scripts/evals/shared/usage.ts`), not a new scorer.

- **objective_fixed** — the hidden `objective/` checks pass (external truth, not
  self-report). The headline quality metric.
- **false_fixed** — claimed done but objective checks fail. The honesty metric.
- **verification_passed** — the flow's own verify step passed.
- **cost** — `cost_usd_reported` and `cost_usd_computed` per arm (per-relay
  capture summed; both arms are Circuit so the same seam applies), token classes,
  and the `usage_by_role` breakdown. Every integrity counter is carried
  (`relays_missing_usage`, `cost_divergence_flag_count`, `price_table_miss_count`).
- **wallclock_ms** and changed-file discipline (`outside_allowed_changed_files`).

## 5. The decision rule (locked before data)

Per family, let `Q_gen` / `Q_ref` be the objective-fixed rate (mean over tasks ×
reps) of the generated and reference arms; `FF_gen` / `FF_ref` the false-fixed
rates; `C_gen` / `C_ref` the median per-task computed cost.

The dynamic / JIT direction is classified as exactly one of:

### WORTH-INVESTING — keep building the dynamic direction
For **both** families:
- `Q_gen ≥ Q_ref − 0.10` (no meaningful quality loss), **and**
- `FF_gen ≤ FF_ref + 0.10` (no meaningful honesty loss), **and**
- on `build`, the folded (whole) grain is **not more expensive** than the
  reference on the small/low tasks (`C_gen ≤ C_ref` on `build-add-helper` and
  `build-validate-input`) — the fold must pay for itself, **and**
- zero unexplained pipeline failures on the generated arm (every generated run
  reached a terminal; trust-gate, publish, and per-mode resolution all held).

### MIXED — invest selectively, with a named gap
Meets WORTH-INVESTING on one family but not the other, **or** quality parity
holds but the build fold costs *more* than the reference without a correctness
gain.

### NOT-YET — do not spend more on the dynamic arm
Any family where `Q_gen < Q_ref − 0.10`, **or** `FF_gen > FF_ref + 0.10`, **or**
the generated arm has unexplained pipeline failures.

### Pipeline-integrity override
If any generated run fails to produce a publishable, runnable flow (create
errors, publish errors, trust-gate rejects in the **default** mode, no
`primary_result`), the classification is **at most NOT-YET** regardless of the
quality numbers, and the failure is the headline. A dynamic path that cannot
reliably run is not worth comparing.

## 6. The composed-vs-reference rule (sibling, locked before data)

Section 5 asks whether the **instantiated** flow (`circuit create` picks a family
template) is worth investing in. The opt-in `--with-composed` arm asks a different
question: does a **genuinely composed** fix flow — assembled block by block with no
family template (`FIX_LINEAR_FULL`: frame → gather-context → diagnose → act →
run-verification → close) — reach the hand-authored reference?

This arm runs on **fix only** (block-level composition for build is unproven). It
is scored by the same hidden objective tests and reuses the same pre-registered
margins as section 5, but drops the build fold-cost criterion (meaningless for a
short composed fix topology). Let `Q_comp` / `Q_ref` and `FF_comp` / `FF_ref` be
the composed and reference objective-fixed / false-fixed rates on fix.

- **COMPOSITION-VIABLE** — `Q_comp ≥ Q_ref − 0.10` **and** `FF_comp ≤ FF_ref + 0.10`
  **and** the composed pipeline is clean. Genuine composition reaches the
  hand-authored bar; the north-star path is efficacious, not just expressible.
- **BELOW-REFERENCE** — pipeline clean, but composed quality falls more than 10pp
  or composed false-fixed rises more than 10pp. A named, measured gap.
- **PIPELINE-BROKEN** — any composed run failed to produce a clean result (a
  compose wall, a runnability abort, or a missing result). This overrides the
  efficacy numbers: you cannot judge a flow that never ran cleanly. The composer's
  offline validity + runnability checks should prevent this; if it fires, the
  composer admitted a spec it should have walled.

The composed verdict is **additive** — it never feeds the section-5 verdict. The
sibling rule is locked in `composed-decision-rule.test.ts`; the composed arm's
publish plumbing (trust-gate acceptance + loader resolution) is proven offline in
`tests/contracts/composed-arm-plumbing.test.ts`.

## Run

Dry-run (plumbing only, $0, prints projected live spend):

```bash
node evals/dynamic-vs-reference/run-dynamic-comparison.ts --dry-run
```

Live run (pinned model, real spend):

```bash
node evals/dynamic-vs-reference/run-dynamic-comparison.ts \
  --pin-model claude-haiku-4-5-20251001 --reps 3
```

Add the composed arm (section 6; fix tasks only, real spend on top of the two
base arms):

```bash
node evals/dynamic-vs-reference/run-dynamic-comparison.ts \
  --pin-model claude-haiku-4-5-20251001 --family fix --reps 3 --with-composed
```

Results land in `results/<ts>/summary.json` + `report.md` (gitignored), and a
numeric, poison-scanned row is appended to the ledger. The human run report is
written to `docs/ideas/dynamic-vs-reference-run-report.md`, applying the section
5 rule to the measured numbers; when `--with-composed` is set, the report also
carries the section-6 composed-vs-reference table and verdict.

## Anti-fitting commitments

- The brief (task set, metrics, rule) is committed before any eval data.
- The thresholds in section 5 are fixed. If the data lands between tiers, the
  lower tier governs. A mis-specified predicate is disclosed and discounted in
  the report, never silently rewritten.
- The reference arm is the bar, measured alongside, so parity is computed, not
  assumed.

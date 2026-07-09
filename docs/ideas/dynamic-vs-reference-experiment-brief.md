# Brief + pre-registration — the dynamic-vs-reference live experiment

> Status: **pre-implementation. Decision-ready brief; builds a harness, runs a
> measured experiment, writes a run report.** Date 2026-06-18, grounded on `main`
> at HEAD `c8026ef2`. This is the task-aware assembler report's recommended next
> step ([`assembler-rebuild-run-report.md`](deprioritized-ledger.md) §4).
> It is written in the pre-registration spirit of
> [`assembler-rebuild-preregistration.md`](assembler-rebuild-preregistration.md):
> the task set, the metrics, and the decision rule are **locked here, before any
> eval data**. If the data lands outside these thresholds, the verdict follows the
> rule, not the hope.

---

## 0. What we are deciding

The task-aware assembler scored **VIABLE** by *selection-and-instantiation*: it
reads a task, picks a family, and instantiates a proven family seed. That verdict
rests on **offline structural scoring** plus two **single** live arms. It does not
yet answer the question that decides whether the dynamic / JIT direction earns
continued investment:

> **When you generate a flow from a natural-language task and run it, does it
> finish _as well as_ the hand-authored reference flow — and at what cost?**

This experiment answers that on the two cleanest families (`fix`, `build`) where
the live arms already succeed. It is **confirmatory and comparative**, with real
model budget, against a locked rule.

---

## 1. Why these two families, and what "different" means

The generated arm runs the flow that `circuit create` produces from a task
description; the reference arm runs the hand-authored built-in. How much they
differ is **not uniform across families**, and the brief is honest about it:

- **`build` — a genuine divergence.** The generated build flow's **grain** is
  chosen from the task signals: a small/low task folds to **whole** (5 steps), a
  large/high-risk task stays **decomposed** (9 steps). The hand-authored
  reference is the **full** build flow. So on a small task the generated arm runs
  a *thinner* flow than the reference — this is a real quality-vs-cost question:
  does the fold finish the work at lower cost without losing correctness?
- **`fix` — primarily a pipeline + cost confirmation.** The generated fix flow
  **instantiates the fix seed**, so it is structurally close to the reference. On
  `fix` the experiment mainly confirms that the end-to-end **generation pipeline**
  (NL → signals → archetype → compile → per-mode package → publish → run under a
  custom slug, through the trust gate) adds **no quality regression and no cost
  blow-up** versus running the reference directly. The paper-to-site findings
  warned that "the editorial spine generalized well; the operational plumbing did
  not" — `fix` is where we measure whether the plumbing holds on a clean family.

This split is the point: `build` tests **shape selection**, `fix` tests the
**pipeline**. Both must hold for the dynamic direction to be worth more budget.

---

## 2. The two arms (locked)

Both arms are **Circuit runs** (not vanilla), same worker model, same task, same
fixture repo, scored identically.

| Arm | What it runs | How it is produced |
|---|---|---|
| **reference** | the hand-authored built-in (`fix` / `build`) | `circuit run fix\|build --goal "<task>" --flow-root <generated/flows> …` |
| **generated** | the flow `circuit create` instantiates from the task text | `circuit create --description "<task>" --publish --home <tmp>`, then `circuit run <slug> --flow-root <tmp custom flows> --goal "<task>" …` |

Pin both arms to one model (`--pin-model`, mirroring
`evals/fix-vs-vanilla/run-fix-comparison.ts`) so the comparison isolates **flow
shape + pipeline**, not model power. Capture cost on **both** arms with the
existing per-relay instrument (§4). The generated arm exercises the per-mode
package and the custom-slug trust path end-to-end.

> **Plumbing dependency — read first.** The generated arm runs a published custom
> flow. If the experiment needs a **non-default depth/mode** of a generated
> fix/build flow, it will hit the per-mode runtime-trust gap (a non-default
> `<mode>.json` sibling is unblessed and rejects). Two clean options: (a) run the
> generated arm in its **default mode only** (sufficient for this experiment — pin
> depth to the default), or (b) land
> [`per-mode-runtime-trust-brief.md`](deprioritized-ledger.md) first.
> The brief assumes (a) unless the operator says otherwise.

---

## 3. The task set (locked, held-out)

Eight tasks, four per family, **held-out** (not the assembler's eight
pre-registered tasks, not the fix-vs-vanilla discovery/regression sets — fresh, so
no tuning contamination). Each is a real coding task on a small fixture repo with
a `package.json` test script (the §6 honesty note in the assembler report:
`fix`/`build` need a runnable verification command, the operator's setup job).

| # | id | Family | Task text | Expected generated grain |
|---|---|---|---|---|
| F1 | `fix-off-by-one` | fix | fix the off-by-one so the last element is included | fix (instantiated) |
| F2 | `fix-null-guard` | fix | fix the crash when the input list is empty | fix (instantiated) |
| F3 | `fix-async-race` | fix | fix the race where two calls double-count | fix (instantiated) |
| F4 | `fix-format-bug` | fix | fix the date formatter dropping leading zeros | fix (instantiated) |
| B1 | `build-add-helper` | build | add a `clamp(min,max,n)` helper and use it | build / **whole** (small/low) |
| B2 | `build-validate-input` | build | add input validation to the form handler | build / **whole** (small/low) |
| B3 | `build-feature-flag` | build | add a feature-flag gate around the new checkout path | build / whole or decomposed (medium) |
| B4 | `build-migrate-store` | build | migrate the store from callbacks to async/await across the module | build / **decomposed** (large/high) |

The fixtures follow the `evals/fix-vs-vanilla/tasks/<id>/` shape: `task.json`
(id, prompt, hidden objective checks, `allowed_changed_files`), a `repo/` template,
and an `objective/` overlay the worker never sees. Reuse that scaffolding; do **not**
reuse its task *bodies* (those are fix-vs-vanilla's; these are held-out here).

Run **N = 3 reps** per task per arm (8 tasks × 2 arms × 3 = 48 live runs). This is
a confirmation, not a powered study; N=3 is the fix-vs-vanilla held-out cadence and
keeps spend bounded.

---

## 4. The metrics (objective + cost, reuse the instrument)

Score with the **existing fix-vs-vanilla machinery** (`scripts/evals/fix-vs-vanilla/scoring.ts`)
and the **committed cost instrument** ([`../evals/cost-capture-design.md`](../evals/cost-capture-design.md)),
not a new scorer:

- **objective_fixed** — the hidden `objective/` checks pass (external truth, not
  self-report). The headline quality metric.
- **false_fixed** — claimed done but objective checks fail. The honesty metric.
- **verification_passed** — the flow's own verify step passed.
- **cost** — `cost_usd_reported` and `cost_usd_computed` per arm (per-relay
  capture for the Circuit arm, summed; both arms are Circuit so the same seam
  applies), plus token classes and the `usage_by_role` breakdown. Carry every
  integrity counter (`relays_missing_usage`, `cost_divergence_flag_count`,
  `price_table_miss_count`).
- **wallclock_ms** and **changed-file discipline** (`outside_allowed_changed_files`).

Land results in a timestamped `results/<ts>/summary.json` + `report.md` exactly as
fix-vs-vanilla does, and append the numeric, poison-scanned row to the ledger
(`scripts/evals/shared/ledger.ts`).

---

## 5. The decision rule (locked before data)

Let, per family, `Q_gen` and `Q_ref` be the **objective-fixed rate** (mean over
tasks × reps) of the generated and reference arms; `FF_gen` / `FF_ref` the
false-fixed rates; `C_gen` / `C_ref` the **median per-task computed cost**.

The dynamic / JIT direction is classified as exactly one of:

### WORTH-INVESTING — keep building the dynamic direction
For **both** families:
- `Q_gen ≥ Q_ref − 0.10` (generated finishes within 10pp of the reference's
  objective-fixed rate — i.e. no meaningful quality loss), **and**
- `FF_gen ≤ FF_ref + 0.10` (no meaningful honesty loss), **and**
- on `build`, the folded (whole) grain is **not more expensive** than the
  reference on the small/low tasks (`C_gen ≤ C_ref` on B1/B2) — the fold must pay
  for itself, **and**
- zero unexplained pipeline failures on the generated arm (every generated run
  reached a terminal; trust-gate / publish / per-mode resolution all held).

Reading: the generated path matches the hand-authored bar on quality and honesty,
the fold saves (or at least does not cost) on small build tasks, and the plumbing
is sound. Spend on broadening the dynamic direction is justified.

### MIXED — invest selectively, with a named gap
Meets WORTH-INVESTING on **one** family but not the other, **or** quality parity
holds but the build fold costs *more* than the reference without a correctness
gain. Reading: ship/keep the family that passed; the failing family or the
fold-economics is the named gap to close before broadening.

### NOT-YET — do not spend more on the dynamic arm
Any family where `Q_gen < Q_ref − 0.10`, **or** `FF_gen > FF_ref + 0.10`, **or**
the generated arm has unexplained pipeline failures. Reading: the generated path
loses quality/honesty or the plumbing is not sound; fix that before any further
dynamic investment.

**Pipeline-integrity override.** If any generated run fails to **produce a
publishable, runnable flow** (create errors, publish errors, trust-gate rejects in
the *default* mode, no `primary_result`), the classification is **at most NOT-YET**
regardless of the quality numbers, and the failure is the headline. A dynamic path
that cannot reliably run is not worth comparing.

---

## 6. How to run (grounded in the existing harness)

Mirror `evals/fix-vs-vanilla/run-fix-comparison.ts`. Concretely:

1. **New eval folder** `evals/dynamic-vs-reference/` with `README.md` (charter +
   this decision rule), `manifest.json` (the held-out task ids), `tasks/<id>/`
   fixtures, and a `run-dynamic-comparison.ts` harness.
2. The harness, per task per rep: (a) **reference arm** — `bin/circuit run
   <family> --goal … --pin-model … --run-folder … --flow-root generated/flows
   --progress jsonl`; (b) **generated arm** — `bin/circuit create --description …
   --publish --home <tmpHome>` then `bin/circuit run <slug> --goal … --pin-model …
   --flow-root <tmpHome custom flows> --run-folder … --progress jsonl`. Both in a
   throwaway copy of the task `repo/`.
3. **Score** by overlaying `objective/` and running the hidden checks; read each
   run's `trace.ndjson` for per-relay usage; aggregate with the shared scoring +
   ledger modules.
4. **Write** `results/<ts>/summary.json` + `report.md`, append the ledger row,
   then write the human run report at
   `docs/ideas/dynamic-vs-reference-run-report.md` applying §5.

Dry-run first (`--dry-run`, mirroring the existing harness) to prove plumbing with
$0, then run live.

---

## 7. Rails / out of scope

- **Do NOT modify the assembler, the resolvers, or any `src/flows/**` flow
  shape.** This experiment *measures* the current generator; changing it
  invalidates the measurement. If the generator is found wanting, that is a
  finding, not a fix to make mid-experiment.
- **Do NOT touch the genuine-block-composition arm.** That is the parked RESEARCH
  PROBLEM (catalog enrichments); this experiment is the *instantiation* path only.
- **No new scorer or cost instrument.** Reuse fix-vs-vanilla scoring + the
  committed price table; if a price-table date is missing, add a dated file
  (append-only), do not inline rates.
- **Budget bound.** 48 live runs on small tasks, pinned to one mid/low model
  (e.g. `claude-haiku-4-5` or `claude-sonnet-4-6` — operator picks). Estimate and
  print projected spend in the dry-run; **STOP-AND-REPORT** before the live run if
  the projected spend exceeds the operator's stated ceiling.
- **Held-out hygiene.** These eight tasks are claim-eligible only while held-out;
  do not reuse them to tune the assembler later without retiring them.

---

## 8. Verification / definition of done

- The harness runs **green in `--dry-run`** (plumbing, $0) before any live spend.
- Full `npm run verify` is green (the new harness + fixtures must not break the
  build, lints, or the eval gates `check-evals`); the new eval is registered in
  `evals/registry.json` with its claim level and cadence.
- The live run completes; `summary.json`, `report.md`, the ledger row, and
  `dynamic-vs-reference-run-report.md` all exist, with **every integrity counter
  reported** (no silent undercount).
- The run report **applies the §5 rule to the measured numbers** and states the
  verdict (WORTH-INVESTING / MIXED / NOT-YET) with the inputs shown, not asserted.

## 9. Anti-fitting commitments

- This brief (task set, metrics, rule) is committed **before** any eval data; its
  commit precedes every result commit.
- The decision thresholds in §5 are **fixed**. If the data lands between tiers,
  the lower tier governs. A mis-specified predicate is **disclosed and discounted
  in the report**, never silently rewritten.
- The reference arm is the bar, measured alongside, so "parity" is computed, not
  assumed.

---

## Hand-off prompt for Claude Code

Copy-paste the block below into Claude Code (run from the repo root,
`/Users/petepetrash/Code/circuit`).

```text
You are implementing a pre-registered experiment in the Circuit repo. Work from
the repo root and stay inside it.

1. Read docs/ideas/dynamic-vs-reference-experiment-brief.md in full, then read
   AGENTS.md and the harness it points at (evals/fix-vs-vanilla/run-fix-comparison.ts,
   scripts/evals/fix-vs-vanilla/scoring.ts, scripts/evals/shared/{usage,ledger}.ts,
   docs/evals/cost-capture-design.md). Follow the repo rails: read before write,
   failing-test-first for any src/scoring change, plain English in operator-facing
   prose, and enumerate 2-3 hypotheses before acting on one.

2. Create a branch: exp/dynamic-vs-reference.

3. Build exactly what §6 specifies: the evals/dynamic-vs-reference/ folder (README
   charter with the §5 decision rule, manifest.json, the eight held-out tasks/<id>/
   fixtures with hidden objective/ checks, and run-dynamic-comparison.ts). Reuse the
   fix-vs-vanilla scoring + cost + ledger modules; do NOT write a new scorer or
   cost instrument. Register the eval in evals/registry.json.

4. Honor the rails in §7. In particular: do NOT modify the assembler, resolvers, or
   any src/flows shape — this experiment measures the current generator. Run the
   generated arm in the DEFAULT mode only (avoids the per-mode trust gap).

5. Prove plumbing with `node evals/dynamic-vs-reference/run-dynamic-comparison.ts
   --dry-run` ($0). Print the projected live spend. Then run `npm run verify`
   (full) — it must be green, including check-evals.

6. STOP-AND-REPORT before any live model spend: show me the dry-run output, the
   projected spend, and the model you intend to pin. Do not start the live run, and
   do not merge, until I approve the spend.

7. After I approve and the live run completes: write results/<ts>/summary.json +
   report.md, append the poison-scanned ledger row, and write
   docs/ideas/dynamic-vs-reference-run-report.md applying the §5 rule to the actual
   numbers (show the inputs; state WORTH-INVESTING / MIXED / NOT-YET).

Definition of "safe enough to merge" (all must hold):
  - npm run verify is green (full canonical gate).
  - The harness ran green in --dry-run before any live spend, and I approved the
    live spend.
  - summary.json, report.md, the ledger row, and the run report all exist with
    every integrity counter reported (no silent undercount).
  - No src/flows or assembler/resolver shape was changed (git diff confirms the
    change is confined to evals/, scripts/evals/, docs/ideas/, evals/registry.json).
  - The run report states the verdict by applying the locked rule, not by asserting.

Merge handling: when the above all hold, commit on exp/dynamic-vs-reference with a
conventional message (e.g. "exp(dynamic-vs-reference): harness + run report —
<verdict>"). If a GitHub remote + gh CLI are available and the repo uses PRs
(it does — history is "Merge pull request #NNN from petekp/..."), open a PR, wait
for CI to pass, then merge it. Otherwise merge the branch into main with a no-ff
merge locally. Then update the docs/ideas/north-star-status.md row for the
dynamic-vs-reference experiment to reflect the verdict, and report: branch, commits,
verify result, the experiment verdict, files changed, and any blocker.

If ANY rail in §7 would be violated, any safety criterion fails, or the
pipeline-integrity override (§5) trips, STOP and report instead of merging.
```

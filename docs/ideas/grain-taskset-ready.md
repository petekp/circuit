# Grain × separability — the taskset is now ready to vet (still not run)

> Status: **taskset built and pre-registered; harness gap closed; B0 not yet
> re-run; no model spend taken.** This is the go-forward surface that replaces
> the blocking half of [`grain-experiment-deferred.md`](grain-experiment-deferred.md).
> That doc deferred the experiment at its own Step-0 (B0) precondition because
> the eval taskset had no entangled or mixed tasks — both grains would pass
> everything and the result would be null-by-construction. The two things B0
> needed are now in place. **Vet the four new tasks, then re-run B0; do not run
> the experiment or touch the structure chooser until that vet passes.**

## What changed since the deferral

1. **Harness gap closed (shipped, `experiments/` only, no engine).** The runner
   now has the K-repeat axis and run-order interleaving the design's standard
   tier requires:
   - `run-matrix.ts` takes `--repeats` / `-k`; `matrix-runner.ts` runs each
     task K times and interleaves cells across repeats so API/time drift spreads
     evenly instead of biasing one grain.
   - `matrix.ts` rows are keyed by `(task_id, repeat)` (the old `.find()` showed
     only the first repeat per row). The `repeat` field is *optional* and
     conditionally spread, so a K=1 run is byte-identical to the prior output —
     the change is inert until you ask for repeats.
   - `matrix.test.ts` grew from 49 to 53 tests covering the new keying.

2. **Four separability-spanning held-out tasks built and pre-registered.** Each
   is in the existing `task.json` + `repo/` + `objective/` (hidden-check) shape,
   with a hidden objective check that **only the assembled (cross-module)
   behaviour passes**. All four traps were validated zero-spend: the unfixed
   repo fails, a naive single-module false-fix still fails the hidden check, and
   the root-cause coherent fix passes.

## The four tasks (a-priori scores committed before any run)

Scores are the design's four dimensions
(co-change / coupling / cross-part-decision / independent-verifiability → sum,
band), pre-registered in each task's `task.json` under `separability`.

| id | archetype | modules | CC | Coup | XPart | IndVer | Sum | Band | Hidden check |
|---|---|---|---|---|---|---|---|---|---|
| `heldout-token-bucket` | entangled-two-module | `limiter.mjs` + `refill.mjs` | 2 | 2 | 2 | 2 | **8** | entangled | `limiter-assembled` (burst must throttle AND steady rate must admit) |
| `heldout-invoice-rounding` | entangled-two-module | `price.mjs` + `invoice.mjs` | 2 | 2 | 2 | 2 | **8** | entangled | `invoice-assembled` (multi-line total exact only under one coherent rounding choice) |
| `heldout-pagination-cursor` | mixed-two-module | `api.mjs` + `store.mjs` | 1 | 1 | 1 | 1 | **4** | mixed | `pagination-assembled` (page-size clamp must agree with cursor window) |
| `heldout-retry-backoff` | mixed-two-module | `retry.mjs` + `backoff.mjs` | 1 | 1 | 1 | 0 | **3** | mixed | `retry-assembled` (loop and delay schedule honour a shared max-attempts contract) |

This gives **≥2 entangled (6–8)** and **≥2 mixed (3–5)**, which is exactly what
B0 was waiting on. The existing 14 held-out tasks remain the separable band
(0–2), so the set now spans all three bands.

Each task introduces a small directory convention worth noting: a two-module
task ships its naive-false-fix and root-cause reference patches under
`fixtures/naive/<module>.mjs` and `fixtures/root-cause/<module>.mjs` (the prior
single-module tasks used flat `fixtures/naive.mjs`). This is additive and only
affects the new tasks.

## Side effect to vet loudly: the held-out claim set grew 14 → 18

These four tasks are `split: held-out`, `provenance: held-out-created`,
`tuning_used: false` — required by the manifest hygiene contract
(`tests/evals/fix-manifest.test.ts`: disk dirs must equal `manifest.sets`
membership, and held-out implies that provenance + untuned). **That means the
held-out evaluation set is now 18 tasks, not 14, and any held-out claim made
after this merge is over a different (larger, harder, multi-module) set than
claims made before it.** This is a deliberate, surfaced consequence — not a
silent change — and it is the main thing to confirm you are comfortable with
before these tasks enter a scored run. If the grain experiment is abandoned,
these four can stay (they strengthen the held-out set) or be pulled; either way
the decision should be explicit.

## Go-forward to actually run (unchanged decision rule)

1. **Re-run B0** now that the set spans separable / mixed / entangled with ≥2
   each. B0 should now *pass* (the precondition that failed before is met).
2. **Standard tier, extremes-first.** ~6 tasks × 2 grains (`fix` = holistic,
   `build --depth high` = separated) × 5 repeats ≈ 60 runs, ≈ $90–120. Run the
   separable + entangled bands at full repeats first; only buy the mixed band if
   the extremes diverge.
3. **Apply the design's pre-committed decision rule** (H-coherence vs
   H-verification). Until a run executes, the structure chooser stays on its
   thin conservative default (lean-to-whole; chop only on explicit operator ask,
   large surface area, or high risk) and surfaces "needs more data."

**Not done here, by design:** the experiment is not run, no model spend was
taken, and the structure chooser is untouched. This doc + the four committed
tasks + the harness fix are the complete prerequisite; the run is the next
authorised step after the taskset vet.

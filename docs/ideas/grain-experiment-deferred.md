# Grain × separability experiment — DEFERRED (not run) + the remedy to make it runnable

> Status: **SUPERSEDED — the deferral was resolved and the experiment has since
> RUN.** Status updated 2026-06-16. The remedy this doc called for was built (the
> harness K-repeat axis + interleaving and the entangled/mixed taskset; see
> [`grain-taskset-ready.md`](grain-taskset-ready.md)), B0 re-passed, and the run
> executed (40 runs, ≈$24). The verdict came back **NULL on the pre-committed
> metric** — the false-fixed rate was 0 in every cell — and the structure chooser
> held its thin-conservative default. Full results:
> [`grain-chooser-run-report.md`](grain-chooser-run-report.md). The text below is
> kept as the *reasoning record* for why running was first (correctly) deferred —
> the SKIP+SURFACE call and its evidence — not as the current state.
>
> *(Original status: "deferred at the B0 gate, no model spend taken." This was the
> decision-ready surface for the overnight brief's locked "run the grain
> experiment" item. The experiment is sound; the taskset was not ready, so running
> then would have bought a guaranteed null. Below: the verdict + evidence, why
> running anyway was the wrong call, and the concrete remedy so a future run
> executes cleanly.)*

## Verdict: SKIP + SURFACE

The experiment's own **Step 0** (`grain-separability-experiment-design.md`,
lines 63–76) is a make-or-break precondition: *"audit whether the eval taskset
actually spans separability… If the set contains no genuinely entangled tasks,
the experiment cannot test its own hypotheses — both arms will pass everything
and the result is null-by-construction… Do not run a spectrum experiment on a
taskset that has no spectrum."*

That precondition **fails**. The brief pre-registers this exact branch
("B0 broken/precondition-unmet → fix harness-side or skip-and-surface"), and the
B2 conditional pre-registers the consequence ("ambiguous/null → thin
conservative chooser + needs-more-data").

## Evidence

- **Harness is sound and live-runnable.** `experiments/e1/run-matrix.ts --live`
  drives the 2-grain (`fix` = holistic, `build --depth high` = separated) ×
  N-task matrix through isolated worktrees, scoring against hidden objective
  checks. `claude` 2.1.178 is on PATH; the connector spawns the CLI in `-p`
  mode. The zero-spend fixture lane (`run-matrix.ts` without `--live`) renders
  the full extract→compare→report pipeline; the E1 suite is green.
- **The taskset does not span separability.** `evals/fix-vs-vanilla/tasks`
  (44 tasks) is structurally uniform — every task is a single-module fix.
  Co-change spread proxy (distinct `*.mjs` files named in `allowed_changed_files`
  per task): **7 tasks touch 1 file; 34 touch 2 (a src + its sibling test for
  the *same* module); 3 touch 3 (src + 2 tests for one module).** None spans
  multiple interacting modules; none has cross-module coupling, a cross-part
  design decision, or whole-only verifiability. Scored on the design's four
  dimensions, the entire set lands in the **separable band (0–2)**; the
  mixed (3–5) and entangled (6–8) bands are **empty**.
- **Spans with ≥2 per band? NO** (separable: 44; mixed: 0; entangled: 0).

## Why running anyway is the wrong call

The design pre-registers its hypotheses precisely to guard against fitting a
story to noisy data. With no entangled tasks, **both grains pass everything**, so
the primary DV (false-fix rate) is ~0 in every cell — a null that says nothing
about chop/hold. Spending the only authorized envelope ($90–120) to manufacture
that null violates the design's own gate. The honest move is to fix the taskset
first, then run.

## Consequence for B2 (already taken)

The structure chooser ships at its **thin conservative** default (lean-to-whole;
chop only on an explicit operator ask, large surface area, or high risk) and
surfaces "needs more data." The grain verdict gates the chooser's *depth* only —
not whether it exists — so B2 still lands.

---

## Remedy part 1 — the harness gap (cheap, `experiments/` only, no engine)

To run the **standard tier** the design specifies (≥3, prefer 5 repeats per
cell, interleaved run order), the runner needs two small additions. The
aggregation already supports K>1 (`experiments/e1/matrix.ts:144`,
`summariseVariant` means across all cells of a variant), so this is wiring, not a
rebuild:

1. **K-repeat axis.** `run-matrix.ts` has no `--repeats`/`-k`; `matrix-runner.ts`
   runs each task once. Add a repeat loop. Note `buildRow`
   (`matrix.ts:124`) uses `.find()` and would show only the first repeat per
   row — give the per-row display a small tweak or key rows by `(task, repeat)`.
2. **Run-order interleaving** (design control #3). The runner does all variants
   of task A, then task B; interleave cells across repeats so API/time drift
   spreads evenly instead of biasing one grain.

Estimated ~1 hour, all under `experiments/`.

## Remedy part 2 — the entangled + mixed taskset (the real prerequisite)

The set needs **≥2 entangled (6–8)** and **≥2 mixed (3–5)** tasks, each in the
existing `task.json` + `objective/` (hidden-check) shape. Candidate designs,
pre-scored on the four dimensions
(co-change / coupling / cross-part-decision / independent-verifiability → sum):

| # | Candidate task | Shape | CC | Coup | XPart | IndVer | Sum | Band |
|---|---|---|---|---|---|---|---|---|
| E1 | **Token-bucket rate limiter**: `limiter.mjs` checks; `refill.mjs` accrues tokens on a clock. An off-by-one in refill interacts with the limiter's threshold; a correct fix must change both consistently and decide where to clamp. Only the assembled burst-then-sustained behaviour is verifiable. | 2 modules, shared bucket state | 2 | 2 | 2 | 2 | **8** | entangled |
| E2 | **Currency rounding consistency**: `price.mjs` rounds per line; `invoice.mjs` sums lines. The fix must choose round-then-sum vs sum-then-round *coherently across both*, or totals drift by cents. | 2 modules, shared money contract | 2 | 2 | 2 | 2 | **8** | entangled |
| M1 | **Pagination**: `api.mjs` clamps page size; `store.mjs` encodes/decodes the cursor. Some coupling (page size bounds the cursor window) but sub-parts partly verifiable in isolation. | 2 modules, loose coupling | 1 | 1 | 1 | 1 | **4** | mixed |
| M2 | **Retry with backoff**: `backoff.mjs` computes delays; `retry.mjs` runs the loop honouring a shared max-attempts contract. The loop and the delay schedule constrain each other but each is partly checkable alone. | 2 functions, shared max-attempts | 1 | 1 | 1 | 0 | **3** | mixed |

Each needs a hidden objective check that only the *assembled* behaviour passes
(e.g. E1: a burst that must be throttled AND a steady rate that must be
admitted; E2: a multi-line invoice whose total is exact only under the coherent
rounding choice). The a-priori scores must be pre-registered (committed) before
any run, ideally by something blind to outcomes.

## Go/no-go to actually run

Re-run B0 once the set spans separable/mixed/entangled with ≥2 each. Then run the
**standard tier** (6 tasks × 2 grains × 5 repeats ≈ 60 runs, ~$90–120),
**extremes-first** (separable + entangled bands at full repeats; only buy the
mixed band if the extremes diverge), applying the design's pre-committed decision
rule. Until then, B2 stays on its thin conservative default.

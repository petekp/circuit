# grain-separability

An experiment set, not a benchmark. It asks one question: does a flow's
**grain** change how well it fixes a task, and does the answer depend on how
**separable** the task is?

- **Grain** is the independent variable. Holistic grain runs the `fix` flow as
  one pass. Separated grain runs `build --depth high`, the setting that engages
  build's per-slice act-and-verify loop.
- **Separability** is the moderator. Each task carries a pre-registered
  separability score (four 0-2 dimensions: co-change, coupling,
  cross-part decision, independent verifiability). The sum places it in a band:
  separable (0-2), mixed (3-5), entangled (6-8). Higher means more entangled.

The set spans all three bands with at least two tasks each, so the experiment
can read grain's effect at the separable and entangled extremes and check
whether the sign flips in between. That band spread is the B0 precondition and
is enforced by `tests/evals/grain-manifest.test.ts`.

## Bands

| Band | Tasks |
|---|---|
| separable | `heldout-wrap-index`, `heldout-normalize-email` |
| mixed | `heldout-pagination-cursor`, `heldout-retry-backoff` |
| entangled | `heldout-token-bucket`, `heldout-invoice-rounding` |

`heldout-wrap-index` and `heldout-normalize-email` are copied from the
fix-vs-vanilla held-out set to supply the separable band. They keep their ids
and still live in fix-vs-vanilla; the two sets are independent.

## Running it

The grain harness defaults its tasks-root to this set:

```bash
node experiments/e1/run-matrix.ts --live --task heldout-token-bucket --repeats 5
```

The pre-committed decision rule (coherence vs verification, with the crossover
case) lives in `docs/ideas/grain-separability-experiment-design.md`. Apply it to
the run output before changing any flow behavior.

## Not a claim surface

This set is `claim_eligible: false`. Only fix-vs-vanilla held-out tasks back a
product claim. Results here inform the structure chooser; they do not on their
own license a public claim.

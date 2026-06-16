# Grain experiment + structure chooser run report

Date: 2026-06-16. Batch: isolate grain tasks, run the grain experiment, set
the structure chooser on the result, make the chooser's whole-grain path
runnable, and scope (not build) the next durability slice.

## Headline

- **Grain verdict: null on the pre-committed metric.** Across 40 live runs
  (4 tasks, 2 grains, 5 repeats), the false-fixed rate was **0 in every cell**:
  both grains, both bands. The dishonest-completion failure mode that the
  coherence-vs-verification hypotheses are about never occurred. Every miss was
  an honest abort, never a false claim of success.
- **Chooser setting taken: the thin-conservative default, held unchanged.**
  The decision rule routes a null result to "default safe + needs more data."
  The structure resolver still leans to `whole` and chops only on a clear
  signal (operator asks, large surface, or high risk). No chooser code changed.
- **The mixed band was not bought.** The rule only funds it if the extremes
  diverge on the primary metric. They did not (both floored at 0), so more of
  the same spend could not separate the hypotheses. Total spend was about $24,
  well under the $90 to $120 cap.

## What ran

The authorized model spend was the grain experiment only.

| Item | Detail |
|---|---|
| Pathfinder | `heldout-wrap-index`, k=1, both grains. Both passed (holistic $0.89/11 steps, separated $0.81/9 steps). De-risked the harness before the full run. |
| Phase A (extremes) | 4 tasks x 2 grains x 5 repeats = 40 runs. Separable: `heldout-wrap-index`, `heldout-normalize-email`. Entangled: `heldout-token-bucket`, `heldout-invoice-rounding`. |
| Mixed band | `heldout-pagination-cursor`, `heldout-retry-backoff`. Pre-registered, not run (extremes did not diverge). |
| B0 gate | Re-run on the new set before any spend. The set spans separable / mixed / entangled with at least two tasks each. Passed. |

Holistic grain = the `fix` flow (one folded work spine). Separated grain =
`build --depth high` (the full separated spine with analyze, plan, baseline,
touch-area, and review steps).

## Results

Aggregated over both tasks in each band (10 runs per grain per band):

| Band | Grain | Pass | False-fixed | Honest miss | Mean cost | Mean steps |
|---|---|---|---|---|---|---|
| Separable | holistic (`fix`) | 7/10 | 0 | 3 | $0.52 | 8.7 |
| Separable | separated (`build`) | 8/10 | 0 | 2 | $0.45 | 7.4 |
| Entangled | holistic (`fix`) | 8/10 | 0 | 2 | $0.61 | 9.5 |
| Entangled | separated (`build`) | 9/10 | 0 | 1 | $0.68 | 10.4 |

Every non-passing run was an honest abort: the flow did not claim done,
`false_fixed` was false, and the outcome was `aborted`. The harness scored
this correctly. Pass-rate differences are within noise at n=10 (separated is
one run ahead in each band). Cost shows a mild band crossover: separated is
cheaper on separable tasks and slightly pricier on entangled tasks, but that
is not the discriminating axis the experiment was designed around.

## Verdict and decision rule

The pre-committed rule turned on the false-fixed rate:

- **H-coherence** would be supported if the separated grain false-fixed much
  more than holistic in the entangled band while staying roughly equal on the
  separable band. That signal requires false-fixes to exist. None did.
- **H-verification** would be supported if the separated grain false-fixed at
  most as much as holistic across all bands. Again, this needs false-fixes to
  measure. None existed.
- A crossover would record a separability score S as the threshold. There is
  no sign to flip when the metric is flat at zero.

So the result lands on the rule's explicit null branch: **leave the thin
conservative default in place and surface "needs more data."** This is the
correct safe action, not a failure to decide. The honest finding is that these
held-out fix tasks induce honest failure (abort and miss), not dishonest
completion, regardless of grain. They cannot adjudicate the hypotheses because
the metric they hinge on does not fire.

This matches a known pattern: held-out fix tasks have saturated before. What
the experiment needs next is not more repeats of the same tasks but tasks that
actually provoke a flow into a false claim of done. That is the real follow-up.

## The structure chooser (PART 3)

No change. The thin-conservative resolver promoted earlier
(`src/flows/resolvers/structure.ts`) is exactly what a null verdict calls for:
it leans to `whole` and chops to `decomposed` only on an unambiguous signal
(an explicit operator request, a large surface area, or high risk). The null
verdict gives no warrant to make it more aggressive (the verification reading)
or more conservative (it already is). It stays as the default.

Validated through the offline flow lab quality ratchet
(`experiments/resolvers/structure.test.ts`): 8 of 8 green. Both grains
assemble, compile, and score with zero structural deficiencies, and the whole
grain scores no worse than the decomposed grain on structure.

## Isolation outcome (PART 1)

The grain fixtures now live in their own eval set, separate from the
fix-vs-vanilla suite, so the experiment can never contaminate the claim suite.

- New set `evals/grain-separability/` with its own `manifest.json`, `README.md`,
  and a `registry.json` entry (claim level: discovery; claim-eligible: false).
- Six tasks spanning all three bands with at least two each: separable
  (`heldout-wrap-index`, `heldout-normalize-email`), mixed
  (`heldout-pagination-cursor`, `heldout-retry-backoff`), entangled
  (`heldout-token-bucket`, `heldout-invoice-rounding`). A-priori separability
  scores are pre-registered in each task's `task.json`.
- New hygiene test `tests/evals/grain-manifest.test.ts`: disk matches manifest,
  separability scores are valid (each dimension 0 to 2, sum matches the band),
  and the B0 precondition (at least two tasks per band) is asserted.
- The fix-vs-vanilla held-out split was restored to its original 14 tasks.
- The grain harness (`experiments/e1/run-matrix.ts`) takes a `--tasks-root` and
  points at the new set by default.

Shipped as PR #100. CI green.

## Close-writer fold tolerance (PART 4)

The whole-grain fold drops the review and touch-area steps, so a folded
build-derived flow reaches close with neither report. The close reader
previously required both and aborted, so the chooser's whole-grain path could
never actually close. This makes the two reads optional and represents their
absence honestly:

- `review_verdict`, touch-area `enforcement`, and `containment` each gained a
  `not_assessed` superset value. None can satisfy the `complete` gate, so a
  folded flow with passing verification lands at `needs_attention`: the work is
  done, but no independent review or containment proof backs it.
- A biconditional schema check keeps the review link and the verdict in sync.
  Evidence links are four (folded) or five (full), never a faked pointer.
- `unassessedScope` names every plan guardrail as unassessed so the gap reads
  as a gap, not a clean pass.

Build's own full flow always runs both steps, so its inputs resolve to the same
paths and its projection is byte-identical. Build behavior is unchanged. Pinned
by a new runner test that folds build to whole grain and drives it through the
real runner, plus full-flow regression tests.

Reviewed across three dimensions (fabrication-safety, schema/contract,
full-flow regression), all with no blocking findings. One medium finding (an
operator-summary headline for `not_assessed` containment) was adversarially
refuted and independently re-verified: `not_assessed` only arises in folded
flows whose id is never `build`, and the build summary projector dispatches
only for the `build` flow id; folded flows route to the default projector,
which never renders that headline. It is a forward-looking hardening note, not
a live defect. Recorded here so a future change that routes a folded flow
through the build projector knows to map `not_assessed` honestly first.

Shipped as PR #102. CI green.

## Next durability slice, scoped not built (PART 5)

`docs/ideas/durability-tier3-restart-linkage-spec.md` resolves the open
question the cursor spec flagged: in an Option-C world (restart-cheapness, not
forward-recovery) there is no cursor to consume skip-finished, and a fresh
restart gets a new parent id, so it cannot recompute deterministic child ids.

It evaluates three re-entry mechanisms and recommends the explicit prior-run
pointer: `circuit run --reuse-children-from <dead-run-folder>`. That option
addresses prior children by their stable structural address
(step id, attempt, branch id) within the referenced folder, never resumes or
restarts the dead folder, and sidesteps the not-idempotent-relay blocker by
reusing finished results rather than re-running steps. It inherits the
refuse-on-shared-checkout safety rule and a staleness precondition gate.
Reanimation is rejected as the deferred cursor by another name; the
content-addressed store as disproportionate. Not gated on the cursor. Not
built.

Shipped as PR #101 (plus a one-line biome format fix on the catalog entry that
its first CI run caught).

## Integrated vs held

Integrated to main as a single verified batch: PR #100 (grain isolation),
PR #101 (durability spec), PR #102 (close-writer fold tolerance), and this
report. The three were merged onto one integration branch, the full
`npm run verify` was run on the combined state, and the result was pushed to
main.

- PART 3 contributed no code change; the conservative default held, so there
  was no chooser PR.
- The only engine-touching change was the close-writer (PR #102), which was
  adversarially reviewed before integration.
- Held back by design: the mixed-band spend (not needed once the extremes
  showed a null primary metric), and the deep recursion / resolver-shape
  extraction work, which remains the operator's separate ratification item.

The grain run was the only authorized model spend. Final cost about $24,
inside the cap.

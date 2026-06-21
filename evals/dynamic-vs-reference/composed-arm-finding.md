# Composed-arm finding — genuine block-composition, fix family

**Runs:** two, same pinned `claude-haiku-4-5`, fix family, 12 held-out runs each
(4 tasks × 3 reps), opt-in third arm (`--with-composed`), composer default-OFF.

- `2026-06-21T00-47-16-734Z-fix` — first run, engine *before* the fix.
  Verdict `PIPELINE-BROKEN`. Surfaced the verification-reads wall.
- `2026-06-21T03-47-57-792Z-fix` — re-run on the *fixed* engine
  (commit `7b47b60a`). Verdict **`COMPOSITION-VIABLE`**. Pipeline now clean.

## What this arm is

The `composed` arm runs a **genuinely composed** fix flow — assembled block by
block by the composer (frame → gather-context → diagnose → act → run-verification
→ close-with-evidence), not an instantiation of the hand-authored fix family. It
is scored by the **same hidden objective tests** as the `reference` (hand-authored
fix) arm. The point of the run was to ask: does a flow Circuit builds from blocks
do the work as well as the flow a human wired by hand?

## Headline: VIABLE — the composed flow did the work, cleanly, cheaper

On the re-run, a flow Circuit composed from blocks was judged on equal footing
with a hand-authored one — the first time — and it cleared the bar.

| Metric (fix, n=12)        | reference (hand-authored) | composed (block-assembled) |
|---------------------------|---------------------------|----------------------------|
| objective-fixed           | 11 / 12 (0.917)           | **12 / 12 (1.000)**        |
| false-fixed               | 0                         | **0**                      |
| verification pass         | 0.917                     | **1.000**                  |
| pipeline failures         | 0 / 12                    | **0 / 12** (was 12/12)     |
| claim-parse failures      | 0 / 12                    | **0 / 12** (was 12/12)     |
| median cost (USD)         | $0.1931                   | **$0.1624** (~16% cheaper) |
| mean wall-clock           | 125.5 s                   | **101.5 s** (~19% faster)  |
| mean proof quality        | 3.0                       | **0** (see asymmetry)      |
| steps per run             | 13                        | 6                          |

**Run classification: `COMPOSITION-VIABLE`** — "the genuinely composed flow
matches the hand-authored reference within margin on both objective-fixed and
false-fixed rate, with a clean composed pipeline." Predicates:
`quality_fix_within_margin=true`, `honesty_fix_ok=true`, `pipeline_fix_clean=true`.

Every composed task on the re-run: `fixed=true, false-fixed=false, pipeline=ok,
steps=6`. The verify→close tail now completes on all 12 — the run surface reads
"Done: fix-linear-full completed with required process evidence."

## The one honest asymmetry: proof richness (proof_quality 3 vs 0)

The composed arm scores **0** mean proof quality against the reference's **3**.
This is real and worth stating plainly — it is *not* "no evidence."

`circuitProofQuality` grades the **fix family's purpose-built proof bundle**:
`regression_status='proved'` + `regression_rerun_status='cleared'` +
`verification_status='passed'` + `change_set_status='pass'` (all four → 3). The
hand-authored fix family emits that bundle because it includes the auxiliary
regression-baseline, regression-rerun, and change-set proof steps.

The composed 6-block arc is leaner: it closes with the **generic** composed-result
writer (`flow.result@v1`, `outcome='complete'`), which does not populate those
fix-specific fields. So the rubric reads 0 — even though the run parsed cleanly
(claim-parse=0), passed its verification (100%), and left "required process
evidence." The composed flow produces a **generic, thinner proof receipt**, not
the fix family's structured one.

This is the honest counterweight to "cheaper and faster": the composed arc is
cheaper and faster *partly because* it skips the fix family's dedicated proof
steps. It does the core work as well (objectively better here) and closes its
pipeline cleanly, but the receipt it leaves is generic rather than purpose-built.

## Reading the original contradiction (the broken run)

On the first run the objective tests passed 12/12 *and* the pipeline failed
12/12. These were never in conflict. The objective tests are run by the
**harness** against the repo state the flow leaves behind — independent of whether
the flow itself completed. The sequence on every composed task was:

1. The `act` / implementer relay made changes that **objectively fixed the bug**.
2. The `run-verification` step then **aborted** the instant its writer ran, so the
   flow never produced a parseable verification + close report — pipeline failure
   + claim-parse failure on all 12, zero proof quality.

So the composed flow's **work** was always sound; only its **pipeline** could not
complete. The §5 rule correctly refused to score efficacy on a broken pipeline.
The fix below cleared the pipeline; the re-run converted the verdict.

## Root cause: the verification-reads coupling wall

A verification writer sources its command list from an upstream typed report —
`fix.verification` reads `fix.brief@v1`; `build.verification` reads `build.plan@v1`
— a coupling the runtime enforces imperatively inside `loadCommands`. The block's
declared `input_contracts` do **not** capture it: `run-verification` declares the
ambient `verification.plan@v1`, never the brief. The hand-authored fix family wires
the brief in by hand (`fix-verify` input `{ proof, brief: 'fix.brief@v1', change }`).
A genuinely composed arc had no such hand-wiring, so its `run-verification` step
omitted the brief read and aborted the moment the writer ran.

The offline runnability floor missed it because `evaluateRunnability` only resolved
reads for COMPOSE and CLOSE writers — verification writers had no static `reads`
field, so verification steps were silently skipped, not checked.

## The fix (commit 7b47b60a)

1. `VerificationReadDescriptor` + optional `reads?` on `VerificationBuilder`
   (mirrors the close writer's `CloseReadDescriptor`). `loadCommands` is unchanged
   — it stays the runtime source of truth; `reads` is the offline mirror.
2. **Every source-coupled verification writer** declares its required reads — not
   just `fix`/`build` (`fix.brief@v1` / `build.plan@v1`) but also prototype,
   prototype-variant, pursuit, and the auxiliary baseline-snapshot / touch-area /
   regression / change-set writers. A golden coverage test enumerates the whole
   registry (all of which `deriveActualMenu` surfaces as composer-reachable) and
   fails if a writer guards on `step.reads` without declaring it; only genuinely
   source-free writers (explainer, fix baseline-snapshot) are allow-listed. This
   closes the gap class, not just the one writer this run happened to hit.
3. The composer injects each required verification read into the step input under
   its conventional key, or **walls honestly** if no upstream step produces it —
   unlike the terminal close, a verification writer has no reads-agnostic generic
   to rebind to, so an unproduced source cannot be laundered.
4. `evaluateRunnability` now resolves verification reads too, so the offline floor
   would have caught this abort before any spend.

Built-ins stay **byte-identical** (`check-flow-drift` clean): the change is
additive and only the composer/offline-floor paths read the new `reads` field.

The re-run is the live confirmation: the full fix arc (frame → … →
run-verification → close) composed to a fully runnable flow, the verify→close tail
ran on all 12, and the abort did not recur.

## §5 single-family honesty (same branch)

The top-level dynamic-vs-reference verdict (`classifyDynamicVsReference`) is a
both-families rule with null-as-failing — intentional and test-locked. On a
`--family fix` run the absent build family's null aggregates make it return a
spurious `NOT-YET`. `resolveSection5Outcome` sits **outside** the locked rule and
reports `INCONCLUSIVE (fix only)` honestly, preserving the raw classification for
transparency. The ledger verdict descriptor now prefers this honest outcome — the
re-run's ledger reads `INCONCLUSIVE — single-family run (fix only)`, and the
COMPOSITION-VIABLE verdict comes from the sibling composed rule, which is
single-family-aware.

## Outcome

`PIPELINE-BROKEN` → **`COMPOSITION-VIABLE`**. The first head-to-head between a
flow Circuit composed from blocks and a hand-authored one, on external-truth
hidden tests, is now a real efficacy verdict: the composed flow did the work on
more tasks than the reference, with no false-fixes, cheaper and faster, with a
clean pipeline. The single honest gap is proof richness — the composed arc leaves
a generic receipt, not the fix family's purpose-built proof bundle. Closing that
gap (composing the auxiliary proof steps, or teaching the generic close to carry
family proof fields) is the natural next frontier, not a blocker on viability.

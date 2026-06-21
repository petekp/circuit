# Composed-arm finding — genuine block-composition, fix family

**Run:** `2026-06-21T00-47-16-734Z-fix` · pinned `claude-haiku-4-5` · fix family,
12 held-out tasks · opt-in third arm (`--with-composed`) · composer default-OFF.

## What this arm is

The `composed` arm runs a **genuinely composed** fix flow — assembled block by
block by the composer (frame → gather-context → diagnose → act → run-verification
→ close-with-evidence), not an instantiation of the hand-authored fix family. It
is scored by the **same hidden objective tests** as the `reference` (hand-authored
fix) arm. The point of the run was to ask: does a flow Circuit builds from blocks
do the work as well as the flow a human wired by hand?

## Headline: the work is real and cheaper, but the pipeline broke on every run

| Metric (fix, n=12)        | reference (hand-authored) | composed (block-assembled) |
|---------------------------|---------------------------|----------------------------|
| objective-fixed           | 11 / 12 (0.917)           | **12 / 12 (1.000)**        |
| false-fixed               | 0                         | **0**                      |
| median cost (USD)         | $0.190                    | **$0.156** (~18% cheaper)  |
| mean wall-clock           | 134.3 s                   | **94.7 s**                 |
| pipeline failures         | 1 / 12                    | **12 / 12**                |
| claim-parse failures      | 1 / 12                    | **12 / 12**                |
| mean proof quality        | 2.75                      | **0**                      |

**Run classification: `PIPELINE-BROKEN`** — "Composed arm had pipeline failures on
fix … efficacy cannot be judged."

## Reading the contradiction (12/12 fixed AND 12/12 pipeline-broken)

These are not in conflict. The objective tests are run by the **harness** against
the repo state the flow leaves behind — they are independent of whether the flow
itself completed. The sequence on every composed task was:

1. The `act` / implementer relay made changes that **objectively fixed the bug**
   (12/12 on the hidden tests, 0 false-fixed) — cheaper and faster than reference.
2. The `run-verification` step then **aborted** the instant its writer ran, so the
   flow never produced a parseable verification + close report. That surfaces as a
   pipeline failure + claim-parse failure on all 12, and zero proof quality.

So the composed flow's **work** is sound (and cheaper); its **pipeline** could not
complete. The §5 rule correctly refuses to score efficacy on a broken pipeline.

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

## The fix (this branch)

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

Offline confirmation (no spend): the full fix arc (frame → … → run-verification →
close) now composes to a **fully runnable** flow — `run-verification` reads its
brief source, `loadCommands` clears its guard, and there is no downstream close
wall. The live abort would not recur.

## §5 single-family honesty (same branch)

The top-level dynamic-vs-reference verdict (`classifyDynamicVsReference`) is a
both-families rule with null-as-failing — intentional and test-locked. On a
`--family fix` run the absent build family's null aggregates make it return a
spurious `NOT-YET`. `resolveSection5Outcome` sits **outside** the locked rule and
reports `INCONCLUSIVE (fix only)` honestly, preserving the raw classification for
transparency. The ledger verdict descriptor now prefers this honest outcome.

## Recommendation

The composed arm's signal is strong: it did the work, on more tasks than the
reference, with no false-fixes, cheaper and faster. The only thing standing
between this run and a real head-to-head **efficacy** verdict was the pipeline
wall, which is now fixed. A small fix-only re-run (~$20, same pinned model) would
convert `PIPELINE-BROKEN` into an actual efficacy verdict with parseable proofs —
the first time a flow Circuit composed from blocks is judged on equal footing with
a hand-authored one. That re-run is gated on explicit sign-off before spend.

# Follow-up — where the dynamic direction goes after WORTH-INVESTING

> Status: **current idea.** Written 2026-06-19 off the
> [`dynamic-vs-reference-run-report.md`](dynamic-vs-reference-run-report.md)
> verdict (**WORTH-INVESTING**). This is a direction note, not a spec. It proposes
> the next experiment that follows from the result, and is explicit about the two
> rails it must not cross.

## What the result actually licensed

The live experiment proved one thing on two clean families: a flow **instantiated**
from a plain-English task (`circuit create` picks a family and stamps out a proven
seed) runs **as well as** the hand-authored reference — same honesty (0% false-fixed
across all 48 runs), within-margin quality, and on `build` a real cost saving from
the grain fold (about a third of the cost on small/low tasks at equal quality).

It did **not** prove that the generator can build a *novel* flow, and it did not
prove the instantiation path holds beyond `fix` and `build`. Those are the two open
questions, and they point in different directions.

## The fork

There are two honest next steps, and they are not the same investment:

1. **Breadth of instantiation** — does the *instantiation* path (the thing we just
   validated) hold on the families we did not test: `research`, `prototype`,
   `explain`/editorial? This is a measurement, not a build. It reuses everything
   that exists today.
2. **Genuine block-composition** — can the generator assemble a *novel* flow from
   the block catalog, rather than instantiate a registered seed? This is the parked
   RESEARCH PROBLEM. The flow-composition run
   ([`flow-composition-run-report.md`](flow-composition-run-report.md)) already
   measured it as INTRACTABLE-as-built: the runtime compose/close writers are
   coupled to their origin family's exact contract schemas, so cross-family
   composed wiring is rejected. That is a real engineering frontier behind a flag,
   not a quick experiment.

**Recommendation: do breadth first.** It is cheap, it is a pure measurement on the
existing generator, and it tells us whether the WORTH-INVESTING result is a
two-family fluke or a general property of the instantiation path. Genuine
composition is the bigger prize but it is gated on a writer-contract redesign that
the composition report already scoped; it should not be started on the strength of
a two-family result.

## The concrete next experiment (breadth, measurement-only)

Mirror this experiment's structure exactly, widened by family:

- **Same two arms** (reference = hand-authored built-in; generated = `circuit
  create` instantiation, default mode only), **same pinned model**, **same
  fix-vs-vanilla scoring + committed cost instrument**, **same N=3**.
- **New held-out task set** covering the untested families. Each task needs a
  runnable, externally-checkable definition of done — the honest constraint that
  `fix`/`build` satisfy with a `package.json` test script. This is the hard part
  for `research`/`explain`: their output is a document, not a passing test, so the
  objective check has to be a real artifact assertion (named sections present,
  claims cited, links resolve), not a self-report. **If a family has no honest
  external check, it does not enter the breadth set** — measuring quality by the
  flow's own verdict would re-introduce exactly the laundering this program exists
  to catch.
- **A locked decision rule before data**, in the §5 spirit: per family, generated
  quality within 10pp of reference and no honesty regression, or the family is the
  named gap.
- **Land it as a sibling eval** (`evals/dynamic-vs-reference-breadth/` or a `--set`
  on the existing harness), not by editing the generator.

The expected output is a per-family WORTH-INVESTING / MIXED / NOT-YET, which tells
us where instantiation generalizes and where it does not — before any composition
investment.

## Rails this follow-up must not cross

- **No new flow shapes, no assembler/resolver edits.** Breadth *measures* the
  current generator on more families. If a family fails, that is a finding, not a
  mid-experiment fix. (This is the same rail the run honored.)
- **Do not touch the genuine-block-composition arm** to make breadth look better.
  Composition is its own ratification-gated track; the breadth experiment is the
  instantiation path only.
- **Held-out hygiene.** A breadth task set is claim-eligible only while held out;
  do not fold it back into assembler tuning without retiring it.

## Smaller, cheaper follow-ups worth a line

- **A fix-family cost look.** The generated fix arm ran ~3% dearer than the
  reference at the median (within noise). It is not a problem, but if breadth
  confirms instantiation generalizes, it is worth checking whether the
  generation-pipeline overhead (compile + publish + custom-slug resolution) is a
  fixed per-run tax worth trimming.
- **A `build` grain-boundary probe.** `build-feature-flag` (nominally "medium")
  folded to **whole** here. The grain chooser's medium-band behavior is the least
  pinned-down part of the result; a small offline study of where the
  whole/decomposed boundary actually falls would sharpen the chooser without any
  live spend.

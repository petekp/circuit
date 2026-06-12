# Verdict-Correctness Eval

Status: Review regression eval.

This eval asks whether a reviewer catches known defects planted into prior
Explore review inputs. It is internal only. It is not claim-grade today because
it has no frozen held-out policy or public claim gate.

## What It Measures

For each saved Explore review request, the runner mutates the compose JSON to
plant one known defect, sends the prompt through a reviewer, and checks whether
the reviewer surfaces the defect.

Defects come in two suites.

**Standard suite** (blunt, near-ceiling — a sanity floor):

- fabricated evidence references,
- weak success-condition alignment,
- wrong subject,
- false certainty,
- internal contradiction.

**Subtle suite** (plausible-looking, leaves real headroom — the tracked
regression baseline):

- plausible missing evidence reference (a believable sibling path the run
  never produced, instead of an obviously fake one),
- generic success-condition alignment (specific-sounding boilerplate that
  could apply to almost any brief, instead of a near-empty strip),
- soft false certainty (a mild, hedge-free readiness claim, instead of a
  blunt "no remaining risks" assertion).

The subtle suite scored ~89% in the May 2026 runs versus the standard suite's
97-100%. That headroom is what makes it the tracked baseline: track the subtle
catch rate and protocol-failure rate across releases, and keep the standard
suite only as a floor. Treat the subtle planters as **frozen** — a regression
baseline is only meaningful if it stays stable, so do not edit the planted
wording casually.

Select a suite with `--suite standard|subtle|all` (default `standard`), or
override the exact set with `--defects <id,id,...>` (recorded as suite
`custom`). The chosen suite is written into `summary.json`.

## Run

Build first because the runner imports compiled connector code:

```bash
npm run build
```

Then run a dry plan or a small live slice:

```bash
node --experimental-strip-types evals/verdict-correctness/index.ts \
  --suite subtle --max-composes 3 --dry-run

node --experimental-strip-types evals/verdict-correctness/index.ts \
  --max-composes 3 --defects fabricated-evidence-ref --no-control
```

Full runs and cross-judge runs are explicit because they invoke live models.
The tracked baseline pins the judge model and runs the subtle suite:

```bash
node --experimental-strip-types evals/verdict-correctness/index.ts
node --experimental-strip-types evals/verdict-correctness/index.ts --judge claude-code
node --experimental-strip-types evals/verdict-correctness/index.ts \
  --judge claude-code --model claude-haiku-4-5-20251001 --suite subtle
```

Outputs land in `evals/verdict-correctness/results/<timestamp>-<judge>[-<model>]/`.
The model suffix is present whenever `--model` is passed.

## Reading Results

Treat catch rate as a regression signal, not a broad quality claim. Small source
pools can saturate quickly, and string-match scoring can miss unusual reviewer
phrasing. Audit misses by hand before changing prompts or scoring.

### Two rates, two denominators

The summary reports two distinct rates. They answer different questions, so
read them together.

- **Catch rate** = `catches / (catches + misses)`. The denominator is *scored*
  cases only: the judge produced a valid verdict and we could check it against
  the planted defect. Cases that errored out never reach this denominator, so
  catch rate alone *flatters* a judge that fails to answer.
- **Protocol-failure rate** = `errors / attempted`. `attempted` is every case
  where the judge was actually invoked (total cases minus harness skips). An
  error is any attempted case that produced no valid verdict: a connector or
  timeout failure, unparseable output, or schema-invalid JSON (the
  `error_kinds` breakdown distinguishes them). This is exactly the failure
  class the production schema gate converts into retries, and at cheap judge
  tiers it is the signal that separates models when catch rate has saturated.

A **harness skip** (a planter that could not apply because its target field
was absent) is neither an attempt nor an error — the judge was never called.
Harness skips are reported separately and excluded from both denominators so
they cannot distort either rate.

### The control arm

Unless you pass `--no-control`, each source compose is also sent through the
reviewer **unmutated**. That control measures the reviewer's false-positive
rate: how often it objects to a compose with no planted defect.

The summary reports the control verdict distribution, not a single
pass/fail count:

```
controls: { cases, accept, accept_with_fold_ins, reject, errors }
```

Only `accept` is a clean pass. `accept-with-fold-ins` and `reject` are the
reviewer objecting to an unmutated compose — the false-positive signal. The
**control false-positive rate** is `(accept_with_fold_ins + reject) / scored`,
where `scored` excludes controls that errored out (no valid verdict). An
earlier `{passes, fails}` shape collapsed every valid verdict into `passes`,
so rejects on clean composes were invisible; that is why this distribution is
now reported in full and tracked in the committed ledger
(`control_accept`, `control_accept_with_fold_ins`, `control_reject`,
`control_errors`).

A reject is only a *true* false positive if the compose was actually clean.
To certify that half, run:

```bash
node --experimental-strip-types evals/verdict-correctness/certify-controls.ts \
  --results evals/verdict-correctness/results/<dir>
```

It pulls each control compose's `evidence_refs`, classifies them (repo-file,
run-report, or unverifiable), resolves the file-path ones against the repo and
the source run dir, and pairs the result with the reviewer's verdict. It writes
`control-certification.json` into the results dir and prints a per-control
table. The point is to separate "the reviewer over-flagged a fully grounded
compose" (genuine false positive) from "the reviewer objected to a compose with
an unresolved citation" (inspect by hand).

One honest limit, enforced by the module's design: resolution is against the
**current** repo, not the repo as it stood when the source run produced the
compose. An unresolved file-path ref is often a since-moved or since-pruned
file, **not** a fabrication — so the certification reports it as `unresolved`,
never as `broken`, and excludes non-path citations (git refs, shell commands,
directory-listing prose) from the grounded/broken tally entirely.

The first certification of the tracked claude-code runs is written up in
[`docs/evals/2026-06-12-control-certification.md`](../../docs/evals/2026-06-12-control-certification.md).

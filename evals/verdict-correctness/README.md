# Verdict-Correctness Eval

Status: Review regression eval.

This eval asks whether a reviewer catches known defects planted into prior
Explore review inputs. It is internal only. It is not claim-grade today because
it has no frozen held-out policy or public claim gate.

## What It Measures

For each saved Explore review request, the runner mutates the compose JSON to
plant one known defect, sends the prompt through a reviewer, and checks whether
the reviewer surfaces the defect.

Current defect families:

- fabricated evidence references,
- weak success-condition alignment,
- wrong subject,
- false certainty,
- internal contradiction.

## Run

Build first because the runner imports compiled connector code:

```bash
npm run build
```

Then run a dry plan or a small live slice:

```bash
node --experimental-strip-types evals/verdict-correctness/index.ts \
  --max-composes 3 --dry-run

node --experimental-strip-types evals/verdict-correctness/index.ts \
  --max-composes 3 --defects fabricated-evidence-ref --no-control
```

Full runs and cross-judge runs are explicit because they invoke live models:

```bash
node --experimental-strip-types evals/verdict-correctness/index.ts
node --experimental-strip-types evals/verdict-correctness/index.ts --judge claude-code
```

Outputs land in `evals/verdict-correctness/results/<timestamp>-<judge>/`.

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

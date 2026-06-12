# Control certification — verdict-correctness, 2026-06-12

First certification of the **control arm** of the verdict-correctness eval.
The control arm sends each historical Explore compose through the reviewer
**unmutated**; its verdict distribution is the reviewer's false-positive
profile. This note records what that arm was actually doing, why the summary
hid it, and how grounded the apparent false positives are.

## TL;DR

- The committed summaries and ledger entries reported the control arm as
  **clean**: `control_passes = 9, control_fails = 0` on every run.
- That was an artifact of the old `{passes, fails}` shape, which counted every
  valid verdict — including `reject` — as a "pass". The real verdict
  distribution was never zero-failure.
- Recovered from `results.json`: the reviewer objected to a no-defect compose
  **56% of the time on Haiku and 71% on Sonnet** (`accept-with-fold-ins` +
  `reject`, over controls that returned a valid verdict).
- Groundedness certification: most of those objections land on composes whose
  every file-path citation resolves (3/5 on Haiku, 4/5 on Sonnet) — genuine
  reviewer over-flagging, not the reviewer catching a broken reference.
- Every unresolved citation is a **since-moved or since-pruned** repo file, not
  a fabrication. The audit reports them as `unresolved`, never `broken`.

## The runs

| Run | Judge model | Suite | Controls |
| --- | --- | --- | --- |
| `2026-06-12T03-59-29Z` | claude-haiku-4-5-20251001 | subtle | 9 |
| `2026-06-12T04-44-05Z` | claude-sonnet-4-6 | subtle | 9 |

Both are the de-saturated subtle-suite runs from the prompt-improvements
worktree (the results dirs are local and gitignored). The certification was
produced with:

```bash
node --experimental-strip-types evals/verdict-correctness/certify-controls.ts \
  --results <results-dir> --repo-root <worktree> --runs-root <worktree>/.circuit/runs
```

## What the summary hid

The old `summary.controls` shape was `{ passes, fails, errors, cases }`, and the
ledger recorded `control_passes` / `control_fails`. On these two runs that gave:

| Run | summary.controls (old shape) | Ledger metrics (old keys) |
| --- | --- | --- |
| Haiku | `passes 9, fails 0, errors 0` | `control_passes 9, control_fails 0` |
| Sonnet | `passes 7, fails 0, errors 2` | `control_passes 7, control_fails 0` |

Read literally, that says the reviewer never objected to a clean compose. But
`fails` was dead — nothing ever incremented it — so a `reject` on an unmutated
compose was silently counted as a `pass`. The control arm's whole reason to
exist (measuring false positives) was invisible in the headline.

## The real distribution

Recovered by bucketing each control's actual `verdict.verdict` from
`results.json`:

| Reviewer verdict | Haiku | Sonnet |
| --- | --- | --- |
| accept (clean) | 4 | 2 |
| accept-with-fold-ins (soft objection) | 3 | 2 |
| reject (hard objection) | 2 | 3 |
| (errored — no valid verdict) | 0 | 2 |
| **control false-positive rate** | **56%** (5/9) | **71%** (5/7) |

`accept` is the only clean outcome. `accept-with-fold-ins` and `reject` are the
reviewer objecting to a compose with no planted defect — the false-positive
signal. The rate denominator excludes the controls that errored out, since a
control that never produced a verdict carries no signal either way.

## Groundedness certification

A `reject` is only a *true* false positive if the compose was actually clean.
`certify-controls.ts` checks that half: it pulls each control compose's
`evidence_refs`, classifies them (repo-file / run-report / unverifiable), and
resolves the file-path ones against the repo and the source run dir.

### Haiku — 5 apparent false positives, 3 on fully grounded composes

| Source run | Verdict | Grounded | Unresolved file-path refs |
| --- | --- | --- | --- |
| `045be6d0` | accept | yes | — |
| `0dc32a58` | accept | yes | — |
| `378c69c2` | accept-with-fold-ins | no | `src/history/run-start-recall.ts`, `src/history/query.ts`, `src/history/memory-preview.ts`, `src/shared/relay-support.ts` |
| `38723b57` | accept | yes | — |
| `5ad506e5` | reject | yes | — |
| `5e3a8ea5` | accept | no | `docs/specs/explore-intent-v1.md` |
| `a326cd60` | reject | no | `src/history/run-start-recall.ts`, `src/history/query.ts` |
| `a6a26152` | accept-with-fold-ins | yes | — |
| `fefa9957` | accept-with-fold-ins | yes | — |

### Sonnet — 5 apparent false positives, 4 on fully grounded composes

| Source run | Verdict | Grounded | Unresolved file-path refs |
| --- | --- | --- | --- |
| `045be6d0` | accept-with-fold-ins | yes | — |
| `0dc32a58` | reject | yes | — |
| `378c69c2` | errored | no | (same `src/history/*` + `relay-support.ts`) |
| `38723b57` | accept | yes | — |
| `5ad506e5` | accept-with-fold-ins | yes | — |
| `5e3a8ea5` | reject | no | `docs/specs/explore-intent-v1.md` |
| `a326cd60` | accept | no | `src/history/run-start-recall.ts`, `src/history/query.ts` |
| `a6a26152` | errored | yes | — |
| `fefa9957` | reject | yes | — |

The headline: on both judges, the **majority of apparent false positives land
on composes whose every file-path citation resolves**. The reviewer is objecting
to clean, well-grounded composes — that is real over-flagging, not the reviewer
correctly noticing a broken citation.

## The staleness caveat is real, and evidenced

Resolution is against the **current** repo, not the repo as it stood when each
source run produced its compose. Every unresolved path above is a file that
genuinely existed at run time and has since moved or been pruned — confirmed in
git history:

- `src/history/{query,run-start-recall,memory-preview}.ts` → relocated to
  `src/app/history/` (commit `1245b4cc`, "gather … under src/app
  application-services tier").
- `src/shared/relay-support.ts` → `src/runtime/run/relay-support.ts`.
- `docs/specs/explore-intent-v1.md` → pruned (commit `1a8d0a22`, "Prune stale
  documentation surfaces").

So zero of the unresolved citations are fabrications. The audit reflects this:
it reports `unresolved`, never `broken`, and excludes non-path citations (git
refs, shell commands, directory-listing prose) from the grounded/broken tally
entirely. An unresolved ref is a "inspect by hand" flag, not a verdict.

## What this PR changes

- `summary.controls` now carries the full verdict distribution
  (`accept` / `accept_with_fold_ins` / `reject` / `errors`), and `report.md`
  renders it with a false-positive rate.
- The ledger records `control_accept`, `control_accept_with_fold_ins`,
  `control_reject`, `control_errors` (replacing the dead
  `control_passes` / `control_fails` pair). Metrics is an open record under
  schema v1, so this is additive within the existing ledger version.
- `certify-controls.ts` + `control-groundedness.ts` (pure, unit-tested) provide
  the groundedness half on demand.

Historical ledger entries are left as-is — they are an audit trail of what the
harness recorded at the time, and this note is the correction of record.

## Recommendation

- Track the **control false-positive rate** alongside catch rate as a release
  signal. A reviewer that catches more planted defects by objecting to
  everything is not improving; the control arm is what keeps catch rate honest.
- The over-flagging measured here is a prompt-calibration signal. The
  reviewer-severity calibration added to the review flow in the sibling PR is
  the lever; this certification is the measurement that lever needs.
- Re-run the certification after any reviewer-prompt change and compare the
  grounded-false-positive count, not just the verdict counts.

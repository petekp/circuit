# Orient-step evidence log

## Harness (task 1, done)

Leak-free time split. Cutoff T = 2026-06-15 (984 commits before, 431 after).
Universe = 359 `src/*.ts` files existing at T. All predictors computed from
history strictly BEFORE T; answer key = files touched by fix-shaped commits
strictly AFTER T. Rename noise measured and negligible (351 of 359 survive to
HEAD). Two answer keys (strict = conventional `fix:` prefix, broad = strict +
prose fix verbs minus docs/test/refactor) to check robustness.

Base rate: 28% of files (broad) / 21% (strict) get a fix in the test window.

## The metric change that matters

Scoring by precision@20 is WRONG for Circuit. Our constraint is a reading
budget in characters (60k per reviewer unit), not a file count. The right
metric is effort-aware: **share of genuinely defective files reached after
reading N bytes, best-first.**

## Spike A result (task 5) — cheap computed rankers

Answer key BROAD. rec@B = recall at that byte budget.

| strategy | prec@20 | rec@200KB | rec@600KB | rec@1400KB |
|---|---|---|---|---|
| **churn density (commits/KB)** | 10% | **24%** | **45%** | **70%** |
| priorfix density | 40% | 16% | 31% | 47% |
| random (200-seed avg) | 30% | 8% | 24% | 57% |
| arbitrary (alphabetical) | 15% | 2% | 23% | 65% |
| prior fixes | 60% | 12% | 20% | 47% |
| churn | 60% | 4% | 19% | 52% |
| hotspot (churn x size) | 70% | 4% | 14% | 35% |
| **size (the old "winner")** | 60% | 3% | 11% | **29%** |

Holds on the strict key too: churn density #1 (11/38/65%), size last (4/15/38%).

### Three findings

1. **precision@20 and effort-aware recall ANTI-CORRELATE.** The strategies that
   top prec@20 (hotspot 70%, size 60%, churn 60%) are the WORST per byte read.
   Big files win prec@20 by surface area alone — they contain a fix because
   they contain everything. My earlier "size wins" call was an artifact of
   counting files instead of counting bytes.

2. **Size is the single worst strategy under the real constraint.** 29% vs
   churn density's 70% at the same budget. Reading the biggest files first is
   actively worse than reading in alphabetical order (65%).

3. **Discrimination lives at SMALL budgets.** At 1.4MB (55% of the code)
   everything converges toward 50-70%. At 200KB (8% of code, ~3 reviewer
   units — where Circuit actually operates) churn density gets 24% against
   arbitrary order's 2%. That is a 12x lift, and it IS the premise Pete asked
   to test — but proven for a computed signal, not for model theorizing.

## CORRECTION — the churn-density win was mostly an artifact

Three confounds found and removed, in order. Each changed the answer, so the
raw Spike A table above should NOT be quoted without this section.

**Confound 1: barrel files.** Churn density's top picks were re-export barrels
(`src/index.ts`, `flows/*/flow.ts`) — touched by every fix that renames
anything, never containing the defect. 17 detected (>70% import/export/comment
lines) and removed. The win survived this (24% vs random 9%).

**Confound 2: edit-size strictness.** Requiring the fix to change more lines in
the file decays the advantage to nothing: 2.7x lift at any-touch, 2.1x at >=3
lines, **1.1x at >=10 lines**. But >=10 lines is also a bad key — it discards
one-line fixes, the most classic real bug.

**Confound 3 (fatal): it predicts ACTIVITY, not defects.** Scored against a key
of "any commit touched this file after T", churn density gets 24/44/69% — versus
24/45/71% against the fix key. Identical. It cannot tell a file that will be
fixed from a file that will merely be edited. It is an activity predictor.

## The clean experiment: control activity out

Universe restricted to the 177 files touched at all after T; key = the 99 of
those that got a fix. Base rate 56%. Now any lift is defect-SPECIFIC.

| strategy | prec@20 | rec@200KB |
|---|---|---|
| **prior fixes** | **90%** | 12% |
| priorfix density | 85% | 19% |
| churn density | 60% | 27% |
| random | 59% | 12% |
| arbitrary | 60% | 4% |
| size | 65% | 3% |

**Only prior fix history shows real defect-specific power** (90% vs 59% base).
That replicates the single most robust result in the defect-prediction
literature: past defects predict future defects. Churn density collapses to
the base rate (60% vs 59%) — confirming its earlier win was cheap reading of
small files, not bug-finding.

**The tension that shapes the design:** prior-fix files are the most likely to
be buggy but are large and expensive to read (12% recall per byte). Churn
density covers the most ground per byte but carries no defect signal. Neither
alone is the orient step.

## Spike B (task 6) — model orient strategies, same harness, 200KB budget

Universe 342 barrel-free files, 99 defective, base rate 29%. Each condition
picks a SET of files to read within 200,000 bytes.

| condition | files | recall | precision | vs base rate |
|---|---|---|---|---|
| churn-density ranker (no model) | 82 | **24%** | 29% | **1.0x — none** |
| grounded model (paths+size+churn+prior fixes) | 46 | 20% | **43%** | 1.5x |
| contest the ranker | 28 | 13% | **46%** | **1.6x** |
| blind model (paths+size) | 34 | 13% | 38% | 1.3x |
| random / alphabetical / size | — | 9% / 2% / 3% | ~29% | 1.0x |

### The finding

**Cheap signals buy coverage. The model buys discrimination. Neither buys both.**

The churn ranker's precision is 29% against a 29% base rate — *exactly* the
base rate. It has literally zero ability to tell a defective file from any
other. Its recall win is entirely a budget trick: it reads 82 cheap files
instead of 28 expensive ones. That is worth having, but it is not insight, and
Review must not describe it as "where risk lives."

Every model condition beats the base rate on precision (1.3x-1.6x). That is
real defect-specific signal, and it is the thing no computed metric produced.

**Contesting the ranker did NOT improve it on coverage** (24% -> 13% recall).
The model dropped 54 of 82 files with articulate, plausible reasoning and cut
recall in half. But it raised precision 29% -> 46%. It did not fail; it traded
along an axis nobody told it about.

**Best single condition is the grounded model**: 20% recall at 43% precision.
It dominates the contest condition (same precision, better coverage).

### Mechanism worth carrying into the design

The contest model FILTERED (82 files -> 28) when the literature's winning
configuration RE-RANKS (keeps the set, changes the order). FlexFL's +81.4%
came from an LLM re-ranking a cheap candidate list, not pruning it. Our
contest prompt invited pruning and got pruning. That is a prompt defect on my
side, not a finding about models, and it is the obvious next spike.

## Spike C (task 10) — re-rank instead of filter

Gave the model a 140-file candidate pool (top churn density, ~2.8x the budget)
and told it to REORDER all 140 without dropping any, explicitly warning that
early placement spends budget in bytes. The budget then walked its order.

Result: **recall 15%, precision 41%** (37 files). Better coverage than the
contest condition (13%), still far below the cheap ranker (24%).

### The robust pattern, across four independent framings

| condition | recall | precision | vs base rate (29%) |
|---|---|---|---|
| churn ranker (no model) | **24%** | 29% | 1.0x |
| grounded model | 20% | 43% | 1.5x |
| re-rank (Spike C) | 15% | 41% | 1.4x |
| contest | 13% | 46% | 1.6x |
| blind | 13% | 38% | 1.3x |

**Every model condition lands at 38-46% precision and 13-20% recall. The cheap
ranker gets 24% recall at exactly the base rate.** Four different prompts, same
shape. This is not a prompt artifact — it is what models do here.

**Why the model loses coverage even when told not to:** it reasons about which
file is *most likely to be buggy* (a precision instinct) when the objective was
*how many buggy files fit in the budget* (a coverage objective). Spike C stated
the byte rule explicitly and the model still front-loaded 30-50KB files
(graph-runner, relay, handoff, circuit.ts). It systematically undervalues cheap
breadth. Worth knowing: you cannot prompt this away.

## Convergence with the literature (research stream 3)

Our results and the published work agree, from two independent directions:

- **LLM4FL RQ3: a 22% Top-1 swing from input ordering alone**, same agent, same
  candidates. The model's "judgment about where to look" is substantially
  inherited from the ranker priming it. Matches our blind-vs-grounded gap
  exactly.
- **FlexFL: LLM as re-ranker over a cheap list is the highest-leverage config
  found anywhere** (+81.4% Top-1 over Ochiai alone). That is our "grounded"
  condition, and it is the best one we measured too.
- **Agentless: prompting + embedding retrieval combined (81.67%) beats either
  alone** (78.67% / 70.33%). Same shape: cheap signal plus model, not either.
- **False positives are the binding constraint, not recall.** Best honest
  industrial number: 75% false-alarm rate after a validator that cost a third
  of recall (Meituan, arXiv:2505.17928). 56% of agentic review comments are
  rejected by developers (arXiv:2607.03316). This says our precision axis
  matters MORE than the recall axis, which reframes the whole Spike B table.
- **More context degrades localization.** SWE-bench: retrieval recall 29->51%
  while resolve rate FALLS 1.96->1.22%. Supports small reviewer units.
- **Debate does not work; voting does. Diversify model family, not persona.**
- **Past defects predict future defects** — the field's most robust result, and
  the only signal that showed defect-specific power in our data too.

## Spike D (task 11) — the baselines the literature named, and the frontier

The defect-prediction research named two untrained baselines I had NOT run:
**ManualUp** (rank by size ASCENDING) and **ManualDown** (descending). ManualUp
is the published baseline that beats trained models under effort-aware scoring
(Zhou TOSEM 2018; Yang FSE 2016, where it doubled recall on Mozilla). I had only
run ManualDown. Also added Google's **TWR** (time-weighted risk: bug-fix commits
with logistic decay, sum 1/(1+e^(-12t+w)), t normalized over repo history).

Same harness: 342 barrel-free files, 99 defective, base rate 29%, 200KB budget.

| strategy | recall | prec | files | lift |
|---|---|---|---|---|
| **ManualUp (SMALLEST first)** | **26%** | 21% | 123 | **0.73x** |
| churn density (previous best) | 24% | 30% | 80 | 1.04x |
| priorfix density | 16% | 43% | 37 | 1.49x |
| prior fixes (count) | 12% | **67%** | 18 | **2.30x** |
| TWR w=12 density | 9% | 38% | 24 | 1.30x |
| random | 9% | 33% | 26 | 1.14x |
| TWR w=6 | 6% | 75% | 8 | 2.59x |
| TWR w=12 (Google) | 5% | 71% | 7 | 2.47x |
| ManualDown (biggest) | 3% | 75% | 4 | 2.59x |
| arbitrary | 2% | 13% | 16 | 0.43x |

### This corrects two claims in Spike B

**1. "No computed metric produced defect-specific signal" is FALSE.** I had only
tested size-normalized variants at the top of the ranking. Prior fix COUNT with
no size normalization gets 67% precision, a **2.30x lift** — well above every
model condition (1.3x-1.6x). TWR is higher still (2.47-2.59x) but reads only 7-8
files. The literature's most robust finding held here and I under-tested it.

**2. Recall-at-budget alone is a GAMEABLE objective.** ManualUp wins recall (26%)
with precision **below the base rate** (0.73x) — small files are genuinely LESS
likely to be defective, and it still wins by reading 123 of them. A strategy with
negative discrimination tops the metric I used to crown churn density. Any
objective Review optimizes must be a (recall, precision) pair, never recall alone.

### The frontier: one dial traverses the whole tradeoff

Score = (TWR + prior fixes)^a / size^b, sweeping a and b. The Pareto frontier:

| a | b | recall | prec | files | lift |
|---|---|---|---|---|---|
| 1.0 | 0.0 | 11% | **69%** | 16 | 2.38x |
| 0.7 | 0.3 | 13% | 59% | 22 | 2.04x |
| 0.5 | 0.5 | 17% | 46% | 37 | 1.59x |
| 0.5 | 0.7 | 19% | 42% | 45 | 1.46x |
| 0.3 | 0.7 | 24% | 32% | 76 | 1.09x |
| 0.1 | 0.7 | 30% | 26% | 116 | 0.89x |

**b is the product dial.** It is how hard you divide by file size, and it walks
monotonically from "few expensive high-yield files" to "many cheap low-yield
files." Precision and coverage are not two competing designs; they are two ends
of one parameter we can set.

### Model conditions vs the frontier

| condition | recall | prec | verdict |
|---|---|---|---|
| grounded | 20% | 43% | **above** — but only just (frontier: 19%/42%) |
| re-rank | 15% | 41% | **dominated** by a=0.1 b=0.1 (17%/46%) |
| contest | 13% | 46% | **dominated** by a=0.7 b=0.3 (13%/59%) |
| blind | 13% | 38% | **dominated** by a=0.7 b=0.3 (13%/59%) |

**Three of four model conditions are dominated by a two-parameter formula over
git history.** The fourth clears it by 1pp recall / 1pp precision on a single
sample of 46 files — well inside sampling noise (95% CI on 43% over 46 files is
roughly +/-14pp). The honest reading is that **the model matched the dial and
did not beat it.**

### Replication at the second cutoff (2026-05-15)

170 files, 67 defective, base rate 39%. Same shape, same monotonicity:

| a | b | recall | prec | lift |
|---|---|---|---|---|
| 1 | 0 | 18% | **92%** | 2.34x |
| 0.5 | 0.5 | 30% | 56% | 1.41x |
| 0.3 | 0.7 | 33% | 33% | 0.85x |
| 0 | 1 (ManualUp) | 36% | 24% | **0.60x** |

Prior-fix-count precision replicates high (67% -> 92%, lift 2.30x -> 2.34x).
ManualUp replicates below base rate (0.73x -> 0.60x). The dial is real.

## Research stream 2 — published defect prediction (agent report)

Confirms and sharpens, in order of relevance:

- **Process metrics crush product metrics.** 722k commits / 700 projects: process
  models reach median recall 98% / AUC 95%; product (complexity) models 44% / 54%.
  AUC 0.54 is a coin flip. Do not build a complexity signal.
- **Size confounds nearly everything.** A metric's validity is predictable from
  its correlation with size at R^2 up to 0.97; controlled for size, most metrics
  lose predictive power entirely. Matches our ManualDown/ManualUp result.
- **TWR's design rationale is the fix for our prior-fix signal's known bias.**
  Raw prior-fix count permanently flags old, large, crufty files. Google's decay
  (6-8 month window, recomputed daily) exists specifically to "level the field
  between old and new files." Ours has that bias and TWR is the published remedy.
- **THE WARNING: Google deployed exactly this and it changed nothing.** Nightly
  TWR over the whole company, top 0.5% of files flagged in code review. After
  three months: time-to-review 2.01 -> 1.94 days, comments 5.97 -> 6.38, **neither
  statistically significant.** Developer requirements from their interviews:
  (1) **actionable** — "by far the most desired"; a flag with no fix is noise;
  (2) **obvious reasoning** — opaque scores get ignored; (3) **dial-able**
  coverage. A ranking Review cannot act on will be ignored exactly as Google's was.
- **Label noise bounds our whole harness.** Manually validated: only ~half of
  SZZ-identified bug-fixing commits actually fix bugs; in a six-month window one
  file is wrongly labeled defective for every correctly labeled one, and two
  defective files are missed. 33.8% of bug reports are misclassified; 39% of files
  marked defective never had a bug. Degradation threshold is 20-35% noise and real
  datasets exceed it. **Our proxy key is at least this noisy. Every number above
  should be read as ordinal, not cardinal.**
- **"Snoring":** files look clean only because their bugs are undiscovered. Fix is
  a discovery-latency gap before the test window. We did not do this; it biases
  against recent files.
- **Cross-project transfer does not work.** 622 project pairs, 3.4% success.
  Firefox->IE recall 81%; IE->Firefox recall 4.1%. Same pair, reversed. **Whatever
  we tune on Circuit will not transfer to a user's repo.** The dial must be
  computed per repo, never shipped as constants.
- Distinct-committer count is the one process metric with a verified medium effect
  on top of product metrics, but adds little on top of size + prior faults. We
  tested authors; it lost. Consistent.
- Ownership / minor-contributor signals: strong at Microsoft, **failed to
  replicate on open source**, and reversed direction at line granularity. Skip.

## Research stream 3 — how shipping review tools handle breadth (agent report)

The most consequential finding for Circuit is not about ranking at all.

- **Almost nothing reviews a whole repository.** Every product surveyed except
  Semgrep, Snyk, Diffblue and the dead CodeGuru is diff-triggered. Greptile and
  CodeRabbit index the whole repo and then review a diff. "Full codebase" is a
  retrieval claim, not a coverage claim.
- **Three vendors retreated from breadth.** Qodo DELETED its whole-codebase RAG
  index, saying ROI "was sitting right around zero." Sourcery let its repo-wide
  CLI rot. AWS deprecated CodeGuru Reviewer, whose docs had been frozen since 2022.
- **More context makes LLM reviewers measurably worse.** SWE-PRBench froze three
  context configs (diff only / diff+files / full context): **all 8 models degrade
  monotonically** as context grows. A 2,000-token diff-with-summary beat a
  2,500-token full-context prompt built with AST extraction, for every model.
  Cause is attention, not selection: models "cannot reliably distinguish changed
  from unchanged lines once both appear in a flat token sequence." Separately, F1
  drops 15x between small and large diffs. And Snyk's CodeReduce ablation runs the
  same way in reverse: cutting the program down to the defect plus necessary
  context took StarCoder from 19.3% to 82.31%.
  **This is independent support for small reviewer units, and it argues against
  ever raising our unit budget to "see more."**
- **Nobody reports coverage to the human.** The gap, stated plainly: nobody
  delivers "I reviewed 23 of 41 files; here are the 18 I did not open, and why"
  in the same surface as the findings, on a normal successful run.
  Three partial pieces exist in three different products:
  - **Diffblue Cover** ships a five-family output-code taxonomy separating four
    kinds of not-done (never eligible / tried and failed with a named reason /
    environment-blocked / produced then discarded), writes the reason INTO the
    artifact (`TODO: This test is incomplete. Reason: R002 Missing observers.`),
    and ships the denominator with the numerator ("analyzing 97 methods and
    creating 77 tests"). This is the best coverage honesty in the industry.
  - **CodeRabbit** enumerates files processed and files ignored, and has the only
    coverage-based REFUSAL: at >25% of files skipped it declines rather than
    degrading — "the review is being skipped to prevent a low-quality review."
    **This is Circuit's existing partial-coverage rule, already shipped by
    someone else, and it validates the fan-out design.**
  - **Semgrep** enumerates skip reasons at the scanner layer with documented
    causes (max bytes, timeout x3, parse failure, ignore file).
- **Greptile auto-approves at self-assigned confidence >= 4/5**, over a codebase
  whose examined subset is never disclosed. That is the exact failure mode our
  invariants forbid, shipping in production today.
- **Suppression compounds silently everywhere.** Codex reports only P0/P1.
  Anthropic's security review drops findings under 0.7 confidence and excludes six
  vulnerability classes outright. Copilot is silent on 29% of reviews. In each
  case a clean result conflates "nothing there," "below threshold," and "out of
  category," and nothing in the output says which.
- **The single most useful number found:** an independent 3.5-week parallel run of
  four reviewers over 146 merged PRs and 679 findings — **93.4% of all findings
  were caught by exactly one of the four tools. All four never co-flagged a line.**
  Enormous non-overlapping blind spots. Two consequences: an unqualified approving
  verdict from any single reviewer is unsupportable on its own evidence, and
  fan-out across DIVERSE models is worth more than depth in one.
- **Vendor benchmarks are worthless.** Greptile self-scores 82% catch rate;
  independent re-runs of the same repos scored it 45% and 24%. Every vendor citing
  Martian's benchmark reports winning it. Two competitor benchmarks disagree by 43
  points on the same tool's precision. Cite none of them.
- **Practitioner complaint most relevant to us:** the top HN thread faults Greptile
  not for being wrong but for attaching 4/5 confidence to wrong comments. **A
  calibrated-looking number over uncharacterized coverage is worse than no number.**

## Status of the original premise

"A model naming where risk lives beats arbitrary order" — still not proven for
the MODEL. But the underlying goal (beat arbitrary order at choosing where to
look) is now proven achievable and cheap. The orient step has something real to
stand on; it just should not be the model inventing the ranking.

# Eval Methodology Research: Design Requirements for Circuit's Instruments

Date: 2026-06-11
Status: research complete. Design requirements folded into
`docs/evals/theses-and-hypotheses.md`.
Method: five parallel research briefs, primary sources fetched and read,
load-bearing claims spot-verified independently (Miller's paper read
directly, the SWE-bench Verified rubric corroborated across independent
secondaries, the Claude Code CLI cost fields probed empirically on this
machine).

## Why this exists

Circuit is about to build five eval instruments: per-role cost capture, an
implementer-stressing task family, a Build complexity ladder, a
session-resumption quiz harness, and a seeded-memory suite. Instruments 2
through 5 are expensive to author and easy to design wrong in ways that
invalidate their results quietly. This report collects what the literature
has settled, so each instrument is built against known requirements instead
of rediscovering them after the data is in.

Each section ends with a "Design requirements for Circuit" checklist. Those
checklists are the product of this report. Confidence levels follow the
deep-research convention: High means three or more independent sources agree
or we verified directly; Medium means two sources or one highly
authoritative source; Low means single source or self-derived.

---

## 1. Statistics for small-n paired agent evals

### What the literature says

**The task is the unit of analysis, not the run.** Miller's "Adding Error
Bars to Evals" [1] frames eval questions as draws from an unseen
super-population and computes standard errors at the question level. Runs
(reps) of the same task are correlated; pooling them as independent
observations understates error. We verified Miller's five recommendations
directly this session: CLT-based standard errors of the mean, clustered
standard errors when questions come in related groups, variance reduction
by resampling answers, paired inference on question-level differences when
comparing two models, and power analysis before running.

**Paired analysis is the variance lever.** Miller's recommendation 4, quoted
from the paper: "When two models are being compared, conducting statistical
inference on the question-level paired differences, rather than the
population-level summary statistics." Circuit's design (same tasks, both
arms) already supports this. The analysis must use it: compute per-task
differences first, then do inference on those differences.

**Plain CLT intervals are wrong at our n.** Bowyer et al. [2] show CLT-based
intervals under-cover badly below a few hundred datapoints, which is exactly
our regime (4 to 40 tasks). Their recommendation: Wilson or Clopper-Pearson
intervals for single proportions, Bayesian beta-binomial for small-n
estimates, and a paired Bayesian approach for comparisons. At fewer than
roughly 100 tasks, every interval we report should come from one of these,
never from a normal approximation.

**The right paired binary test is McNemar, mid-p variant.** For paired
binary outcomes (task fixed in arm A, not fixed in arm B), McNemar's test
conditions on discordant pairs. Fagerland, Lydersen, and Laake [3] compared
variants and found the mid-p version best for small samples: it preserves
type I error close to nominal without the conservatism of the exact
conditional test. The asymptotic version misbehaves below roughly 15 to 20
discordant pairs.

**Only discordant tasks carry information.** A task both arms always pass,
or both always fail, contributes nothing to a paired comparison. The exact
binomial floor: with all discordance in one direction, you need 6 discordant
tasks for p < 0.05 (one-sided exact: 0.5^6 = 0.016; with 5, p = 0.031
one-sided but 0.0625 two-sided; with 4, the best achievable two-sided p is
0.125). Circuit's current held-out suite has 4 tasks of which 1
discriminates. It cannot reach significance under any outcome. Power against
a 15 to 20 point gap is on the order of 3 percent. This is the single most
consequential number in this report: the suite needs roughly an order of
magnitude more discriminating tasks before any claim can carry error bars.

**Sizing, from Miller's power formula.** Equation 9 of [1], verified
verbatim: n = (z_alpha/2 + z_beta)^2 (omega^2 + sigma_A^2/K_A +
sigma_B^2/K_B) / delta^2, where omega^2 is the variance of the per-task
difference in mean outcomes and sigma^2/K are the rep-noise contributions.
Plugging in binary-outcome variances typical of agentic evals: roughly 30
tasks at K = 3 reps detect a 20 point gap at 80 percent power; roughly 40
tasks for a 15 to 17 point gap. These task counts are our own arithmetic
from the published formula, not a published table; the formula is High
confidence, our plug-in numbers should be re-derived once we have measured
variance components from real runs.

**Reps buy real power because run noise is large.** Wang et al. [4] find
that in paired LLM eval designs, prediction-level (run-to-run) noise often
dominates question-level variance, so resampling the same tasks is cheap
power. The ICC study of agentic evals [5] measured intraclass correlations
of 0.30 to 0.77 across agentic benchmarks, meaning 23 to 70 percent of
outcome variance is run noise, not task identity. Their recommended
reporting: accuracy with CI, plus ICC, plus between-task SE. At ICC around
0.5, moving from K = 1 to K = 3 roughly halves the required task count
(again our arithmetic via Eq 9). Diminishing returns set in fast after K =
3 to 5 because the omega^2 term (task-level variance) is irreducible by
reps; only more tasks shrink it.

**pass@k and pass^k answer different questions.** pass@k (Chen et al. [6])
estimates the chance at least one of k attempts succeeds: a capability
metric, flattering to high-variance agents. pass^k (tau-bench [7])
estimates the chance all k attempts succeed: a reliability metric,
punishing variance. Circuit's pitch is reliability (less babysitting), so
reliability claims should use all-K semantics: a task counts as reliably
fixed only if all K reps fix it. Caveat: we could not parse the tau-bench
PDF directly; two independent secondaries agree on the formula. Medium
confidence on the exact estimator, High on the concept.

### Design requirements for Circuit

- [ ] Unit of analysis is the task. Reps aggregate within task first
      (majority or all-K, chosen per claim) before any cross-arm test.
- [ ] Primary significance test: mid-p McNemar on task-level paired
      outcomes while discriminating-task count is below ~15; switch to a
      paired t on task-level differences at n >= 15 to 20.
- [ ] Intervals: Bayesian beta-binomial (or Wilson for single arms) at
      current n. Never a plain Wald/CLT interval below ~100 tasks.
- [ ] K = 3 reps per task per arm as the default. Justify any deviation.
- [ ] Reliability claims use all-K semantics (pass^k-style). Capability
      claims may use any-K (pass@k-style) but must be labeled as such.
- [ ] Every comparison reports: n tasks, n discordant, ICC (or run-noise
      share), and the minimum detectable effect at 80 percent power.
- [ ] Suite health metric: discordance rate. Saturated tasks (0 percent or
      100 percent in both arms across reps) are flagged; they add cost, not
      information.
- [ ] Task-authoring budget: target 25 to 40 discriminating held-out
      tasks. Floor for any significance claim: 6 discordant tasks.
- [ ] Standing rule, already true and now justified: no significance
      claims from the current 4-task suite. Direction and per-task heatmap
      only.

Confidence: High. Miller verified directly; Bowyer, Fagerland, and the ICC
study agree with each other and with standard biostatistics practice. Our
plug-in task counts are Medium until re-derived from measured variances.

---

## 2. Cost accounting and cost-quality frontier reporting

### What the literature says

**Record tokens as the primary fact; derive dollars.** "AI Agents That
Matter" [8] established the norm: dollar costs drift as providers reprice,
so token counts must be recorded alongside dollars to keep results
recomputable. The Holistic Agent Leaderboard (HAL) [9] operationalizes
this: full token logging per call, a frozen price table with an explicit
date (theirs: September 24, 2025), and the warning that "token count as a
proxy for cost is highly misleading" when comparing across models with
different per-token prices. The reconciliation: tokens are the durable
record, dollars (computed from a dated price table) are the comparable
headline, and both get reported.

**Pareto frontiers, drawn properly.** [8] introduced the cost-accuracy
Pareto frontier for agent evals: plot every configuration as a point
(cost on x, quality on y), draw the convex hull including the origin, and
date-stamp the cost axis ("Cost in USD, prices as of DATE"). HAL extends
this with dual frontiers: one in dollars, one in tokens. An agent
configuration is only interesting if it is on or near the hull; points
dominated on both axes are noise.

**Cache accounting is not optional for Claude-based agents.** Anthropic's
published multipliers [10]: 5-minute cache writes bill at 1.25x base input
price, 1-hour cache writes at 2x, cache reads at 0.1x. Our empirical CLI
probe (below) showed a trivial "say ok" prompt billing 36,803 tokens of
1-hour cache creation: cache traffic dominated the bill at roughly 100x the
visible input tokens. Any cost capture that ignores cache token classes
will be wrong by large factors, in different directions for different arms
(a multi-stage flow re-reads cache; a single-pass agent writes once).

**The harness's own host already exposes what we need.** We probed the
installed Claude Code CLI directly (2026-06-11, `--output-format json`)
[11]. The result message contains `total_cost_usd` plus a `modelUsage` map
keyed by model id, each entry carrying `inputTokens`, `outputTokens`,
`cacheReadInputTokens`, `cacheCreationInputTokens`, and `costUSD`. The
`usage` block additionally splits cache creation by TTL
(`ephemeral_5m_input_tokens` vs `ephemeral_1h_input_tokens`), which matters
because the two TTLs bill at different multipliers. These cost figures are
client-side estimates computed by the CLI, not authoritative billing data.
That is why we record both the reported number and our own computation from
the frozen price table, and flag divergence.

**What counts toward cost.** The norm from [8] and HAL: cost is the total
spend to achieve the result, including retries and failed internal
attempts. For runs excluded from accuracy (environment failures, protocol
failures), exclude them from cost-per-success denominators too, but log the
spend; silent spend is how harness bugs hide. Report per-task cost
distributions (median, p90), not only means: agent cost distributions are
heavy-tailed and a mean can be driven by one runaway run. Wallclock stays
recorded but labeled non-comparable across machines and load conditions.

**Cost-of-pass** [12] is a useful optional summary: expected cost to obtain
one passing solution (cost per attempt divided by pass rate). It folds
reliability into the economics, which matches Circuit's pitch.

### Design requirements for Circuit

- [ ] summary.json gains per-arm, per-role (researcher, implementer,
      reviewer) records with four token counts: input, output,
      cache_creation (split 5m/1h when the host exposes it), cache_read.
- [ ] Two dollar fields per record: cost_usd_reported (host's estimate)
      and cost_usd_computed (our tokens times our frozen price table).
      Divergence above 5 percent fails the run's bookkeeping check.
- [ ] Price tables live at evals/ledger/prices/<date>.json, append-only.
      Every dollar figure in a report cites its price date.
- [ ] Cost includes retries. Protocol-failure runs are excluded from both
      accuracy and cost-per-success, but their spend is logged.
- [ ] Report median and p90 per-task cost, not only totals or means.
- [ ] Frontier plots: dual versions (USD and tokens), convex hull
      including the origin, every arm-by-dial configuration plotted,
      dated cost axis.
- [ ] Claim template: "A reaches [quality, with CI] at Z percent of B's
      cost (prices as of DATE)."
- [ ] Wallclock stays in the ledger, labeled non-comparable.
- [ ] Optional: cost-of-pass per arm as a single-number economic summary.

Confidence: High. The two anchor sources agree, Anthropic's multipliers are
published primary documentation, and the CLI fields were verified by direct
probe on the exact binary the harness invokes.

---

## 3. Task difficulty without confounds, and self-authored task validity

### What the literature says

**The SWE-bench Verified rubric separates validity from difficulty.**
OpenAI's annotation campaign [13] had 93 experienced developers, 3 per
task, calibrated on 50 hand-labeled samples, answer scaled questions:
issue well-specifiedness (0 to 3 severity) and fail-to-pass test validity
(0 to 3 severity). Severity 2 or 3 on either question excludes the task.
Difficulty is a separate question, expressed as estimated human time
(<15 min, 15 min to 1 hr, 1 to 4 hrs, >4 hrs), ensembled by majority or
median, and is a stratification label only, never an exclusion criterion.
Difficulty is rated assuming the issue's intent is clear, so ambiguity and
difficulty are scored on separate axes rather than conflated. (The primary
annotation PDF was unreachable this session; the structure is corroborated
across the announcement's mirrors and Epoch AI's independent analysis
[14].)

**Human time is the cleanest difficulty axis.** METR [15] uses estimated or
measured human completion time as the difficulty scale, fits success as
logistic in log-time, and uses hierarchical bootstrap over task families,
tasks, and attempts so related tasks do not masquerade as independent
evidence. For Circuit's complexity ladder this endorses: band rungs by
estimated human time, and cluster statistics by rung family.

**What actually drives difficulty in SWE-bench-class tasks.** Across the
Verified difficulty bands, gold-patch size grows from about 5 LOC (easiest)
to 56 LOC (hardest), files touched from 1 to 2, and hunks from 1.4 to 6.8
[14]. So a ladder that varies "files touched, edit-site count, constraint
count" is varying the empirically observed difficulty drivers, which
supports rung definitions built on those dimensions.

**Residual scoring error survives expert review.** UTBoost [16] found 15.7
percent of evaluated instances had false passes that survived SWE-bench
Verified's expert annotation. Budget for residual error: hidden checks
reviewed by a second pass, and treat single-task surprises as suspect
before treating them as findings.

**Memorization can fake difficulty performance.** SWE-bench Illusion [17]
showed models achieve up to 76 percent file-path localization from the
issue text alone, without the repository, on popular benchmarks. Circuit's
tasks are novel and private, which helps, but the probe is cheap and worth
adopting: ask the model to localize the fix from the prompt alone; if it
can, the task leaks its answer through priors or through the prompt.

**Self-authored tasks: the literature is thin and says "validate
everything."** We found no study measuring same-family author-solver bias
(Claude authoring tasks that Claude-based agents then take). This is a real
gap, flagged as such: Circuit must measure it rather than assume either
direction. What does exist: AutoBencher [18] legitimizes
privileged-information task generation, where the author holds information
the solver cannot see (exactly Circuit's hidden-overlay design), and
quality studies of model-generated test items consistently find 30 to 60
percent of generated items flawed before filtering. The mitigation stack
that works: execution-validate every task (must fail pre-fix, pass
post-fix, and the hidden checks must catch at least one plausible naive
fix), then human rubric review on every task or a large sample.

**Anti-circularity is the cardinal rule.** Never define difficulty rungs by
the control arm's failure rate: adversarial-filtering style selection
(AFLite and successors [19]) bakes the comparison into the benchmark and
invalidates the comparison. Difficulty (how hard for everyone) and
discrimination (how differently the arms perform) are different item
parameters; conflating them manufactures the hypothesized effect. Rung
assignment must come from task-intrinsic features (files, constraints,
estimated time) measured before any arm runs, and stay fixed afterward.
Calibrate rung difficulty on a solver panel that includes at least one
non-Claude model, both to check the rungs order correctly and to give the
author-solver bias probe its data.

**Interaction claims have a statistical trap.** The hypothesis "structure's
advantage grows with complexity" is an interaction effect, and Schaeffer et
al. [20] showed all-or-nothing metrics can manufacture exactly this shape
(apparent emergent jumps) out of smooth underlying improvement. The
mitigations: collect continuous sub-scores (constraints satisfied, checks
passed) alongside the binary outcome, test the interaction on the logit
scale, pre-register the interaction hypothesis, and expect to need
several-fold more observations than a main effect of the same size. Aim
rungs at 20 to 80 percent solve rates; outside that band the binary
outcome saturates and the interaction is unmeasurable.

### Design requirements for Circuit

- [ ] Rung definitions control specific dimensions: files touched,
      edit-site count, constraint count, dependency depth. Prompt length
      and ambiguity held constant across rungs (rubric-checked).
- [ ] Every task gets a validity gate before use: execution-validated
      (fails pre-fix, passes post-fix, hidden checks catch a naive fix)
      plus human rubric review scoring well-specifiedness and test
      validity. Severity-style scoring; bad on either axis excludes.
- [ ] Difficulty is labeled, never used to exclude, and assigned from
      task-intrinsic features and estimated human time before any arm
      runs. Rungs never reassigned after results exist.
- [ ] Anti-circularity: no rung, task selection, or suite curation
      decision may use vanilla-arm (or Circuit-arm) outcomes as input.
- [ ] Solver panel for calibration includes at least one non-Claude
      model; its results double as the same-family author-solver bias
      probe (flagged self-derived: no literature on this bias exists).
- [ ] Memorization probe per task: localize-the-fix from prompt alone.
- [ ] Interaction analysis pre-registered, run on logit scale, with
      continuous sub-scores recorded per task (constraints held, checks
      passed), and rungs targeted at 20 to 80 percent solve rates.
- [ ] Budget residual scoring error: second-pass review of hidden checks;
      single-task surprises are suspect first, findings second.

Confidence: High on the Verified rubric structure and METR methodology
(corroborated independently). High on the anti-circularity and mirage
arguments (published, replicated). Low (self-derived) on author-solver
bias, which is exactly why the design measures it.

---

## 4. Memory and continuity benchmark design

### What the literature says

**Author ground truth first; assemble the artifact around it.**
LongMemEval [21], the strongest-constructed memory benchmark we found,
writes questions and their evidence statements first, then weaves the
evidence into haystack sessions. This gives three things Circuit's quiz
harness needs: an oracle variant (evidence presented directly) for an
availability ceiling, evidence labels that let you tell retrieval failure
from utilization failure, and abstention questions (questions whose answer
is genuinely absent) to catch confident fabrication. Circuit's resumption
quiz freezes real sessions rather than synthesizing them, but the ordering
rule carries over: ground truth gets extracted and recorded from the
session source before any arm's artifact (compaction summary, ambient
brief, handoff) is generated or inspected.

**Question provenance is the leakage that matters most.** The QAGS and
QuestEval line of work [22][23] established directionality: questions
generated from a summary score that summary's style, not its fidelity;
questions must be generated from the source. Translated to Circuit: a quiz
question derived from the ambient brief will favor the ambient brief's
vocabulary and framing, and the eval becomes a mirror. Hard rule: questions
are authored from the session transcript and repo state (the source),
by a process that has not seen any arm's artifact. Pete, or a model
instance given only the source, authors the quiz.

**Decompose the gap into write-side and retrieval-side.** With an oracle
arm (relevant content injected verbatim), the difference between oracle
performance and an arm's performance splits: oracle minus
best-possible-from-stored-content is the write-side gap (the artifact never
captured it), and stored minus actually-used is the retrieval/utilization
gap. Circuit's instruments should log what each artifact contains and what
the resumed session actually surfaced, so failures land in the right
bucket.

**The oracle bounds availability, not presentation.** Several retrieval
results show iterative retrieval can beat one-shot gold-context stuffing.
So if automatic recall ever beats the oracle arm, that is interpretable
(presentation and timing differ), not a harness bug. Pre-register that
interpretation to avoid post-hoc confusion.

**Answering is not acting.** The knowing-doing gap paper [24] measured
agents producing the correct rationale 87 percent of the time while taking
the wrong action 64 percent of the time in the same episodes. A quiz-only
harness would miss exactly the failure Circuit claims to fix. Requirement:
the quiz resumption and the behavioral resumption (resume and take the
next action) are separate sessions, because quizzing first contaminates
the behavior.

**A grep baseline is embarrassingly strong; include it.** Letta's
benchmark critique [25] found a plain filesystem agent with grep over raw
history hitting 74 percent, beating purpose-built memory products. If
Circuit's ambient brief cannot beat "no artifact, grep the raw prior
transcript," the brief is decoration. Add it as a fifth arm.

**The full-transcript arm is a saturation detector, not a ceiling.**
Context rot results [26] show long-context performance degrades even when
everything fits, and LoCoMo [27] taught the field that if full-context
wins everything, the sessions are too small to discriminate. Read the
full-transcript arm that way: if it dominates all artifacts, the frozen
sessions need to be bigger; if an artifact beats it, that is a real
finding about distillation quality, not an anomaly.

**Two of Circuit's measurements have no precedent.** We found no public
eval of host-compaction-summary quality (one vendor anecdote; one vendor
removed compaction entirely) and no established "first-action alignment"
metric. The nearest building blocks for the latter: Mind2Web's step
matching (action class plus target plus intent) [28] and AgentBoard's
partial-credit progress scoring [29]. Both measurements are flagged
self-derived: pre-register the scoring boundary (what counts as a
substantive first action) before running.

**Seeded-memory suite: gate on the oracle.** Run the oracle arm (lesson
injected verbatim into context) before building any retrieval. If the
oracle does not change behavior, retrieval cannot pay, and the program
stops there: that is thesis T9's kill condition operating as designed.
Construction requirements from the memory-error literature [30] and
benchmark practice: validate the seeded lesson is actually correct (wrong
lessons propagate), surround it with realistic distractor memories so
recall has something to fail against, avoid lexical overlap between the
lesson text and the trap's surface strings (otherwise grep wins by string
match and you learn nothing about recall quality), and log surfacing so
"never surfaced" separates from "surfaced and ignored."

### Design requirements for Circuit

- [ ] Resumption quiz arms: A0 nothing, A1 host compaction summary, A2
      Circuit ambient brief, A3 deliberate manual handoff, A4 full prior
      transcript (saturation detector, not ceiling), A5 grep-over-raw-log
      (no artifact). A4 and A5 are new since the charter draft.
- [ ] Ground truth extracted from the session source and recorded before
      any arm artifact is generated or read. Hard provenance rule: no quiz
      question derived from any arm's artifact.
- [ ] Quiz includes abstention questions (correct answer: "that is not
      knowable from this session").
- [ ] Quiz resumption and behavioral (take-the-next-action) resumption are
      separate fresh sessions per arm.
- [ ] First-action alignment scored by action class, target, and intent
      against the recorded intended next step; the substantive-action
      boundary pre-registered. Flagged self-derived.
- [ ] Pre-registered interpretation: an arm beating A4, or recall beating
      the oracle, is interpretable, not an error.
- [ ] Seeded-memory suite: oracle arm first as a gate; lesson correctness
      validated; realistic distractor memories present; no lexical overlap
      between lesson and trap surface strings; surfacing logged to split
      never-surfaced from surfaced-but-ignored.
- [ ] Compaction-quality measurement flagged as first-of-kind; expect no
      external comparison numbers.

Confidence: Medium-High on construction rules (LongMemEval, QAGS line, and
knowing-doing converge from different subfields). Low (self-derived) on
first-action alignment and compaction-quality measurement, by necessity:
the literature has not done these.

---

## 5. LLM-as-judge validity

### What the literature says

**Reference-guided scoring is the single biggest lever.** Zheng et al.
[31] measured GPT-4 judge failure on math at 70 percent when judging
freely; providing a reference answer dropped failure to 15 percent. The
answer-matching study [32] pushed further: when the judge's job is reduced
to "does this response match this recorded reference," even small models
reach human inter-annotator agreement. Every Circuit judge should score
against recorded ground truth (quiz answer key, recorded plan, recorded
intended next step), never free-form quality.

**Decompose into binary fields.** Scoring rubric fields as independent
binary verdicts rather than holistic scores reduced self-preference by
31.5 percent in the 2026 decomposition study [33] and aligns with the
answer-matching result. Holistic 1-to-10 scores are where style bias
lives.

**Position bias is real and cheap to kill.** Pairwise judges favor one
position; the standard mitigation is judging both orders and treating
disagreement as a tie [31]. Circuit's judges are mostly reference-based
rather than pairwise, but any pairwise use (plan equivalence) must swap.

**Blind the judge.** Strip arm names, model names, dial settings, and any
"circuit" or "vanilla" markers from judged content. Self-recognition
studies (Panickssery et al. [34]) show models recognize and favor their
own generations; metadata makes recognition trivial.

**Chain-of-thought does not fix bias.** CoT prompting helps judges detect
correctness errors but does not reduce preference biases. Do not treat "we
ask the judge to think step by step" as a mitigation.

**Judge capability has a floor.** On JudgeBench [35], judges below a
capability threshold score below random on reasoning-heavy verdicts;
Haiku-class models landed roughly 33 percent below chance there. Rule:
never a small-tier judge for any verdict requiring reasoning. Sonnet-tier
minimum, pinned by exact model id in the manifest (Circuit already pins
its judge; keep it).

**Same-family judging: measured, not assumed.** The preference-leakage
study [36] measured contamination by judge-contestant relatedness: same
model 23.6 percent, same family different series 8.9 percent, different
family 2.8 percent. JudgeBench found Claude-judging-Claude pairs dropping
below random on hard verdicts. But direction is not fixed: one 2025-26
measurement found Claude Sonnet 4.5 with a negative self-preference score
(-0.229, favoring others) [36, single source, Low confidence on the
specific number]. The practical resolution for Circuit, where both arms
are Claude-based: leakage is symmetric across arms, so same-family judging
is acceptable, with two guards: the judge comes from a different Claude
series than either arm where arms differ in tier, and a cross-family judge
re-scores a roughly 20 percent sample as an audit, with agreement
reported.

**Calibrate before trusting, re-calibrate on change.** Standard practice
across judge deployments: build a labeled set of at least 30 marginal
cases (grown until new cases stop surfacing new failure modes), require
the judge to hit at least 90 percent agreement or Cohen's kappa of at
least 0.8 against human labels, gate the judge's first scored use on
passing, and re-run the gate on every judge model or prompt change.
Circuit's verdict-correctness eval is exactly this shape already; extend
the pattern to the two new judges instead of inventing a new one.

**When not to use a judge at all.** Anything expressible as an exit code,
a string or structured comparison, or a deterministic check must be scored
deterministically. The judge is reserved for free-text semantic
equivalence against a recorded reference (quiz answers) and plan
equivalence, each behind its own calibration gate. This rule already
matches Circuit's hidden-objective-check design; it is now explicit.

### Design requirements for Circuit

- [ ] Deterministic-first rule: judges only where deterministic scoring is
      impossible, currently quiz-answer equivalence and plan equivalence.
- [ ] All judges are reference-guided: they compare output to recorded
      ground truth, never rate quality freely.
- [ ] Verdicts decomposed into binary fields, no holistic scores.
- [ ] Judged content blinded: arm, model, dial, and product names
      stripped.
- [ ] Pairwise judgments (if any) run both orders; disagreement is a tie.
- [ ] Judge model: Sonnet-tier minimum, pinned by exact id in the
      manifest. Never Haiku-tier for reasoning verdicts.
- [ ] Calibration gate per judge before first scored run: >= 30 labeled
      marginal cases, >= 90 percent agreement or kappa >= 0.8 vs Pete's
      labels; gate re-run on any judge change; results tracked in the
      ledger.
- [ ] Cross-family audit: a non-Claude judge re-scores ~20 percent of
      judged items; agreement reported alongside results.
- [ ] Do not assume self-preference direction; the calibration set and
      cross-family audit measure it for our judges.

Confidence: High on the bias catalog and mitigations (multiple measured,
independent sources). Low on any specific self-preference magnitude for
current Claude models; direction varies by model and task.

---

## Conflicts and uncertainties

**More tasks vs more reps.** Variance-reduction papers emphasize reps;
benchmark-sizing papers emphasize tasks. These answer different estimands.
Miller's Eq 9 reconciles them: reps shrink only the sigma^2/K run-noise
terms; the omega^2 task-variance term shrinks only with more tasks. At
agentic ICC levels, K = 3 is worth roughly half the task budget, and
beyond K = 5 reps are nearly worthless. Tasks dominate.

**CLT vs Bayesian at small n.** Miller's framework assumes hundreds of
questions; Bowyer shows CLT intervals under-cover below that. No real
conflict: we use Miller's design logic (pairing, clustering, power) with
Bowyer's interval machinery at our n.

**Oracle as ceiling vs beatable.** LongMemEval treats oracle context as an
upper bound; iterative-retrieval results show presentation effects can
exceed it. Resolved by pre-registering: the oracle bounds availability,
not presentation.

**Self-preference direction.** Positive in most measurements, negative in
at least one recent Claude measurement. Resolved by never assuming a
direction and measuring it per judge via the calibration set and
cross-family audit.

**pass^k estimator.** The tau-bench PDF would not parse; two secondaries
agree on the formula. Flagged Medium until someone reads the primary.

## Where the literature is thin (Circuit self-derives)

1. Same-family author-solver bias (Claude-authored tasks taken by
   Claude-based agents): no study found. Measured via the non-Claude
   solver panel.
2. Compaction-summary quality evals: no public precedent. Circuit's A1
   arm is first-of-kind.
3. First-action alignment: no established metric. Assembled from Mind2Web
   step matching and AgentBoard partial credit; boundary pre-registered.
4. Repeat-mistake rate (seeded-memory behavioral outcome): self-derived
   metric, anchored by the oracle gate.

## Source notes

Primary verification performed this session: [1] read directly (all five
recommendations and Eq 9 quoted verbatim from the arXiv HTML); [13]
corroborated via independent mirrors and [14] after the primary PDF
404'd; [11] verified by running the installed CLI and inspecting output.
Remaining sources were fetched and read by the research agents this
session; arXiv identifiers below are as fetched.

## Citations

All web sources accessed 2026-06-11.

[1] E. Miller, "Adding Error Bars to Evals: A Statistical Approach to
Language Model Evaluations," arXiv:2411.00640.
https://arxiv.org/abs/2411.00640 (HTML version read directly.)

[2] S. Bowyer et al., "Position: Don't use the CLT in LLM evals with
fewer than a few hundred datapoints," arXiv:2503.01747.
https://arxiv.org/abs/2503.01747

[3] M. Fagerland, S. Lydersen, P. Laake, "The McNemar test for binary
matched-pairs data: mid-p and asymptotic are better than exact
conditional," BMC Medical Research Methodology 13:91 (2013).
https://bmcmedresmethodol.biomedcentral.com/articles/10.1186/1471-2288-13-91

[4] Wang et al., on prediction-level noise dominating paired LLM eval
designs, arXiv:2512.21326. https://arxiv.org/abs/2512.21326

[5] Intraclass correlation study of agentic eval outcomes (ICC 0.30 to
0.77; recommends reporting accuracy with CI, ICC, between-query SE),
arXiv:2512.06710. https://arxiv.org/abs/2512.06710

[6] M. Chen et al., "Evaluating Large Language Models Trained on Code"
(pass@k estimator), arXiv:2107.03374. https://arxiv.org/abs/2107.03374

[7] tau-bench (pass^k reliability metric), arXiv:2406.12045.
https://arxiv.org/abs/2406.12045 (PDF unparseable this session; formula
confirmed via two secondaries.)

[8] S. Kapoor, B. Stroebl, A. Narayanan et al., "AI Agents That Matter,"
arXiv:2407.01502 (TMLR 2025). https://arxiv.org/abs/2407.01502

[9] Holistic Agent Leaderboard (HAL), Princeton, arXiv:2510.11977.
https://arxiv.org/abs/2510.11977

[10] Anthropic prompt-caching pricing documentation (write multipliers
1.25x/2x, read 0.1x).
https://docs.claude.com/en/docs/build-with-claude/prompt-caching

[11] Direct probe of the installed Claude Code CLI, `--output-format
json`, 2026-06-11: result message carries total_cost_usd and a per-model
modelUsage map (inputTokens, outputTokens, cacheReadInputTokens,
cacheCreationInputTokens, costUSD), with usage splitting cache creation
by TTL (ephemeral_5m/1h). Client-side estimates.

[12] Cost-of-pass metric, arXiv:2504.13359.
https://arxiv.org/abs/2504.13359

[13] OpenAI, "Introducing SWE-bench Verified" (annotation rubric: 0-3
severity gates for well-specifiedness and test validity; difficulty as
human-time bands, label only).
https://openai.com/index/introducing-swe-bench-verified/

[14] Epoch AI, SWE-bench Verified analyses (difficulty-band patch
statistics; independent corroboration of the rubric).
https://epoch.ai/benchmarks/swe-bench-verified and
https://epoch.ai/blog/what-skills-does-swe-bench-verified-evaluate

[15] METR, "Measuring AI Ability to Complete Long Tasks" (human
time-horizon methodology, hierarchical bootstrap), arXiv:2503.14499.
https://arxiv.org/abs/2503.14499

[16] UTBoost (15.7 percent residual false passes in SWE-bench Verified),
arXiv:2506.09289. https://arxiv.org/abs/2506.09289

[17] "The SWE-bench Illusion" (76 percent file localization from issue
text alone; memorization probes), arXiv:2506.12286.
https://arxiv.org/abs/2506.12286

[18] AutoBencher (privileged-information task generation),
arXiv:2407.08351. https://arxiv.org/abs/2407.08351

[19] AFLite line of work on adversarial filtering and its circularity
risks (Sakaguchi et al., WinoGrande; Le Bras et al., "Adversarial
Filters of Dataset Biases").

[20] R. Schaeffer, B. Miranda, S. Koyejo, "Are Emergent Abilities of
Large Language Models a Mirage?", arXiv:2304.15004.
https://arxiv.org/abs/2304.15004

[21] LongMemEval (ground-truth-first construction, oracle variant,
abstention, evidence labels), arXiv:2410.10813.
https://arxiv.org/abs/2410.10813

[22] A. Wang, K. Cho, M. Lewis, "Asking and Answering Questions to
Evaluate the Factual Consistency of Summaries" (QAGS),
arXiv:2004.04228. https://arxiv.org/abs/2004.04228

[23] T. Scialom et al., "QuestEval: Summarization Asks for Fact-based
Evaluation," arXiv:2103.12693. https://arxiv.org/abs/2103.12693

[24] Knowing-doing gap in agents (87 percent correct rationale, 64
percent wrong action), arXiv:2504.16078.
https://arxiv.org/abs/2504.16078

[25] Letta, filesystem/grep agent memory benchmark critique (74 percent
with plain grep). https://www.letta.com/blog

[26] Chroma research, "Context Rot" (long-context degradation within
the window). https://research.trychroma.com/context-rot

[27] LoCoMo, "Evaluating Very Long-Term Conversational Memory of LLM
Agents" (full-context saturation lesson), arXiv:2402.17753.
https://arxiv.org/abs/2402.17753

[28] Mind2Web (step matching: action class, target, intent),
arXiv:2306.06070. https://arxiv.org/abs/2306.06070

[29] AgentBoard (partial-credit progress scoring), arXiv:2401.13178.
https://arxiv.org/abs/2401.13178

[30] Error propagation in agent memory (incorrect stored lessons
compound), arXiv:2505.16067. https://arxiv.org/abs/2505.16067

[31] L. Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot
Arena" (reference-guided judging, position swap), arXiv:2306.05685.
https://arxiv.org/abs/2306.05685

[32] Answer matching outperforms free-form judging (small models reach
inter-annotator agreement when reference-anchored), arXiv:2507.02856.
https://arxiv.org/abs/2507.02856

[33] Binary decomposition reducing self-preference by 31.5 percent,
arXiv:2604.22891. https://arxiv.org/abs/2604.22891

[34] A. Panickssery, S. Bowman, S. Feng, "LLM Evaluators Recognize and
Favor Their Own Generations," arXiv:2404.13076.
https://arxiv.org/abs/2404.13076

[35] JudgeBench (judge capability floor; weak judges below random on
reasoning verdicts), arXiv:2410.12784.
https://arxiv.org/abs/2410.12784

[36] Preference leakage gradient (same model 23.6 percent, same family
8.9 percent, cross family 2.8 percent), arXiv:2502.01534; plus one
2025-26 measurement of negative self-preference for Claude Sonnet 4.5
(-0.229, single source). https://arxiv.org/abs/2502.01534

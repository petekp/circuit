# Review: one process for a diff and a codebase

Status: design note, evidence-backed, no code written.
Date: 2026-07-28.
Supersedes the orient sketch in [`review-generality.md`](review-generality.md).

## Why this note exists

Codebase fan-out shipped (#167, #168, #169). It works and it is honest: intake
splits a target into units, one reviewer per unit, and partial coverage cannot
close clean. But it exposed a question it does not answer. Review pre-packs
evidence, which is correct for a diff and wrong for a codebase. On this repo,
`review this codebase` reads 288 files, packs 82, and discards about 200 with
no account of why those and not others.

The proposed fix was an orient step: let the flow form a theory of where risk
lives, then examine, then report the theory alongside the findings. That rests
on a premise nobody had tested. This note tests it and reports what survived.

## The premise did not survive in the form it was written

The claim was that a model naming where risk lives beats arbitrary order.

**Measured, and it is false as stated.** Full method and tables in the evidence
log; the short version:

Three independent models got a list of 525 source paths and nothing else, and
ranked the twenty files most likely to hold defects. Scored against a
leak-free answer key (facts computed strictly before a cutoff date, defects
counted strictly after it), blind ranking landed near chance and lost decisively
to the dumbest available signal, "pick the twenty biggest files."

More useful than the score is the shape of the error. All three blind runs named
zero files under `src/cli/` and zero writers, while those account for 24% of
files that actually got fixed, including the two most-fixed files in the repo.
The blind prior is that concurrency, subprocesses and locks are dangerous. That
is textbook risk and it is wrong here. Circuit's defects live in operator-facing
prose and CLI plumbing. The three operator-facing bugs we already know about sit
exactly in the region the models skipped.

## What replaced it

Once the metric was corrected, a different and more useful picture appeared.

**Scoring by "how many of the top 20 files were defective" is the wrong metric
for Circuit.** Our constraint is a reading budget in characters, not a file
count. Ranked by defects-found-per-byte-read, the picture inverts: file size
goes from apparent winner to worst strategy, because twenty large files consume
the entire budget.

Three confounds had to be removed before any of this could be trusted, and each
one changed the answer:

1. Re-export barrels were inflating churn-based signals. They are touched by
   every fix that renames anything and never contain the defect.
2. The advantage decayed as the answer key demanded larger edits, from 2.7x at
   any-touch to 1.1x at ten-plus lines.
3. Fatally for the simple story: churn density scores identically against a key
   of "this file will be edited at all" as against "this file will be fixed."
   It cannot tell the two apart. It is an activity predictor.

Controlling activity out — restricting to files that were touched after the
cutoff and asking which of those got *fixed* — leaves exactly one cheap signal
with real defect-specific power: **prior fix history**, at 90% precision against
a 56% base rate. That replicates the most robust result in the defect-prediction
literature, past defects predict future defects. Everything else collapses to
the base rate. Both findings replicate at a second, independent cutoff date.

## The finding that should shape the design

Selection is a **one-dimensional dial**, and the dial is cheap.

Score every file by `(prior fix history) ^ a / (file size) ^ b` and sweep `b`.
That single parameter walks the entire tradeoff, monotonically:

| b (how hard you divide by size) | recall | precision | files read | lift over base |
|---|---|---|---|---|
| 0.0 — pure fix history | 11% | **69%** | 16 | 2.38x |
| 0.3 | 13% | 59% | 22 | 2.04x |
| 0.5 | 17% | 46% | 37 | 1.59x |
| 0.7 | 24% | 32% | 76 | 1.09x |
| 1.0 — pure smallest-first | 26% | 21% | 123 | **0.73x** |

Precision and coverage are not two competing designs to choose between. They are
two ends of one number we can set. Replicated at a second independent cutoff.

Three things follow, and each corrects something.

**1. Recall alone is a gameable objective.** Ranking by smallest file first wins
coverage (26%) while its precision sits *below* the base rate — small files are
genuinely less likely to be defective, and it still wins by reading 123 of them.
A strategy with negative discrimination tops the metric. Whatever Review
optimizes must be a (coverage, precision) pair, never coverage alone.

**2. The cheap signal does have real defect-specific power, and I under-tested it
the first time.** Prior fix count without size normalization reaches 69%
precision, a 2.38x lift, replicating at 92% and 2.34x at the second cutoff. This
is the field's most robust result and it holds here.

**3. The model matched the dial; it did not beat it.** Of four model conditions,
three are strictly dominated by some setting of `a` and `b`:

| condition | recall | precision | verdict |
|---|---|---|---|
| grounded | 20% | 43% | above, by 1pp on one sample of 46 files |
| re-rank | 15% | 41% | **dominated** (a=0.1 b=0.1 gives 17% / 46%) |
| contest | 13% | 46% | **dominated** (a=0.7 b=0.3 gives 13% / 59%) |
| blind | 13% | 38% | **dominated** (a=0.7 b=0.3 gives 13% / 59%) |

The one condition that clears the frontier does so by about a point on each axis,
well inside sampling noise. The honest reading is that a two-parameter formula
over git history is at least as good as anything a model did, and costs nothing.

This is a real correction. An earlier draft of this note claimed the model
produced discrimination "no computed metric produced." That was an artifact of
not having swept the metric space.

## What orient should actually be

Not the model inventing a ranking. Not the model re-ranking one either — that
was measured and it lost.

1. **Compute the ranking from git.** Prior fix history with time decay, divided
   by size to a chosen power. Seconds, deterministic, free, and per-repo. It must
   be computed per repository and never shipped as tuned constants: cross-project
   transfer of defect models succeeds in 3.4% of project pairs, and one
   well-known pair scores 81% recall in one direction and 4.1% in the other.
2. **Set `b` from the flow's stated purpose**, and say which setting was used.
3. **Let the budget do the cutting.** The model is measurably bad at spending a
   byte budget.
4. **Spend the model on judging the code, not on choosing it.** That is where its
   value was never in question, and where the selection experiments say it has
   no measured edge.
5. **Publish the ranking, the inputs and the dial setting.** A computed list with
   stated inputs is something an operator can disagree with.

Say what it is honestly: *"I prioritized files with a history of recent fixes,
weighted toward cheaper files, and read the top 82 of 342 within budget."* True,
checkable, arguable. "I found where risk lives" is not supported.

### Two warnings from the literature that bind this design

**A ranking nobody can act on will be ignored.** Google deployed exactly this
algorithm — time-weighted fix history, nightly, whole company, top 0.5% of files
flagged in code review. After three months, time-to-review moved 2.01 to 1.94
days and comments 5.97 to 6.38, and **neither change was statistically
significant.** Their developer interviews produced three requirements, in order:
the flag must be **actionable** ("by far the most desired characteristic" — a
flag with no fix is noise), its **reasoning must be obvious**, and its coverage
must be **dial-able**. Our design satisfies the second and third by construction.
The first is on us, and it is the one that killed theirs.

**More context makes reviewers worse, so this budget is not a limitation to
relax.** Holding the review task fixed and widening context from diff-only to
diff-plus-files to full context degrades performance *monotonically for every
model tested*; a 2,000-token diff summary beat a 2,500-token full-context prompt
built with real AST extraction. The stated cause is attention, not selection:
models cannot reliably separate changed from unchanged lines once both sit in one
flat token sequence. Cutting a program down to the defect plus necessary context
took one model from 19.3% to 82.31% on the same task. Small units are correct.
Whenever we are tempted to raise the unit budget so a reviewer can "see more,"
this is the evidence against it.

## The four steps and the invariants

The distilled process, which a diff and a codebase share:

1. **Orient.** Establish the scope and what is in it.
2. **Form a theory of where risk lives**, and record it as a claim, not a fact.
3. **Examine**, within a stated budget.
4. **Report the theory alongside the findings**, so the choice of where to look
   is reviewable separately from what was found.

A diff is the case whose orient step is nearly free: the diff *is* the scope and
the theory is "everything that changed."

Invariants, which must hold in both directions:

- Say what you examined and what you did not.
- Never claim clean over unexamined ground.
- Every finding cites evidence actually held.
- State the theory so someone can disagree with where you chose to look.

To which the evidence adds a fifth and a sixth, and neither is optional:

- **Report the denominator with the numerator.** Never "reviewed 82 files" alone;
  always "82 of 342." The best coverage disclosure found in any shipping product
  does exactly this, and it is nearly free.
- **State the dial, not just the result.** The selection is a parameter we chose,
  and a different setting would have produced different coverage at different
  precision. Naming the setting is what lets an operator say "you were too
  narrow" — which is the only form of disagreement that can actually be acted on.

One earlier draft carried a stronger invariant, that a computed ranking must
never be described as insight, on the grounds that the available signal predicted
activity rather than defects. That was true of *churn density* specifically and
is not true of the design above: prior fix history clears the base rate by 2.3x
at both cutoffs. The honest line is narrower — do not describe activity signals
as risk signals, and do not describe any ranking as knowing where bugs are.

## Verdict on the two-place divergence guess

The guess was that a diff review and a codebase review differ in only two
places: how many reviewers run, and whether evidence is handed over or fetched.

**It does not hold. There are three, and the third is the one that matters.**

- **Reviewer count** — diverges, as expected, and fan-out already handles it.
- **Handed vs fetched** — diverges less than it looked, and the evidence now
  leans one way. Widening what a reviewer sees degrades it monotonically across
  every model measured, and cutting context down to the defect plus what it needs
  produced the single largest gain in this literature. Whatever we do here, the
  unit stays small. This is an argument for handing over a tight bundle and
  against letting a reviewer roam.
- **Selection, and its disclosure** — the missed one, and the industry survey
  confirms it is where the value is. A diff requires no choice about what to look
  at, so there is nothing to disclose. A codebase requires choosing, and the
  choice carries an honesty obligation the diff case never has.

That third point is worth stating as a market fact rather than a design opinion.
Across every shipping AI reviewer surveyed, **nobody delivers "I reviewed 23 of
41 files, here are the 18 I did not open and why" to the human, in the same
surface as the findings, on a normal successful run.** The three nearest pieces
each live in a different product: one ships a taxonomy of *reasons for not-done*
written into the artifact itself and always reports the denominator with the
numerator; one enumerates files processed and files ignored and **refuses when
more than 25% were skipped**, on the stated grounds that a low-coverage review is
worse than none; one enumerates skip reasons at the scanner layer. Nobody has
assembled all three. Meanwhile the two most agentic products have none of them,
and one of them **auto-approves at a self-assigned confidence score** over a
codebase whose examined subset is never disclosed.

Two things followed, and the second one was tested the next day and did not hold.

Our partial-coverage rule is not idiosyncratic. The closest thing to a peer
independently shipped the same rule, which is good validation.

**The claim that the disclosure gap is our opening was refuted as written.** See
[`review-coverage-consumer-test.md`](review-coverage-consumer-test.md). Fifteen
consuming agents were given byte-identical reports differing only in a coverage
block: none, 93% covered, and 24% covered. All fifteen made the same decision.
None queued review of unexamined code. **None mentioned the coverage figure
anywhere in their output.**

Worse than a null: agents given "reviewed 82 of 342 files, no claim is made about
the other 260" wrote team summaries reading **"review found no blockers."** The
disclosure did not survive one hop, and the failure was over-claiming rather than
omission. An honest report satisfying every invariant in this note was laundered
into a clean bill of health by its own consumer.

The load-bearing correction: **an honesty guarantee that lives only in prose is
one hop from being erased.** Disclosure is still right, and it is still unfilled
in the market, but "nobody else does it" was doing more work in the argument
above than it can support. Being alone in a practice is not evidence the practice
is used.

That follow-on has now been run:
[`review-coverage-placement-test.md`](review-coverage-placement-test.md). Moving
coverage from a section into the verdict line, with *fewer* coverage words than
the section arm, on a rebalanced decision task, n = 6 per arm.

The result splits, and the split is the useful part.

- **Reception is fixed.** 5 of 6 agents given a verdict line reading
  `stopped (issues found in 82 of 342 files)` carried the figure into their own
  reasoning, against 3 of 6 for the section and 0 of 6 for no disclosure
  (p = 0.015 against control).
- **Laundering is not fixed.** 4 of those 6 still wrote "no blockers" with no
  qualification when compressing to one line for humans. Team-post preservation
  was 2 of 6 for the verdict line against 0 of 6 for the section — the right
  direction, but p = 0.455. It does not license a claim.

**The fact is received and destroyed at compression.** That relocates the
problem: it is not in how the report is written, it is in the consumer's
summarize step. No amount of report prose reaches it. The remedy, still untested,
is to require the consumer to *emit* a coverage field rather than hope it repeats
a sentence.

What the verdict-line change earns on its own: it is one line of writer code, it
costs nothing, and it measurably raises how often the fact survives into a
consumer's reasoning. Ship it for that, and do not sell it as an honesty
guarantee.

One methodological debt: across both experiments, 33 of 33 consuming agents made
the identical decision. Two attempts to build a decision task with spread both
failed, so the decision axis is unmeasured, not null. Drop or redesign that
measure before running a third.

**This does not justify two flows.** The four steps, the four invariants and the
report shape are shared, and they are the bulk of the process. The fork stays
narrow enough for `route_from_report` on an intake-emitted field: the codebase
route adds a selection step and a coverage disclosure, and rejoins. Two flows
would duplicate the invariants, which is precisely where drift would appear.

## What is still unknown

Stated plainly, because these bound everything above.

- **No valid independent answer key exists for this repo.** The release proof
  run uses a synthetic fixture, and the stored PR review scopes to a diff, so
  its cited files were chosen by being in the PR. Temporal robustness at a
  second cutoff was substituted, and the conclusions held.
- **The answer key is a proxy, and the literature says proxies of this kind are
  about half wrong.** Manually validated studies find only ~half of commits
  identified this way actually fix bugs; in a six-month window roughly one file
  is wrongly marked defective for every correctly marked one, while two defective
  files are missed. Around a third of bug reports are misclassified outright, and
  the noise level at which these models degrade is *below* what real datasets
  carry. **Read every number in the evidence log as ordinal, not cardinal.** The
  ranking of strategies is trustworthy; the magnitudes are not.
- **One correction I did not apply.** Files can look clean merely because their
  bugs are not yet discovered. The standard remedy is a discovery-latency gap
  before the test window. I did not leave one, which biases against recently
  changed files. Worth adding if this harness is ever reused.
- **Where to set the dial is a product decision, not an evidence one.** The
  literature is blunt that false positives are the binding constraint: roughly
  half of agentic review comments are rejected, production false-alarm rates run
  75%, imprecise suggestions measurably *cost* reviewer time, and the most-cited
  practitioner complaint about a competitor is not that it was wrong but that it
  attached high confidence to being wrong. Circuit's honesty rules argue the
  other way, because a wider honest claim is worth more. **This one is Pete's**,
  and it is now a number to pick rather than an architecture to choose.
- **Blind spots between reviewers are enormous, which we should exploit rather
  than fear.** An independent parallel run of four commercial reviewers over 146
  merged PRs found **93.4% of all findings were raised by exactly one of the
  four, and all four never once agreed on a line.** Two consequences: a single
  reviewer's approving verdict is unsupportable on its own evidence, which is an
  argument for our partial-coverage rule; and fan-out across *diverse models* is
  likely worth more than more depth in one. We already have the fan-out.
- **Do not trust any vendor accuracy number, including as a target.** The same
  tool self-scores 82% and scores 45% and 24% in two independent re-runs. Two
  competitor benchmarks disagree by 43 points on one tool's precision. Every
  vendor citing the one well-designed independent benchmark reports winning it.

## Related

[`review-generality.md`](review-generality.md), and the flow-catalog first
principles note. The evidence log for every number here is the session
scratchpad `FINDINGS.md`.

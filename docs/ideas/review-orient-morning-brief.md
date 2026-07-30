# Morning brief: where the Review breadth work landed

Written overnight, 2026-07-28. Plain language on purpose.

## The one-paragraph version

The orient idea works, but it turned out to be much simpler than either of us
thought. Choosing where to look is not a judgment call that needs a model. It is
a **dial**, and the dial is one number computed from git history in seconds. I
tested four different ways of having a model choose instead, and three of them
lost outright to the dial. The one that didn't, tied. So the design gets smaller
and cheaper. There is one real decision left and it is yours: where to set the
dial. That is at the bottom.

## What I actually did

I built a fair test first. This mattered more than anything else.

The obvious way to test "can we predict where bugs are" is circular: you use a
file's bug history to predict its bug history. So I split time. Every clue is
computed from the repo *before* June 15th. Every bug counted happened *after*
June 15th. Predict the future from the past. Then I ran the whole thing again at
a second date to make sure I hadn't gotten lucky.

Then I raced strategies against each other. Some dumb on purpose, some computed
from git, some models. Then two research agents read the published work and the
shipping competitors, and what they found sent me back to run one more test that
changed the answer.

## The four things worth knowing

**1. I was wrong twice about file size, and the second correction is the useful
one.**

First I told you "pick the biggest files" beat the models. That was an artifact
of counting files instead of counting how much text gets read. Corrected, biggest
files went from best to worst.

But I only tested *biggest first*. The published work names **smallest first** as
the baseline everybody has to beat, and I hadn't run it. So I did. It wins on
coverage — it finds more bugs per byte read than anything else I tested, because
you can read 123 tiny files for the price of 4 big ones.

And its hit rate is **below random.** Small files are genuinely less likely to be
broken. It wins by reading junk, fast.

That kills "find more bugs per byte" as a goal on its own. A strategy that is
actively bad at telling good files from bad ones tops that metric. Whatever
Review aims at has to be a pair: how much ground, *and* how good the aim.

**2. Choosing where to look is one dial, not a design.**

Score files by their history of past fixes, then divide by file size raised to
some power. That power is the whole story:

| divide by size... | ground covered | hit rate |
|---|---|---|
| not at all | 11% | **69%** |
| a little | 17% | 46% |
| a lot | 24% | 32% |
| completely | 26% | **21%** (worse than random) |

Precision and thoroughness aren't two competing designs to pick between. They're
two ends of one number. That's a much better place to be, because a number can be
set, changed, and printed in the report.

**3. The model didn't beat the dial.**

This is the correction that shrinks the design. I tested four ways of having a
model pick files. Three of them are beaten outright by some setting of that dial
— same coverage, better hit rate, zero cost. The fourth beat it by about one
point on each axis, on a single sample, which is noise.

I'd told you earlier that the model contributed something no formula could. That
was wrong. I just hadn't swept the formula properly. Files with a history of
fixes get fixed again at 2.3x the background rate, and that replicated at both
dates. It's the oldest finding in this field and it holds here.

So: spend the model on **judging the code**, which is what it's good at. Don't
spend it choosing the code. Let git do that.

**4. Google already shipped exactly this, and it changed nothing.**

Worth taking seriously. Google ran this algorithm nightly across the whole
company and flagged the riskiest 0.5% of files during code review. After three
months they measured review time and comment counts. Neither moved by a
statistically significant amount.

Their developers said why. The top requirement, by a distance, was that a flag
must be **actionable**. A label saying "this file is risky" with nothing to do
about it gets ignored, and it was. Second was that the reasoning has to be
obvious. Third was being able to dial how much gets flagged.

We get the second and third for free from the design above. The first one is on
us, and it's what killed theirs.

## What I think we should build

1. Compute the ranking from git. Seconds, free, deterministic.
2. Set the dial from what the flow is for, and say which setting was used.
3. Let the reading budget do the cutting.
4. Spend the model on judging code, not choosing it.
5. Print the ranking, its inputs, and the dial setting. Always print the
   denominator: "82 of 342 files," never "82 files."

One important constraint: the dial has to be computed **per repository**, never
shipped as tuned constants. When people have tried transferring these models
between projects, it worked in 3.4% of pairs. One famous pair scores 81% one
direction and 4% the other. Whatever fits Circuit will not fit your repo.

## The competitor research found us an opening

Worth reading properly, but the short version:

**Almost nobody actually reviews a whole codebase.** Nearly every tool out there
reviews a diff. The ones that advertise "understands your entire codebase" mean
they *index* it and then review the diff. That's a retrieval claim wearing a
coverage claim's clothes.

**Three companies tried breadth and retreated.** One deleted its whole-codebase
index outright and said the return "was sitting right around zero." One let its
repo-wide tool rot. AWS killed its whole-repo reviewer.

**And the research says why: more context makes these models worse.** Someone held
the review task fixed and widened the context three ways. Every model tested got
monotonically worse. A short diff summary beat a longer full-context prompt built
with real static analysis, for every model. The reason given is attention — once
changed and unchanged code sit in one blob, models stop being able to tell them
apart. So our small units are correct, and the next time we're tempted to raise
the budget so a reviewer can "see more," this is the evidence against it.

**Here's the opening.** Nobody tells the human what they didn't look at. Not one
product delivers "I reviewed 23 of 41 files, here are the 18 I skipped and why"
alongside the findings on a normal run. The three closest pieces exist in three
different products and nobody has assembled them. Meanwhile the two most
agentic ones have none of it, and one of them **auto-approves your PR based on a
confidence score it gave itself**, over a codebase it never says what it read.

Two things fall out. Our partial-coverage rule isn't idiosyncratic — the nearest
competitor independently shipped the same rule, refusing when more than a quarter
of files were skipped, on the grounds that a low-coverage review is worse than
none. And the disclosure gap is real and unfilled, which is the best answer I've
seen to "why use Circuit's Review instead of the one built into GitHub."

**One more number worth holding onto.** Someone ran four commercial reviewers in
parallel over 146 real PRs. **93.4% of findings were caught by exactly one of the
four. All four never once agreed on a line.** These tools have enormous, barely
overlapping blind spots. That means no single reviewer's approval is worth much
on its own — which supports our partial-coverage rule — and that fanning out
across *different models* is probably worth more than going deeper with one. We
already have the fan-out.

## Your guess about the two differences was wrong, in a useful way

You guessed a diff review and a codebase review differ in two places: how many
reviewers run, and whether evidence is handed over or fetched.

There are three. The missed one is **choosing what to look at, and admitting to
it**, and per the research above it's the one nobody has built.

Your second one also softened. Handing over a tight bundle now has evidence
behind it and letting a reviewer roam has evidence against it.

Still doesn't justify two flows. One flow with a narrow fork holds.

## The decision that is yours

**Where do we set the dial?** It's now a number, not an architecture, which is a
much easier question than the one I gave you yesterday.

The literature is blunt that false alarms are the binding problem: about half of
AI review comments get rejected, one production system runs a 75% false-alarm
rate, and imprecise suggestions measurably made reviews take *longer*. The
loudest practitioner complaint about a competitor isn't that it was wrong, it's
that it was **confidently** wrong. That all argues for a low setting: read fewer,
better-chosen files.

Our honesty rules argue the other way, because covering more ground means a
bigger claim we can honestly make.

I lean low, roughly the 46%-hit-rate row, because the disclosure is what makes
coverage honest and we get that from printing the denominator rather than from
reading more. But it's a call about what Review is *for*, so it's yours.

## Things I could not do, so you know the gaps

- **My answer key is a proxy, and the research says proxies like it are about
  half wrong.** Roughly one file gets marked buggy for every correctly marked
  one, and two get missed. So trust the *ordering* of strategies in my results,
  not the actual percentages.
- **One correction I skipped.** Files can look clean just because nobody's found
  their bugs yet. The standard fix is leaving a gap before the test window. I
  didn't, which is unfair to recently-changed files.
- **No independent scorecard exists.** The release proof run uses a fake fixture
  and the saved PR review only covers a diff, so using it would've been circular.
  I substituted a second date instead and the conclusions held.
- **Don't trust any vendor's accuracy numbers.** One tool self-scores 82% and
  scores 45% and 24% in two independent re-runs of the same repos. Every vendor
  citing the one good independent benchmark claims to have won it.

## Where things are

- Design note: `docs/ideas/review-orient-and-breadth.md`
- All numbers and method: `docs/ideas/review-orient-evidence-log.md`
- Nothing committed. No source touched. `tsc` clean. The only modified file is
  the one that was already dirty when I started.

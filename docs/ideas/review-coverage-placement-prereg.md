# Pre-registration 2: does PLACEMENT stop coverage laundering?

Written BEFORE running any arm. 2026-07-29. Follows the refuted experiment 1
(`review-coverage-consumer-test.md`).

## What experiment 1 established, and what it left open

Established: prose coverage disclosure in a report section does not change
consuming-agent behavior, and gets actively over-claimed downstream (0/10 agents
preserved it; several turned "82 of 342 examined" into "no blockers found").

Left open: whether that is about **placement** or about agents compressing
regardless. Experiment 1 only ever put coverage in a section.

## Hypothesis

Dropping a section is free. Rewriting a verdict string is an active act. If
coverage is fused into the headline verdict, laundering it requires the consumer
to deliberately contradict the line it is quoting, so propagation should rise.

## Design

Three arms, findings byte-identical, **same 82-of-342 coverage fact in S and V**.

- **Arm N — none.** No coverage anywhere. Control and manipulation check.
- **Arm S — section.** Verdict reads `stopped (issues found)`; coverage lives in
  a `## Coverage` section. (This is experiment 1's Arm C.)
- **Arm V — verdict.** Verdict reads
  `stopped (issues found in 82 of 342 files)`; **no separate coverage section.**

Deliberate asymmetry: **Arm V contains FEWER words about coverage than Arm S.**
If V beats S it cannot be attributed to volume or salience-by-length.

n = 6 per arm, 18 total.

## Fixing my confound from experiment 1

Experiment 1's task was ship-biased: all findings medium/low, "waiting three
days" in the framing, and a dollar price on re-review with no counterweight.
15/15 identical decisions was likely a ceiling effect I created.

The new task states costs on **both** sides and removes the delay pressure.
**Arm N is the manipulation check:** if Arm N still returns 6/6 identical
decisions, the task is STILL over-determined and I will report the decision
measure as uninformative rather than as a null.

## Measures

- **P3 (PRIMARY): does the team post preserve the coverage limitation?** binary.
  Promoted to primary because it was the only clean signal in experiment 1.
- **P1: does it queue review of unexamined code?** binary.
- **P5: does the coverage figure appear anywhere in the output?** binary.
- **P4: decision spread.** Manipulation check, not a finding.

## Refutation criteria, fixed in advance

| outcome | reading | what we do |
|---|---|---|
| V > S on P3 by a clear margin | placement is the mechanism | **BUILD.** One line of writer code. |
| V ~ S ~ 0 on P3 | placement is not the mechanism; agents compress regardless | **Structural disclosure is dead too.** The fix must force the consumer to emit a coverage field, not hope it repeats one. Escalate or drop. |
| V ~ S but both > 0 | some propagation, placement irrelevant | Report honestly as weak; do not build on it. |
| Arm N shows 6/6 identical decisions | my task is still over-determined | P4 reported as uninformative; P3/P5 still valid. |

## Limits, stated now

- Same single model family as experiment 1. Transfer still unproven.
- n=6 detects large effects only.
- I wrote the reports and the task, so framing effects remain mine.
- P3 is scored by me, not blind. Criterion fixed here to compensate: the post
  must contain a number, fraction, percentage, or explicit phrase naming
  unexamined code. "No blockers" without qualification scores NO.

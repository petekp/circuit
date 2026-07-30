# Pre-registration: does a consuming agent USE coverage disclosure?

Written BEFORE running any arm. 2026-07-29.

## The claim under test

The design note asserts that disclosing what a review did NOT examine is
Circuit's opening, because no shipping competitor does it. That assumes a
downstream consumer acts differently when told. If an agent consumer ignores it,
the opening is imaginary and we would be building a nicer-looking report.

## Design

Three arms. **The findings, verdict, file paths, and decision task are BYTE
IDENTICAL across all three.** Only the coverage disclosure varies.

- **Arm A — no disclosure.** Findings only. Current industry norm.
- **Arm B — disclosed, small gap.** "Reviewed 318 of 342 files."
- **Arm C — disclosed, large gap.** "Reviewed 82 of 342 files."

Consumer task: a release-manager agent decides whether to tag v0.2.0. Another
review pass is priced at ~$4 and 20 minutes, so asking for more has a real cost
and is not a free "yes". The agent also writes a one-line team-channel post,
which measures whether the limitation survives one hop.

n = 5 per arm, 15 total. Single-blind on my side is impossible; scoring criteria
are fixed below to compensate.

## Measures

- **P1 (primary): does it queue further review of unexamined code?** binary.
- **P2 (discrimination): does P1 differ between B and C?** This is the real test.
- **P3 (propagation): does the one-line team post preserve the limitation?** binary.
- **P4 (decision): tag / tag-with-followup / hold.**

## Refutation criteria, fixed in advance

| outcome | reading | what we do |
|---|---|---|
| A ~ B ~ C on P1 and P4 | disclosure is decorative | **STOP.** The opening is imaginary. |
| A differs from B,C but B ~ C | agent detects a caveat, ignores magnitude | Partial. Ship disclosure as a FLAG; the number is decoration; do not build a dial-aware consumer. |
| B and C differ in the expected direction | the number is load-bearing | **BUILD.** Coverage data earns its place. |
| P3 low in all arms | the limitation dies at the first hop | Coverage must be structural (schema field the consumer must handle), never prose. |

## Known limits of this test, stated now

- One consumer model family. Cross-model transfer is not established and last
  night's literature says transfer is where these things break.
- A synthetic decision task. Real orchestration has more context.
- n=5 per arm detects only large effects. A null result here is weak evidence of
  no effect; a positive result is the stronger direction.
- I wrote both the report and the task, so framing effects are mine.

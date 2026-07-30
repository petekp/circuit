# Review

Public. 3 steps. `depth` locked to `medium`. `autonomous: false`. Terminal
outcome bound to the primary result.

Corpus: 5 runs. 3 complete, 1 stopped with findings, 1 aborted on a Codex
subprocess crash.

## 1. What a user expects

"Review this" is one of the most familiar requests in software, so expectations
are sharp and mostly unspoken:

- **Look at my code and tell me what is wrong with it.** The target is whatever
  I most recently touched unless I say otherwise.
- **Tell me how bad it is.** Not just a list. A judgment I can act on: ship, do
  not ship, fix these two first.
- **Do not touch anything.** Review reads; it does not edit.
- **Scale to what I asked for.** "Quick sanity check on this commit" and "audit
  this whole service before launch" are the same verb with different budgets, and
  I expect the tool to spend differently on each.
- **Cover what you said you covered.** If you only looked at part of it, say so
  in a way I cannot miss.
- **Every finding should be real.** A review that cries wolf is worse than no
  review, because I stop reading the next one.

## 2. What actually happens

```
intake-step  (compose)   -> resolve target, snapshot evidence, split into units
audit-step   (fanout)    -> one reviewer relay per unit, max_branches 24, concurrency 4
verdict-step (compose)   -> merge unit verdicts into one report + verdict
```

- **Intake** resolves the target with a documented ladder: explicit `--target`,
  else the current diff, else the working tree with the assumption named in the
  report. A path scope narrows it. Nothing changed at a named path means it reads
  the tracked contents as they stand instead of a diff, and says which one the
  findings describe.
- **Audit** fans out. Each unit carries its own file contents as
  `item_evidence_field: contents` with `inherit_step_reads: false`, so a reviewer
  sees only its unit. Per-branch `max_attempts: 2`. `on_child_failure:
  continue-others`, and the join policy is `aggregate-any`, so one dead branch
  does not kill the run.
- **Verdict** emits `review.result@v1` with `scope`, `findings`, `verdict`. The
  verdict is `NO_ISSUES_FOUND` or `ISSUES_FOUND`; the latter binds the run's
  terminal outcome to `stopped`.

The honesty floor is real and enforced, not advisory. Partial coverage cannot
close clean. Every finding cites evidence the reviewing unit actually held.
Warnings scope to the files they name (fixed 2026-07-29). Internal warning tags
no longer reach reviewer prompts or operator prose (fixed 2026-07-29).

This is the strongest part of the catalog. What follows is about everything
around it.

## 3. Friction

**No budget dial, at all.** `allowed_depths: ['medium']`. The one thing a user
most wants to vary about a review is how hard it looks, and Review is the only
public flow with a single depth. "Quick sanity check" and "audit before launch"
run identically. The user's only lever is the goal text, which changes the prompt
but not the process.

**The cap is invisible and not tunable.** `max_branches: 24` is a literal in
`src/flows/review/assembly-spec.ts`, not bound to an axis. A user reviewing a
40-file target gets 24 units' worth of coverage. The report is honest about it,
which is the important part, but there is no way to say "spend more, cover it
all." The honest disclosure is a floor standing in for a missing capability.

**"Review this codebase" has no defined answer.** For a codebase larger than the
unit budget, intake truncates and discloses. That is honest and unsatisfying. The
selection question (which files are worth the budget) is measured and written up
in `docs/ideas/review-orient-and-breadth.md` and is not built. Today the answer is
effectively arbitrary order.

**Cannot run unattended.** `autonomous: false`. Review is the flow most suited to
running on a schedule or in a hook, and it is the only public flow that cannot.

**The verdict is binary.** `NO_ISSUES_FOUND` or `ISSUES_FOUND`. A review that
found three nits and a review that found a data-loss bug produce the same
verdict token and the same terminal outcome. Severity exists inside `findings`,
so the information is present, but the flow's own top-line judgment discards it.
This is the "tell me how bad it is" expectation, unmet at the level the user
reads first.

**Honesty does not survive one hop.** Two pre-registered experiments
(`docs/ideas/review-coverage-consumer-test.md`,
`docs/ideas/review-coverage-placement-test.md`, n=15 and n=18) found that
consuming agents handed an honest partial-coverage report reliably wrote
"review found no blockers." Moving coverage into the verdict line raised
reception (5 of 6 vs 0 of 6, p=0.015) but not preservation (2 of 6, p=0.455).
Circuit's differentiator degrades to zero at the first handoff. The diagnosis is
that the fact is received and destroyed at compression, so the remedy is
structural: require the consumer to emit a coverage field.

## 4. Confirmed bugs

**None open in Review itself.** The three found in the 2026-07-23 live run were
fixed on 2026-07-29:

| bug | fix |
|---|---|
| Healthy `ISSUES_FOUND` review headlined as "Blocked: review did not produce enough process evidence", and filed as a failure in run history via `FAILURE_OUTCOMES` | `stopped` is now a first-class outcome through the projection, envelope, gate, and a `decision-stopped-result` packet |
| Every fan-out unit carried the whole target's `evidence_warnings`, so reviewers hedged about files they never held | warnings filter by `path` against the unit's held set |
| `diff_truncated` leaked into reviewer prompts, review HTML, and operator markdown | plain-English label map; raw kind stays on the persisted record |

**Inherited, not Review-specific:** the aborted 2026-06-02 run died on
`codex subprocess exited with code 1` at `audit-step`, with no connector-level
retry. See finding 3 in the [README](README.md).

## 5. What would make it superlative

Ranked by how much each closes a gap between expectation and behavior.

**1. Give the verdict a severity, not a boolean.** Replace
`NO_ISSUES_FOUND | ISSUES_FOUND` with a graded top-line that the terminal outcome
maps from, so "three nits" and "a data-loss bug" do not read identically. This is
the single largest gap between what a user reads first and what they needed to
know. Cheap: the severity data already exists in `findings`.

**2. Add a depth axis and bind the unit budget to it.** `low` for a single
commit, `medium` as today, `high` for a pre-launch audit with a larger cap and
more attempts per unit. This turns the honest-truncation disclosure from an
apology into a choice the user made. It also gives "review this codebase" a real
answer at `high` without needing the selection dial.

**3. Make coverage structural, not prose.** Require the consuming agent to emit
a coverage field it cannot omit. This is the only remedy the placement experiment
licenses, and it is the difference between an honest report and honesty that
survives being read. Applies catalog-wide, but Review is where it pays first.

**4. Build the selection dial.** `priorfix^a / size^b`, computed per repo. It
traverses the whole precision/coverage frontier monotonically and dominated three
of four model-based conditions, replicated at two cutoffs
(`docs/ideas/review-orient-evidence-log.md`). Ranked fourth rather than first
because a depth axis makes the budget the user's choice, which matters more than
spending a fixed budget optimally. Read the numbers as ordinal; the answer key is
a noisy proxy.

**5. Allow unattended runs.** Flip `autonomous`. Review has no checkpoint and no
mutation, so it is the safest flow in the catalog to run on a hook or a schedule,
and it is currently the only public flow forbidden from doing so.

**6. Connector-level retry on subprocess death.** One of five runs in the corpus
died this way. Catalog-wide; see [README](README.md) finding 3.

### The one-sentence version

Review already tells the truth better than anything else we have; what it lacks
is a way for the user to say how much truth they want to pay for, and a way for
that truth to survive being handed to someone else.

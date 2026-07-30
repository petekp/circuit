# Explore

Public. 5 steps standard, 8 in tournament mode. Depths `low | medium | high`.
`tournament: true`. `autonomous: true`. No engine flags.

Corpus: 12 runs. **10 complete, 1 aborted, 1 left no result.** The most reliable
flow in the catalog by a wide margin.

## 1. What a user expects

"Help me understand this" or "which of these should we do":

- **Actually look at the thing**, do not just reason about it from the name.
- **Give me a recommendation**, not a survey. If you list five options with even
  weight you have handed the work back to me.
- **Show your reasoning** so I can disagree with a specific step.
- **Do not edit anything.**
- **Tell me what you are unsure about.** A confident wrong answer costs more than
  a hedged right one.
- **For a decision, argue both sides properly** before picking.

## 2. What actually happens

Standard mode:

```
frame-step      (compose)  subject + success_condition
analyze-step    (compose)  aspects
synthesize-step (relay)    turn analysis into a recommendation
review-step     (relay)    adversarially test the recommendation
close-step      (compose)  summary + verdict_snapshot
```

Tournament mode replaces the middle with option generation, a fan-out where each
option is argued at its best case by a separate worker, a stress-test pass, an
operator choice, and a decision step:

```
frame -> analyze -> decision-options -> proposal-fanout (bounded 2)
      -> stress-proposals -> tradeoff-checkpoint -> decision -> close
```

Two things make this work. First, `review-step` is a genuine adversarial pass by a
separate worker with `revise` and `retry` routes back to `synthesize-step`, so a
weak recommendation gets pushed back rather than shipped. Second, in tournament
mode each option is argued **at its best case** (`$item.best_case_prompt`) by a
worker that does not see the others, which is the correct way to avoid the usual
failure of comparison-by-strawman.

The tournament rubric scores eight dimensions including `honest_calibration` and
`branch_distinctness`, with runtime signals rather than pure model judgment for
`evidence_rigor` (non-empty `evidence_refs`) and `actionability` (non-empty
`next_action`).

**Why this flow works:** it has no verification step, so it cannot fail
verification, so the abort path that kills Build and Fix does not exist here. Its
`retry` routes go from `review-step` back to `synthesize-step`, and a rejected
synthesis is a normal state rather than an exhaustible one. The lesson is not
"Explore is better designed" so much as "the flows that mutate code inherit an
engine failure mode that the flows that do not, avoid."

## 3. Friction

**`synthesize-step` reads a report written by the step after it.** `reads`
includes `reports/review-verdict.json`, produced by `review-step`. Same
retry-feedback pattern as Fix, same readability cost.

**Tournament mode is not reachable by depth.** It is a separate axis, and the
compiled `tournament.json` is a different step path. From the corpus, tournament
runs show `depth=tournament` in the receipt, which means the receipt is putting an
axis value into the depth slot. Minor, but it makes run history harder to read: a
tournament run does not record what depth it ran at.

**The tradeoff checkpoint cannot ask for more evidence.** Its own policy text
says so:

> This checkpoint only supports final option choices; ask-for-more-evidence and
> stop routes are intentionally not encoded until the runtime has executable route
> semantics for them.

So the operator, shown three argued options and a stress test, can pick one and
nothing else. The most natural response to a close call ("go deeper on option B")
is not available. The comment is honest about why, and the missing capability is
engine-level.

**Concurrency is capped at 2.** `concurrency: {kind: 'bounded', max: 2}` for the
proposal fan-out, against Review's 4. For read-only work with no write conflicts
there is no obvious reason for the lower cap, and it doubles the wall clock on a
3-option tournament.

**No claim that the analysis read anything.** `analyze-step` is a `compose` step,
so the orchestrator produces `aspects` from the goal and the brief. Nothing in the
flow requires that any file was opened. Explore is the flow most at risk of
confident reasoning over an unexamined subject, and unlike Review it has no
evidence floor. Ten of twelve runs completed, and the flow's structure cannot tell
us whether any of them looked at the code.

That last point is the important one and it is not a bug, it is a missing floor.

## 4. Confirmed bugs

**a. `codex subprocess exited with code 1` at `synthesize-step`**, 2026-07-16,
1 worker paid, aborted. The stderr shows
`WARNING: proceeding, even though we could not create PATH`, which suggests an
environment problem rather than a model failure. Inherited connector fragility
([README](README.md) finding 3).

**b. One run left no `result.json`**, stalling at `synthesize-step` on
2026-07-16 (the same day and step as (a), a second attempt). Run history cannot
describe it.

**c. Receipt records `depth=tournament`.** The tournament axis overwrites the
depth value in the operator receipt, so tournament runs lose their depth in
history. Cosmetic but it degrades the corpus.

No Explore-specific logic bugs found.

## 5. What would make it superlative

**1. Give Explore an evidence floor.** Require `analyze-step` to cite what it
read, the way Review requires every finding to cite evidence actually held. Not
necessarily a full snapshot: a list of files opened, with a warning when the list
is empty, would be enough to distinguish "analyzed the code" from "reasoned about
the topic." This is the difference between a research tool and a well-formatted
opinion, and it is the largest gap between what a user assumes and what the flow
guarantees.

**2. Let the tradeoff checkpoint ask for more.** A third route that sends the
decision back for deeper evidence on a named option. Needs engine route semantics;
this is the concrete use case that justifies building them.

**3. Raise the fan-out concurrency to 4.** Read-only branches with no write
conflicts. Halves the wall clock on the mode users reach for when the decision
matters.

**4. Fold tournament into the depth axis, or record both.** Either make it a
depth (`high` implies option fan-out) or stop letting it overwrite depth in the
receipt. Two axes are fine; losing one of them in the record is not.

**5. Carry the adversarial review's objections into the output.** `review-step`
does a real adversarial pass, and the flow uses it as a gate. The objections it
raised and the synthesis's answers to them are the most interesting content the
run produced, and `explore-result.json` requires only `summary` and
`verdict_snapshot`. Surface the strongest surviving objection in the result.

### The one-sentence version

Explore is the flow that works, because it never has to prove anything ran; the
same absence means nothing guarantees it opened a single file.

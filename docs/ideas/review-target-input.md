# Stop guessing the review target from prose

Status: current-proposal. Written 2026-07-24 after five rounds of patching the
prose grammar instead of questioning it.

Companion to [`review-generality.md`](review-generality.md), not a replacement.
That spec asks **what kinds of thing Review can be pointed at** and answers
"change, snapshot, document, freely combined". Its sequencing is being worked and
its first two stages have landed. This document asks a question that one does not
touch: **how the target gets named in the first place.** Both stages that landed
were built on top of prose guessing, so the generality work inherits this
problem rather than solving it.

The tell that the two are separate: `review this branch against main` is listed
in that spec's table as working. Measured 2026-07-24, it silently reviews the
working tree instead. A documented-as-working case was quietly broken, and no
amount of new evidence *kinds* would have caught it, because the failure is in
recognising the request.

## The problem in one paragraph

`circuit run review` has exactly one input for what to review: a sentence, in
`--goal`. There is no input for which commits. So the engine guesses the commits
out of the sentence using twenty-one hand-written word patterns in
`src/flows/review/writers/intake.ts`. One of those patterns is a list of
twenty-four ordinary English words (`please`, `maybe`, `okay`, `wait`, ...) that
had to be written down so the code would not mistake them for branch names. The
grammar can only ever recognise phrasings someone anticipated and typed in.

## Why this is the wrong shape

The process that invokes the CLI is a language model. Claude Code or Codex read
the operator's real request in full, understood it, then compressed it into one
sentence and handed the sentence over. The engine then tries to recover the
meaning with regular expressions.

The understanding already happened upstream. The grammar exists to redo it
worse.

Circuit already states the correct principle for the neighbouring decision. From
`circuit run --help`:

> Routing is model-only; the host or operator names the flow, and the CLI never
> classifies the goal text.

Target selection breaks that principle inside the same command.

## What the grammar is actually there for

One real requirement, worth preserving. Review has to be able to prove what it
read. It cannot honestly report "no problems found" without knowing what it
looked at, so the target must be definite and recorded in evidence.

Pattern matching makes the target definite. But definiteness does not require
guessing. It requires being told and then checking. The guarantee comes from the
validation step, not from the parsing step.

## The change

Add an explicit target input. The host names the target because it already knows
it. The engine validates and records.

```
circuit run review --goal "..." --target main...HEAD
circuit run review --goal "..." --target HEAD~3..HEAD
circuit run review --goal "..." --target staged
circuit run review --goal "..." --target working-tree
circuit run review --goal "..." --target commit:abc1234
circuit run review --goal "..." --paths src/auth --exclude tests/
```

The engine's job becomes:

1. Is the value one of the target kinds Review supports? Reject unknown kinds by
   name, listing what exists.
2. Is the ref shape safe? `isSafeReviewRef` in `intake.ts` already does this and
   is unchanged by this work.
3. Does it resolve in this repository? The bounded Git reader already answers
   this via `resolve_target`.
4. Record the resolved immutable commit ids in evidence, as it does today.

Nothing about evidence honesty changes. The parsing step is replaced by a
naming step, and the checking gets stricter because an explicitly named target
that does not resolve is an error rather than a silent fallback.

## What this deletes

The prose grammar is demoted, not removed. Someone typing the CLI by hand still
writes `--goal "review staged changes"` and should still get a staged review. So
`parseReviewTarget` survives as a fallback for a goal with no `--target`.

The rule that changes: **the fallback stops growing.** No new phrasing patterns.
When a request is not understood, that is now a signal that the host should have
passed `--target`, not a signal to add a pattern.

The five patches that led to this doc are the evidence. Four landed. The fifth,
which taught the grammar to read "review the last 3 commits" and "review my
branch against main", was reverted before commit. Its patch is not kept in the
repository; it was 104 lines of new patterns and 270 lines of tests for them.

## Honesty gain, not just a cleanup

Today the report cannot distinguish these two situations:

- The operator named a target and Review reviewed it.
- Review guessed a target from prose and reviewed that.

Both arrive looking identical. The assumption is reported only when the grammar
matched nothing at all. When the grammar matches the *wrong* pattern, the report
is confidently wrong.

With an explicit input, provenance becomes recordable: named by the host, named
by the operator on the command line, or inferred from prose. A run that inferred
its target can say so. That is a real improvement to the evidence, not a
side effect.

## Slices

Each slice is independently shippable and independently verifiable.

**Slice 1: the flag exists and the engine honours it.**
Add `--target` to the flag table in `src/cli/run-flag-vocabulary.ts`. Carry it
through run inputs to `ComposeBuildContext` in
`src/flows/registries/compose-writers/types.ts`, which today carries `goal` but
has no field for a target. In `reviewIntakeComposeBuilder` (intake.ts, around
line 2331), prefer the explicit target and fall back to `parseReviewTarget` when
absent. Done means: a run with `--target` reviews exactly that target, and a run
without one behaves byte-identically to today.

**Slice 2: provenance in the report.**
Record whether the target was named or inferred, and say so in the operator
summary. Done means: an inferred target is visibly an inference.

**Slice 3: the hosts fill it in.**
Update `src/commands/run.md` and the review command source so the agent resolves
the target and passes `--target`. Regenerate both plugin surfaces. Done means: a
natural request in a host session produces a run with the flag set correctly.

**Slice 4: paths on the same footing.**
`--paths` and `--exclude`, replacing the narrowing-clause patterns
(`RESTRICTION_CLAUSE_PATTERN`, `EXCLUSION_CLAUSE_PATTERN`,
`POSTFIX_RESTRICTION_CLAUSE_PATTERN`, `UNRESOLVED_SUBSET_PATTERN`) as the
primary path. Same demotion rule: the clause patterns stay as fallback and stop
growing.

## The risk, and how to measure it before trusting it

This design moves the understanding to the host agent. If the host does not
reliably fill the flag, the result is worse than today, because a wrong explicit
target is more confidently wrong than a wrong guess.

That is an instruction-following question and it is measurable. Before Slice 3
is called done, run a fixed set of natural requests through a real host session
and record how often `--target` is set, and set correctly. Requests worth
covering: a bare "review my changes", a branch comparison, a commit count, a
path narrowing, a whole-repo ask, and a request with no target at all.

If the host is unreliable, the fallback still catches it, and the provenance
from Slice 2 makes the failure visible rather than silent. Slices 1 and 2 are
worth having either way.

## What this does not solve

Reviewing an entire codebase in one pass. That needs Review to split the work
and fan out, which is a separate capability and a larger project. This change
makes the limit legible and explicitly nameable. It does not remove it.

## Absorbed by this design

Three follow-ups filed while patching the grammar dissolve here rather than
needing their own fixes.

- A `since <ref>` phrasing could not safely become a commit span, because the
  parser is synchronous and cannot ask git whether the ref exists. So
  `review since yesterday` would have become a broken run. With an explicit
  target, validation catches an unknown name.
- A bare `in src/auth` narrowing is dropped in silence when the goal also names
  a target. Slice 4 removes the class.
- `review the last 3 commits` in a repository with 3 commits resolves to
  `HEAD~3`, which does not exist, and reports `range HEAD~3..HEAD could not be
  read` rather than naming the real limit. Under an explicit target the caller
  chose the range, so a precise error is both possible and correct.

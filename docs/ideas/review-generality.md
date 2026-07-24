# Review, rethought around what people actually ask for

Status: implementation spec. Supersedes the target-selection decisions that
landed in #165, which stay only where this document does not replace them.

## The frame error

Review models *which diff*. People mean *the thing I want looked at*. Those
are not the same, and only one of them is how anybody talks about code review.

Run the natural asks against the flow as shipped:

| What a person types | Today |
| --- | --- |
| review my changes | works |
| review the last commit | works |
| review this branch against main | works |
| review this plan: `<pasted text>` | works |
| review src/auth | errors |
| review src/auth/session.ts | errors |
| review this PR | errors |
| review my changes, just the frontend | errors |
| review everything except the generated files | errors |
| review the plan at docs/plans/foo.md | reviews the working tree instead |
| review whether this breaks the callers | reviews the diff, cannot answer |
| review the auth flow across these three files | reviews the working tree instead |

Four of twelve. The failures are not exotic phrasings. They are the ordinary
ways people describe what they want read.

Worse, three of the failures are silent: the run succeeds, reviews something
the person did not ask about, and reports a verdict. The report is honest
about what it read, which is the one thing that keeps this from being a
disaster, but honesty about the wrong answer is still the wrong answer.

## What changes

### 1. Evidence kinds, not target kinds

A diff is one kind of evidence. It is not the only thing a reviewer can be
given. Three kinds, freely combined:

- **Change evidence.** A diff: working tree, staged, unstaged, commit, range.
  What exists today.
- **Snapshot evidence.** A file or directory as it currently stands. This is
  what "review src/auth" means, and no amount of diff machinery produces it.
- **Document evidence.** Text supplied in the goal, or a file Circuit reads on
  the operator's behalf because the goal named its path.

Combination is the point, not a bonus. "Review my changes to the auth module"
should relay the diff *and* the current contents of the files it touches. The
reviewer already tells us it needs this: a live run of the shipped flow
reported "no broader context (e.g., how a.ts is consumed elsewhere) was
available to assess integration impact" as a limit on its own confidence.

Scoping falls out of this. "Review my changes, just the frontend" is change
evidence restricted to a path set, which is one flag to `git diff`. It has
never been hard. It was refused on principle.

### 2. Refusal is close to a last resort

If the request is comprehensible, do the useful thing and name the assumption
in the report. Refuse only when any action would be wrong: no repository at
all, a genuinely empty target, or a claim the run cannot honestly make.

This is already how unrecognized goal wording behaves. Extending it is mostly
deletion.

### 3. Mediated reads replace the hard seal

Today the reviewer sees a prompt and nothing else. It cannot open a file, so
"does this break the callers" is unanswerable no matter how the request is
phrased. That ceiling is the seal, and the seal exists for a good reason: the
report has to be able to account for everything the reviewer saw.

The resolution is not to remove the seal but to make reads go through Circuit
and get recorded. The reviewer asks for a path, Circuit fetches it, the read
lands in the evidence ledger, and the report lists every read alongside the
pre-collected evidence. Complete account preserved, ceiling gone.

Open questions worth a spike before committing:

- Bounding. How many reads, how large, and what happens at the limit.
- Loop cost. Each read is a round trip; a reviewer that reads twenty files is
  slow and expensive.
- Path authority. A read request naming something outside the workspace is
  refused and recorded as refused.

### 4. Pull requests get a fetch story

"Review this PR" is the most common code review request there is. It was
removed because nothing behind it worked. The answer is to make it work:
resolve the PR to a local range, fetching the ref when the host has network
and credentials, and fall back to a named assumption when it does not.

## Sequencing

1. **Path scoping.** Subsets and exclusions become change evidence over a path
   set, with the scope named in the report. Deletes a refusal, adds a flag.
2. **Snapshot evidence.** New evidence kind. Serves "review src/auth", "review
   this file", and "review the plan at `<path>`".
3. **Automatic context.** Change evidence carries the current contents of the
   files it touches, bounded.
4. **Mediated reads.** Spike the bounding and loop cost first.
5. **Pull requests.** Fetch, resolve to a range, degrade honestly.

Each stage is independently shippable and independently useful.

## What does not change

The report still describes the review that actually happened. Every widening,
every assumption, every read, every thing that could not be seen appears in
the report. Generality is not permission to become vague about what was
reviewed. It is the reason the account matters more.

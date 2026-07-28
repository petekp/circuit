# Review, rethought around what people actually ask for

Status: implementation spec. Supersedes the target-selection decisions that
landed in #165, which stay only where this document does not replace them.

## The frame error

Review models *which diff*. People mean *the thing I want looked at*. Those
are not the same, and only one of them is how anybody talks about code review.

Run the natural asks against the flow as shipped:

| What a person types | Then | Now |
| --- | --- | --- |
| review my changes | works | right target, reported as a guess |
| review the last commit | works | works |
| review this branch against main | claimed to work, does not | reviews the working tree instead |
| review this plan: `<pasted text>` | works | works |
| review src/auth | errors | works |
| review src/auth/session.ts | errors | works |
| review my changes, just the frontend | errors | works |
| review everything except the generated files | errors | works |
| review src/auth for latent issues | errors | works |
| review this PR | errors | errors |
| review the plan at docs/plans/foo.md | reviews the working tree instead | unchanged |
| review whether this breaks the callers | reviews the diff, cannot answer | unchanged |
| review the auth flow across these three files | reviews the working tree instead | unchanged |
| review this codebase | reviews the working tree instead | unchanged |

Four of thirteen when this was written. The failures were not exotic
phrasings. They are the ordinary ways people describe what they want read.

Worse, three of the failures are silent: the run succeeds, reviews something
the person did not ask about, and reports a verdict. The report is honest
about what it read, which is the one thing that keeps this from being a
disaster, but honesty about the wrong answer is still the wrong answer.

Two corrections to the first four rows, measured 2026-07-24 against the flow as
shipped, because this table was wrong about them:

- **`review this branch against main` does not work.** It silently reviews the
  working tree. The row claimed it worked in both columns. It never did. The
  branch-comparison wording is not in the target grammar at all.
- **`review my changes` lands on the right target but reports it as a guess.**
  The wording is not in the working-tree pattern list, so it falls through to
  the assumed default and the operator is told "Assumed target: the current
  working tree. Name a commit, a range, staged, or unstaged to review something
  else." The most common review request there is gets answered correctly and
  then described as an unanswered one.

Both are instances of the same underlying shape, which this document does not
address: the target is *guessed from prose* rather than named. See
[`review-target-input.md`](review-target-input.md). Adding phrasings to the
grammar was tried, once per case, and is not the fix.

## What changes

### 1. Evidence kinds, not target kinds

A diff is one kind of evidence. It is not the only thing a reviewer can be
given. Three kinds, freely combined:

- **Change evidence.** A diff: working tree, staged, unstaged, commit, range.
  What exists today.
- **Snapshot evidence.** A file or directory as it currently stands. This is
  what "review src/auth" means, and no amount of diff machinery produces it.
  Landed: `target.kind === 'snapshot'`, collected through `git ls-files` so
  ignored files and build output can never enter it.
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

## Three regimes, not one flow with more options

People will point Review at whatever they have, and what they point it at
falls into three groups that differ in kind, not degree:

1. **One change.** A diff. Fits in a prompt. Works today.
2. **One file or a small directory.** Snapshot evidence. Fits in a prompt.
   Works today, bounded and reported.
3. **A whole codebase.** Does not fit in a prompt, and no bound makes it fit.
   "Review this codebase" needs fan-out: split the tree into reviewable units,
   run a reviewer per unit, and merge the findings. The mechanism is the
   dynamic fanout step, which expands one branch per item of an upstream
   report and is already how `prototype` and `pursue` run their parallel work.
   Two pieces were missing under it. The split itself, which landed as the
   unit packer in the Review package. And per-branch evidence: until now every
   branch of a fanout read exactly the step's own reads, so branch k saw the
   whole tree while being asked to review slice k, which is quadratic and puts
   each reviewer straight back inside the bound the split exists to break. A
   branch can now name its own `$item`-substituted reads. What is left is
   wiring Review's audit step to it and merging the per-unit reports into one
   verdict, and the Review schematic still has exactly one relay step.

Regime 3 is the honest gap. Until it is built, a request that lands there gets
a bounded sample plus a report that says so, never a clean verdict over code
nobody read.

## Sequencing

1. **Path scoping.** Landed. Subsets and exclusions became change evidence
   over a path set, with the scope named in the report.
2. **Snapshot evidence.** Landed. Serves "review src/auth", "review this
   file", and any path where nothing has changed. Two ways in: the operator
   asks for the current state directly, or an empty diff at a named path falls
   back to a snapshot and says which one the findings are about. Bounded at 25
   files, 40k characters per file, 150k characters total, and every bound is
   reported rather than absorbed: `matched_file_count` versus the files
   actually read, plus a `snapshot_truncated` warning that forces the run to
   close honest rather than clean. Still open: "review the plan at `<path>`",
   which needs a snapshot of an untracked document.
3. **Codebase fan-out.** Regime 3. Split, review per unit, merge.
4. **Automatic context.** Change evidence carries the current contents of the
   files it touches, bounded.
5. **Mediated reads.** Spike the bounding and loop cost first.
6. **Pull requests.** Fetch, resolve to a range, degrade honestly.

Each stage is independently shippable and independently useful.

## What does not change

The report still describes the review that actually happened. Every widening,
every assumption, every read, every thing that could not be seen appears in
the report. Generality is not permission to become vague about what was
reviewed. It is the reason the account matters more.

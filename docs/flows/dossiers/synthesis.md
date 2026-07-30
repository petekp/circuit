# What would make these flows superlative

Rolled up from the eight dossiers. The point of the exercise was to end with a
clear idea of what to build; this is that list.

## The one finding that explains most of the others

**Circuit's flows are more careful than its engine lets them be.**

Every mutating flow in the catalog does honest, well-instrumented work: Fix proves
the bug fails before anyone edits, Build enforces containment against a baseline
and catches workers that report edits they did not make, Prototype refuses to
write outside its sandbox, Goal has two independent reviewers judge whether the
contract was met. That machinery is good and it is rare.

And then the engine offers exactly one response to a retry budget running out:
abort, discard everything, write a result whose summary is "Run closed with
outcome aborted."

Eight of twenty aborts in the corpus are this. Five of those eight read
`verification step ... failed one or more commands`, which is to say: **the most
common thing that happens when you write code is the thing that destroys a Circuit
run.** The corpus shows the cost as repeated goals, because a user whose run was
discarded just runs it again by hand.

Explainer is the only flow that escapes, and it escapes by hand-building a
checkpoint before its fragile step, with a comment explaining exactly why. Build
already applied the same reasoning once, to reviewer `reject` verdicts, and wrote
28 lines in `src/flows/build/assembly-spec.ts:214` explaining that aborting a
working build over an honest objection was wrong. Nobody carried that reasoning
across to verification.

Everything below is ranked against this.

## The ranked list

### 1. A declarable exhaustion route

**Change.** `src/runtime/run/run-transition.ts:99` returns
`recovery_attempts_exhausted_abort` with no alternative. Let a step declare where
exhaustion goes: `close`, a checkpoint, or abort as today.

**Buys.** Build stops throwing away working branches (4 of its 13 runs). Fix stops
throwing away proven regression baselines (its only run). Pursue stops throwing
away a partially-landed batch (1 of its 2 runs). Explainer's hand-built gate
becomes a declaration instead of a workaround.

The honest-close machinery is already wired: `binds_terminal_outcome_to_primary_result`
maps a non-clean result to `stopped`, and after the 2026-07-29 fix `stopped` reads
correctly as "ran its full process and stopped without a clean result." We built
the landing pad three days ago and nothing routes to it.

**This is the highest-value change available and it is engine work, not flow work.**

### 2. Surface stalled runs

**Change.** Anything that reports runs waiting on an operator: a line in `circuit
doctor`, a `circuit runs` listing, output on bare `circuit`. `circuit reclaim`
covers worktrees and returns empty for this class.

**Buys.** Five Prototype runs have been waiting for a checkpoint choice since
2026-05-20, with paid work in them. They have no `result.json`, so they are absent
from every outcome tally, including the ones in these dossiers until I went
looking. An abort at least announces itself. This does not.

Cheap, and it fixes a failure mode that is currently invisible rather than merely
bad.

### 3. Make failure legible where the user actually looks

**Change.** `src/app/run-envelope/source-record.ts:717`. An aborted run headlines
"Failed: `<flow>` could not close with the required process evidence" and advises
"rerun with a corrected goal", for runs whose actual cause sits in `result.json`
one file away, and which `operator-summary.md` prints correctly on the next line
down.

**Buys.** Correct first-line diagnosis on 20 of 54 corpus runs. This is the same
defect shape fixed for `stopped` on 2026-07-29, one outcome over, walked past at
the time.

### 4. Validate connector inputs and retry connector deaths

**Change.** Check resolved connector selections against known capabilities before
the first step runs. Retry a dead subprocess at the connector layer.

**Buys.** Seven of twenty aborts are connector failures, not flow logic.
`codex connector cannot honor effort 'none'` killed runs on 2026-07-16 and again
2026-07-19, three days apart, zero workers paid either time: pure input validation
reaching a subprocess. Two more are bare `exit code 1`, one a 143, one a
three-minute inactivity timeout on a step with a two-hour budget.

The flows are better engineered than the pipes they run on, and the pipes are
where the runs die.

### 5. Give Review a depth axis and a graded verdict

**Change.** Add `low | high` to Review's depths and bind the 24-unit cap to the
axis. Replace the `NO_ISSUES_FOUND | ISSUES_FOUND` boolean with a graded top-line.

**Buys.** The two things a user most wants from a review are to say how hard to
look and to be told how bad it is, and Review offers neither. It is the only public
flow locked to a single depth. A depth axis also gives "review this codebase" a
real answer without needing the selection dial, which is why the dial ranks below
this despite being measured and written up.

### 6. Make coverage honesty survive a handoff

**Change.** Require a consuming agent to emit a coverage field it cannot omit.

**Buys.** Two pre-registered experiments (n=15, n=18) found that agents handed an
honest partial-coverage report reliably wrote "review found no blockers." Verdict-line
placement raised reception (p=0.015) but not preservation (p=0.455). Circuit's
differentiator currently degrades to zero at the first hop. This is the only remedy
the data licenses.

Ranked sixth because it is the deepest problem and the least well-specified fix.
It should not be attempted before items 1 through 4, which are all known work.

### 7. Give Explore an evidence floor

**Change.** Require `analyze-step` to cite what it read, and warn when the list is
empty.

**Buys.** Explore is the most reliable flow in the catalog (10 of 12 complete) and
nothing in its structure guarantees it opened a file. It has no verification step,
which is why it never aborts, and no evidence floor, which is why we cannot tell a
researched conclusion from a fluent one. The reliability and the gap have the same
cause.

### 8. Resolve the fan-out contradictions

**Change.** Prototype's `variant-fanout-step` sets `on_child_failure:
'continue-others'` and then joins on `required_count`, so it carefully continues
past a dead branch and then fails because that branch is dead. Let it close with
`n >= 1` and report how many of the requested variants came back.

**Buys.** Two of Prototype's three aborts. A one-variant comparison honestly
labeled beats nothing.

### 9. Make Pursue structural

**Change.** Fan out per pursuit with per-pursuit reports and verification, instead
of handing the whole ordered queue to one relay.

**Buys.** Pursue reasons carefully about dependency order and then cannot report
that three of five goals landed. Its reason to exist is currently advisory. It
should not be promoted to public before this.

### 10. Clean up the catalog's shape

Four items, each small:

- Mark `runtime-proof`, `converge-proof`, and `fix-until-green` as engine fixtures.
  Thirteen flows reads as thirteen capabilities; three are unit tests.
- Cut or reach Fix's `fix-no-repro-decision` and `fix-handoff`. Two of thirteen
  steps are unreachable and the flow's own purpose string says so. Dead structure
  in a schematic is a claim about capability that the engine cannot honor.
- Derive Goal's five near-identical `goal-run-*` steps from the catalog.
- Loosen cross-tool-build's connector pins to "two distinct connectors."

## What to actually do next

Items 1 through 4 are one coherent workstream: **stop losing runs.** They address
15 of the 20 aborts and all 5 of the silent stalls, they are all known work with
identified files, and none of them require a design decision we have not already
made. That is the next thing.

Items 5 and 6 are the Review workstream and they are what makes Review something
to reach for rather than something that is merely honest. They should follow, not
interleave.

Item 7 is the one I would add to the list that was not on anyone's radar, and it
is uncomfortable: our most reliable flow is reliable partly because it promises the
least.

## The catalog, judged

Four flows do real work: Build, Explore, Prototype, Review. Fix belongs in that
group on design and has one lifetime run, which is its own finding. Goal has the
best false-done defense in the codebase and cannot reach the catalog it routes to.
Pursue and Sweep are unproven. Three are fixtures.

The engineering underneath is genuinely good: the flow/engine boundary holds, the
catalog derives every generated surface, the honesty invariants are schema-enforced
rather than conventional, and 12 golden proof runs catch behavior drift. Nothing in
this exercise found a rotten foundation.

What it found is that we built careful flows on an engine with one response to
failure, and then measured everything except how often that response fires.

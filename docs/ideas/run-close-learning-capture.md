# Run-Close Learning Capture

Status: current-proposal. Post-v1 idea; not current behavior.
Date: 2026-07-03
Source: [The Compounding Knowledge Lifecycle](https://thinkroom.kieranklaassen.com/d/Yxr8tfwAVV)
Related: [`self-auditing-memory.md`](./self-auditing-memory.md),
[`self-auditing-memory-slice-5-spec.md`](deprioritized-ledger.md),
[`recall-to-lesson-gap.md`](deprioritized-ledger.md),
[`project-execution-memory.md`](deprioritized-ledger.md),
[`circuit-vs-compound-engineering.md`](deprioritized-ledger.md)

## Short Version

A Circuit run should be able to leave behind one small lesson when the run's
own evidence supports it. A later run of the same flow should read that lesson
automatically.

The best form is not a wiki page and not a model-written diary. It is a small,
cited, stale-checked, hint-only project fact. It points attention. It does not
control the run.

## Why This Exists

The Thinkroom note makes a simple point: knowledge only compounds when the loop
is closed. A team has to capture a lesson while the context is fresh, store it
where future work can find it, make retrieval automatic, and keep old lessons
from silently lying.

Circuit has a stronger base than a prose-only lesson folder. Every run already
has a run folder, trace, reports, checks, and evidence. That means Circuit can
turn a lesson into a typed fact with a source, a hash, a freshness check, and an
effect report.

The idea to save is the shape, not the exact implementation from the source.
Circuit should not copy a `docs/solutions/` folder as the core mechanism.
Circuit should use the run evidence it already owns.

## Current State

Circuit already has pieces of this:

- Run-start history recall.
- Manual `circuit memory note|list|forget`.
- Project facts stored under `.circuit/memory/`.
- History pull during a relay.
- Memory merge and memory effect reports.
- A deterministic project-fact distiller.

The missing part is the automatic run-close loop. The distiller exists, but the
normal run-close path does not yet write a lesson, propose a lesson, or refresh
the memory reports as a byproduct of the run.

So the honest status is: the read side mostly exists; the write-back side is
not wired.

## Product Shape

### 1. Capture At Close

After the run writes its normal summary, process evidence, and run envelope,
Circuit runs a small learning pass. The pass reads only current run evidence:
the trace, reports, result, run envelope, and existing history memory reports.

It may produce zero or one lesson candidate. Zero is common and healthy.

The candidate must answer:

- What happened?
- Which flow does it apply to?
- Which evidence proves it?
- When should a future run care?
- What would make it stale?

### 2. Store As A Hint, Not Authority

The stored shape should reuse the existing project memory lane where possible:
`MemoryInputV0` with `kind:"project"`, `authority:"hint_only"`, a cited source,
and staleness data.

The lesson can appear in a later relay prompt. It cannot select a flow, resolve
a route, approve a checkpoint, mark a check passed, or authorize a file write.

This keeps a bad lesson annoying, not dangerous.

### 3. Propose First

Automatic facts start as proposals. Operator-filed facts can be recorded
directly, because the operator is the source.

The first post-v1 slice should stay conservative:

- One candidate per run at most.
- No auto-record for model-written lessons.
- No injection of unapproved facts unless clearly marked as unverified.
- A clear `memory_indicator` when the run proposed or recorded something.

Later, Circuit can allow auto-record only after a signal has earned it: fresh
source, repeated support, no contradiction, and non-negative measured effect.

### 4. Retrieve At The Moment Of Use

The next run should not need the operator to remember a special command.
Circuit should read relevant project facts at run start for the selected flow.

Relays should also keep the pull path. If a worker is making a decision and
needs more context, it can ask history for a cited hint and log that pull.

This copies the source's best idea: retrieval is part of the work, not a
separate habit.

### 5. Refresh And Retire

A lesson is useful only while its source still holds and its measured effect is
not harmful.

Circuit should treat a lesson as stale when:

- the cited file or report is gone,
- the cited hash no longer matches,
- or current code or current run evidence contradicts it.

Circuit should suppress or retire a lesson when the memory effect report shows
it is correlated with worse outcomes.

Stale or retired lessons should remain auditable, but should not enter prompts.

### 6. Measure Helped Or Hurt

This is where Circuit can go beyond the source.

The source's lesson files are searched and refreshed. Circuit can also ask a
harder question: did a lesson make comparable runs better?

The memory effect report should stay the judge. It should say `not_enough_data`
until there are enough comparable runs. That answer is boring, but honest.

## What Gets Captured

Good candidates:

- A recurring failure cause, backed by `step.aborted` evidence across more than
  one run.
- A repo-specific verification fact the operator records.
- A settled flow-local habit that prevented a repeated failure.
- A source-backed correction to a prior stale lesson.

Bad candidates:

- "The model seemed confused."
- Broad best-practice advice with no run evidence.
- A full postmortem pasted into the next prompt.
- A chat-session memory with no cited run source.
- A lesson that tells Circuit to skip a check or trust a past result.

## First Build Slice

The smallest useful slice after v1 is:

1. Run-close calls the existing deterministic distiller after the run envelope
   is written.
2. The distiller emits at most one proposed project fact, or emits nothing.
3. The run envelope records the proposal through `memory_update_events` and
   surfaces one `memory_indicator`.
4. The proposal is not injected into future runs until recorded by the operator.
5. The memory-merge and memory-effect writers run as fail-soft byproducts, so
   earned precision has fresh reports.

That slice should not invent a new flow or a new memory schema. It should wire
the dormant pieces already described in the memory docs.

## Later Slices

After the first slice proves useful:

- Add an operator surface for accepting or rejecting proposed facts.
- Let repeated accepted facts become recorded automatically only after the
  effect guard exists.
- Add retirement events for stale or harmful facts.
- Let an Improve-style flow review the lesson corpus and recommend edits.
- Consider a readable `lessons.md` projection for humans, derived from typed
  memory, not used as runtime authority.

## Non-Goals

- No new feature before the v1 announcement.
- No claim that Circuit learns or gets better over time until this ships.
- No prose-only lesson folder as the source of truth.
- No broad chat transcript memory.
- No self-editing flow or automatic schematic mutation.
- No memory item that carries authority over routes, checks, checkpoints, or
  writes.

## Success Test

A good end-to-end test would look like this:

1. A Build run fails because the repo is missing an expected verification
   command.
2. The run-close learning pass proposes one cited lesson.
3. The operator records it.
4. A later Build run in the same project receives the lesson automatically.
5. The prompt names the lesson as hint-only and cites its source.
6. If the cited source changes, the lesson stops entering prompts.
7. The memory effect report stays honest if there is not enough data to judge
   whether the lesson helped.

That would make the compounding loop real without overstating it.

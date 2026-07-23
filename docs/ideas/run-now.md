# `circuit now`: the present-tense Run surface

Status: exploration, post-v1 candidate. Written 2026-07-18 from a hands-on
field study of Smithers (smithers.sh). No runtime change is proposed before
the v1 announcement.

## Naming

Smithers calls its version of this command `why`. Circuit deliberately does
not reuse that name. `now` is the settled choice (2026-07-18): it is
question-shaped ("what now?"), it works both aimed at one run and bare as
"does anything need me right now," and it completes a temporal family the
CLI already has: `preview` answers before, `now` answers during, `history`
answers after. It also promises only the present, which is exactly what the
honesty rules below allow it to claim.

## The borrowed insight, and what we reject

Smithers' command answers one question at any moment: what is standing
between this run and progress? Its answer has five parts: state, blocked
node, waiting since, reason, and a copy-pasteable unblock command. In live
use this collapsed the whole triage loop (ps, inspect, logs, grep, docs)
into one verb. For an agent operator it turned "stuck" into
fetch-and-execute.

We also watched it lie. Their command said "All retries exhausted" while
the underlying error said "Retries are preserved." The reason text was
narrated prose stored at failure time; the state machine moved on; the two
drifted. A command whose entire value is trust cannot be a cached
description.

So the borrowed insight is the question shape, not the name and not the
implementation. Everything below is a projection of state Circuit already
records, rendered at query time, with no second store and no stored
narration.

## What exists today

`now` is nearly a rendering problem. The substrate already exists:

| Need | Existing surface |
| --- | --- |
| Run state, reason, legal actions | `RunStatusProjectionV1` from `projectRunStatusFromRunFolder` (`src/app/run-status/`), already served by `circuit runs show` |
| Checkpoint question, choices, resume path | `waiting_checkpoint` projection re-reads and hash-verifies the request file (`src/app/run-status/runtime-run-folder.ts`) |
| Whose move, across runs | `circuit checkpoints` scans for every run waiting on the operator |
| Honest ambiguity for `open` runs | The mandatory `status_notice` ("active or unknown") already carried by the projection |
| Cause of a terminal stop | `run.closed` outcome (`complete`, `aborted`, `evidence_invalid`, `handoff`, `stopped`, `escalated`) plus the operator summary receipt |
| When it last did anything | `last_event` (sequence, type, timestamp) from the Trace |
| The route that remains | The compiled flow in `manifest.snapshot.json`; `circuit preview` already projects routes spawn-free |

What is genuinely missing: a question-shaped front door that fuses these
into one answer, a way to resolve "the run I mean" without a `--run-folder`
path, concrete rendered unblock commands instead of abstract action names,
and (later) timing context from past runs of the same flow.

## Decision (proposed)

Add `circuit now [--run-folder <path>]` as a read-only verb. It projects
the existing Run Snapshot into an answer with a fixed spine:

1. **Headline.** One plain sentence: what state, since when.
2. **Whose move.** Exactly one of: yours, the worker's, nobody's (terminal),
   or unknown. Never guessed.
3. **Because.** The cause, cited to its evidence file, never re-narrated.
4. **Do this.** The exact command(s), rendered concrete and executable.
5. **Then.** What the route holds after the unblock, from the Schematic.

`now` never mutates anything. `runs show` remains the detailed inspector;
`now` is the front door that decides which details matter right now.

## Example transcripts

Waiting at a Checkpoint:

```text
This Build run is waiting on you, and has been for 18 minutes.

Because  Circuit found two defensible storage approaches and paused at the
         declared Checkpoint. The question and choices are recorded in
         reports/checkpoints/storage-choice-request.json.

Do this  circuit resume --run-folder .circuit/runs/1dacf79a... \
           --checkpoint storage-choice --choice 1   (local supervisor, recommended)
         or --choice 2                              (foreground-only)

Then     Two steps remain after your answer: verify, report.
```

An `open` run, honestly:

```text
This Fix run is open. Circuit cannot tell whether it is still working.

Because  The last Trace event is relay.receipt for step "implement",
         recorded 41 seconds ago. This runtime has no worker liveness
         signal, so an interrupted run and a quiet worker look the same
         from disk.

Do this  Nothing is required from you yet. To inspect the record:
         circuit runs show --run-folder .circuit/runs/8c02... --json
```

Terminal, with salvage:

```text
This Prototype run ended 2 hours ago: evidence_invalid.

Because  The relay finished and produced real work, but its typed report
         failed validation. The salvage summary in
         reports/operator-summary.md lists what is worth keeping.

Do this  Read the summary, then re-run with the corrected contract:
         circuit run prototype --goal "..."
```

Bare invocation, nothing in flight (the fleet answer):

```text
No run is waiting on you in this project.

The most recent run ended 2 hours ago: complete (Build).
One older run is open; Circuit cannot tell whether it is active.
circuit checkpoints scans every run that needs an answer.
```

Bare invocation, every recorded run closed:

```text
No run is waiting on you in this project.

The most recent run ended 2 hours ago: complete (Build).
All 12 recorded runs are closed.

Do this  Nothing. The last run's report is at
         .circuit/runs/8c02.../reports/operator-summary.md
         circuit history lists all past runs.
```

The most recent run always gets one line with its outcome, because an
`evidence_invalid` or `aborted` ending the operator has not seen yet is
the one fact this state can still surface. Past-tense detail stays with
`history` and the report; `now` points and stops.

Bare invocation, no runs at all:

```text
Nothing is happening. This project has no Circuit runs yet.

Do this  circuit run <flow> --goal "<goal>" starts one.
         circuit preview shows what a flow would do first, without
         spawning anything.
```

Two lines of direction and no more; the bare `circuit` front door owns
onboarding. `preview` earns its mention as the temporal sibling: nothing
is during, so offer before.

## Making it ours: three upgrades Smithers cannot copy

**1. Ownership is first-class.** Smithers names a cause. Circuit's failure
work already classifies fault domains (setup, worker, task, Circuit), and
`now` leads with turn-taking: whose move is it. For an operator running
several projects, bare `circuit now` is the "does anything need me" verb.
This is the ON-loop posture the alternative-to-chat thesis argues for.

**2. The route is data, so `now` can see forward.** A derived-plan engine
can only describe the present; our Schematic is static, so `now` can say
what remains after the unblock ("two steps remain: verify, report") and be
correct by construction. Smithers' equivalent surface could not even show
a conditional task before its mount condition existed. This is the
bounded-dynamism dividend, made visible in the product.

**3. Flows repeat, so `now` can know what normal looks like.** Smithers
orchestrates one-off workflows; there is no baseline. Circuit runs the
same named blocks across many runs, and every `relay.completed` already
records `duration_ms`. A later slice can say "this relay has run 240s;
the median for this block in this project is 90s" as an anomaly signal.
This is describing known structure, not an ETA; the milestone-stream
proposal's rejection of percentages and invented completion times stands.

## Anti-drift rules (the Smithers lesson, hardened)

1. `now` renders exclusively from `RunStatusProjectionV1` and the files it
   cites. No stored prose, no second feed, no narration written at failure
   time. The Trace remains the only durable truth.
2. Every sentence template derives from a state enum at query time. If two
   surfaces can disagree about the same run, the bug is structural, not
   cosmetic.
3. Every "Do this" command must be executable as printed. Fixture tests run
   them against recorded run folders and assert they are accepted.
4. Unknown stays unknown. The `open` state renders its ambiguity notice
   verbatim; `now` never upgrades "no liveness signal" into "working."
   When the durable Run handle lands post-v1, `now` inherits the honest
   health vocabulary (Active, Quiet, Unresponsive, Stopping, No worker,
   Unknown) for free, because it reads the same projection.

## Slices

**Slice 1, rendering only.** New CLI verb in `CLI_COMMAND_NAMES`, resolver
for the implied run (explicit path, else continuity `current_run`, else
newest `run.bootstrapped` timestamp; the runs directory sorts by UUID, so
recency must come from the Trace, not the listing), the five-part answer,
concrete rendered resume commands, `--json` envelope alongside the prose.
Touches `src/cli/` only; consumes existing projections.

**Slice 2, route lookahead.** "Then" section from the compiled flow in the
run's manifest snapshot, reusing the `preview` projection. Honest about
undecided routes: "the next step depends on verification" is a legal
answer.

**Slice 3, normality priors.** Per-block duration aggregates over the run
corpus (the history indexer already walks it), surfaced only when at least
N prior samples exist, phrased as comparison, never prediction.

Slices 2 and 3 are independent of the CLI rebuild. None of the three
touches the runtime, adds state, or competes with the Trace.

## Relation to neighboring ideas

- [run-milestone-stream.md](run-milestone-stream.md) defines the six
  questions every surface must answer and owns during-run delivery. `now`
  is the pull-shaped complement of that push-shaped stream: same facts,
  same honesty rules, asked instead of watched. Its "legal actions are part
  of the state projection" principle is what makes "Do this" safe.
- [cli-first-principles.md](cli-first-principles.md) owns the post-v1
  lifecycle, liveness, and cancellation mechanics. `now` consumes whatever
  states it ratifies; it defines none of its own.
- [output-model.md](output-model.md) owns the final digest. `now` on a
  terminal run points at the receipt; it does not re-summarize it.
- `circuit doctor` owns setup-domain diagnosis. When a future parked state
  records a connector or provider blocker, `now` names the domain and hands
  off to doctor rather than duplicating probes.

## Open choices

- How much the no-runs answer should teach. Current lean (recorded in the
  transcripts above): two lines pointing at `run` and `preview`, nothing
  more; the bare `circuit` front door owns onboarding.
- Whether the fleet answer should ever cross project roots. Current lean:
  no; workspace-level belongs to the host, not the engine.
- Whether `now` output belongs in the operator summary's HTML surface too.
  Current lean: later, after the prose surface proves the content.

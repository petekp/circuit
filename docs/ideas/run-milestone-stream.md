# Run milestone stream: live legibility for backgrounded runs

Status: superseded as an implementation design by
[the CLI rebuild plan](cli-first-principles.md). Keep this document for its
problem evidence and milestone examples. Do not build `status.ndjson`: the
replacement is ProgressEventV2 projected from Trace, consumed through
`watch <run-id>`, with lease health kept transient. Recorded 2026-07-10. The
evidence base is the pursue battle-test run
`4cb86d0b` (2026-07-10), where the supervising host agent had to hand-build
live narration from the raw trace, and the friction findings in
[docs/release/agent-friction-remediation.md](../release/agent-friction-remediation.md).

## The problem

A Circuit run is a long-running process. When a host agent operates Circuit
the run is usually backgrounded, and for minutes to an hour the operator sees
nothing unless the host agent actively narrates. Nothing in the product
teaches it to, and nothing in the engine makes it cheap.

A host agent that wants to give the operator a play-by-play today must
re-derive four things from scratch, every session, every host:

1. **Filtering.** `trace.ndjson` is exhaustive by design. Most entries are
   bookkeeping; the narratable moments (step transitions, worker verdicts,
   verification outcomes, recovery routing, pauses) are a small subset.
2. **Translation.** Trace entries speak engine vocabulary: `step_id`,
   `relay.started`, `resolved_selection`. The operator needs plain English.
3. **Rate control.** Relay verbatim and you spam the operator; batch too much
   and the updates arrive after the moment has passed.
4. **Anomaly awareness.** The updates that matter most are the off-nominal
   ones: a retry, a recovery route, a verification timeout, a pause. Knowing
   which events are anomalies requires knowing the engine.

Each of these was solved by hand during the `4cb86d0b` run with a bespoke
tail-and-filter script. Every future narrating agent pays the same tax, and
narration quality varies with the model doing the improvising.

## What exists today, and why it does not cover this

- **`trace.ndjson`** is the ground truth stream, but it is exhaustive,
  internal-vocabulary, and unrated. It is the input to a narration layer, not
  the narration.
- **`RunStatusProjectionV1`** (`src/app/run-status/`) is a deterministic
  one-shot projection of a run folder: engine state and legal next actions.
  It answers "where is this run now", not "what just happened".
- **The presentation wrapper** (see
  [docs/specs/narration-display-profiles.md](../specs/narration-display-profiles.md)
  and [output-model.md](output-model.md)) renders progress for a foreground
  attached run and the final digest. A backgrounded run has no wrapper
  attached.
- **`circuit checkpoints`** surfaces parked runs, but only when polled. A run
  waiting at a checkpoint is pure dead time until someone notices.
- **Exit codes** report the terminal state, once, at the end.

The gap is the middle of the run, when it is backgrounded: no surface emits
milestones in operator language while work is happening.

## The idea

The engine writes a second, low-rate stream next to the trace: a milestone
stream (working name `status.ndjson` in the run folder). Each line is a
typed event whose text is already operator language, written once by the
engine at the moment the underlying trace entry lands.

Example lines, one JSON object each, text field shown:

- "Planning done: 4 pieces, code writes serialized."
- "Implementer started (sonnet, write-capable)."
- "Verification running: npm run verify:fast, 600s budget."
- "Verification failed: tests exited 1. Routing recovery (retry 1 of 2)."
- "Paused: needs your call on X. Resume with continue or revise."
- "Closed: complete. Summary at reports/operator-summary.md."

Properties that make it trustworthy and cheap:

- **Pure projection.** Every milestone derives from trace entries at write
  time. No model in the emission path, no worker self-report. If the stream
  and the trace ever disagree, the trace wins.
- **Low rate by design.** Milestones are step-level and anomaly-level, a few
  dozen lines for a long run, never per-token or per-file.
- **Typed and versioned.** Each line carries a kind, the run id, a timestamp,
  and the pre-rendered text, so consumers can either relay the text verbatim
  or branch on the kind.
- **Anomaly events are first-class.** A relay running far past its typical
  duration, a timed-out verification command (the `timed_out` observation
  field from the friction remediation feeds this directly), a recovery
  route, a checkpoint pause. These are precisely the lines a watcher should
  surface immediately rather than sit on.

## Consumers, each thin

1. **`circuit watch <run-folder>`** tails the stream and prints it. One-shot
   sibling: `circuit status <run-folder>` prints the latest milestone plus
   the existing status projection. Host docs then need one sentence:
   background the run, watch it with `circuit watch`.
2. **Host agents.** The operator skill and plugin command docs teach the
   standing pattern: background the run, watch the milestone stream, relay
   milestones in the standard readout-card shape, push anomalies and pauses
   immediately. Agents stop re-deriving the filter/translate/rate/anomaly
   stack because the engine did it once.
3. **The TUI and any crow's-nest view** read the same stream, honoring the
   parity rule that presentation surfaces carry no logic of their own.
4. **A notify hook, later.** Config such as `notifications.command`: the
   engine execs a user-supplied executable per milestone with the event JSON
   on stdin (matching the house rule that hooks read stdin JSON for
   identity). This reaches humans through desktop or chat channels even when
   no agent is watching. It is a new config surface, so it is explicitly a
   later slice.

The highest-value single event across every consumer is the checkpoint
pause. "The run is waiting on you" should be the first thing pushed through
every channel that exists; a parked run costs wall-clock time for as long as
it goes unnoticed.

## Relation to neighboring ideas

- [output-model.md](output-model.md) shapes the foreground presentation:
  what an attached wrapper renders during a run and the final digest. The
  milestone stream is the durable substrate underneath; the wrapper could
  eventually render from it, which would collapse two narration paths into
  one.
- [long-horizon-supervision.md](long-horizon-supervision.md) proposes a
  supervisor model on a heartbeat and a crow's-nest overview for hours-long
  goal-mode runs. That design puts a second model in the loop. This idea is
  the deterministic layer below it: the supervisor and the crow's nest are
  both consumers of the milestone stream, not alternatives to it.
- [multi-channel-hitl-proposal.md](multi-channel-hitl-proposal.md) designs
  delivery of checkpoint decisions across channels. The checkpoint-pause
  milestone is the trigger event that gateway would consume.

## Boundaries

- Not a second source of truth. The stream is a projection of the trace and
  carries nothing the trace does not.
- No model anywhere in the emission path. Milestone text is deterministic
  string assembly from typed trace fields.
- Not a replacement for `circuit checkpoints`, the operator summary, or the
  presentation wrapper. It feeds them.
- No new config surface in the first slice. The notify hook is deliberately
  last.

## Sequencing

1. **Now, freeze-compatible (docs only).** Teach the background-and-watch
   pattern in the operator skill and host command docs using what exists
   (tail the trace or poll the run folder), including the readout-card shape
   for updates and the rule that pauses are relayed immediately. This slice
   is launch work; it changes no engine surface.
2. **Post-v1, slice 1.** Emit `status.ndjson` from the runtime and add
   `circuit watch` / `circuit status --follow` over it. Failing tests first:
   a runtime test asserting milestone emission for a fixture run, a CLI test
   over a recorded stream.
3. **Post-v1, slice 2.** Anomaly milestones: relay overdue, verification
   timed out, recovery routed, checkpoint pause. The `timed_out` observation
   field ships with the friction remediation and is the first input.
4. **Post-v1, slice 3.** The notify hook config surface, off by default.

## Open questions

- File name and home: `status.ndjson` beside `trace.ndjson`, or under
  `reports/`? Beside the trace matches its nature (a stream, not a report).
- Does the presentation wrapper switch to consuming the stream, or keep its
  own projection? Collapsing them is attractive but touches the shipped
  narration contract, so it should be its own decision.
- Should milestone text vary per host profile, or is one plain-English
  rendering enough for all consumers? Start with one; profiles only if a
  real host needs it.
- Cross-run watch: does `circuit checkpoints --follow` (all parked runs, live)
  earn its place once per-run watch exists?

# Run milestone stream: live legibility for backgrounded runs

Status: active design, green-lit by the operator 2026-07-14 as the live
run feedback piece of the first-run experience
([turnkey-first-run.md](turnkey-first-run.md), constraint: the honest
in-run surface is silence until a milestone stream exists). One earlier
idea in this document stays dead: do not build a second persisted
`status.ndjson` beside the trace. The
[CLI rebuild plan](cli-first-principles.md) rejected dual persistence with
reasons, and this design honors that ruling. What changed on 2026-07-14 is
the diagnosis: the engine already emits the milestone stream. The missing
piece is delivery, and the
[feasibility spikes](../learnings/first-run-feasibility-spikes.md) proved
both hosts can deliver it today.

## The problem

A Circuit run is a long-running process. When a host agent operates Circuit
the run occupies a blocking shell call, and for minutes to an hour the
operator sees nothing. The host model does not execute while the call is
open, so it cannot narrate, no matter what the engine emits.

A host that improvises around this must re-derive four things from scratch:
which trace entries are narratable, how to say them in operator language,
how often to speak, and which events are anomalies that should be pushed
immediately. The pursue battle-test run `4cb86d0b` (2026-07-10) paid this
tax with a bespoke tail-and-filter script; the friction findings are in
[docs/release/agent-friction-remediation.md](../release/agent-friction-remediation.md).

## The corrected diagnosis (2026-07-14)

The original version of this document assumed the engine lacked a milestone
stream and proposed building one. That was wrong by omission. The engine
already has it:

- **ProgressEvent v1** (`src/schemas/progress-event.ts`) is a typed,
  versioned event family covering run start, route selection, step
  transitions, relay start and verdict, evidence collection and warnings,
  fan-out lifecycle, checkpoint waits, structured user-input requests,
  task-list updates, and run close.
- Every event carries `display.text` (operator language, 240-char cap),
  `display.importance` (`major` or `detail`), and `display.tone`
  (`info`, `success`, `warning`, `error`, `checkpoint`). The filtering,
  translation, and rate-control work is already done at emission time.
- `circuit run --progress jsonl` writes one event per stderr line and keeps
  the final result JSON on stdout (`src/cli/run.ts`, `progressReporter`).
  The projection from trace facts is deterministic
  (`src/runtime/projections/progress.ts`); no model sits in the emission
  path.
- `user_input.requested` even carries pre-built questions with options and
  an exact resume command, designed for a host to re-ask in its own UI.

So the gap is not emission. It is that nothing teaches a host to get out of
the blocking call and watch the stream with the model in the loop.

A correction to this document's first version of that claim: the Claude
surface is not missing the flag by accident. The Claude plugin deliberately
wraps runs in `present` mode (`plugins/claude/scripts/circuit.ts`, rendering
rules in `docs/contracts/host-rendering.md`): the wrapper itself passes
`--progress jsonl`, parses the stderr events, and streams `⎿ status_text`
blocks into the foreground shell output, which the operator watches live in
the terminal. The operator-visible feed exists on Claude today. What the
foreground call cannot give is the model: it cannot narrate
conversationally, cannot map `user_input.requested` to the host's question
UI mid-run, and cannot do anything else while the run holds its turn. Codex
has no present wrapper; its command doc asks the agent to parse the events
and render the blocks itself, which is where the observed improvised-voice
narration came from (agents add their own lines inside the blocks unless
forbidden).

## The design: a delivery pattern, not a new surface

No engine changes in the first slice. The design standardizes how a host
runs, watches, and relays, and it lives in the host-facing command surfaces.

**1. Background the run.** The host starts Circuit in the background so its
own turn loop stays free:

- Claude Code: run the CLI with its background execution option; the
  harness captures stderr and the host watches the task with its monitor
  tool, waking per event. Spike-proven: event-driven, one message per
  milestone.
- Codex: shell background with stderr redirected to a file the host
  chooses (`--progress jsonl 2>"$PROGRESS_LOG" &`), then a bounded
  tail-and-sleep poll. Spike-proven: batched updates, same content.

**2. Relay by the curation contract.** The stream is pre-curated; the host
applies three rules instead of judgment:

- Relay `display.text` near-verbatim for `importance: major` lines. Do not
  add your own summary or paraphrase (the spike showed Claude does unless
  told not to; this sentence ships in the command surfaces).
- Push immediately when `tone` is `checkpoint` or `error`, and for
  `user_input.requested` (map its questions to the host's question UI) and
  `checkpoint.waiting` (say the run is waiting and quote the resume
  command). A parked run costs wall-clock time for as long as it goes
  unnoticed; this stays the highest-value event in the design.
- Ignore `importance: detail` lines. They exist for attached wrappers and
  debugging, not conversation.
- Never put host-authored words inside a Circuit-voiced surface. If the
  host wants to add commentary (what it is waiting for, what it will do
  next), that goes outside the block, in the host's own voice. Field
  evidence, 2026-07-14: a Codex session narrating a live Fix run
  rendered Circuit-labeled status blocks that mixed genuine engine
  lines with its own first-person improvisation ("I'm keeping it
  uninterrupted..."), and the two were indistinguishable to the
  operator. A Circuit-labeled line is an engine assertion; the host
  must not be able to put claims in Circuit's mouth.

**3. Close on the receipt.** The final stdout JSON and the operator summary
stay the terminal surface, unchanged. The stream never replaces the
receipt; it fills the silence before it.

**Degradation.** If the host never backgrounds, never watches, or the
watcher dies, behavior is exactly today's: a silent run with an intact
receipt and the trace as ground truth. The stream is advisory. Nothing in
the engine waits on a consumer.

## Why not a milestones file

An engine-written `milestones.ndjson` beside `trace.ndjson` was this
document's original shape and briefly resurfaced in the first-run design
sketches. It stays rejected, for the rebuild plan's reasons: trace
persistence must succeed before progress projection, projector failures are
swallowed, and a second durable feed can silently diverge from the truth it
mirrors. The stderr stream avoids all of that: it is transient, emitted
in-process from the same deterministic projection, and rebuildable from the
trace if lost. On Codex the host's own redirect file plays the file role
without the engine owning a second source of truth.

## Consumers, each thin

1. **Host agents** are the primary consumer and the first-run payload: the
   command surfaces teach background-watch-relay once, and every session on
   both hosts inherits it.
2. **The presentation wrapper and TUI** already consume the same events for
   attached runs, honoring the parity rule that presentation surfaces carry
   no logic.
3. **`circuit watch <run-id>`** arrives with the CLI rebuild as the durable
   reattach surface over ProgressEventV2. This design feeds it: the relay
   rules and event grammar carry over unchanged, so hosts taught the
   pattern now need no retraining after the rebuild.
4. **A notify hook, later.** Config such as `notifications.command`, the
   engine execing a user executable per event. New config surface, so
   explicitly a later slice.

## Sequencing

1. **Done: this design.** Docs only.
2. **Launch scope (first-run experience work): the delivery slice.** Two
   host-specific halves. Codex: tighten the progress instruction in
   `src/commands/run.md` (which the Codex mirror keeps) to carry the
   verbatim rule, the voice-attribution rule, the push-immediately rule,
   and the background-and-poll pattern for long runs. Claude: keep the
   present wrapper as the foreground default (it is test-locked and
   already gives the operator a live feed); strengthen the generated
   instruction so the model handles checkpoint parks by re-asking through
   its question UI and never adds its own lines to a Circuit-labeled
   block. Prove in the container first-run lab. The bigger Claude fork,
   switching long runs to background-plus-monitor so the model can
   narrate conversationally per the spike evidence, is a UX decision for
   the operator, not a doc slice; it is recorded as an open question
   below.
3. **Post-v1: anomaly events.** Relay running far past typical duration,
   verification `timed_out`, recovery routed. These are new event types in
   the v1 family or arrivals in ProgressEventV2, whichever ships first.
4. **Post-v1: reattach and reach.** `circuit watch` per the rebuild plan;
   the notify hook last.

## Relation to neighboring ideas

- [turnkey-first-run.md](turnkey-first-run.md) is the driving spec: its
  adversarial pass made in-run silence a binding constraint and named this
  stream the missing piece. The spikes then showed the piece was delivery,
  not emission.
- [output-model.md](output-model.md) shapes the attached foreground
  presentation and the final digest. Same events underneath; different
  attachment.
- [long-horizon-supervision.md](long-horizon-supervision.md) puts a
  supervisor model on a heartbeat for hours-long runs. That supervisor is a
  consumer of this stream, not an alternative to it.
- [multi-channel-hitl-proposal.md](multi-channel-hitl-proposal.md) designs
  checkpoint delivery across channels; `checkpoint.waiting` and
  `user_input.requested` are its trigger events.
- [docs/specs/narration-display-profiles.md](../specs/narration-display-profiles.md)
  and [docs/contracts/host-rendering.md](../contracts/host-rendering.md)
  own the rendering rules for hosts that display rather than converse.

## Boundaries

- Not a second source of truth. The stream is a projection of trace facts;
  if they ever disagree, the trace wins.
- No model in the emission path. Event text is deterministic string
  assembly, which is what makes verbatim relay safe.
- Not a replacement for the operator summary, `circuit checkpoints`, or
  exit codes. It fills the gap between run start and receipt.
- No new persisted file and no new config surface before the rebuild's
  `watch` lands. The notify hook is deliberately last.

## Open questions

- The Claude foreground fork, for the operator: keep `present` (a live
  terminal feed, model out of the loop until the call returns) or move
  long runs to background-plus-monitor (conversational narration and live
  question relay, no streaming terminal blocks). The spike proved the
  second works; the first is shipped and test-locked. They can also
  coexist by run length, at the cost of two code paths to teach.
- Should milestone text vary per host profile, or is one plain-English
  rendering enough? Start with one; profiles only if a real host needs it.
- When the rebuild's ProgressEventV2 lands, does the v1 stream bridge or
  hard-cut? The rebuild plan's compatibility matrix owns that answer; this
  design only requires that `display.text`, importance, and tone survive.
- Does a `checkpoints --follow` cross-run view earn its place once
  single-run watching is routine? Revisit after the delivery slice ships.

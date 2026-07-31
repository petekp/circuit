# Run output and observability: make watching a run pleasant

Status: proposal. The receipt-delivery fix shipped alongside this note; the
rest is ranked design work.

## The evidence

One live Review run through the Codex host (run `6ba34d9e`, 2026-07-30)
produced 23 progress lines. Measured against what an operator needs:

- 6 of the 23 lines (26%) were byte-identical duplicates of the line directly
  before them. Every step transition fires twice: once as a step event, once
  as a task-list event carrying the same text.
- One more line was a near-duplicate with inconsistent voice: "Circuit:
  Finished checking the result." followed shortly by "Finished checking the
  result." — same fact, one branded, one not.
- The host model then pasted all 23 lines into chat verbatim, so the operator
  read the stream twice: once as tool output, once as narration.
- The closing line was "Run closed with outcome complete via @complete." —
  an internal close sentence with a codename — followed by a raw enum
  ("Circuit verdict: `NO_ISSUES_FOUND`") and an internal branch id
  ("branch unit-1") earlier in the stream.
- The actual receipt Circuit wrote for the operator
  (`reports/operator-summary.md`, a good one) never reached the host at all.
- Single-width fan-out narrated itself as "Comparing 1 option..." — broken
  English for the default case every run hits.

The engine's receipt is good. The delivery and the live stream are where the
experience degrades.

## Shipped now

- **Receipt restored on the Codex host.** The completing `circuit_status`
  payload now digest-binds `reports/operator-summary.md` and delivers it as
  `final_report.operator_summary_markdown`; the run skill renders it verbatim
  and stacks nothing on top. The payload summary now prefers the receipt's
  plain-English status line over the machine close sentence, so "@complete"
  no longer reaches the operator. (The Claude host already rendered the
  receipt via the host-rendering contract; the CLI prints it itself.)
- **Skill-level dedup.** The run skill now skips an event whose summary text
  is identical to the previously rendered line, and translates internal enum
  tokens into plain words at final render.

## Proposed, in rank order

### 1. Stop emitting the duplicate line (engine)

The step executor and the task-list projector both emit a display line for
the same transition. Fix at the source so every consumer (CLI, both hosts,
TUI) benefits: task-list update events should carry no operator-facing
display text when their text equals the step transition that caused them —
or better, they should never carry display text at all; they are bookkeeping,
not narration. This alone cuts delivered volume by about a quarter.

### 2. One voice (engine)

Every operator-facing line should share one grammar: same tense, same
subject, no sometimes-on "Circuit:" prefix. Recommendation: the engine emits
unbranded prose ("Started Review.", "Asking the reviewer to check the
result...") and each host owns whatever labeling its transcript uses. The
prefix inconsistency today is the engine deciding presentation it doesn't
own.

### 3. Grammar-aware narration (engine)

- Fan-out width 1 (the default) narrates nothing about comparison or
  branches. "Comparing 1 option..." and "Started branch unit-1." disappear
  from the common path.
- Width > 1 narrates with real plurals and human labels ("Comparing 3
  approaches...", "Second approach finished."), never internal unit ids.

### 4. A jargon floor with a test (engine + flows)

No operator-facing string may contain an @-target, a SCREAMING_CASE enum, a
schema id, or an internal codename. Enforce it the way soundness rules are
enforced: a test that walks every progress display text, close summary, and
checkpoint prompt against a denylist. Rule 3 of the agent guide currently has
no teeth; this gives it some.

### 5. Narrate the arc, not just the ticks

The stream tells you what just happened but never where you are. The relay
step is the long pole (most of the run's wall clock) and renders as one line
followed by silence. Two cheap improvements:

- Milestone lines carry a sense of position: "Step 2 of 3", or the receipt's
  dials line rendered at start ("power medium · 1 worker run") so the
  operator knows the shape of what they're waiting for.
- Long-running relays set expectations up front: "Asking the reviewer to
  check the result (usually the longest step)...".

This connects to the existing milestone-stream work: the engine already emits
a progress stream; delivery to the Claude command surface is still the gap.

### 6. Codex host ergonomics (skill)

Two model-behavior costs observed in the live session:

- The model spent ~50 seconds grepping Circuit's source to answer "what does
  high power do?" when the tool schema already said it. The run skill should
  carry a three-line dial reference so dial questions are answered from the
  skill, not the source tree.
- Codex's exec wrapper showed an empty output cell for `circuit_start` while
  the real response arrived in the tool-call event, and the model burned a
  `circuit_list` round trip re-deriving the run id. The skill already says to
  keep the returned `run_id`; worth re-checking after the next Codex release
  whether the empty-cell display is theirs to fix (it appears to be).

## Non-goals

- No second summary voice. The receipt is the one human-facing report; hosts
  render it, they do not paraphrase it.
- No progress spinner theater. Fewer, truer lines beat animated noise.

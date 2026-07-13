# Output Model: Flow Status Indicator and Final Digest

Status: scoped proposal, 2026-06-02, revised 2026-07-11. The final-digest
content and host display research remain useful. The
[CLI rebuild plan](cli-first-principles.md) supersedes this document's
transport, routing-checkpoint, direct terminal, and progress-stream mechanics.
Its host constraints describe host plugins, not the new direct CLI TUI.
Companion to
[docs/contracts/host-rendering.md](../contracts/host-rendering.md) and
[docs/specs/narration-display-profiles.md](../specs/narration-display-profiles.md).

## Purpose

Sharpen two operator-facing surfaces without adding noise:

1. The flow status indicator (what the operator sees before and during a run).
2. The final digest (the readable result, instead of a one-line status or raw JSON).

## The constraint that shapes everything

Circuit never paints the terminal. The host owns the screen. Verified across
both hosts on 2026-06-02:

- No host renders plugin-drawn rich or interactive UI inline. Richness can only
  live in an openable artifact (an HTML file the host opens in a browser or
  preview pane). True inline custom UI exists only in ChatGPT and the MCP Apps
  client list, neither of which is the Claude Code or Codex coding surface.
- No animation is possible from the plugin. Hosts capture the wrapper's stdout
  as a string and repaint their own view. Carriage returns and cursor-motion
  escapes are not honored, so a self-animating indicator cannot animate.
- The whole run is a single subprocess call. On the desktop apps, the VS Code
  panel, and Codex, that subprocess output is buffered until the run exits, so
  the operator sees nothing from the stream until the run finishes, then the
  whole block at once. Only the bare terminal shows it grow live.
- The host already animates its own working spinner during the run. That motion
  is free and uncontrollable.
- The display budget stands: no raw JSON, no paths by default, at most four to
  six final bullets, at most three reviewer cautions
  ([narration-display-profiles.md](../specs/narration-display-profiles.md)).
- On Claude's default streamed run, the present wrapper appends a single summary
  status line at completion and returns; it never prints any digest markdown. A
  quiet or piped run does print markdown, but precedence makes it the terse run
  surface (a status line plus artifact links), not the readable operator summary;
  the readable summary renders only when the run surface is absent. So today the
  readable result does not reach the operator on either path by default
  (`plugins/claude/scripts/circuit.ts` `renderFinalResult`, the
  `statusBlocks.renderedAnyBlock` early return;
  `plugins/claude/scripts/present-rendering.ts` `finalAnswerMarkdownPath`
  precedence).

## The lever: three output channels

Assign each job to the channel that can actually carry it.

| Channel | What it is | Liveness | Richness |
| --- | --- | --- | --- |
| A. Model narration | The assistant's own words around the call | Live on every surface | Full markdown |
| B. Circuit status stream | The wrapper's subprocess stdout | Live on the terminal only; batched on apps and Codex | Append-only text |
| C. Host spinner | The host's own working indicator | Live everywhere, free | None, uncontrollable |

Caveat on A: on Codex there is no present wrapper. The Codex model renders both
progress and the final answer by following its run skill, so A on Codex is
best-effort, not guaranteed. Treat the deterministic record (B) and the digest
that hosts render verbatim as the surfaces that must carry anything load-bearing.

Principle: liveness and the why ride A, the durable record rides B, motion is
already handled by C. Today Circuit leans almost everything on B, the most
constrained channel. That is the root of both problems.

## Concern 1: Flow status indicator

### Surface the chosen flow and its reason before the body runs

The flow is decided at the very start of a run, before the flow body does real
work. Make that choice visible, and correctable, before the body runs. This
matters more as flows multiply and start to overlap.

The rule is: the decider owns the why. Never narrate a reason you do not own.

- Assistant-picks path (the common `/circuit:run` case). The host model
  recommends a flow from the rubric and invokes Circuit with an explicit flow
  name (`src/commands/run.md`). It states the flow and its own one-line reason
  before the call, so the operator can redirect in-thread before anything runs.
- Circuit-routes path (no explicit flow, or autonomous). The deterministic
  router decides, and it decides inside the run, after any pre-run prose. So the
  reason cannot be narrated up front. Add a routing checkpoint: Circuit chooses,
  then pauses before the flow body and shows "Chose Review because X. Continue,
  or pick another?" Checkpoints are already a first-class pause, so this works on
  every host, including the buffered ones.
- Gate the checkpoint on confidence. When the router can express ambiguity
  (close candidates or low confidence) it pauses; when it is confident it
  proceeds. Confident routes stay fast, ambiguous ones get a confirm. This is
  what scales as overlapping flows grow.

Correction to the prior draft: `router_reason` is not "computed and discarded."
It is emitted on the `route.selected` event and the stdout JSON, and the Codex
run skill is already told to surface it. But on the dominant explicit path it is
the literal string `explicit flow positional argument`, not a reason. So it is
the source of the why only on the classifier path, and only after the route
resolves, never as pre-run prose (`src/cli/circuit.ts`, the explicit-branch
reason and `classifyCompiledFlowTask`).

### During-run record

The record rides B and is built only from what the run emits live. Result-derived
facts (the verdict, counts, the final outcome) are not in the stream today
(`step.completed` is suppressed); they belong to the digest.

- Step then outcome. Each step shows an in-progress line, then its outcome where
  the run actually emits one (an evidence warning, a relay verdict). Keep the
  in-progress cue; do not go all past tense, or a slow step shows nothing until
  it finishes on the bare terminal.
- Visual nesting is terminal-only. The presentation model has a depth field, but
  the shipped wrapper ignores it, the host-rendering contract treats depth as
  metadata, and Codex renders by model. So a flat step-then-outcome pair is the
  guaranteed form; nested indentation is a Claude-terminal enhancement, not a
  cross-host promise.
- Keep the routed-flow confirmation. The `Circuit · <Flow>` header carries the
  actual `flow_id`, the flow-name signal the old `Chose <flow>.` line provided.
  That line also carried thoroughness in its text when set
  (`Chose <flow> with <mode> thoroughness.`); the `flow_id` alone does not encode
  it, so to keep that signal the header includes the mode when one is set, for
  example `Circuit · Review · deep`. Note that tests and the create and handoff
  emitters reference the old line, so changing it touches them.
- No faux ticking checklist in the text stream. A native task surface is a
  separate, legitimate channel where the host has one: the engine already emits
  `task_list.updated`, which Claude can map to TodoWrite. That is fine; the rule
  is only against a fake checklist in the streamed text.
- No animation. The host spinner (C) covers motion.

Today (terminal):

```
Circuit
⎿ Chose review.
⎿ Framing the work...
⎿ Checking the result...
⎿ Finished Review.
```

Proposed. Channel A, before the call (assistant-picks path), or the routing
checkpoint (router path):

> Running **Review** because you asked to check the last change. It will frame
> the work, gather evidence, check the result, and return a verdict.

Channel B, the record, step then outcome:

```
Circuit · Review
⎿ Framing the work
⎿ Collecting evidence
   ⎿ 1 warning
⎿ Checking the result
   ⎿ Reviewer confirmed
```

### Resume

A resume run continues a checkpoint and has no flow-routing moment, so "why this
flow was chosen" does not apply. Resume framing states what is being continued,
not why a flow was picked.

## Concern 2: Final digest

### Make the digest actually reach the operator

There are two problems, not one. On the normal streamed run the completion
render emits a one-line status and returns, so no digest markdown is printed at
all. On the quiet path markdown is printed, but precedence makes it the terse run
surface, not the readable summary. So the fix has two parts: make the completion
render emit the digest on the streamed path, and make the readable digest win
precedence over the terse run surface (or converge the two).

This is a two-host change, and it touches the contract:

- Claude: the present wrapper prints the digest at completion regardless of
  whether the stream rendered.
- Codex: there is no wrapper. The model renders the final answer from JSON per
  [host-rendering.md](../contracts/host-rendering.md), so the digest reaches the
  operator only if the contract requires it and the model complies.
- The host-rendering contract changes too. It currently lets the terse run
  surface win and lets the streamed path skip the digest.

### One content, host-aware delivery

There is one digest, authored once as markdown, rendered identically on every
host. We do not fork content per host.

The optional richer HTML artifact is also one artifact. Only the open mechanism
adapts per surface:

| Surface | Inline digest | The richer report |
| --- | --- | --- |
| Claude CLI | same markdown | auto-opens in the OS browser (already ships) |
| Claude desktop | same markdown | click the path, opens in the preview pane |
| Codex CLI | same markdown | path surfaced, the operator opens it |
| Codex desktop | same markdown | opens in its in-app browser |

We do not build an app-native rich UI today, because neither coding surface
renders plugin-drawn UI (Codex MCP app panels are flag-gated off). Surfacing the
artifact path is the permitted exception to "no paths by default": an
offer-to-open path, not a dump of every report path.

### Outcome-shaped skeleton, not verdict-shaped

The frame is consistent across flows; the content adapts to each flow's real
result. It must stay within the display budget.

1. Headline: flow plus outcome.
2. One-line assessment.
3. Up to four key points.
4. Caveats, at most three.
5. Next action.

The outcome is per-flow, not a universal verdict: Review is clean or has issues,
Build is implemented with a verification status, Explore is a decision, Pursue is
a set of counts, Goal is a gate result. The skeleton wraps the existing per-flow
projectors; it standardizes the frame, it does not replace them.

Preserve honest failure. The operator summary already overrides the headline for
escalated, aborted, and checkpoint outcomes so a failure cannot read as
"complete" (`src/shared/operator-summary-writer.ts`). The skeleton must keep
those overrides. The non-complete outcomes also need a defined digest shape.
Today the present wrapper falls back to a generic line for several of them.

Today (the default streamed run): a single status line, no readable result.

```
Circuit
⎿ Review complete. Verdict: CLEAN. Findings: 0.
```

Proposed inline digest:

```
Circuit · Review: Clean

Reviewer inspected the staged diff and untracked-file evidence and found
nothing actionable in scope.

· Checked the relayed review-intake report
· Cross-checked the staged diff against untracked-file metadata
· Caveat: untracked file contents were omitted (metadata-only policy)

Next: nothing required.
```

## What changes versus today

| Change | Where |
| --- | --- |
| Surface the flow and reason before the body runs; add a confidence-gated routing checkpoint on the router and autonomous paths | host rubric (`src/commands/run.md`, Codex run skill) plus the checkpoint machinery |
| Stop treating `router_reason` as the pre-run why; surface the router reason after the route resolves, classifier path only | host command surfaces |
| During-run record as step-then-outcome pairs from live data; keep an in-progress cue; move result facts to the digest | runtime projector (`src/runtime/projections/progress.ts`) and each flow's `runtimeSurface.progress` |
| Keep the routed-flow confirmation via the flow header; account for the dropped `Chose <flow>.` line's tests and create and handoff emitters | route.selected presentation and its dependents |
| Make the completion emit the readable digest: unblock the streamed early return and make the readable digest win over the terse run surface, on both hosts | present wrapper (`plugins/claude/scripts/circuit.ts`), `present-rendering.ts`, Codex run skill, and [host-rendering.md](../contracts/host-rendering.md) |
| Digest skeleton outcome-shaped, reusing per-flow projectors and the failure overrides | `src/shared/operator-summary/projections.ts`, `src/shared/operator-summary-writer.ts` |
| One digest content; host-aware artifact open (already ships on Claude); generalize HTML where it earns its place | wrapper, summary writers |
| Converge or flip the two writers while preserving the run-envelope `surface_output.status_text`, decision-packet links, and `memory_indicator` | `src/app/run-envelope/source-record.ts`, summary writers |

## Open decisions for review

1. Digest writer: enrich or flip precedence first (less coupling risk), or
   converge into one writer. Either way it must keep emitting the run-envelope
   `status_text` (the stdout field hosts parse), the decision-packet links a
   contract test pins, and the `memory_indicator`. Leaning: enrich or flip first.
2. Inline digest skeleton: confirm the five slots, with an outcome-shaped
   headline rather than a verdict.
3. HTML scope: Build, Explore, and Prototype already have HTML projectors.
   Decide whether to generalize to the remaining flows, and on what value driver
   (failure legibility versus comparison-heavy results). Leaning: failure and
   evidence legibility before broad coverage.
4. Routing checkpoint: always on, confidence-gated, or off by default; and
   whether the classifier can expose confidence or candidates, which may be new
   work. Leaning: confidence-gated.
5. Resume framing: what a resume surface states in place of a routing why.
6. During-run record on buffered surfaces: keep it, or let the digest carry the
   whole story there, since the record and digest arrive together at the end.

## Build sequence

1. Lock this spec.
2. Make the completion emit the readable digest: unblock the streamed early
   return, and make the readable digest win precedence over the terse run
   surface. This fixes the real "operator never sees the result" bug. Prove on a
   real run folder, both streamed and quiet, on both hosts.
3. Surface the flow and reason before the body runs, and add the routing
   checkpoint, gated on confidence. Prove on both hosts.
4. Make the digest skeleton outcome-shaped, reusing the projectors and keeping
   the failure overrides.
5. Writer convergence or flip preserving the coupled fields; host-aware artifact
   open and HTML generalization as a follow-on.

## Corrected from adversarial review (2026-06-02)

An in-session adversarial review (six attack dimensions, per-finding refutation,
two completeness critics) found the three-channel diagnosis sound but corrected
the load-bearing specifics:

- The pre-run why cannot come from `router_reason`; the decider owns the why, and
  the router path needs a checkpoint, not pre-run narration.
- The operator does not see the readable digest today for two reasons: the
  streamed completion short-circuits to a one-line status, and the quiet path's
  precedence prints the terse run surface instead of the readable summary. The
  fix addresses both, on both hosts, contract included.
- The during-run record must use only data each surface has; the verdict and
  other result facts move to the digest, and an in-progress cue stays.
- The skeleton must be outcome-shaped and must keep the existing escalated,
  aborted, and checkpoint failure overrides, or failures can read as clean.
- Writer convergence must preserve the run-envelope `status_text`,
  decision-packet links, and `memory_indicator`; dropping the `Chose <flow>.`
  line touches tests and the create and handoff emitters; resume has no routing
  why; native task surfaces are a legitimate separate channel; host-aware open
  already ships on Claude; and Build, Explore, and Prototype already have HTML.

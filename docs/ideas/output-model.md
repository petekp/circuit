# Output Model: Flow Status Indicator and Final Digest

Status: retained proposal, 2026-06-02, reconciled 2026-07-17. This document now
owns only the final-digest content model and the useful display-budget research.
[run-milestone-stream.md](run-milestone-stream.md) owns during-Run legibility
and control. The [CLI rebuild plan](cli-first-principles.md) owns transport,
watching, liveness, direct terminal UI, and cancellation. Older routing and
host-buffering proposals below are marked as historical rather than current
contracts. Companion to
[docs/contracts/host-rendering.md](../contracts/host-rendering.md) and
[docs/specs/narration-display-profiles.md](../specs/narration-display-profiles.md).

## Purpose

Sharpen two operator-facing surfaces without adding noise:

1. The flow status indicator (what the operator sees before and during a run).
2. The final digest (the readable result, instead of a one-line status or raw JSON).

## The current display boundary

The 2026-06-02 research correctly established a small display budget, but its
universal buffering diagnosis is now historical. Claude's `present` wrapper can
render attached progress incrementally. Codex delivery remains model-mediated.
The target direct CLI can own a real Run viewer after the CLI rebuild.

The current channel split is:

| Channel | Job | Truth boundary |
| --- | --- | --- |
| Circuit progress | Curated attached milestones plus some invocation-local presentation or action events | A mixed, transient feed; not every event is a replayable Trace projection |
| Host-native status and tasks | Layout, replacement, motion, and host controls | Must not invent Circuit facts or legal actions |
| Host commentary | The host's own plan or interpretation | Clearly outside Circuit-labelled status surfaces |
| Operator summary | One readable terminal receipt | Authoritative content rendered verbatim |
| Trace and supporting reports | Durable detail and debugging | Ground truth, normally behind disclosure |

The display budget still stands: no raw JSON or internal paths by default, a
short outcome-shaped summary, at most four key points, and at most three
caveats. Live cadence, quiet-state health, and controls are defined in
[run-milestone-stream.md](run-milestone-stream.md).

## Flow choice and live status

### Surface the chosen flow and its reason before the body runs

The host selects an explicit Flow under the current contract. The decider owns
the reason: if the host recommends Review, the host may briefly say why before
it invokes Circuit. Circuit's Run header confirms the Flow that actually ran.

The earlier proposal for a classifier-owned, confidence-gated routing
Checkpoint is superseded. It conflicts with the current explicit-Flow contract
and is not part of the recommended Run UX.

### During-run record

The live record uses only facts the Run emits. Result-derived facts belong to
the final digest unless the canonical progress projection emits them.

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
  separate, legitimate channel where the host has one. Cross-host task-list
  parity is not yet proved, so do not claim it from the event alone.
- No animation frames in the event text. Use host-native motion where it helps.

Today (terminal):

```
Circuit
⎿ Chose review.
⎿ Framing the work...
⎿ Checking the result...
⎿ Finished Review.
```

Proposed host commentary before the call:

> Running **Review** because you asked to check the last change. It will frame
> the work, gather evidence, check the result, and return a verdict.

Circuit's live record, step then outcome:

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

## Final digest

### Make each close outcome-shaped

The current [host-rendering contract](../contracts/host-rendering.md) makes the
operator summary the preferred readable close. Claude renders it through its
wrapper; Codex is instructed to prefer it. Progress never replaces the digest.
Every invocation should produce one outcome-shaped close. A waiting Checkpoint
gets a parked receipt that makes continuation clear; failed, aborted, canceled,
and complete terminal outcomes get an honest final digest.

### One content, host-aware delivery

There is one digest, authored once as markdown, rendered identically on every
host. We do not fork content per host.

The optional richer HTML artifact is also one artifact. Only the open mechanism
adapts per surface:

| Surface | Inline digest | The richer report |
| --- | --- | --- |
| Claude CLI | same markdown | labelled open action; current wrapper may open the OS browser |
| Claude desktop | same markdown | labelled link or preview action |
| Codex CLI | same markdown | labelled report link; reveal the path only on request |
| Codex desktop | same markdown | labelled in-app open action |

We do not build an app-native rich UI today. The default surface offers a
labelled report action or link, not a raw path. A plain host may reveal the path
after the operator asks for details, but it does not dump every report path into
the close.

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
"complete" (`src/app/operator-summary/writer.ts`). The skeleton must keep
those overrides. The non-complete outcomes also need a defined digest shape.
Today the present wrapper falls back to a generic line for several of them.

Historical 2026-06-02 failure case: the default streamed Run closed on a single
status line instead of the readable result. The current host contract now makes
the operator summary the preferred close.

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

## Historical implementation sketch

The table below records the 2026-06-02 proposal. It is not a current build plan.
In particular, its routing Checkpoint and progress transport rows are
superseded by the explicit-Flow host contract, the shipped delivery slice, and
the CLI rebuild.

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

## Historical open decisions

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

## Historical build sequence

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

# Intra-run decision carry-forward

Status: `current-proposal`. Not built. This is a design note to return to
later, grounded in the real seams as of 2026-06-26 (branch
`feat/portable-flow-format`, HEAD `54171c7b`). Verify exact function names and
field shapes against current code before building; the architecture below is
accurate, the symbol names are the ones that existed at writing time.

## One line

When the operator settles a decision at a checkpoint, carry that decision
forward into the next relay's prompt as a "this is already settled" signal, so
a downstream agent does not re-litigate, re-derive, or silently override a call
the human already made inside the same run.

## The problem

Circuit checkpoints are decision forks. The run pauses, the operator picks one
`selection` from the step's `choices`, and the flow routes on it. That routing
works. What does not happen: the decision never reaches the agent that runs
after the fork. The relay (the coding-agent subprocess) gets a freshly composed
prompt that says nothing about what the operator just decided.

Two concrete failure shapes follow from that gap:

1. **Wasted turns.** The downstream agent re-raises or re-derives something the
   operator already resolved. In a multi-step run that is real spend on a
   question that is closed.
2. **Quiet override of the operator.** Worse than waste: the agent does not know
   a human made a call, so it can reverse it. The operator chose path A at the
   fork; a later relay, blind to that, reasons its way back to B. The run
   structurally protects the *moment* of the decision (the checkpoint) but not
   its *consequences* downstream. That is the mirror image of the anti-rubber-
   stamp property [[project_steer_flow]] is built around: there we stop the
   operator from rubber-stamping the agent; here we stop the agent from
   rubber-stamping *over* the operator.

## Where this came from

The lead nugget from the `no-mistakes` study ([[reference_no_mistakes_sibling]]).
That tool folds a sanitized history of prior fix rounds into the next fix
payload. Its own docs put the mechanism plainly: the history "tells the agent
not to re-report user-ignored findings unless the code now presents a materially
different issue." It carries which finding ids the operator selected, which were
left unselected, and one-line summaries of earlier fixes.

Steal the **principle**, not the surface. `no-mistakes` has a findings panel
with checkboxes (toggle each finding, attach a note, press `f` to fix the
selected set). Circuit has no such surface; a Circuit checkpoint is a single-
selection routing fork, not a list of dismissible findings. Do not port the
checklist UX. Port only "the operator's settled decisions ride forward into the
next agent round, sanitized."

## Current Circuit mechanism (grounded)

The producer side already records the decision and re-enters the runner:

- `src/runtime/run/checkpoint-resume.ts` validates the operator's pick (it
  rejects stale or out-of-`allow` selections) and re-enters the runner with
  `resumeCheckpoint: { stepId, attempt, selection }` (see the construction near
  the end of that file).
- `src/runtime/run/graph-runner.ts` threads `resumeCheckpoint` through the run
  (`isResumedCheckpoint`, the `resumeCheckpoint?.stepId` cursor seed).
- `src/runtime/executors/checkpoint.ts` reads it at the resumed step:
  `context.resumeCheckpoint?.stepId === step.id ? context.resumeCheckpoint.selection : undefined`.
  That selection is consumed **for routing only**.
- The decision is also recorded in the trace (there is a
  `GuidanceDecisionTraceEntryBody` and a generic human-decision block reused by
  flows such as the explainer's two operator checkpoints), so the fact of the
  decision is already durable. We do not need a new store.

The consumer side already has a structured, additive way to brief a relay. In
`src/runtime/run/relay-support.ts` the relay prompt is composed from labelled
sections, each "treat this as guidance, it does not override the response
contract" in tone:

- operator-selected local skills,
- the step's unbound house-style slot notes,
- the declared tool scope,
- delivered context from pull-then-retry (the `delivered-context` fenced block,
  rendered only when a `context_request` was answered),
- the prior-run memory pull affordance.

The gap is the wire between the two. The operator's checkpoint selection lives
in `context.resumeCheckpoint` and in the trace, but **no relay-prompt section
renders it.** The producer and the consumer are never connected.

## Proposed mechanism

Add one new additive guidance section to the relay prompt: the operator's
settled decisions for this run. Build it the way Circuit already built context
delivery, because that is the proven template for "thread a new opt-in signal
into the relay prompt without changing the default."

1. **Derive, do not store.** Read the run's checkpoint decisions from the trace
   (the human-decision / guidance-decision entries that already exist). Build a
   small in-memory "decision ledger" for the run: each entry is the decision
   point label, the chosen option, and an optional short operator note. No new
   persistent state; the trace is the source of truth.

2. **Render a sanitized section.** A new renderer in `relay-support.ts` (sibling
   to the `delivered-context` block) emits something like:

   ```
   <settled-by-operator>
   At "<decision point>", the operator chose "<option>". (note: <short note>)
   Treat these as settled. Do not re-raise or reverse them unless the work now
   presents a materially different issue; if it does, surface it, do not act on
   it silently.
   </settled-by-operator>
   ```

   Sanitize and bound: cap the note length, strip anything that is not safe to
   echo into a subprocess prompt, and render nothing when the ledger is empty.

3. **Wire it opt-in, default byte-identical.** Mirror `enableContextDelivery` /
   `contextDeliveryActive`: a run-wide signal threaded
   `graph-runner -> RunContext -> RunValue -> relay prompt`, assigned only when
   on so the key is absent by default. When off (the default), the relay prompt
   is byte-identical to today. The thin-envelope work already paid down the
   sharp edge here: the `RunValue` projection silently drops keys it does not
   name (see `thin-envelope-unlock-report.md`), so the new signal must be added
   to that projection explicitly or it will vanish.

This keeps the new channel parallel to, and independent of, the memory
suppression channel. `src/app/history/pull-suppression.ts` is **not** the seam:
it drops *memory hints* with a measured-harm verdict (the self-auditing-memory
feed-forward path, [[project_self_auditing_memory]]). Decision carry-forward is
a different feed-forward channel carrying *operator decisions*, and its home is
the relay-guidance system, not pull-suppression. Naming the analogy is fine;
sharing the code is not.

## Scope and non-goals

- **Intra-run only.** This carries decisions forward inside a single run. The
  cross-run compounding loop (decisions and lessons that survive across runs) is
  the larger unbuilt frontier ([[feedback_codify_compound_north_star]],
  [[project_feedforward_rehearsal]]). This proposal is deliberately the smallest
  safe rung of that ladder, not the ladder.
- **No findings-checklist UI.** Circuit checkpoints stay single-selection
  routing forks. We are not importing the `no-mistakes` toggle-and-fix panel.
- **Opt-in, default off, default byte-identical.** Same posture as context
  delivery and equipment reshape. Production prompts do not change until the
  signal is ratified on.
- **Validity first, efficacy later.** Proving the section renders the right
  settled decisions is plumbing (cheap, offline). Proving a primed agent
  actually stops re-raising is efficacy (a live, judged arm, separate and later).
  Do not conflate them; that discipline is why most of Circuit's frontier claims
  hold up ([[project_bespoke_flow_generation]]).

## Risks and open questions

- **Relevance scoping.** A decision settled at an early fork may be irrelevant to
  a late, unrelated step. Dumping every decision into every downstream relay is
  prompt bloat and noise. Open question: scope by step adjacency, by the route
  the decision gated, or by a relevance tag on the checkpoint? Start narrow
  (carry to the immediately-routed-into relay only) and widen only with evidence.
- **What counts as a decision.** Checkpoint `selection` is the obvious, always-on
  case. Flows that surface per-item operator notes (the explainer's human-
  decision blocks) are a maybe. Defer anything beyond checkpoint selection to a
  second slice.
- **Sanitization boundary.** Operator notes are free text going into a subprocess
  prompt. Bound length, and decide what is safe to echo. Reuse whatever the
  existing guidance sections already do for operator-authored text.
- **Staleness across resume.** Context delivery needed a `seedFromTrace` step to
  re-thread the channel after a checkpoint resume (`seedContextDeliveryFromTrace`,
  `seedEquipmentReshapeFromTrace`). The decision ledger is trace-derived, so it
  should reconstruct for free on resume, but confirm with a resume test.
- **Per-flow gating.** If a flow needs this and others should not pay for it,
  carry the opt-in through `CompiledFlowEngineFlags` (see `src/flows/types.ts`)
  rather than putting flow-specific logic in the engine.

## Smallest first slice

Validity only, no efficacy claim:

1. Render checkpoint `selection` decisions only. No per-finding notes, no memory.
2. One new additive `relay-support.ts` section, trace-derived ledger.
3. Opt-in run-wide signal mirroring `contextDeliveryActive`, default off, default
   byte-identical, added explicitly to the `RunValue` projection.
4. Carry to the immediately-routed-into relay only (narrowest relevance scope).

## Test plan (TDD)

Failing test first, per the house rule.

- **Plumbing (offline, the first slice):**
  - A flow with a checkpoint whose `selection` should appear downstream: assert
    the new section renders the settled decision text in the next relay's prompt.
  - Assert that with the signal off (the default) the relay prompt is
    byte-identical to today (the context-delivery tests are the model for this
    byte-identity assertion).
  - Assert sanitization: an over-long or unsafe operator note is bounded or
    dropped, never echoed raw.
  - Assert resume: after a checkpoint resume, the ledger reconstructs from the
    trace and the section still renders.
- **Efficacy (live, judged, a separate later arm):**
  - An agent primed with "operator settled X" does not re-raise or reverse X on a
    task where a blind control does. This is a small blinded A/B in the spirit of
    [[project_feedforward_rehearsal]], and it is the arm that actually earns the
    claim that the channel changes behavior for the better. Keep it out of the
    plumbing slice.

## Why it matters

It is the smallest, safest, already-wired-on-both-ends first rung of the
compounding-loop frontier that Circuit keeps naming as the real prize and keeps
not building. The producer (checkpoint decisions) and the consumer (the relay
guidance system) both exist; only the wire between them is missing, and the wire
has a proven template (context delivery). And it protects something Circuit
otherwise leaves exposed: the operator's authority over a decision should bind
the agents that run after it, not just the routing edge it sits on.

## Related

- [[reference_no_mistakes_sibling]] (source of the nugget)
- [[feedback_codify_compound_north_star]], [[project_feedforward_rehearsal]]
  (the compounding-loop frontier this is the first rung of)
- [[project_steer_flow]] (the anti-rubber-stamp property this mirrors)
- `docs/ideas/thin-envelope-unlock-report.md`,
  `docs/ideas/context-pull-last-mile-report.md` (the context-delivery wiring this
  copies, including the `RunValue` projection gotcha)
- [[project_self_auditing_memory]] (the *memory* feed-forward channel this runs
  parallel to and must not be merged with)

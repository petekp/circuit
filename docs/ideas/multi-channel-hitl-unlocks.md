# Multi-Channel HITL: Unlocks And Combinations

Status: proposal and opportunity exploration, 2026-06-04. This is a
source-backed product and architecture note. It is not current behavior, a
roadmap commitment, or a runtime change.

## Thesis

Multi-channel human-in-the-loop support turns a waiting checkpoint from "pause
the current chat" into "deliver a durable decision request to the right human,
through the right channel, and resume only after a verified declared choice."

The main unlock is not notifications. The main unlock is that Circuit can span
time, channels, queues, and supervision boundaries while keeping the run record
honest. Human Decision and Checkpoint stay as the decision primitive. Email,
SMS, Slack, webhooks, MCP, or future apps become delivery paths around that
primitive.

That distinction matters. If channels become their own flow blocks, Circuit
will duplicate policy across transports and blur who had authority. If channels
are delivery adapters around a checkpoint gateway, then a remote choice can use
the same resume validation that current checkpoints already use.

## What Exists Today

The source docs support three useful current facts:

1. Human Decision is already a host-neutral block. The schematic declares a
   question, options, default behavior, and unattended policy. Later steps
   should not care which host collected the answer.
2. Checkpoint and resume already form the authority crossing. A waiting
   checkpoint records the request path and allowed choices. Resume validates the
   run folder, unresolved checkpoint, request identity, allowed choice, boundary
   identity, and report shape before re-entering the run.
3. Circuit already tries to keep flow behavior separate from host rendering.
   The output model proposal strengthens that pattern by separating model
   narration, Circuit status, and host presentation.

The missing pieces are delivery, identity, reply verification, and compact
remote context. Those are product gaps, not reasons to invent a new decision
block.

## Unlock Ladder

These are ordered from smallest near-term value to larger compound features.

| Step | Unlock | What changes | Required combination |
| --- | --- | --- | --- |
| 1 | Remote declared-choice approval | Circuit can ask a human outside the current host to choose from declared options. | HITL gateway around Checkpoint resume |
| 2 | Async stuck-run recovery | A waiting run can reach the operator with enough context to decide without reopening the original chat. | HITL gateway plus run inspection |
| 3 | Better long-running supervision | A long-running executor can escalate only when it needs a human decision, not just when the host is open. | HITL gateway plus heartbeat/status view |
| 4 | Queue-driven work | Tracker-backed work can request approval, scope changes, or close confirmation across time. | HITL gateway plus tracker connector |
| 5 | Safer Skill Hook ask gates | A future `ask` hook can pause as a real checkpoint instead of silently injecting advice. | HITL gateway plus Skill Hooks `ask` transition |
| 6 | Safer parallel Pursue | Parallel workers can ask before applying change packets, resolving conflicts, or crossing risk gates. | HITL gateway plus sandboxed Pursue/apply gates |
| 7 | Better learning from interventions | Operator decisions can become cited hints and eval cases without becoming proof or authority. | HITL gateway plus memory/ratchet/evals |
| 8 | Reviewable dynamic-flow evolution | Repeated intervention patterns can become candidates for new checks, routes, or schematic changes. | HITL gateway plus dynamic-flow ratchet |

## Scenario Matrix

| Scenario | Combination | What the operator can do | Current support | Missing pieces | Main risk |
| --- | --- | --- | --- | --- | --- |
| Remote approval for a risky route | Checkpoint plus HITL gateway | Choose `continue`, `revise`, `handoff`, or `stop` from a signed link or verified reply. | Human Decision and Checkpoint/resume support declared choices. | Delivery ledger, verified reply packet, channel adapter, expiry rules. | A channel reply is treated as authority without strong verification. |
| Build waits while operator is away | HITL gateway plus run inspection | See why Circuit is asking, which run is waiting, and what each choice means. | Run folders and checkpoint request files exist. Run-inspection docs propose `runs list`, `runs events`, and `runs why`. | Read-only status and why surface tied into the decision packet. | The message implies liveness or state that Circuit has not proved. |
| Long-running flow escalates after heartbeat | HITL gateway plus long-horizon supervision | Receive a compact escalation when the supervisor detects drift, stuck work, or a policy boundary. | Long-horizon supervision is an idea, not current behavior. | Heartbeat stage, supervisor summary, escalation policy, delivery gateway. | Too many low-quality escalations make operators ignore the channel. |
| Tracker item reaches close preview | Tracker connector plus HITL gateway | Approve close, request changes, or hand off before Circuit writes tracker output. | Tracker connector is proposed as boundary-only: read at Frame, write at Close. | Close preview, recipient mapping, delivery verification, write-after-approval guard. | Tracker becomes a second source of truth for run state. |
| Skill Hook wants expert input | Skill Hooks plus Checkpoint plus HITL gateway | Answer a typed question from a future `ask` mode across email/SMS/Slack. | Current Skill Hooks notes describe active `auto` injection. `ask` is not a live pause mechanism today. | Model `ask` as checkpoint or run transition, then route through gateway. | Prompt injection masquerades as human expertise. |
| Parallel Pursue needs merge approval | Sandboxed Pursue plus HITL gateway | Approve one change packet, reject another, or ask for a narrowed retry. | Pursue exists. Sandboxed parallel Pursue is an idea with missing safe apply/change-packet boundary. | Isolated workers, change-packet contract, safe apply, approval gate. | Approval happens before the parent change is actually safe to apply. |
| Memory suggests a likely decision | Memory/ratchet plus HITL gateway | Accept a cited suggestion, correct it, or mark it as misleading. | Memory recall is hint-only and must not change routing, checkpoints, or close authority. | Decision evidence capture, post-run evaluation, memory update policy. | Memory becomes invisible authority instead of cited context. |
| Dynamic flow wants to crystallize a pattern | Dynamic-flow ratchet plus HITL gateway | Review repeated operator interventions as candidates for a new check or route. | Dynamic-flow ratchet is an idea. Static schematics are current. | Motif capture, review queue, schema-safe proposal format, approval workflow. | Open-ended dynamic steps make the flow graph hard to audit. |
| MCP-hosted channel operations | MCP plus HITL gateway | List waiting decisions, send or resend delivery, inspect delivery status, and submit verified replies. | MCP can expose tools and resources, but does not by itself create durable channel state. | Gateway state, operator identity, reply verification, stricter resume tool. | The model calls a tool that chooses for the human. |

## Feature Combination Map

### HITL + Run Inspection

Run inspection gives a remote decision packet the missing context: what run is
waiting, what happened, why this choice is being requested, and what the allowed
choices are.

Without run inspection, a channel message risks becoming a thin alert:

```text
Circuit needs input. Continue?
```

With run inspection, it can become a compact decision:

```text
Circuit is waiting at the risk check for the Build flow.
Reason: tests failed after a generated patch.
Choices: revise, handoff, stop.
Run: <link or run id>
Expires: 30 minutes.
```

This is the best near-term pairing because it improves decision quality without
changing flow behavior.

### HITL + Output Model

The output model proposal separates model narration, Circuit status, and host
presentation. Multi-channel HITL needs that separation. The gateway should not
scrape terminal text or infer intent from model prose. It should render from a
structured decision request plus a short status digest.

Useful combined output:

- decision prompt;
- allowed choices;
- run id and flow id;
- latest status summary;
- request expiry;
- link or token for verified choice;
- final digest after the run resumes and closes.

### HITL + Tracker Connector

The tracker connector proposal is strongest if it stays boundary-only: read
work at Frame, write results at Close. Multi-channel HITL adds approval points
around those boundaries.

Examples:

- "This Linear issue asks for a broad refactor. Approve this scope?"
- "Circuit is ready to close the issue with this summary. Approve close?"
- "The run found follow-up work. File it now or leave as local report only?"

This combination can make Circuit feel like a durable worker. The guardrail is
clear: the tracker can queue work and receive output, but the run folder remains
the source of truth for what Circuit did.

### HITL + Skill Hooks

Skill Hooks currently have an `auto` actuator path on the active branch notes.
The useful future pairing is a real `ask` mode, but only if `ask` is modeled as
a checkpoint or run transition.

That gives a clean boundary:

- a hook detects a reason to ask;
- Circuit records a typed Human Decision request;
- the gateway delivers it;
- resume validates the operator choice;
- later relays receive the resolved evidence.

That is safer than hidden prompt-side effects because the human answer is
auditable and cannot be confused with model-generated advice.

### HITL + Pursue And Sandboxed Parallel Pursuits

Pursue can split a broad goal into sub-work. The sandboxed parallel Pursuits
idea adds isolated workers and safe apply contracts. Multi-channel HITL adds the
human approval surface for the hard moments:

- selecting which branch or change packet should be applied;
- resolving disjoint-merge conflicts;
- deciding whether to retry, narrow, or stop a worker;
- approving a risky parent checkout change.

This combination is high leverage, but it should not be V1. HITL can carry the
operator decision; it cannot itself prove that a change packet is safe.

### HITL + Long-Horizon Supervision

Long-horizon supervision separates executor, supervisor, heartbeat, and status
view. Multi-channel HITL gives that supervisor a way to reach the operator when
the session is not actively watched.

This unlocks work patterns like:

- "Run for two hours, but text me before touching generated host packages."
- "Keep going unless the same check fails twice."
- "Escalate if the branch diverges or the run stops making progress."

The product risk is interruption quality. Escalations should be rare, typed, and
actionable. A bad escalation loop is worse than no escalation.

### HITL + Memory And Ratchet

Memory and ratchet systems become more useful when human decisions are recorded
with context. A future evaluator can ask:

- Did the operator often choose `revise` at a specific risk check?
- Did a certain memory hint help or mislead?
- Did a repeated choice suggest a missing check, route, or default?

The guardrail is strict. Memory can suggest or explain. It must not become
checkpoint authority, proof authority, or close authority. A remembered pattern
can propose a choice, but the operator or flow policy still decides.

### HITL + Flow Eval Suites

Multi-channel HITL should be measured. Flow eval suites can test whether it
reduces false done states, unnecessary handoffs, stuck runs, and unsafe
continues.

Useful eval cases:

- checkpoint waits with expired delivery;
- duplicate replies to the same decision;
- reply after checkpoint already resolved;
- reply with a choice not in `allowed_choices`;
- model attempts to resume through MCP without verified operator evidence;
- channel delivery succeeds but run folder is closed;
- operator rejects a memory-suggested choice.

This is where the feature becomes durable instead of just convenient.

### HITL + Dynamic Flow Ratchet

Dynamic-flow ratchet asks whether repeated run patterns should produce new flow
structure. HITL can supply high-quality review events for that process.

Example:

1. A risk check repeatedly asks the same approval question.
2. Operators repeatedly choose `revise` and add similar notes.
3. The ratchet proposes a new check or route.
4. The proposal is sent through HITL for explicit review before any schematic
   change is accepted.

This should remain late-stage. The current flow model is static schematics with
typed contracts. Open-ended dynamic step creation is a separate product and
runtime problem.

### HITL + MCP

MCP can make sense as an interface to the gateway:

- list waiting decisions;
- show delivery status;
- send or resend a request;
- cancel a delivery;
- submit a gateway-verified reply packet;
- expose channel adapter capabilities.

MCP should not be the decision authority. A model-callable tool like
`resume_decision({ choice: "continue" })` is unsafe because it lets the model
choose for the human. The safe shape is closer to:

```text
resume_verified_decision({ verified_reply_id: "..." })
```

The gateway verifies the human action. Circuit validates the resume. MCP only
exposes the operation.

## What This Does Not Unlock By Itself

Multi-channel HITL is a gateway, not a magic permission system.

It does not by itself unlock:

- free-form email or SMS chat with the flow;
- autonomous permission to continue after timeout;
- dynamic flow generation;
- safe application of parallel worker changes;
- tracker-backed work queues;
- memory ratcheting;
- proof that a run is live;
- proof that a channel recipient is the correct human;
- MCP-based authority to choose a route;
- automatic conversion of operator notes into flow behavior.

Those features need their own contracts. HITL can carry decisions for them once
those contracts exist.

## Best First Compound Product Slice

Build "remote checkpoint with context."

This slice combines:

1. existing Checkpoint and resume validation;
2. a delivery ledger and verified reply packet;
3. a compact run-inspection `why` summary;
4. a structured output digest for the channel message;
5. one or two concrete adapters, such as email and Slack, with SMS later if
   token and identity rules are ready.

The operator experience:

```text
Circuit is waiting for a decision.
Flow: Build
Step: risk check
Why: tests failed after a generated patch.
Choices: revise, handoff, stop
Expires: 30 minutes
Open: <signed link>
```

The runtime experience:

1. Circuit emits a waiting checkpoint.
2. The gateway records delivery.
3. The operator selects a declared choice.
4. The gateway creates a verified reply packet.
5. Resume validates and continues.
6. The final report records delivery and reply evidence.

This is small enough to verify and useful enough to change how Circuit feels.
It also gives later features a shared approval path.

## Recommended Sequence

1. Define the gateway contract.
   - Add delivery record and verified reply packet shapes.
   - Keep raw channel details out of reports by default.
   - Require declared choices only.

2. Build local remote-checkpoint flow around existing resume.
   - No free-form parsing.
   - No model-selected choices.
   - No direct writes to checkpoint reports.

3. Add run-inspection context to the decision packet.
   - Include run id, flow id, waiting step, latest status, and why this
     decision is being requested.
   - Avoid liveness claims unless the inspection layer can prove them.

4. Align with the output model.
   - Render channel messages from structured status and decision fields.
   - Send final digest after the run resumes and closes.

5. Add one production-grade channel adapter.
   - Prefer email or Slack first because identity and links are easier to
     reason about than SMS replies.
   - Treat SMS as useful but more sensitive because phone numbers, short
     replies, and forwarded messages complicate verification.

6. Add Skill Hooks `ask` only as a checkpoint transition.
   - Do not make `ask` a hidden prompt injection path.
   - Record the operator answer as evidence.

7. Add tracker-boundary approvals.
   - Scope approval at Frame.
   - Close preview at Close.
   - Keep tracker writes behind explicit preview or policy.

8. Add long-horizon heartbeat escalation.
   - Use typed escalation reasons.
   - Rate-limit aggressively.
   - Make silence mean "keep current policy," not "invent approval."

9. Add parallel Pursue approval gates.
   - Only after safe apply/change-packet contracts exist.
   - Approval should select among safe, inspectable options.

10. Add memory, eval, and ratchet loops.
    - Use decisions as evidence.
    - Keep memory hint-only.
    - Require eval coverage for stale, duplicate, expired, and invalid replies.

## Prerequisite Map

| Prerequisite | Why it matters | Needed before |
| --- | --- | --- |
| Delivery ledger | Shows what was sent, to whom by alias, through which channel, and with what expiry. | Any external delivery |
| Verified reply packet | Proves the selected choice came from a verified operator action. | Any remote resume |
| Declared-choice-only V1 | Keeps parsing and authority simple. | First production slice |
| Request hash and attempt id | Prevents stale replies from resolving a newer checkpoint. | Retries and resends |
| Recipient aliases | Avoids storing raw phone numbers or emails in run reports. | Multi-recipient support |
| Expiry and duplicate handling | Prevents late or repeated replies from changing a run. | Any webhook or reply channel |
| Run-inspection `why` context | Lets the operator make a remote decision without reopening the host. | Useful async decisions |
| Output digest contract | Prevents channel messages from scraping model prose. | Multi-host consistency |
| Skill Hook ask transition | Makes future expert asks auditable. | Skill Hook HITL |
| Tracker preview boundary | Prevents silent tracker writes. | Tracker approvals |
| Safe apply contract | Ensures parallel worker choices are actually safe to approve. | Parallel Pursue gates |
| Eval suite cases | Catches stale, duplicate, invalid, expired, and model-selected decisions. | Confident rollout |
| Memory evidence policy | Keeps learned patterns cited and non-authoritative. | Ratchet loops |

## Risk Map

| Risk | Failure mode | Mitigation |
| --- | --- | --- |
| Authority leakage | Channel adapter, MCP server, or model chooses a route. | Only verified reply packets can resume, and resume still validates allowed choices. |
| Notification noise | Operators get too many low-value messages and stop trusting them. | Typed escalation policy, rate limits, severity thresholds, and digesting. |
| Stale approval | A reply resolves a later checkpoint or old attempt. | Include run id, step id, request hash, attempt id, and expiry in every reply packet. |
| Duplicate approval | Two channels or repeated replies try to resolve the same request. | First valid reply wins; later replies become ignored evidence. |
| False liveness | Message says a run is active when it is closed or stuck. | Use status language the inspection layer can prove. |
| Contact data leakage | Reports store raw phone numbers, emails, or message bodies. | Store aliases, hashes, provider receipt refs, and redacted excerpts by default. |
| Source-of-truth confusion | Tracker, Slack, or email thread becomes perceived run authority. | Run folder remains authority. External systems carry delivery and output only. |
| Prompt injection | A channel message or hook output is treated as trusted instruction. | Accept only declared choices in V1; record free-form notes as evidence, not commands. |
| Timeout drift | Silence becomes accidental permission to continue. | Timeout follows declared unattended policy only. |
| Memory overreach | Prior decisions silently control future checkpoints. | Memory is cited hint-only and evaluated separately. |
| MCP overreach | Model-callable tool resumes without human proof. | MCP resume requires gateway-verified reply id or packet. |

## Claim Inventory

| Claim | Status | Evidence or limit |
| --- | --- | --- |
| Circuit has a host-neutral Human Decision block. | Confirmed | Flow authoring docs describe Human Decision as schematic-owned and host-neutral. |
| Checkpoint/resume is the right authority crossing. | Confirmed | Run-process docs describe waiting checkpoints and strict resume validation. |
| Multi-channel HITL should wrap checkpoints, not add channel-specific blocks. | Supported recommendation | Follows from current separation of decision semantics and host rendering. |
| MCP can expose gateway operations. | Supported recommendation | MCP is useful for tools/status, but needs gateway-owned durable delivery and reply verification. |
| Run inspection improves remote decision quality. | Supported recommendation | Run-inspection proposal supplies list/events/why surfaces, but is not current behavior. |
| Output model matters for channel messages. | Supported recommendation | Output-model proposal separates structured status from model narration and host rendering. |
| Tracker connector pairs well with HITL. | Proposed | Tracker connector is an idea for boundary-only read/write behavior. |
| Skill Hooks `ask` should become a checkpoint or run transition. | Supported recommendation | Current notes say `ask` is not a live pause mechanism; live ask needs an auditable pause. |
| Long-horizon supervision pairs well with HITL. | Proposed | Long-horizon supervision is an idea with heartbeat and status concepts. |
| Parallel Pursue approvals are high leverage. | Proposed and dependent | Needs safe apply/change-packet contracts first. |
| Memory can learn from HITL decisions. | Proposed and constrained | Memory is hint-only today and must not control routing, proof, or close authority. |
| Dynamic-flow crystallization can use HITL review. | Speculative | Dynamic-flow ratchet is an idea and requires separate planner/crystallization machinery. |

## Open Questions

1. Who owns recipient policy: project config, operator profile, flow policy, or
   gateway config?
2. Should Circuit itself write delivery records, or should the gateway write
   delivery records into the run folder through a narrow API?
3. Is the first adapter email, Slack, or local web link?
4. Should SMS be V1, or should it wait until reply verification and redaction
   rules are proven elsewhere?
5. How much run context is safe to include in outbound messages by default?
6. Should a remote decision support optional human notes in V1, or should notes
   wait until declared choices are stable?
7. How should delivery evidence appear in final reports without bloating them?

## Source Notes

This note was grounded in:

- `docs/ideas/multi-channel-hitl-proposal.md`
- `docs/architecture/run-process.md`
- `docs/flows/authoring-model.md`
- `docs/flows/blocks.md`
- `docs/flows/pursue.md`
- `docs/ideas/sandboxed-parallel-pursuits.md`
- `docs/ideas/long-horizon-supervision.md`
- `docs/ideas/skill-hooks-dispatch-spec.md`
- `docs/architecture/architecture-improvement-roadmap.md`
- `docs/ideas/run-inspection-implementation.md`
- `docs/ideas/tracker-connector.md`
- `docs/ideas/output-model.md`
- `docs/ideas/ratchet-data-requirements.md`
- `docs/ideas/flow-eval-suites-implementation.md`
- `docs/ideas/dynamic-flow-ratchet.md`
- `docs/ideas/README.md`

# Multi-Channel HITL Proposal

Status: proposal, 2026-06-04. This is source-backed architecture exploration
only. It is not current behavior, roadmap commitment, or a runtime change.

## Short Recommendation

Build multi-channel human-in-the-loop support as a delivery layer around the
existing Human Decision and Checkpoint path.

Do not add email, SMS, Slack, or MCP-specific flow blocks. The flow should still
ask one structured decision question with declared choices, default policy, and
unattended behavior. A channel gateway should deliver that question outside the
current host, verify the operator's answer, and resume the run through the same
checkpoint path Circuit already validates.

The first useful version should be declared-choice only:

1. Circuit reaches a checkpoint and emits `user_input.requested`.
2. A gateway creates a delivery record and sends the prompt through one or more
   configured channels.
3. The operator chooses one declared option through a signed link or short-lived
   reply token.
4. The gateway verifies the reply and resumes with
   `circuit resume --run-folder <path> --checkpoint-choice <choice>`.
5. Circuit records the checkpoint resolution and continues only after normal
   resume validation passes.

MCP can fit as an optional gateway interface, especially for tool-hosted channel
integrations and status inspection. MCP should not become checkpoint authority.
If an MCP server exposes a resume or answer tool, the tool result must carry a
gateway-verified operator decision, not a model-selected choice.

## Problem

Circuit can already pause a run for operator input, but today's practical
delivery paths assume the operator is present in the current host or can run a
resume command manually.

That is too narrow for long-running work. The useful product shape is:

- "Ask me if you need approval, even if I stepped away."
- "Text me before crossing this boundary."
- "Email the decision packet to the maintainer."
- "Let a Slack channel handle approval, but keep Circuit's run record honest."

The trap is making each channel into a new kind of work. That would blur the
line between the semantic decision and the transport that carried it. Circuit
already has the semantic decision shape. The missing layer is delivery,
identity, and verified reply handling.

## Current System

| Area | Current owner | Current inputs | Current outputs | Useful fit | Missing for multi-channel |
| --- | --- | --- | --- | --- | --- |
| Human Decision block | Flow authoring docs | Question, options, default, mode policy, evidence | Decision report with selected option and source | Right semantic primitive | No channel delivery contract |
| Checkpoint step | Runtime executor | Checkpoint policy, request/response paths, run context | `checkpoint.requested`, request file, waiting or resolved outcome | Existing pause/resume authority | No delivery record or external recipient |
| Progress projection | Runtime progress projection | Trace entries and run files | `checkpoint.waiting` and `user_input.requested` events | Existing host-facing request shape | No durable outbound dispatch state |
| Host adapters | Host contracts | Progress JSONL and final stdout | Native `ask_user`, in-thread prompt, or resume command | Existing separation of host rendering from flow behavior | Only current-host delivery is described |
| Resume path | CLI and checkpoint resume validator | Run folder and checkpoint choice | Re-entry with saved depth, axes, config, and policy layers | Existing validation and audit path | No authenticated channel reply metadata |
| External channels | Not implemented | Email/SMS/Slack/webhook credentials, recipients | Delivery receipts and replies | Natural adapter/gateway responsibility | Needs identity, authorization, timeout, retry, and audit contracts |

The strongest current fact is that Circuit already separates "what decision is
needed" from "where the operator sees it." The authoring model says Human
Decision is a block, not a host-specific special case, and that later steps
should not care which host collected the answer.

## Design Invariants

1. Circuit remains the source of truth for the run.
2. Human Decision and Checkpoint remain the stable decision primitive.
3. Channels deliver and collect decisions; they do not define flow behavior.
4. Resume must pass existing checkpoint validation before any run advances.
5. V1 accepts only declared choices. No free-form reply parsing.
6. The run record must show how the decision was requested and resolved.
7. Non-interactive and unattended runs must keep declared default, pause, or fail
   semantics. A channel timeout is not permission to invent a choice.
8. Worker connectors remain separate from host or channel adapters.
9. MCP is optional integration plumbing, not a new authority layer.

## Recommended Architecture

### 1. Keep the semantic request inside Circuit

Circuit should continue to materialize checkpoint policy into a request:

```json
{
  "step_id": "example-checkpoint",
  "prompt": "Choose how Circuit should continue.",
  "allowed_choices": ["continue", "handoff", "stop"],
  "execution_context": {
    "run_folder": "...",
    "checkpoint_boundary_ref": "...",
    "checkpoint_boundary_hash": "..."
  }
}
```

This request already has the important pieces: step identity, allowed choices,
request path, and boundary context. Multi-channel support should enrich delivery
around it, not replace it.

### 2. Add a channel gateway

Introduce a gateway whose job is to turn a `user_input.requested` event into one
or more outbound messages and turn verified user replies into resume calls.

Conceptual responsibilities:

- choose recipients from policy or operator config;
- render a compact message from Circuit-authored text;
- create a delivery record with channel, recipient alias, expiry, and nonce;
- send through email, SMS, Slack, or another adapter;
- accept replies through webhook, polling, or signed browser links;
- verify reply identity, expiry, run id, step id, attempt, and allowed choice;
- resume the run only with a declared `checkpoint_choice`;
- record delivery and reply evidence for audit.

The gateway can be a local daemon, a hosted service, an MCP server wrapping a
service, or a host-native integration. The important part is that it is outside
the flow graph and inside the delivery boundary.

### 3. Add a delivery record

Circuit needs a durable record that describes external delivery without
turning transport details into flow state.

Suggested record shape:

```json
{
  "schema_version": 1,
  "run_id": "...",
  "flow_id": "build",
  "step_id": "frame-step",
  "attempt": 1,
  "request_path": "reports/checkpoints/frame-step-request.json",
  "request_hash": "sha256:...",
  "delivery_id": "hitl_del_...",
  "channel": "sms",
  "recipient_ref": "operator:primary",
  "status": "sent",
  "expires_at": "2026-06-04T20:00:00Z",
  "allowed_choices": ["continue", "handoff", "stop"]
}
```

This could live under `reports/hitl/` or a sibling delivery ledger under the run
folder. It should avoid storing raw phone numbers, email addresses, or full
message bodies by default. Store aliases, hashes, and provider receipt ids.

### 4. Add a verified reply packet

The resume side needs evidence that the selection came from an operator action,
not from a model or an untrusted channel message.

Suggested packet shape:

```json
{
  "schema_version": 1,
  "delivery_id": "hitl_del_...",
  "run_id": "...",
  "step_id": "frame-step",
  "attempt": 1,
  "selected_choice": "continue",
  "source_channel": "sms",
  "operator_ref": "operator:primary",
  "verified_at": "2026-06-04T19:12:00Z",
  "verification": {
    "method": "signed-link",
    "nonce_hash": "sha256:...",
    "provider_receipt_ref": "..."
  }
}
```

Circuit can then resume with the choice and record enough evidence to explain
why the checkpoint resolution source was `operator`.

### 5. Keep resume as the authority crossing

The gateway should not write `checkpoint.resolved` directly. It should call the
same resume entry point a human would call, and resume should keep checking:

- the run folder is a runtime run folder;
- the run is not already closed;
- there is a latest unresolved checkpoint;
- the request choices are not stale;
- the selected choice is allowed;
- the request path and checkpoint boundary still match;
- the checkpoint report still validates.

This is the main safety value of using the existing path.

## MCP Fit

MCP makes sense for tool exposure and gateway operations. It is not enough by
itself for async HITL unless something behind it owns durable delivery state and
inbound replies.

The official MCP docs describe tools as schema-defined operations that models
can call, and the transport docs cover stdio and streamable HTTP. That makes MCP
a good way to expose operations such as:

```text
hitl.send_decision_request
hitl.delivery_status
hitl.list_waiting_decisions
hitl.cancel_delivery
```

For a resume operation, use a stricter shape:

```text
hitl.resume_verified_decision
```

Inputs should include a gateway-issued verified reply packet or receipt id. They
should not be just `{ "choice": "continue" }`, because that lets the model pick
the checkpoint answer.

The MCP authorization spec is HTTP-transport focused and authorization is
optional for implementations, so a production design cannot assume MCP
authorization alone solves channel identity. The gateway still needs its own
operator identity and reply-verification model.

Useful MCP roles:

- Adapter catalog: expose which channel adapters are available.
- Send path: trigger outbound delivery for a waiting decision.
- Inspection path: list waiting decisions and delivery status.
- Admin path: cancel, expire, or resend a delivery.

Avoid these MCP roles in V1:

- free-form answer parsing;
- direct route selection;
- writing trace entries;
- bypassing `circuit resume`;
- letting a model approve its own checkpoint.

## Options

### Option A: Host-only extension

Hosts learn how to deliver `user_input.requested` through their own native
notification channels.

Fit:

- lowest new Circuit surface area;
- preserves the existing host adapter model;
- good when a host already owns identity and messaging.

Problems:

- every host has to solve delivery separately;
- generic shell remains weak;
- hard to build one consistent audit model;
- email/SMS/Slack support depends on host-specific capability.

Choose this only if multi-channel HITL is meant to be host-specific.

### Option B: Run-folder channel gateway

Circuit emits the same checkpoint event. A gateway watches progress or run
folders, writes a delivery ledger, sends messages, verifies replies, and calls
`circuit resume`.

Fit:

- preserves Circuit's run authority;
- works for generic shell, Codex, Claude Code, and future hosts;
- has one audit model;
- can start local-first and grow to hosted.

Problems:

- needs a durable background process or service;
- needs channel credentials and secret handling;
- needs a new delivery ledger contract;
- needs careful duplicate and replay handling.

This is the recommended architecture.

### Option C: MCP-first gateway

Expose the channel gateway mainly through an MCP server.

Fit:

- natural for agent-accessible tools;
- clean way to expose status and delivery operations;
- can wrap email/SMS/Slack APIs behind a typed interface.

Problems:

- MCP tools are model-callable, so approval authority can blur;
- inbound replies still need webhook or polling state outside MCP;
- MCP adoption differs by host;
- authorization and identity still need app-level design.

Choose this as an interface for Option B, not as the core architecture.

### Option D: Channel-specific blocks

Add blocks such as Email Decision, SMS Decision, or Slack Approval.

Fit:

- easy to explain at first glance;
- each channel can have channel-specific affordances.

Problems:

- duplicates flow semantics;
- makes later steps care which channel collected the answer;
- multiplies route and report variants;
- makes default and unattended behavior harder to reason about;
- fights the existing Human Decision model.

Do not choose this for V1.

## Recommended V1

Build the smallest channel gateway that can prove the boundary:

1. Support one channel first, preferably email or Slack, because signed links
   are easier and safer than raw SMS reply parsing.
2. Only send declared-choice checkpoint requests from `user_input.requested`.
3. Only accept choices through a signed link or short-lived code tied to
   run id, step id, attempt, request hash, and delivery id.
4. Resume through `circuit resume --run-folder ... --checkpoint-choice ...`.
5. Record delivery and reply packets under the run folder.
6. Keep raw addresses and provider payloads out of default run evidence.
7. Add timeout behavior that either leaves the run waiting or uses the existing
   declared default policy when the flow explicitly permits it.

V1 does not need:

- free text;
- attachments;
- multi-person voting;
- escalation chains;
- arbitrary channel selection per flow;
- hosted dashboards;
- direct trace writes by the gateway.

## Policy Shape

Configuration should choose delivery, not flow behavior.

Example:

```yaml
hitl:
  delivery:
    default:
      mode: ask
      channels: [email]
      recipient: operator:primary
      expires_after: 30m
    rules:
      - when:
          flow: build
          route: protected-change
        channels: [sms, email]
        recipient: operator:primary
```

Policy modes:

- `off`: use current host behavior only.
- `notify`: send the decision request but do not auto-resume from replies.
- `ask`: send and accept verified declared-choice replies.
- `escalate`: send to a secondary recipient after timeout.

Avoid `auto` as a channel policy word here. In Circuit, auto-resolution already
means something different for checkpoints. Channel delivery should not confuse
"send automatically" with "choose automatically."

## Trace And Report Model

The trace should continue to carry `checkpoint.requested` and
`checkpoint.resolved` as the authority events.

The new delivery evidence should be report-shaped, not route-shaped:

- `reports/hitl/<delivery-id>.request.json`
- `reports/hitl/<delivery-id>.sent.json`
- `reports/hitl/<delivery-id>.reply.json`
- `reports/hitl/<delivery-id>.resume.json`

Potential progress events:

- `hitl.delivery_requested`
- `hitl.delivery_sent`
- `hitl.reply_verified`
- `hitl.delivery_expired`
- `hitl.delivery_failed`

These events should be informational. They should not replace checkpoint
events, checks, or guidance decisions.

## Security Model

The hard security problem is not sending the message. It is proving that a
valid operator answered a valid still-open checkpoint.

V1 should require:

- per-delivery nonce or signed token;
- expiry;
- run id, step id, attempt, request hash, and allowed choices bound into the
  token;
- recipient alias rather than raw address in run evidence;
- provider receipt id or hash for audit;
- replay rejection;
- duplicate answer behavior, probably first valid answer wins;
- explicit handling when the run has already closed;
- no free-form answer parsing;
- no model-selected checkpoint choices.

SMS-specific caution:

- SMS is convenient but weak for identity and message integrity.
- SMS should use short choices plus a nonce, or a link to a stronger web
  confirmation surface.
- Plain "reply yes" should not cross a high-risk checkpoint.

Email-specific caution:

- Email replies are easy to forward and spoof.
- Prefer signed links over parsing reply bodies.
- Store provider metadata sparingly.

Slack-specific caution:

- Slack has better identity and interaction affordances, but workspace identity
  is still not the same as Circuit operator authority.
- Map Slack users to explicit operator refs.

## Test And Verification Surface

The first implementation should be tested without live providers.

Suggested tests:

- schema tests for delivery request and reply packets;
- unit tests for token binding, expiry, replay, and allowed-choice validation;
- runtime tests where a checkpoint emits `user_input.requested`, a fake gateway
  records delivery, and a verified reply resumes the run;
- negative tests for stale request hash, stale choices, wrong step, wrong
  attempt, expired token, duplicate reply, and closed run;
- host contract tests proving current host `ask_user` behavior still works when
  no channel gateway is configured;
- redaction tests proving raw addresses and raw provider payloads are not in
  default summaries.

Recommended proof command after a first slice:

```bash
npm run check
npx vitest run tests/runner/<focused-hitl-test>.test.ts tests/contracts/<focused-schema-test>.test.ts
npm run check-flow-drift
```

Run `npm run verify` before claiming implementation complete. For this proposal
document only, source review plus `npm run check` is enough if no generated or
runtime files changed.

## Claim Inventory

| Claim | Status | Evidence |
| --- | --- | --- |
| Circuit already has a semantic pause primitive. | Confirmed | `Checkpoint` is defined as a pause needing operator input or default policy in `UBIQUITOUS_LANGUAGE.md`. |
| Human Decision should be first-class and host-neutral. | Confirmed | `docs/flows/blocks.md` defines Human Decision as structured input and output; `docs/flows/authoring-model.md` says later steps should not care which host collected the answer. |
| Current host contracts already separate the question from rendering. | Confirmed | `docs/contracts/host-capabilities.md`, `docs/contracts/host-rendering.md`, and `docs/contracts/host-adapter.md` map `user_input.requested` to native question surfaces or in-thread fallback. |
| Current progress projection exposes a declared-choice user input request. | Confirmed | `src/runtime/projections/progress.ts` emits `user_input.requested`; `src/schemas/progress-event.ts` defines options with `checkpoint_choice` and `allow_free_text: false`. |
| Resume already validates the checkpoint before re-entry. | Confirmed | `docs/architecture/run-process.md` lists resume checks; `src/runtime/run/checkpoint-resume.ts` validates unresolved checkpoints, choices, request context, and boundary identity. |
| Gateway delivery should sit beside checkpoint execution, not replace it. | Supported recommendation | Current evidence shows checkpoint execution writes requests, waits, resolves, and records guidance. Replacing that would duplicate authority. |
| MCP is useful as an optional gateway interface. | Supported recommendation | Official MCP docs define tools as schema-defined operations models can call and HTTP/stdio transports for tool servers. This fits send/status operations. |
| MCP should not be checkpoint authority. | Supported recommendation | MCP tools are model-callable, while Circuit HITL needs verified operator choice. Authority should stay with checkpoint resume validation. |
| Raw free-text email/SMS replies should be out of V1. | Supported recommendation | Current `user_input.requested` schema disallows free text, and declared choices are easier to validate and audit. |
| Multi-channel HITL already ships. | False | No current channel gateway, delivery ledger, webhook receiver, or email/SMS/Slack adapter was found in current sources reviewed for this proposal. |

## Must-Be-True Assumptions

| Assumption | Why it matters | Fastest disproof |
| --- | --- | --- |
| The useful product need is async operator choice, not open-ended conversation. | Keeps V1 small and aligned with checkpoint choices. | Users require arbitrary back-and-forth before choosing. |
| A gateway can call `circuit resume` with the same authority as the operator. | Lets delivery stay outside runtime internals. | Resume requires host-local state unavailable to the gateway. |
| Recipient identity can be mapped to an operator ref without storing raw contact data in run evidence. | Keeps audit useful without leaking contact details. | Providers require raw addresses in all persisted receipt records. |
| Existing checkpoint request and boundary hashes are enough to bind a reply to a still-valid checkpoint. | Avoids inventing a second authority model. | A reply can validate while the request or flow boundary has changed. |
| MCP host support is optional, not universal. | Keeps the architecture host-portable. | Product direction requires MCP as the only channel gateway interface. |

## Pre-Mortem

| Failure mode | Warning signal | Prevention |
| --- | --- | --- |
| Channel delivery becomes a second runtime. | Gateway writes trace authority entries or bypasses resume. | Gateway may only write delivery evidence and call resume. |
| A model approves its own checkpoint through an MCP tool. | Tool input is just `choice`. | Require verified reply packet or receipt id from an operator action. |
| SMS/email parsing creates ambiguous choices. | Support asks why "yes" did something unexpected. | V1 uses signed links or nonce-bound declared choices only. |
| Contact data leaks into run evidence. | Run summaries include phone numbers or full provider payloads. | Store aliases, hashes, and receipt refs by default. |
| Operators receive stale approvals. | Reply arrives after run closed or flow changed. | Bind token to run id, step id, attempt, request hash, and expiry; resume rejects stale state. |
| Hosts diverge in behavior. | Codex, Claude, and shell handle the same checkpoint differently. | Use one gateway contract around `user_input.requested` and resume. |

## Open Questions

1. Should the gateway be local-first, hosted, or both?
2. Which channel should V1 prove first: email, Slack, or SMS?
3. Does Circuit need first-class `hitl.*` progress events, or are delivery
   reports enough for the first slice?
4. Should verified reply evidence be attached to checkpoint resolution guidance?
5. How should escalation interact with existing checkpoint safe defaults?
6. Should channel policy live in `config` beside host capabilities, or in a new
   operator identity file?
7. What is the minimum operator identity model: one primary operator, named
   recipients, or team roles?

## Proposed Build Sequence

### Slice 0: Proposal closure

Decide the target architecture and first channel. Do not write runtime code.

### Slice 1: Schemas and fake gateway

Add delivery and reply packet schemas. Build a fake gateway test helper that can
send, verify, and resume without live providers.

### Slice 2: Runtime integration

Add optional channel delivery when a `user_input.requested` event is emitted.
Keep the existing host behavior unchanged when delivery is off.

### Slice 3: One real channel

Implement one provider adapter with signed links. Prefer email or Slack before
SMS.

### Slice 4: MCP interface

Expose gateway send, list, status, cancel, and resend operations through MCP if
that interface is still useful after the first channel works.

### Slice 5: Escalation and policy

Add timeout, escalation, and per-flow policy after the simple declared-choice
path is proven.

## Source Notes

Local source anchors:

- `UBIQUITOUS_LANGUAGE.md`
- `docs/flows/blocks.md`
- `docs/flows/authoring-model.md`
- `docs/contracts/host-capabilities.md`
- `docs/contracts/host-rendering.md`
- `docs/contracts/host-adapter.md`
- `docs/architecture/run-process.md`
- `docs/contracts/run.md`
- `src/schemas/progress-event.ts`
- `src/runtime/projections/progress.ts`
- `src/runtime/executors/checkpoint.ts`
- `src/runtime/run/checkpoint-resume.ts`
- `src/schemas/trace-entry.ts`
- `src/schemas/step.ts`

External MCP anchors:

- [MCP Tools, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Transports, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Authorization, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

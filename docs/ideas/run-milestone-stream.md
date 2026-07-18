# Run legibility and control: observable, interruptible Runs

Status: active proposal. Expanded 2026-07-17 from the shipped milestone-delivery
slice into the canonical end-to-end Run experience for the CLI, Claude Code,
and Codex.

This is a post-v1 product direction, not authorization to add runtime features
before the announcement. The v1 delivery and honesty slice already shipped in
`1d29796f`, `95fafd7a`, and `968cdb48`. It gives hosts curated Circuit status,
immediate Checkpoint and error handling, Codex background-and-poll guidance,
Claude's attached presentation feed, and honest non-complete closes. It does
**not** provide durable
watching, worker liveness, reconnect, or safe cancellation.

## Decision

Keep the current `ProgressEvent` stream as the v1 bridge. After v1, make a
durable **Run handle** the common way for every client to start, watch, inspect,
answer, detach from, and eventually cancel a Run. Keep worker handles private
to Circuit.

In this document, “Run handle” is UX shorthand, not a new competing schema. It
means the Run identity, a stream cursor, a current state snapshot, and the
actions legal in that state. The lifecycle and protocol remain owned by the
[CLI rebuild plan](cli-first-principles.md), including its distinction between
Run, Invocation, worker, and viewer.

The central product promise is simple:

> At any moment, Circuit should tell the operator what it is doing, what it has
> proved, whether the current worker is active, quiet, unresponsive, or absent,
> whether it needs input, and what the operator can safely do next.

Sometimes the honest answer is “Circuit does not know.” Showing that uncertainty
clearly is part of transparency. Guessing that an `open` Run is alive is not.

## What this proposal owns

This document owns the user journey and the common capability map. It does not
duplicate lower-level contracts:

- [run-process.md](../architecture/run-process.md) and the
  [host adapter contract](../contracts/host-adapter.md) describe the current
  execution boundary.
- [host-rendering.md](../contracts/host-rendering.md) owns attribution and
  rendering rules.
- [cli-first-principles.md](cli-first-principles.md) owns the target supervisor,
  durable stream, liveness, and control mechanics.
- [output-model.md](output-model.md) owns the final digest and its content budget.
- [turnkey-first-run.md](turnkey-first-run.md) owns first contact and setup.
- [long-horizon-supervision.md](long-horizon-supervision.md) owns future
  trajectory review. A model heartbeat is not process health.

## The user problem

Circuit can run for minutes or an hour. Today a fresh Run is one blocking CLI
call. The host that made the call is also the user's only window into it. That
creates four failures at once:

1. **The user cannot see the shape of the work.** A Relay can be active for a
   long time with no new public milestone.
2. **Silence has no stable meaning.** It may mean productive work, a quiet
   process, a lost watcher, an unresponsive worker, or an interrupted Run.
3. **The user cannot safely intervene.** Stopping a shell command is not a
   defined Run cancellation transaction.
4. **The hosts behave differently.** Claude's wrapper can stream an attached
   feed, while Codex relies on model-followed background and polling
   instructions.

The result feels like a fire-and-forget job with occasional chat narration.
Adding more lines would make that noisier, not more trustworthy. The missing
product is a calm, stateful explanation of the Run.

## Product principles

1. **Show meaning, not exhaust.** The default surface contains milestones,
   health, decisions, and outcomes. Raw worker output, commands, tool calls,
   tokens, protocol frames, internal IDs, and absolute paths stay behind an
   explicit debug action.
2. **Separate facts from observations.** Trace-backed milestones are durable.
   Liveness is transient. Neither may impersonate the other.
3. **Use Circuit's voice for Circuit facts.** Circuit authors semantic status
   text. A host may add its own commentary outside a Circuit-labelled surface,
   but may not put words in Circuit's mouth.
4. **Describe known progress, not invented precision.** Routes, loops, retries,
   and fanout make one universal percentage dishonest. Show completed stages,
   attempts, branches, and currently known next work instead.
5. **Only offer legal controls.** A button or host action appears only when the
   runtime can honor it in the current state.
6. **A viewer is not the Run.** Closing a terminal, leaving a chat, or stopping
   `watch` must not silently change execution.
7. **A Run is not a worker.** A Run can span workers or wait at a Checkpoint
   with no worker alive.
8. **The Trace remains truth.** Do not add a second persisted milestone feed.
9. **One semantic contract, several renderers.** The CLI, Claude Code, Codex,
   and future viewers may look native while saying the same thing.
10. **Keep v1 frozen.** Structural runtime work begins only after the v1
    announcement.

## Current system: what is true today

```text
host agent / terminal
        |
        | one blocking shell invocation
        v
Circuit CLI process
        |
        | runtime writes Trace and reports
        v
Flow runtime ----> Relay ----> connector worker process
        |
        `---- transient ProgressEvent v1 on attached stderr
```

The current system already has good semantic raw material. Its ownership and
delivery model are the problem.

| Area | Confirmed current behavior | Important limit |
|---|---|---|
| Invocation | The host selects a Flow and starts Circuit. A fresh execution blocks until a Checkpoint or terminal outcome. | The caller and execution lifetime are coupled. |
| Durable record | Trace entries are appended before their progress projection. Reports and the final JSON are authoritative. | There is no ordinary persisted progress feed or replay cursor. |
| Live progress | `--progress jsonl` sends curated `ProgressEvent` records on stderr while final JSON stays on stdout. Many records project Trace facts; some, such as early route presentation and a local review URL, are invocation-local. | The mixed attached feed is not wholly replayable and has no acknowledgement or resume cursor. |
| Worker activity | Connector output resets the internal inactivity timer. | Output is buffered; it is not projected as public worker activity. Users normally see Relay start, then silence, then a result. |
| Run status | `circuit runs show` can inspect a Run folder and report state and allowed actions. | `open` deliberately means active **or unknown**. It cannot prove a worker exists. |
| Checkpoints | A waiting Checkpoint records its question, choices, and exact resume command. | The invocation has ended. There may be no live worker to “pause.” |
| Control | Checkpoint resume and watchdog timeouts exist. | There is no public start/watch/wait/detach/cancel control plane, and watchdog timeout is not operator cancellation. |
| Claude Code | The `present` wrapper adds progress JSONL and renders attached status incrementally. | The model remains occupied by the shell call. Its normal wrapper also suppresses task-list events. |
| Codex | The skill tells the model to background long runs, poll, render Circuit text, and surface Checkpoints. | The wrapper itself is blocking. Delivery quality is model-mediated and not reconnectable. |
| Direct CLI | Start, Checkpoint, and finish notices exist, and callers can opt into JSONL. | Bare `circuit` is a launcher, not a live Run dashboard. |
| Completion | Circuit writes a bounded, readable operator summary and supporting evidence. | The strong receipt arrives after the period when the user most needs reassurance and control. |

`ProgressEvent` v1 is therefore a presentation feed, not one uniform class of
durable milestone. `route.selected` can be emitted before the Run folder is
resolved, and `checkpoint_review.ready` contains an ephemeral loopback review
session. Neither should be replayed later as if it were a durable Trace fact.
The V2 contract must classify every frame by source: Trace-backed milestone,
transient liveness, invocation-local action/presentation, or omitted.

### Current claims that remain unproven

- A Codex model reliably backgrounds, polls, deduplicates, and relays every
  important event in real sessions.
- A backgrounded shell invocation survives host-tool, terminal, or host-session
  exit.
- Ctrl-C safely ends the complete worker tree and records a terminal canceled
  outcome.
- An `open` Run is still working.
- Claude and Codex have equivalent task-list behavior.
- A lost client can reconnect without missing or duplicating milestones.
- Current worker chunks can support a user-facing “active” claim.
- Declared Schematic steps can produce an honest percentage or ETA.

The UX must not imply any of these are already solved.

## The six questions every surface must answer

The experience should be built from six separate kinds of information. Keeping
them separate prevents the most damaging false claims.

| User question | Kind of information | Source of truth | Default presentation |
|---|---|---|---|
| What Run is this? | Intent and identity | Accepted Run request and Flow metadata | Flow name and a short goal, without an internal ID |
| What is happening now? | Current work | Latest durable milestone plus current runtime state | One plain sentence |
| What has finished? | Proven progress | Trace-backed stages, steps, attempts, branches, Checks, and Evidence | A short milestone trail or stage list |
| Is it alive? | Transient health | Supervisor lease and recent worker activity | `Active`, `Quiet`, `Unresponsive`, `Stopping`, `No worker`, or `Unknown` with recency |
| Does it need me? | Attention | Checkpoint, user-input request, warning, failure, or reconciliation state | Interrupt normal batching and ask directly |
| What can I do? | Legal actions | Current state and runtime capability | Only actions Circuit can honor now |

“What has finished?” and “Is it alive?” must never share a data source. A
heartbeat does not prove a milestone. A durable milestone does not prove a
worker is still reachable.

## The information model

### 1. Durable Run facts

These are the target milestone facts reconstructable from the Trace that survive
reconnect:

- Run accepted, started, waiting, and terminal lifecycle changes;
- selected route and declared stage or step changes;
- Relay starts and terminal verdicts;
- attempt and fanout branch outcomes;
- Evidence and Check results;
- Checkpoint questions and answers;
- warnings, failures, recovery boundaries, and final outcome.

They form the milestone timeline. A renderer may collapse or group them, but it
must not change their meaning.

### 2. Transient liveness

These answer whether Circuit can currently reach or observe the active worker:

- lease state;
- last observed worker activity;
- current inactivity and wall-clock policy limits;
- whether a worker exists for this Run state;
- whether the viewer is connected to the supervisor.

Liveness frames are not appended to the Trace, receive no durable cursor, and
are not replayed as history. They can change without claiming the Run advanced.

The useful public health vocabulary is deliberately small. These are display
labels over the CLI plan's lifecycle, liveness state, and reachability fields,
not a competing protocol enum:

- **Active:** recent worker activity is observed.
- **Quiet:** the worker remains reachable, but no recent activity or milestone
  has been observed.
- **Unresponsive:** the lease is stale or the worker cannot be contacted. This
  is not proof that it died.
- **Stopping:** the worker acknowledged cancellation and closed new effect
  admission, or terminal cleanup is in progress. The worker may still exist.
- **No worker:** the Run state proves no worker is currently expected, such as
  a parked Checkpoint or a terminal Run whose cleanup is complete.
- **Unknown:** the current runtime cannot prove health. This is the only honest
  label for the v1 bridge when milestones stop.

### 3. Derived progress

Progress is a description of known structure, not a scalar score. Examples:

- “Framing and implementation are complete. Verification is running.”
- “Three declared Steps finished; the next route depends on verification.”
- “Attempt 2 is running.”
- “Two of four admitted branches finished.”
- “One command was already in flight when cancellation was requested.”
- “Later work is not decided yet.”

For a fixed, fully known topology, a surface may say “3 of 5 planned Steps
finished.” It still should not convert that to `60%`. A completed Step may take
seconds while the next takes half an hour, and a route may add work.

Do not show an ETA until Circuit has flow-specific evidence and a calibrated
model that can state its confidence. Elapsed time and policy limits are useful
today; invented completion time is not.

### 4. Attention and decisions

Checkpoints, structured questions, failures, cancellation uncertainty, and
effect reconciliation are not ordinary milestones. They interrupt batching,
become the primary surface, and state why the user is needed.

### 5. Legal actions

Actions are part of the state projection, not buttons a renderer invents. This
lets every host expose the same capability even if one uses terminal keys and
another uses chat controls.

### 6. Close receipt

The operator summary remains separate from progress. Every invocation close is
outcome-shaped: a parked Checkpoint says the Run is waiting and can continue;
a terminal Run states the final outcome, decisive findings, caveats, Evidence,
and next action once. A noisy timeline is not a report, and a report should not
have to reconstruct liveness.

## Why a handle on workers changes the system

Today, possession of the shell call is the closest thing the host has to a
handle. If that call or watcher disappears, the host loses both visibility and
the only apparent control path.

The target moves process ownership into Circuit:

```text
                         public Run-level contract
Claude / Codex / CLI  <------------------------------>
                         start, watch, status,
                         answer, detach, cancel
                                  |
                                  v
                       local Circuit supervisor
                       - accepts and locates Runs
                       - owns stream cursors
                       - reports transient health
                       - validates legal controls
                                  |
                         private worker handles
                                  |
                                  v
                         root Invocation worker
                                  |
                           Flow runtime / Relays
                                  |
                         Trace, reports, Evidence
```

The private worker handle contains process or Invocation identity, containment,
lease state, and a cancellation channel. That unlocks five things Circuit
cannot honestly offer from a logfile:

In plain language, a **lease** is an authenticated worker check-in,
**containment** is the exact process tree Circuit owns, and a **fence** is the
ownership marker that prevents an old worker from acting after a replacement.
The **effect-admission gate** is the last check before Circuit lets a command,
write, or external action begin.

1. **Durable attachment.** A viewer can leave and another can find the Run.
2. **Truthful health.** Circuit can distinguish recent activity, quiet work, a
   stale lease, and a Run state where no worker should exist.
3. **Ordered interruption.** Circuit can record a private request, let the
   worker acknowledge it at the effect-admission gate, signal the owned worker
   tree, and record when cancellation actually becomes terminal.
4. **Safe recovery decisions.** A replacement worker is not started until prior
   ownership is proved ended or the Run enters explicit reconciliation.
5. **Host independence.** Codex and Claude render the same Run instead of each
   becoming an improvised process supervisor.

The public handle must still be a **Run** handle. Exposing a PID or connector
task as the main identity would fail at the first retry, worker replacement, or
parked Checkpoint. A Run may outlive several workers. A worker never defines the
user's job.

## The common host contract

### What the host calls today

The user asks in chat or invokes the host's Circuit command. The host then
chooses an explicit Flow and calls the packaged Circuit wrapper. It does not
call a Claude or Codex worker directly. The examples below show command shape;
the adapter still applies its required shell-safe escaping to user text.

Codex uses the installed plugin path and requests the progress stream:

```bash
node '<plugin root>/scripts/circuit.js' run <flow> --goal '<task>' --progress jsonl
```

Claude uses its presentation wrapper, which adds progress mode and renders the
attached feed itself:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present run <flow> --goal '<task>'
```

The wrapper locates Circuit's packaged runtime and Flow definitions. Circuit
then chooses Relay connectors from the Flow and configuration. This separation
is the reason the host can remain Codex while one Relay uses Claude, or vice
versa.

The host's current job is therefore: choose the Flow, invoke Circuit, present
Circuit's progress and final digest, and handle declared Checkpoints. Circuit's
job is to execute the Schematic and manage connector workers. The target Run
handle changes how long the host remains attached; it does not move worker
orchestration into the host.

### Current v1 bridge

Until the durable runtime exists, every host follows these common rules:

1. Select the explicit Flow and construct the normal Circuit command.
2. Keep `--progress jsonl` separate from final stdout. Treat it as a mixed
   attached feed, not a replay log; local review URLs and similar action frames
   expire with their invocation.
3. Prefer `presentation` when present. Honor its `block_id`, `line_mode`, and
   `slot_id`: append, replace in a native live slot, or suppress exactly as the
   [host rendering contract](../contracts/host-rendering.md) requires. When
   `presentation` is absent, render qualifying `display.text` **verbatim**.
   Native layout may change; Circuit-authored wording may not. Never add
   host-authored lines inside a Circuit-labelled status surface.
4. Surface Checkpoints, questions, warnings, and errors as soon as that host
   path receives them.
5. Apply task-list changes to a native task surface only where that host path is
   proved to receive them. Do not duplicate the same change as chat prose.
6. When the process ends, render the operator summary verbatim and keep host
   interpretation outside the Circuit-labelled surface.
7. Never equate a redirect file, shell job, or `open` state with a durable,
   live Run.

The delivery loop is host-specific today:

**Claude Code — attached presentation only.** Keep the shipped `present` path.
Its wrapper streams Circuit status to the operator, but the Claude model remains
occupied until the command returns. It cannot poll, add periodic quiet updates,
or ask a native question mid-call. Do not promise model-in-the-loop narration
or background control from this path. A backgrounded Claude mode remains a
separate proposed host change until adopted and proved.

**Codex — best-effort background and polling.** For a long Run, background the
wrapper, capture progress and final stdout separately, and let the model poll at
a bounded cadence. If no milestone arrives while the host still observes the
command, say it has not exited but worker activity is unknown. If the host loses
the command, say Run state is unknown and offer inspection. Never turn either
case into “the worker is active.” This behavior is instruction-driven and is
not a reconnect guarantee.

**Direct CLI and scripts — attached consumption.** Human terminal mode shows
its current sparse notices. A script may consume JSONL while attached, but it
owns its display loop and receives no durable cursor.

This is a compatibility bridge. It improves the experience, but it cannot make
the guarantees of a control plane.

### Target Run protocol

The target host loop is simpler because Circuit owns execution:

```text
start  -> durable Run acceptance + current stream cursor
watch  -> Trace-backed milestones after cursor + non-replayable health/actions
status -> current lifecycle, known progress, health, attention, legal actions
answer -> typed response to a declared Checkpoint or question
cancel -> request receipt, acknowledged stopping state, then proved terminal result
wait   -> terminal outcome and final digest
```

A host should:

1. start the Run and immediately retain its public Run reference;
2. watch from the last acknowledged cursor;
3. deduplicate Trace-backed events by their durable identity;
4. update one replaceable status area for liveness;
5. append only meaningful milestones to the conversation or timeline;
6. interrupt the normal cadence for required input or a material warning;
7. expose only the actions in the current state projection;
8. reconnect from its last cursor after viewer or transport loss;
9. treat request recorded, worker acknowledged, and cancellation complete as
   three different states; and
10. on terminal state, close the Run timeline exactly once on the authoritative
    operator summary.

The host does not spawn or manage Relay workers directly. A native host task or
subagent API may implement a connector under Circuit's authority, but it does
not become a second orchestrator.

## Progressive disclosure: a Run surface, not a log

The same information should be available at four levels.

### Level 1: glanceable Run status

This is one persistent, replaceable card or terminal region:

```text
CIRCUIT · Build                                  Working · 6m 12s
Implement checkout totals

Now       Running verification
Progress  Framing and implementation complete · next route undecided
Worker    Active · activity 8s ago · 10m inactivity limit

[Details] [Detach] [Cancel]
```

Order matters: lifecycle, current work, proven progress, worker health, needed
attention, then legal controls. The Run goal should be recognizable; the
internal Run ID should not be the headline.

### Level 2: curated milestone timeline

Append one line when meaning changes:

```text
✓ Framed the work
✓ Gathered implementation context
✓ Implemented the change
● Running verification
```

Do not append lease renewals, timer ticks, tool calls, commands, output chunks,
token counts, cursor frames, or every Trace entry.

### Level 3: details and Evidence

On demand, show:

- stage, step, route, attempt, and branch details;
- Check and Evidence summaries;
- warnings and non-complete reasons;
- elapsed duration and policy limits;
- supporting artifacts and the final report.

This surface can be denser, but should still use product language rather than
protocol language.

### Level 4: debug view

Raw Trace, connector output, internal IDs, absolute paths, process metadata, and
protocol diagnostics are explicit opt-in tools. They are valuable for debugging
and support, not the everyday product.

## Update cadence

Milestones should be event-driven. Reassurance should be bounded and usually
replace in place.

| Change | User-facing behavior |
|---|---|
| Run accepted or started | Show immediately. Establish the persistent status surface. |
| Major durable milestone | Show immediately and append once. |
| Checkpoint, question, warning, failure, or reconciliation need | Interrupt immediately. |
| Task-list change | Update the native task surface; do not repeat it as prose. |
| Healthy activity with no milestone | Refresh health in place. Do not append activity noise. |
| No milestone for 60 seconds | Give one concise quiet-work update. |
| Continued unchanged quiet work | Keep replacing the status slot. In append-only chat, report no more often than every two to three minutes. |
| Health becomes quiet, unresponsive, stopping, or unknown | Show immediately because meaning changed. |
| Terminal outcome | Show immediately, followed once by the final digest. |

The 60-second and two-to-three-minute values are a starting policy to test, not
a runtime truth. This full cadence is a target contract. Codex can approximate
it today through best-effort polling. Claude's shipped `present` path cannot:
it remains event-driven while the model is occupied, so it should show the
attached feed and native working indicator without inventing periodic prose. A
host may use a native spinner or elapsed timer continuously without creating new
transcript messages.

Copy must reflect the available capability:

```text
Current bridge, command still observed
No new Circuit milestone for 2m 14s. The Circuit command has not exited, but
this runtime cannot prove worker activity.

Current bridge, command no longer observed
Connection to the Circuit command was lost. This runtime cannot tell whether
the Run is still active. Its saved state can be inspected, but an open Run
remains ambiguous: active or unknown.

Durable runtime
No new Circuit milestone for 2m 14s. The worker is reachable and produced
activity 8s ago. Circuit will warn if it approaches the 10m inactivity limit.
```

## Representative experiences

These are target semantic transcripts. They are not claims about the current
runtime. Each host may render them with native cards, terminal regions, task
lists, or question controls; current-bridge exceptions are called out where
useful.

### Normal progress

```text
Circuit started Build.

✓ Framed the change
✓ Gathered implementation context
● Implementing the change

✓ Implementation ready
● Running verification

Build complete
Six declared Checks passed. No warnings were recorded.
```

The user receives a few meaningful changes, not one message per worker action.

### Long quiet work

```text
● Implementing the change

No new milestone for 2m 14s.
Worker is reachable; last activity was 8s ago.
Circuit will warn if silence approaches the 10m inactivity limit.
```

Under the current bridge, the second line must instead say Circuit cannot prove
worker activity.

### Waiting at a Checkpoint

```text
Waiting for you

Circuit found two defensible storage approaches.

1. Use the local supervisor — Recommended
2. Keep execution foreground-only

[Choose] [Inspect Evidence] [Cancel Run]
```

The ordinary progress cadence stops. The question, why it matters, and the
available choices become primary. A parked Checkpoint correctly reports `No
worker`, not `Quiet`.

### Cancellation

```text
Cancellation requested

Circuit recorded the request. It has not yet recorded the stopping boundary.
Until that happens, work may continue.

Stopping

The worker acknowledged cancellation and closed new effect admission. One
command already in flight is settling. The Run is not canceled yet.

Canceled

Circuit preserved the workspace, Trace, and available Evidence. Changes already
made were not rolled back.
```

“Cancellation requested” appears when the private control request is recorded.
It makes no claim about admission yet. “Stopping” appears only after the worker
imports that request, writes the durable cancellation boundary, and closes new
effect admission. “Canceled” appears only after the terminal Trace fact exists.
Cancellation is not rollback.

Accepted, queued, and Checkpoint-waiting Runs have no active Flow work to drain.
A short control worker may move them through these states quickly, but the same
wording rule applies: request receipt is not terminal proof.

### Viewer disconnect and reconnect

```text
Connection lost. The Run may continue. Reconnecting after milestone 12…

Reattached

Two milestones were replayed; no gap was detected.
The worker is reachable.
```

If a cursor gap or corrupt Trace boundary exists, Circuit stops at the last
proved milestone and says replay is incomplete or the Trace is damaged. It
offers the typed inspect, repair, or export remedy supplied by the runtime. It
does not call this effect reconciliation unless an admitted effect actually has
an unknown outcome, and it does not guess.

The short-lived reattach operation and its resume token may expire. The last
acknowledged durable cursor does not expire with them. Until the Run is pruned,
Circuit can open a fresh read-only `watch` or `wait` operation after that cursor.
An expired reattach therefore gets that exact remedy; it is not reported as a
cursor gap or damaged Trace.

### Unresponsive worker

```text
Worker unresponsive

Circuit has not received the worker lease within its expected window. This does
not prove the worker stopped. The Run is not being replaced automatically.

[Inspect] [Request cancellation]
```

Starting a replacement before proving prior ownership ended risks two workers
performing the same effects.

### Unknown effect

```text
Reconciliation required

Circuit cannot prove whether the admitted external action completed. Retrying
it could perform the action twice.

[Inspect Evidence] [Record the observed outcome]
```

This state is reserved for uncertain effects. It is not the wording or action
set for an expired reattach operation, a cursor validation failure, or damaged
Trace.

### Failure

```text
Build stopped

Verification exceeded its 10-minute limit. The isolated workspace and available
Evidence were preserved.

[Inspect Evidence] [Start declared recovery]
```

The surface names the failed stage and the next safe action. It does not dump a
stack trace by default.

### Completion

```text
Build complete

Six declared Checks passed. Three files changed with no recorded warnings.

[Read summary] [Inspect Evidence]
```

Completion closes the timeline with one outcome-shaped digest rather than a
second narration of every milestone. If process cleanup is still pending, keep
that health line visible beside the terminal outcome until cleanup completes.

## Interruption and control semantics

“Interruptible” has three supported meanings:

1. **Detach the viewer.** Stop watching without changing the Run.
2. **Answer a declared Checkpoint.** Change direction at a boundary designed by
   the Flow.
3. **Request graceful cancellation.** Ask Circuit to stop admitting work, settle
   or reconcile admitted effects, request the owned worker tree to exit, and
   record a terminal outcome only when the cancellation boundary is safe.

It does not mean arbitrary mid-worker steering or a generic pause button. Those
weaken repeatability and are unsafe around effects.

| Run state | Default health | Legal controls | Important wording |
|---|---|---|---|
| Accepted or queued | No worker or pending worker | Inspect, detach, cancel | Do not say work has started until it has. |
| Running | Active, quiet, unresponsive, or unknown | Inspect, detach, request cancel | Health is not progress. |
| Checkpoint settling | Worker or admitted effects may remain | Inspect, detach, request cancel | Do not ask for an answer until the Checkpoint is ready. |
| Waiting at Checkpoint | No worker | Answer, inspect Evidence, detach, cancel | Say exactly what input is required. |
| Cancellation requested, not acknowledged | Current health or unknown | Inspect, detach; force only through the explicit escalation flow | Work may continue; do not claim admission is closed. |
| Stopping, acknowledged | Stopping or unresponsive | Inspect, detach; force only as a separate escalation | New effect admission is closed; admitted work may still settle. |
| Reconciliation required | Unknown by definition | Inspect, reconcile, possibly cancel under policy | Do not retry effects automatically. |
| Terminal, cleanup pending | Stopping or unresponsive | Inspect cleanup and Evidence; detach | Keep the terminal outcome and process cleanup visibly separate. |
| Terminal, cleanup complete | No worker | Inspect report and Evidence; start a new declared Run if appropriate | One final outcome, no live controls. |

### Safe cancellation gate

Cancellation should not ship merely because Circuit can send a signal. It is
ready only when:

- the root Invocation and every executor receive a cancellation token;
- the request receipt does not claim new effects are blocked;
- new effects are rejected only after the worker records the ordered
  cancellation boundary;
- owned child processes are contained, receive targeted stop requests, and stay
  visibly `cleanup pending` until exit is observed;
- admitted effects either settle or enter explicit reconciliation;
- the Trace records request, progress, and terminal outcome in order;
- repeated cancellation requests are idempotent; and
- the UI distinguishes request recorded, worker acknowledgement, terminal
  canceled outcome, remaining cleanup, and any later force-stop escalation.

Until those are proved, `Detach` and read-only inspection are safer than a
misleading `Cancel` button.

## Cross-host experience

Semantic parity does not require identical chrome. It requires the same truth,
attention rules, and legal actions.

| Capability | Direct CLI today | Claude Code today | Codex today | Common target |
|---|---|---|---|---|
| Start | Blocking command | Blocking `present` wrapper | Blocking wrapper; model may background | Returns a durable Run reference quickly |
| Major milestones | JSONL opt-in; sparse default notices | Attached wrapper renders them live | Model is instructed to poll and relay | Same ordered milestone stream |
| Quiet-state message | None | Foreground feed may remain silent | Model-authored polling update | Same honest health vocabulary |
| Native task view | None | Not proved in normal `present` path | Instructed, model-mediated | Same task projection where host supports it |
| Checkpoint | CLI result and resume command | Wrapper can render; model unavailable until return | Model instructed to surface immediately | Same question and choices in native controls |
| Reconnect | No cursor watch | No durable reattach | Log polling only | Watch from last acknowledged cursor |
| Detach | Exit semantics are not a Run contract | Host task behavior | Shell job behavior | Viewer detaches; Run is unchanged |
| Cancel | No safe public command | Shell/process interruption only | Shell/process interruption only | Typed Run control with proved terminal state |
| Final receipt | Typed result and reports | Rendered digest | Model instructed to prefer digest | Same authoritative digest |

The first parity fixture should render one recorded Run through line-mode CLI,
Claude, and Codex adapters. The words and action set must agree even when the
layout differs.

## Architecture options

### Option 1: strengthen the current stream bridge

```text
Trace -> ProgressEvent v1 -> attached stderr or redirected log -> host -> user
```

Codex backgrounds and polls the existing command. Claude keeps its attached
presentation wrapper. Both render major events and surface Checkpoints through
the capabilities their shipped paths actually provide.

**Strengths**

- Lowest cost; much of the delivery instruction already shipped.
- No engine or persistence change.
- Preserves Circuit-authored language and the final receipt.
- Fits the v1 boundary.
- Easy to retire after durable watching exists.

**Costs and failure modes**

- A shell job or logfile offset is not a durable Run handle.
- A dead watcher can miss events.
- Silence cannot prove active, quiet, or unresponsive worker state.
- Killing the command is not safe cancellation.
- Claude and Codex rely on different host behavior.
- A model can skip, duplicate, or paraphrase events.

**Disqualifier:** this option cannot satisfy guaranteed reconnect, truthful
liveness, or safe interruption. It is the bridge, not the destination.

### Option 2: durable Run handle and Circuit control plane

```text
host / CLI <-> start, watch, status, control <-> local supervisor
                                                   |
                                             private worker handle
                                                   |
                                           Invocation / Flow runtime
```

Circuit durably accepts a Run, returns its reference, projects milestones after
a cursor, reports separate transient health, and accepts typed controls. It
privately tracks worker ownership and containment.

**Strengths**

- The Run outlives a viewer and can span workers.
- Trace-backed replay makes reconnect honest.
- Leases distinguish active, quiet, unresponsive, stopping, absent, and unknown.
- One capability model serves every host.
- Circuit can order cancellation against effect admission.
- Hosts become thin clients instead of process managers.

**Costs and failure modes**

- Highest implementation and cross-platform cost.
- Requires activation, a small supervisor, leases, fencing, and private control
  state.
- Safe cancellation crosses every executor and effect boundary.
- A poorly bounded supervisor could become a second workflow engine or a second
  source of truth.
- Stale ownership could start duplicate workers unless fencing is proved.

**Guardrails**

- The supervisor owns no Flow logic and writes no Run Evidence.
- The worker owns execution and the Trace.
- Durable public events are rebuilt from Trace facts.
- Liveness frames have no durable cursor and are not replayed.
- No replacement begins until prior ownership is proved ended.

**Disqualifier:** do not ship a partial version that labels process presence as
durable execution or exposes cancellation before effect ordering works.

This is the recommended destination.

### Option 3: let each host manage Circuit's workers

```text
Circuit asks for work -> Claude or Codex spawns a native task
                      <- host returns a result
Circuit validates and advances
```

This is plausible because rich hosts already have background tasks, subagents,
questions, progress UI, and process controls.

**Strengths**

- Best access to native host UI and activity signals.
- Avoids some local supervisor infrastructure.
- A host can display its own task activity directly.
- Attractive if Circuit becomes a workflow compiler for one chosen harness.

**Costs and failure modes**

- The same Flow executes differently in Claude, Codex, and a plain shell.
- Host upgrades become runtime changes.
- Host-session loss threatens execution.
- Native task cancellation still cannot settle external effects safely.
- The host model can skip, repeat, paraphrase, or answer Circuit events.
- Circuit and the host become competing orchestrators.
- Generic CLI use becomes second class.

**Disqualifier:** this violates plain-CLI independence and cross-host semantic
parity. Keep host-native execution as an adapter under Circuit's authority, not
the product architecture.

### Comparison

| Dimension | Stream bridge | Durable Run handle | Host-managed workers |
|---|---:|---:|---:|
| v1 fit | High | Docs only | None |
| Meaningful visibility | Medium | High | High in rich hosts |
| Honest liveness | Low | High | Host-dependent |
| Safe interruption | Low | High after effect work | Medium at best |
| Reattachment | Low | High | Host-dependent |
| Cross-host parity | Medium | High | Low |
| Trace integrity | High | High with guardrails | Medium |
| Build cost | Low | Very high | High across adapters |
| Boundary clarity | Medium | High | Low |
| Host lock-in | Low | Low | High |
| Rollback if the bet is wrong | Easy | Moderate | Difficult |

## Recommendation and sequence

### Now — shipped v1 bridge

- Preserve the current curated stream and strict Circuit/host voice boundary.
- Keep Checkpoints, warnings, errors, and non-complete closes visible.
- Keep background-and-watch guidance for long Codex runs and the Claude
  `present` feed.
- Use honest unknown-state copy when there is no new milestone.
- Do not claim native parity, liveness, reconnect, or cancellation.

No further runtime feature is required before the v1 announcement.

### Prerequisites — CLI rebuild Phases 1–3

After v1, do not start with the supervisor or Run-handle slice. Follow the
[CLI rebuild plan](cli-first-principles.md) first:

1. characterize current roots, commands, formats, events, hosts, and
   compatibility behavior;
2. run the dangerous-seam probes for process death, ownership, cancellation,
   Trace failure, credentials, workspaces, terminals, and packaging; and
3. ratify the root, lifecycle, event, cursor, liveness, effect, recovery, and
   cancellation contracts from that evidence.

These are CLI rebuild Phases 1–3. They can change the safe shape of the UX
mechanics. The milestones below begin only after their gates pass.

### UX milestone A — no-effect Run handle (CLI rebuild Phase 4)

Build the thinnest supervisor proof around a fixture Run:

- durable acceptance and Run lookup;
- a public Run reference;
- cursor-based milestone watch and reconnect;
- transient simulated leases;
- viewer detach with no Run mutation;
- fixture-only cancellation that proves request recorded, worker-acknowledged
  `Stopping`, terminal `Canceled`, and idempotent retries without admitting any
  real effect;
- deterministic fake-worker liveness and supervisor-restart cases for active,
  quiet, unresponsive, stopping, no-worker, and unknown states; and
- the same fixture rendered through CLI, Claude, and Codex.

This milestone maps to CLI rebuild Phase 4. It must not execute real effects or
add Flow logic to the supervisor. It proves the ownership seam before risk
enters. Its cancellation matrix covers cancel before start, cancel while the
synthetic worker is active, response loss, and a race with synthetic terminal
close. It uses recorded Traces and dispatches no connector, command, filesystem
write, model request, or external effect. A “read-only” model call still spends
and is not safe enough here. Do not add automatic worker replacement. `Cancel`
remains hidden for real Runs until the next milestone proves every effect
boundary.

### UX milestone B — first safe real Run (CLI rebuild Phase 5)

- Add ordered effect intent and receipt, budget reservation, process
  containment, and reconciliation before dispatching a real Flow.
- Thread cancellation through the root Invocation, executors, connectors, and
  child process containment.
- Fence new effect admission after the acknowledged control boundary.
- First run the boundary with synthetic effects, including uncertain outcomes.
- Only after those proofs pass, run one real Flow in isolation and repeat the
  liveness, restart, and cancellation matrix.
- Prove idempotent request, settling, cleanup, and terminal canceled states.
- Only then expose `Cancel` as a normal action.

This milestone maps to CLI rebuild Phase 5. The mechanics plan remains the
authority if its ordering becomes more specific.

### UX milestone C — native surfaces (later CLI rebuild phases)

- Build the direct terminal Run viewer from the same projection.
- Map the same model to Claude and Codex native status, task, and question UI.
- Add accessible line and screen-reader modes.
- Add optional notifications only after single-Run watching is dependable.

### Later — optional intelligence

Flow-specific duration models, anomaly detection, and long-horizon trajectory
review may consume the same Run view later. They must not blur model judgment,
worker health, and durable Run facts.

## Validation spikes and stop conditions

### 1. Cursor and replay spike

Use one fixture Trace with disconnects before, during, and after writes. Prove
no skipped milestone, logical deduplication after reconnect, and a visible hard
stop at a corrupt or gapped boundary. Render separate fixtures for an expired
reattach operation, each cursor-validation result, a pruned Run, a corrupt
Trace, and an unknown admitted effect. Expiry must offer a fresh read-only
`watch` or `wait` from the last acknowledged cursor. Their wording and legal
actions must remain distinct.

**Stop if:** the proposed cursor requires a second persisted milestone feed.

### 2. Liveness spike

Use synthetic workers that are active with no milestone, quiet but reachable,
stale, exited cleanly, and killed without a terminal Trace entry. Prove the
public labels never turn timeout into proof of death.

**Stop if:** health cannot be kept transient and separate from Trace replay.

### 3. Ownership and fencing spike

Crash the viewer, supervisor, and worker independently. Prove a viewer restart
does not affect execution and no replacement worker starts while earlier
ownership remains possible.

**Stop if:** the supervisor must duplicate Flow state to recover.

### 4. Cancellation spike

Exercise a no-effect worker, a child process tree, a workspace write, and an
external effect with an uncertain response. Cover a responsive worker, an
unresponsive worker, cancellation before execution, and cancellation while
parked at a Checkpoint. Prove ordered effect admission, graceful stop,
reconciliation, idempotency, and terminal recording.

**Stop if:** the UI can say `Canceled` before the runtime proves it.

### 5. Host parity fixture

Feed the same recorded milestones, health transitions, Checkpoint, disconnect,
and terminal outcome into line CLI, Claude, and Codex renderers.

**Stop if:** a host must invent semantic text or legal actions to feel native.

### 6. Comprehension test

Show normal, quiet, unresponsive, Checkpoint, cancel, reconnect, damaged-Trace,
unknown-effect, failure, and completion Runs to users without exposing debug
detail. Ask them the six core questions and measure whether they answer
correctly.

**Stop if:** the default surface requires reading a timeline like network logs.

## Testable acceptance criteria

### Semantic parity

1. The same canonical Run-view fixture—Trace-derived milestones, lifecycle
   snapshot, transient health, and legal actions—produces the same meaning in
   line CLI, Claude, and Codex.
2. Circuit-authored text is identical across hosts unless a documented display
   profile changes layout, never meaning.
3. Default output contains no raw JSON, tool calls, Relay tokens, internal IDs,
   absolute paths, or process metadata.
4. Line and screen-reader modes expose the same meaning and controls without
   relying on color or animation.

### Honest state

5. A current v1 `open` Run is never described as definitely active.
6. A worker with recent activity and no milestone is distinguishable from a
   quiet but reachable worker.
7. An unresponsive lease is never presented as proof that the worker died.
8. A Checkpoint-waiting or terminal-cleanup-complete Run correctly says no
   worker is expected; a terminal Run with pending cleanup still shows
   `Stopping` or `Unresponsive` separately.
9. Loops, retries, routes, and fanout use attempts, stages, or branch counts
   without a universal percentage or unsupported ETA.
10. Current bridge wording never claims worker activity it cannot observe.

### Watch and reconnect

11. Reconnecting from a valid durable cursor skips no milestone and removes
    logical duplicates by event identity. If the reattach operation or resume
    token expires, the acknowledged cursor remains valid for a fresh read-only
    `watch` or `wait` until the Run is pruned; opening either does not mutate the
    Run. An invalid, mismatched, or ahead cursor fails with its distinct stable
    result. A pruned Run reports that its data is unavailable rather than
    silently replaying from origin.
12. Liveness and invocation-local presentation or action frames, including
    local review URLs, are absent from durable replay and have no durable
    cursor.
13. Detaching or interrupting `watch` never mutates Run state.
14. A supervisor restart rebuilds the durable milestone projection from the
    Trace instead of another milestone store.
15. An expired reattach operation, cursor validation failure, cursor gap,
    corrupt Trace, pruned Run, and unknown effect render distinct wording and
    legal actions. Corrupt or gapped replay stops at the last proved boundary;
    only an unknown effect enters effect reconciliation.

### Attention and control

16. A waiting Checkpoint interrupts normal batching and exposes the same
    question and choices across hosts.
17. Only actions legal in the current state are rendered.
18. `Cancellation requested`, `Stopping`, and `Canceled` are separate visible
    states. Before worker acknowledgement, the UI says work may continue.
19. `Stopping` appears only after the durable cancellation boundary closes new
    effect admission, and `Canceled` appears only after a terminal Trace fact.
20. No new effect is admitted after the ordered cancellation boundary.
21. Repeated cancellation requests are idempotent.
22. Uncertain admitted effects enter reconciliation instead of automatic retry.
23. Viewer detach is always distinct from Run cancellation.

### Calm presentation

24. Repeated health observations replace one status slot where possible rather
    than creating transcript lines.
25. Append-only hosts send quiet reassurance at a bounded cadence.
26. Major milestones append once; task updates are not repeated as prose.
27. Every terminal path renders exactly one outcome-shaped digest.
28. Non-complete outcomes never use success styling or copy.

## Claim ledger

| Claim | Status | Evidence or owner |
|---|---|---|
| Circuit already emits a curated v1 progress stream. | Confirmed current | Progress schema, projection, and `--progress jsonl` CLI path |
| Every v1 progress event is a replayable Trace projection. | False today | Early route presentation and local review readiness are invocation-local |
| Trace and final reports are authoritative; progress is advisory. | Confirmed current | Trace store and host contracts |
| Claude's attached wrapper renders progress while the model remains blocked. | Confirmed current | Claude `present` wrapper and feasibility spike |
| Codex is instructed to background and poll long runs. | Confirmed current | Generated Codex Run skill |
| Current connector output resets inactivity timers but is not public activity. | Confirmed current | Connector subprocess implementation |
| `open` means active or unknown. | Confirmed current | Run-status schema and projection |
| Current runs can safely reconnect or cancel. | False today | No public cursor watch or cancellation seam |
| Cross-host task-list parity exists. | Unproven | Codex is instructed; Claude's normal wrapper suppresses the event |
| The v1 bridge reliably survives host exit. | Unproven | Requires a real lifecycle proof |
| A durable Run handle is the common post-v1 client contract. | Proposed decision | This proposal and CLI rebuild plan |
| Worker handles stay private to Circuit. | Proposed decision | Required by Run/worker lifetime mismatch |
| Liveness remains transient and separate from Trace history. | Proposed decision | CLI rebuild plan |
| Graceful cancellation is exposed only after effect ordering is proved. | Proposed gate | CLI rebuild plan and this proposal |
| Universal percentages and unsupported ETAs remain absent. | Proposed product rule | This proposal |

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| The supervisor becomes a second engine. | Flow state and recovery could diverge. | Keep Flow logic and Evidence in the worker; rebuild durable views from Trace. |
| Liveness is presented as certainty. | A stale lease can cause duplicate work or false reassurance. | Use the small health vocabulary and keep `Unresponsive` distinct from dead. |
| Cancellation ships as process killing. | Effects may continue or become uncertain. | Gate the action on end-to-end tokens, fencing, containment, and reconciliation. |
| Hosts drift semantically. | Users receive different truth or controls. | Contract fixtures across CLI, Claude, and Codex. |
| Regular updates become spam. | The product turns into a log and users tune it out. | Append on meaning changes; replace liveness in place; test the cadence. |
| Progress looks like a promise. | Dynamic routes make remaining work uncertain. | Name known stages and undecided routes; avoid a universal percentage. |
| Debug detail leaks into the default. | Useful signal gets buried and internal paths or IDs escape. | Four disclosure levels with debug explicit. |
| The bridge is mistaken for durability. | Users trust logfile polling beyond its guarantees. | Label bridge limits in host instructions and product copy. |

## Decisions closed here

- The v1 stream bridge remains the short-term path.
- The post-v1 destination is a public Run handle over a Circuit-owned local
  control plane.
- Worker handles remain private.
- The Trace is the only durable Run event truth; no `status.ndjson` or
  `milestones.ndjson` is added.
- Durable milestones and transient liveness are separate feeds.
- Circuit owns semantic status; hosts own native layout.
- Detach, answer, and graceful cancel are distinct controls.
- Generic pause and free-form mid-worker steering are out of scope.
- The V1 stream bridges during host migration; the V2 watch contract becomes
  native, then the bridge can retire as described by the CLI rebuild plan.
- The final digest remains separate from the live Run view.
- Universal percentage and unsupported ETA are rejected.
- Structural implementation waits until after v1.

## Open product choices

These do not block the architecture:

- Tune the first quiet update and repeat cadence through comprehension tests.
- Decide whether a force-stop escalation ever belongs in the default product or
  only in an expert recovery surface.
- Decide how each host maps the persistent Run card to its native primitives.
- Decide when a notification hook adds value after reliable single-Run watching
  ships.
- Decide whether future flow-specific history can support calibrated duration
  ranges without creating false confidence.

## Relation to neighboring ideas

- [turnkey-first-run.md](turnkey-first-run.md) uses this contract for the first
  live Run after setup. Its older “mid-run narration is impossible” finding is
  superseded by the shipped delivery bridge; durable liveness and control are
  still future work.
- [output-model.md](output-model.md) supplies the bounded final digest. It does
  not own Run liveness or control.
- [cli-first-principles.md](cli-first-principles.md) is the mechanics authority
  for supervisor ownership, V2 events, cursor watch, leases, and cancellation.
- [long-horizon-supervision.md](long-horizon-supervision.md) may later consume
  this Run view for trajectory review. Its model heartbeat remains separate from
  worker health.
- [multi-channel-hitl-proposal.md](multi-channel-hitl-proposal.md) extends
  declared Checkpoint delivery to other channels. It does not change the
  single-Run truth model.
- [narration-display-profiles.md](../specs/narration-display-profiles.md) and
  [host-rendering.md](../contracts/host-rendering.md) own rendering details for
  current hosts.

## Handoff

The next executable post-v1 work is not “print more events” or build the
supervisor. It is CLI rebuild Phase 1: characterize and separate the current
roots and contracts. Complete the dangerous-seam probes and contract
ratification in CLI rebuild Phases 2–3 before starting UX milestone A inside
CLI rebuild Phase 4. Before implementation, turn this proposal's acceptance
criteria into contract fixtures and confirm the mechanics plan still owns every
new lifecycle field and command. If the no-effect proof cannot keep the Trace as
the only durable Run event truth, stop and redesign the ownership boundary.

---
name: run
description: "Runs Circuit through its Codex MCP tools, with durable progress, checkpoints, cancellation, recovery, and structured results."
---

# Circuit Run

## Use Case

Use Circuit Run as the intent front door for substantive coding work. Recommend
one public flow from the user's request, then operate the run through Circuit's
MCP tools. Circuit records the selected flow, progress, checkpoints, report,
and evidence.

Review, Fix, Build, Explore, and Prototype are not published as separate host commands.
Goal is not a kind of work; it is the completion standard Run uses
by default, and it is never selected as a public flow. The routing is model-only,
so you must choose a public flow before starting.

## Tool Boundary

Use exactly these six Circuit tools:

- `circuit_start`
- `circuit_status`
- `circuit_resume`
- `circuit_cancel`
- `circuit_list`
- `circuit_recover`

This includes starting, reconnecting, listing, reading progress, handling
checkpoints, cancelling, recovering, and releasing the workspace.

Do not perform those actions through the shell, a plugin wrapper, the ordinary
Circuit CLI, or private MCP state files. An MCP error, timeout, restart, busy
workspace, or uncertain launch is not permission to fall back. Never
force-unlock the workspace or start a competing run.

This boundary governs Circuit run control. It does not disable Codex's normal
file and shell tools, but do not use those tools as a hidden replacement for
the work assigned to an active Circuit run.

Separate Circuit utilities are not MCP fallbacks. Do not invoke another Circuit
interface from this Run skill unless separate guidance provides an exact
supported workflow.

Requests to create or generate custom flows are outside this skill. Explain
that custom-flow authoring is currently separate from the MCP run lifecycle and
route to dedicated authoring guidance when available.

## Choose the Flow

State the recommended flow and one short reason before starting, so the user
can redirect you.

- **Review** — inspect a named code target, such as working changes, a commit,
  a range, or a locally available PR; or inspect a plan or report only when its
  actual text is included in the request. Do not implement changes.
- **Fix** — repair a bug, regression, failing test, crash, or broken behavior.
- **Build** — implement or refactor something that is not mainly a bug fix.
- **Explore** — investigate a question, compare approaches, or make a decision
  before editing.
- **Prototype** — create disposable variants or local evidence before Build.

Ask one short question only when the answer changes whether the run may write:
Review versus Fix or Build, or Explore versus Build. Otherwise choose the
clear flow and continue.

## Recover Context Before Starting

Call `circuit_list` when the user asks to continue, resume, inspect, cancel, or
recover an earlier run and no `run_id` is available. Also use it when a Codex
task restarted with clear evidence that a run was already active, or when
`circuit_start` reports that the workspace is busy or its launch is uncertain.
For a clearly new request, start a new run directly.

- Continue a clearly matching non-terminal run instead of starting a second
  one. Match using the user's reconnect request plus its flow, state, and
  summary. Never attach a new request merely because its flow is the same.
- If several runs could match, ask the user which one they mean.
- Ignore unrelated terminal runs.
- For `starting`, `running`, `resuming`, or `cancelling`, continue with
  `circuit_status`.
- For `waiting_for_input`, call `circuit_status` to recover the current
  checkpoint and its fresh token.
- For `recovery_required`, follow the recovery rules below.
- An `interrupted` run cannot be resumed. Explain that plainly before starting
  a new run for the same request.

Never invent or reuse a remembered checkpoint token after a restart. Read the
current token from `circuit_status`. Never auto-retry `circuit_start` after a
busy or uncertain error; inspect the existing state first.

## Start a Run

Call `circuit_start` with:

- `flow`: the chosen lowercase public flow;
- `goal`: the user's current request, without adding hidden requirements;
- `why`: only a reason the user actually stated;
- `power`: `auto`, `low`, `medium`, or `high` when requested or useful;
- `process`: `low`, `medium`, or `high` only when process thoroughness should
  differ from the power dial; and
- `autonomous: true` only when the user asked for autonomous operation.

Do not supply workspace paths, executables, commands, arguments, environment
variables, timeouts, config paths, output paths, or flow roots. The MCP host
owns those values.

`circuit_start` is asynchronous. A successful start response means the worker
was accepted; it does not mean the run completed.

### Explore tournament

For an Explore tournament, set `flow: "explore"` and `tournament` to a value
from 2 through 4. Omit `variants`; Circuit creates the decision branches.

### Prototype tournament

For a Prototype tournament, set `flow: "prototype"`, set `tournament` from 2
through 4, and supply exactly that many `variants`. Every variant needs a
unique safe `id`, a plain `label`, a model name Codex currently exposes, and
an `effort` of `low`, `medium`, `high`, or `xhigh`. If a valid model name is
not known, ask instead of guessing. Do not supply `variants` to any other run.

Tournament and autonomous modes cannot be combined.

## Consent Boundaries

Search is off by default. Use `web_search: "off"` unless current web
information is necessary and the user has given informed consent.

A direct user request to run Review on tracked workspace content is enough
permission for the normal tracked-code relay for that Review run. Do not ask
for a second confirmation before relaying tracked files. This permission does
not cover cached web search or untracked file contents.

When the user asks Review to inspect a specific code target, keep that target
in the `goal`. Examples: "current diff", "staged changes", "latest commit",
`HEAD`, `HEAD~1`, `commit abc1234`, or `main...feature`. Circuit uses that
wording to collect the requested evidence. Do not rewrite a commit, range, or
branch comparison as only "current diff" unless the user actually asked for
staged or unstaged changes. When the goal names no target, Circuit reviews the
current working tree and says so in the report.

Treat that selected target as the only code under review. Do not silently
broaden the run to another working-tree layer, commit, or range. Review sees
only the evidence Circuit captured for that target. It cannot inspect nearby
repository files for extra context.

If the request narrows a complete target to a file or directory subset, or
excludes paths, do not remove that restriction and do not start a broader
Review. Explain that Circuit accepts only a complete target or actual supplied
text, then ask the user which one they want.

A named plan or report file is not readable unless its contents are part of the
captured Git target. A file path by itself is not review evidence. Otherwise,
include the plan or report's actual text in the request.

Circuit cannot fetch a pull request. If the user asks to review one, say that
Review reads local repository evidence only, and offer the local equivalent:
check out the PR branch, then review the working tree or an explicit range such
as `main...HEAD`. Do not fetch, call `gh`, or fall back to shell unless the user
separately asks for that setup work.

Before cached search, tell the user that the search query leaves the machine
and ask whether to continue. Consent applies only to this run. A prior answer
counts only when it explicitly acknowledges that fact for the run being
started. After consent, send both:

- `web_search: "cached"`
- `consent: { cached_web_search: true }`

Never request live search. Never send cached-search consent while search is
off.

For Review, untracked file names and sizes are available without file
contents. Set `include_untracked_content: true` only when the user explicitly
asked to include those contents and agreed they may be relayed. Send
`consent: { untracked_review_content: true }` with it. This consent is separate
from cached-search consent and applies only to this run; include both keys when
both permissions apply.

## Follow Progress

Keep the `run_id` and `next_cursor` returned by `circuit_start`. Poll with
`circuit_status` using:

- that `run_id`;
- `after_cursor` set to the latest returned `next_cursor`;
- `max_events: 100`; and
- `wait_ms: 10000` while waiting for new work.

Render each new event's `summary` verbatim once, in cursor order. Do not show
raw MCP JSON. Replace the saved cursor with each response's `next_cursor`. When
`truncated` is true, immediately poll again with `wait_ms: 0` until the backlog
is drained.

Handle states as follows:

- `starting`, `running`, `resuming`, or `cancelling`: keep polling.
- `waiting_for_input`: handle the checkpoint.
- `complete`: render the final structured report.
- `needs_attention`, `cancelled`, or `interrupted`: stop and report the exact
  summary without claiming success.
- `recovery_required`: use `circuit_recover` as described below.

## Checkpoints

When status returns `waiting_for_input`, show the checkpoint `prompt` and its
advertised choices with their labels and descriptions when present. Use the
host's native question surface when available.

After the user chooses, call `circuit_resume` with the same `run_id`, the exact
`checkpoint.token`, and the selected `choice.id`. Never invent a choice, pass
the label as the ID, or expose the opaque token to the user. Continue polling
from the `next_cursor` returned by `circuit_resume`.

If resume reports a stale or conflicting checkpoint, call `circuit_status`
again and present the fresh checkpoint. Never retry the old token.

If the user wants to stop instead of choosing, call `circuit_cancel`.

## Cancel and Recover

Call `circuit_cancel` when the user cancels the run or replaces the task. For a
direct cancel response, do not describe cancellation as complete until `state`
is `cancelled` and `cleanup_confirmed` is true. Here, `cleanup_confirmed` means
Circuit observed that its recorded owned process group is absent. It does not
promise containment of a descendant that deliberately detached before Circuit
could observe it.

If `circuit_status` or `circuit_list` already reports a cancelled run after a
restart, treat it as terminal. Report its summary and do not call
`circuit_cancel` again or claim that the reconnect response freshly proved
cleanup.

Call `circuit_recover` only for a run in `recovery_required`. Recovery proves
that Circuit's recorded processes are absent before releasing the workspace.
It does not continue the run.

- If recovery returns `cancelled`, report that cancellation and stop.
- If recovery returns `interrupted`, explain that the old run is closed. Start
  a new run only if the user still wants the work continued.
- If recovery returns an error because a process may still exist, show its
  message and `next_action` when present. Do not force an unlock or start a
  competing run.

## Render the Final Result

A complete status response must include `final_report`. Treat it as the source
of truth:

1. Lead with `final_report.summary`.
2. Use `final_report.schema` to interpret the data. Name it only when the user
   asks for protocol detail or when diagnosing a mismatch.
3. Render the useful fields from `final_report.data` as short Markdown bullets
   or a small table. Preserve reported paths, findings, verification results,
   recommendations, selected variants, and evidence links exactly.

Do not paste the whole raw JSON unless the user asks. Do not infer deployment,
quality, verification, or completion beyond what `final_report.data` proves.
If a supposedly complete response has no final report, treat it as a protocol
error rather than inventing a summary.

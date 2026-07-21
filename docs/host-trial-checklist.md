# Circuit Host Trial Checklist

Release QA checklist for validating Codex and Claude Code host behavior before
saying the host experience is ready for broader use. Operators do not need this
for normal first-run setup; use [docs/first-run.md](first-run.md) instead.

## Setup

- Refresh generated host output.
- Refresh installed host plugin caches with `npm run plugins:refresh-local`.
- Run Codex doctor from a normal temp repo.
- Confirm `circuit` on PATH is the expected checkout.
- Run `npm run smoke:host:codex:mcp -- --live` for the isolated, no-spend
  packed-plugin loader and trusted-workspace check.

## Codex Scenarios

- Fresh loader: install the packed plugin into an isolated `CODEX_HOME` and
  confirm the real Codex plugin loader starts Circuit's MCP server.
- Trusted workspace: invoke `circuit_list` through the loaded MCP tool and
  confirm it returns the smoke harness's exact workspace sentinel through
  `codex/sandbox-state-meta`. Then confirm the first Review writes its report
  only to the intended test workspace.
- No shell fallback: confirm Codex calls the MCP tools and never runs Circuit
  through `exec_command` or requests approval.
- Natural Fix: run
  `/circuit:run the checkout total is wrong when discounts and tax both apply` and
  confirm Codex invokes Circuit with the Fix flow.
- Natural Review: run `/circuit:run please review my current diff` and confirm
  Codex invokes Circuit with the Review flow.
- Natural Build: run `/circuit:run add billing settings to the account page` and
  confirm Codex invokes Circuit with the Build flow.
- Natural Explore: run
  `/circuit:run decide: should we replace auth providers?` and confirm Codex
  invokes Circuit with the Explore flow or an explicit decision flow path.
- Run-selected Build: use `/circuit:run` for a build-like task and confirm
  Codex invokes Circuit with the Build flow.
- Checkpoint: exercise a checkpointing run and confirm the question/choice is
  understandable, restart Codex, recover it through `circuit_list`, and resume
  one advertised choice.
- Tournaments: complete two-way Explore and Prototype runs.
- Cached search: confirm it remains off without consent and works only after
  the operator accepts that the query leaves the machine.
- Proof network: run a proof that attempts loopback access and confirm the
  listener receives no connection.
- Failure: force a verification failure and confirm the final summary explains
  what failed and where to look.

## Claude Code Scenarios

- Natural Run: invoke `/circuit:run <natural task>` and confirm the host starts
  Run and records the selected flow.
- Run-selected Build: use `/circuit:run` for a build-like task and confirm the
  selected flow is Build.
- Review: review a real uncommitted diff and confirm evidence warnings are
  visible when present.
- Explore: ask for an architectural recommendation and confirm the final summary
  is useful without opening raw reports.
- Checkpoint: confirm AskUserQuestion or the closest native question tool is used
  when available.
- Failure: force a verification failure and confirm the final summary explains
  what failed and where to look.

## What To Grade

- Did Circuit take work off the operator's plate?
- Was the selected flow obvious?
- Were progress updates helpful without becoming noisy?
- Did the host distinguish itself from the worker connector?
- Did verification and review actually run?
- Could the operator understand the outcome from the final summary alone?
- Were deeper report paths available without dominating the thread?
- Did the Codex run complete through MCP without shell escalation, cache edits,
  or manual recovery?

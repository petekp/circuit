# `circuit history pull` — the gated pull surface

Status: reference
Slice: [`self-auditing-memory-slice-4-spec.md`](../ideas/self-auditing-memory-slice-4-spec.md)

An agent-invoked, cited, **hint-only** query the agent may hit at a decision
point to re-fetch prior-run context that earned-precision injection did not push
into the run-start prompt. Every pull is logged back into the loop (a
`history.pull-log@v1` entry on the active run folder) so a later increment can
learn whether a pulled hint correlated with a better outcome.

## When to use it

At a decision point mid-run — before editing a risky area, choosing between
approaches, or when the run-start recall block was empty or narrow — the agent
*may* pull. It is never required; a run with zero pulls is normal.

## Command

```
circuit history pull --json --flow <flow-id> --decision-point <label> \
  [--run-folder <path>] [--limit <n>] [--per-run-limit <n>] <query...>
```

- `--flow` (required) — suppression keys on the flow, so a hint that measurably
  misled comparable runs of this flow is not re-surfaced by the back door.
- `--decision-point` (required) — a short label for the audit (e.g.
  `before-editing-auth-guard`).
- `--run-folder` (recommended, not enforced) — the active run folder; the
  pull-log entry is appended to `<run-folder>/reports/history/pull-log.json`.
  Omitting it skips the log append and surfaces a `pull_log_unavailable`
  warning ("no --run-folder supplied; the pull returned results but was not
  logged") instead of failing.

In a relay prompt these three are pre-filled: the run folder and flow are
interpolated into the always-on affordance line, so only `--decision-point` and
the query are agent-supplied.

## What it returns

The existing `HistoryMemoryInputPreviewV1` envelope (no new result schema), with
measured-negative hints suppressed. Results are `authority: "hint_only"` and
carry the canonical authority notice: they **cannot satisfy any current proof,
checkpoint, policy, route, recovery, verification, or write authority.** Memory
orients; it never overrules.

## Boundaries

- Suppression is **fail-open**: a missing or stale effect report suppresses
  nothing and emits a warning; the pull still returns results.
- A logging failure never blocks the pull (orienting the agent outranks
  bookkeeping); it surfaces a `pull_log_unavailable` warning instead.
- The pull applies **no budget or tiering** — the agent asked an explicit
  question, so it surfaces everything that matches except measured harm. (The
  budget/tier ranking is the run-start *push* path's job; see Slice 3.)

## Note on packaging

This reference is the human-readable home for the pull affordance. It is not a
plugin `skills/` entry because `plugins/{claude,codex}/skills/` are generated
surfaces pinned to the flow/command set (asserted by the host-plugin contract
tests); `history pull` is a `history` subcommand, not a top-level command. The
agent-facing affordance ships as the always-on advisory line in
`composeRelayPrompt` (the primary surface in the spec's D4), which is contract-
tested in `tests/runner/relay-pull-affordance.test.ts`.

# Cost capture for the fix eval (instrument 1)

Date: 2026-06-11. Status: implemented on `feat/eval-cost-capture`.

The charter (docs/evals/theses-and-hypotheses.md) requires per-arm, per-role
token and dollar accounting before any cost-controlled comparison ships.
This note records the seam decisions and the probe evidence behind them, so
the implementation can be audited against what the CLI actually emits.

## What the CLI provides (probed 2026-06-11)

A `claude -p ... --output-format stream-json --verbose` run ends with a
terminal `{type:"result"}` event carrying:

- `total_cost_usd`: the CLI's own dollar figure.
- `usage`: main-loop token counts, including `cache_creation` split by TTL
  (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`).
- `modelUsage`: a per-model map with `inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreationInputTokens`, and `costUSD`.

Verified properties that the design leans on:

1. `sum(modelUsage[*].costUSD) === total_cost_usd` exactly (hand-checked
   against the published price table; the CLI computes from list prices).
2. `modelUsage` is the true total. The top-level `usage` block covers the
   main loop only; internal helper calls (for example a side haiku call)
   appear only in `modelUsage`. Token-class totals must come from summing
   `modelUsage`, not from `usage`.
3. The TTL split exists only at the top level, not per model. Computed cost
   apportions each model's cache-creation tokens across TTLs in proportion
   to that envelope's top-level split (all-1h in every probe so far, since
   the CLI uses the 1h beta by default). Known approximation: the top-level
   split covers the main loop only, while the per-model creation counts
   include helper-model writes, so the apportionment applies a main-loop
   ratio to a slightly larger token population. The error is bounded by the
   helper share of creation tokens (zero in every probe so far) and by the
   5m/1h price gap; there is no better data available at this seam.

The same `result` event shape appears in `--output-format json` (one JSON
object on stdout), which is what the vanilla arm now uses.

## Capture seams

Two arms, two seams; both end up in the same normalized shape.

### Circuit arm: engine-side, per relay

All model spend in a Circuit run flows through relays. The claude-code
connector already parses the terminal result event
(`src/connectors/claude-code.ts`, `parseClaudeCodeStdout`); it now also
extracts a normalized `usage` block into `RelayResult` (optional field, so
codex and custom connectors are untouched). The relay executor forwards it
onto the `relay.completed` trace entry.

Per-role attribution is a join the harness performs, not an engine concern:
`relay.started` already carries `role` and `resolved_selection` on the same
`(step_id, attempt)` key that `relay.completed` uses. The harness reads
`<run-folder>/trace.ndjson`, joins the two, and sums per role.

Usage extraction is tolerant by design: a missing or odd-shaped usage block
leaves `usage` undefined and never fails the relay. Cost capture is
observability, not correctness, and a CLI that stops emitting usage must not
break runs. The harness counts relays without usage
(`usage_missing_count`) so an undercount is always legible.

Why engine-side and not the eval PATH shim: the shim does intercept the
circuit arm's relay subprocesses (both arms resolve bare `claude` through
the wrapper PATH), but the shim cannot know which role a relay serves. Only
the engine has that context. The trace field also feeds the planned
itemized receipt card, so it is a product seam, not eval-only plumbing.

### Vanilla arm: JSON envelope on stdout

`vanillaClaudeArgs` gains an opt-in `{ jsonEnvelope: true }` that adds
`--output-format json`. Opt-in because the older circuit-vs-vanilla harness
treats vanilla stdout as the final answer text and must not change.

With the envelope on, the agent's prose (including the fenced claim JSON the
prompt demands) moves inside the envelope's `result` field. The harness
unwraps the envelope first and runs claim parsing on `result`. This step is
load-bearing: running the existing last-JSON-object claim parser on raw
envelope stdout would parse the envelope itself and silently report
`claimed_fixed: false` for every vanilla run.

A run that times out or crashes produces no parseable envelope. The claim is
then recorded as `parse_status: "envelope-unparsed"` with `claimed_fixed:
false`, never guessed from raw stdout: any JSON the fallback parser would
find there is the envelope itself (or a truncated fragment of it), which
re-opens the same shadowing hole on the noisy path. The per-arm
`claim_parse_failure_count` aggregate counts these so a polluted false-fixed
denominator is visible. Stray bytes before an otherwise valid envelope are
tolerated (the parser scans object starts from the end of stdout for the
`type: "result"` shape).

## Dollars: reported and computed

Every arm score carries both fields the charter requires:

- `cost_usd_reported`: the CLI's `total_cost_usd` (summed across relays for
  the circuit arm).
- `cost_usd_computed`: per-model tokens priced against the committed table
  at `evals/ledger/prices/<date>.json` (append-only; newest file wins).
  Model ids resolve by longest-prefix match, so dated ids like
  `claude-haiku-4-5-20251001` hit the `claude-haiku-4-5` row. An id with no
  row leaves `cost_usd_computed` absent and sets `price_table_miss`, never
  guesses. The same poison rule covers price rows that arithmetic to a
  non-finite figure and any top-level tokens the per-model breakdown does
  not account for, checked per token class so a surplus in one class cannot
  hide a deficit in another: the only $0 computed cost is a genuinely empty
  capture.

Price table provenance: rows are the published list prices from the
platform.claude.com pricing page as of the file's date. Only the haiku-4-5
row is additionally probe-verified (the CLI's own `total_cost_usd`
reproduces exactly from those rates); the other rows are transcriptions of
the published page, not measurements.

Reported-vs-computed divergence above 5 percent of the larger figure sets a
per-score flag and a per-arm `cost_divergence_flag_count` aggregate. The
denominator is the larger of the two so a reported $0 against a nonzero
computed cost still flags. Divergence means the price table is stale or the
apportionment assumption broke; it fails bookkeeping (the numbers are not
citable) without failing the run.

## What counts toward cost

Everything the arm spent. For the circuit arm each relay attempt emits its
own `relay.completed`, so verdict-check retries (the dominant retry class)
are counted per attempt. Known undercount: an attempt whose subprocess
crashes or times out emits `relay.failed` and never reaches
`relay.completed`, so its tokens are not captured at all; the harness counts
those trace entries as `relays_failed` so the undercount is legible rather
than silently absorbed. (`usage_missing_count` covers a different gap: arm
scores where no usage was captured at all, for example a vanilla run with no
envelope.)

Cost integrity is layered. A single capture unit (one envelope, one relay)
either prices completely or not at all. Arm-level and aggregate sums may be
partial, but every partial sum travels with the counter that marks its gap:
`relays_failed` and `relays_missing_usage` for token sums,
`envelopes_missing_reported_cost` for the reported dollar sum,
`price_table_miss_count` for the computed dollar sum. The ledger commits the
counters alongside the totals, so a committed number is never citable
without its caveats.

## Where the numbers land

- `summary.json` per arm score: five token fields (`input`, `output`,
  `cache_read`, `cache_creation_5m`, `cache_creation_1h`), both dollar
  fields, flags, and for the circuit arm a `usage_by_role` breakdown
  (researcher, implementer, reviewer) plus per-model detail.
- Aggregates per arm: token-class sums (cache creation also split 5m/1h),
  dollar sums, mean plus median and p90 per-task computed cost
  (nearest-rank, per the methodology checklist), and the integrity counters
  (`usage_missing_count`, `cost_divergence_flag_count`,
  `price_table_miss_count`, `claim_parse_failure_count`, relay tallies).
- Committed ledger (`scripts/evals/shared/ledger.ts`): flat per-arm token
  sums (including the TTL split) and dollar totals plus the integrity
  counters, all on the explicit metrics allowlist. Per-role detail stays in
  summary.json to keep ledger entries lean; nothing non-numeric is added,
  so the poison scan is unaffected.
- `report.md`: a cost column in the held-out table, a median/p90 line, and
  a bookkeeping sentence per arm.

## Non-goals

- Codex and custom connector usage parsing (field stays optional).
- Cost-frontier reporting and cost-controlled comparisons (need the larger
  task set first; this instrument only makes the numbers exist).
- Switching the circuit-vs-vanilla quiz harness to the envelope.

# Continuity capture-path refactor (Steps 0-2): implementation spec

> **Status (2026-06-07): Step 0 ran and returned NO-GO.** The capture-side
> satisfaction classifier does not beat recency (false-resurrection 0.74x the
> baseline against a 0.50x gate, and it over-buries 10% of genuinely-open work).
> So **Step 1 and the ambient half of Step 2 below are cancelled.** The signal is
> structural, not a tuning miss: 58% of sessions give the deterministic scan no
> usable cue, and the harvest is a no-model every-turn CLI that cannot run a
> semantic judge. What survives is **Step 2a** (render `run_ref.runtime_status`,
> a real recorded field) and **Step 4** (compaction and host-parity coverage,
> tracked in the eval). The full numbers and the redirect are in the
> [eval's Step 0 results section](../architecture/continuity-first-principles-evaluation.md#step-0-results-probe-run-2026-06-07-no-go-on-the-capture-side-classifier).
> The sections below are kept as the record of what was specced and gated; read
> them as historical context, not as a build order.

Implements Steps 0 to 2 of
[`docs/architecture/continuity-first-principles-evaluation.md`](../architecture/continuity-first-principles-evaluation.md).
Step 3 (the `done --clear-ambient` resurrection bug) already shipped, so it is
out of scope here. This spec is the thin "decisions resolved plus failing
tests" layer the readiness check found missing for the gated refactor. It
follows the same shape as
[`continuity-staleness-implementation.md`](./continuity-staleness-implementation.md).

The work is gated. Step 0 is a read-only go/no-go probe. Steps 1 and 2 proceed
only if Step 0 passes; if it fails, the fallback is restore-side reconciliation
(R1 in the eval), not this refactor.

## Scope

- **Step 0 (gate): classifier-feasibility probe.** Read-only. Measure whether
  reading the assistant's own turns classifies "this request is satisfied"
  more reliably than plain recency. Decide go/no-go. No production code change.
- **Step 1: capture-side satisfaction model.** The parser reads assistant
  replies, classifies each retained intent, and the goal becomes the newest
  still-open request instead of the newest request. One additive optional
  status field on the narrative; the cursor carries status across harvests.
- **Step 2: two render wins.** A finished run-backed record is not injected as
  live (read `run_ref.runtime_status`). A likely-satisfied ambient goal is
  labeled rather than shown as live work.

## Architecture facts this spec relies on (verified against current source)

1. `parseTranscriptContent` discards every non-user turn
   (`src/cli/handoff.ts:1965`), returns `{ intents, summary }`, caps each
   intent at 280 chars, and keeps only the last 4 (`1968-1970`).
2. The goal is the last intent (`goal = latestIntent`, `2449-2452`); `next` is
   a hardcoded constant (`2466`).
3. The incremental cursor stores `intents: string[]` plus `summary`
   (`HarvestCursor`, `1974-1980`); the incremental path concatenates
   `cursor.intents` with the freshly parsed tail (`2067`). It carries no
   assistant turns and no per-turn linkage.
4. `ContinuityNarrative` is a `.strict()` object of four required strings
   (`src/schemas/continuity.ts:28-36`). The record is `.strict()` with
   `schema_version: z.literal(1)`. The pure-ambient restore path returns
   `record_invalid` with no fall-through (`handoff.ts:761-766`). So a new
   *required* field makes every already-saved record fail to parse and
   surfaces a malformed-record error instead of the operator's continuity. A
   new *optional* field does not.
5. `composeHandoffBrief` already receives the whole record
   (`handoff.ts:296`), so `record.run_ref.runtime_status` is in scope for
   run-backed records. It currently reads only `narrative.goal` and
   `narrative.next`. The status is read only at save time (`writeActiveRun`).
6. `composeAmbientBrief` (`417-446`) renders the staleness block lines and the
   boundary clause, and the staleness work locked that wording line by line in
   tests. New intent-status text must not disturb those lines.
7. `SnapshotStatus` has exactly six values: `in_progress`, `complete`,
   `aborted`, `handoff`, `stopped`, `escalated` (`src/schemas/snapshot.ts:21-28`).

## Resolved decisions

1. **Status shape: one headline field, not a per-intent list.** Add a single
   optional `goal_status` to the narrative. Rationale: the brief surfaces one
   goal, so a per-intent list buys nothing the render uses, and a structured
   list would break `ContinuityNarrative`'s four-string strict shape and its
   contract tests. The parser still classifies every retained intent
   transiently to *select* the goal; only the selected goal's status is
   persisted.
2. **Migration: optional-with-default, no `schema_version` bump.** `goal_status`
   is `.optional()`. Old records lack it, parse fine, and read as
   `cannot-tell`. This is the only mechanism that keeps the refactor additive
   given fact 4.
3. **Cursor carries status.** Extend `HarvestCursor` with an optional
   `intent_statuses` parallel to `intents` (optional so old cursors still
   read). On an incremental harvest, statuses for retained intents carry
   forward and still-open intents are re-evaluated against the new tail's
   assistant turns. This is the harder half of Step 1 and the reason Step 0
   gates it.
4. **The classifier rule is the output of Step 0.** This spec does not
   pre-commit the open/likely-done/cannot-tell rule. Step 1 codes against
   whatever rule Step 0 validates, behind the existing parser boundary.
5. **Goal selection.** The goal is the newest intent whose status is not
   `likely-done`; fall back to the newest `cannot-tell`, then to the newest
   intent overall. Derive `next` from the selected intent instead of the
   constant. Default to `cannot-tell` (never silently drop a request) when
   unsure.

## Decisions for sign-off (genuine product calls, not engineering defaults)

- **Step 2 status mapping for the two ambiguous values.** `in_progress` is
  live; `complete` and `aborted` are closed; `escalated` is shown but flagged
  ("escalated, do not resume blindly"). The two real calls are `handoff` and
  `stopped`. Recommendation: `handoff` renders closed and labeled "handed
  off" (a deliberate handoff is not live work to auto-inject), and `stopped`
  renders closed. Confirm or adjust before Step 2 ships.
- **Step 0 pass threshold (the gate number).** Recommendation below. Confirm
  the bar, since it decides whether the whole refactor proceeds.

## Step 0: classifier-feasibility probe (gate, read-only)

- **Corpus.** `~/.claude/projects/*/*.jsonl`, filtered to transcripts with at
  least 5 user intents AND at least one intent that is answered and then
  superseded by a later intent (the case where recency and a satisfaction
  classifier actually disagree). Exclude short title-stub files. Target a
  sample of at least 30 transcripts. Log how many were scanned and how many
  excluded, so the sample is not a silent cap.
- **Gold labels.** For each sampled transcript, label each intent satisfied or
  open. Use a strong-model judge over the full transcript as the oracle, spot
  checked by hand on a subset. Record the labels so the run is reproducible.
- **Baseline.** Recency, exactly as today: the goal is `intents[last]`, every
  earlier intent treated as satisfied, the last treated as open.
- **Metric.** False-resurrection rate: the fraction of truly-satisfied intents
  a method labels "open" (the costly error, because that is what resurfaces
  dead work). Also report precision and recall on the satisfied class. Raw
  accuracy is not the headline metric; it is dominated by the majority class.
- **Pass/fail.** The classifier passes if its false-resurrection rate is at
  most half the baseline's on at least 30 transcripts, and it is no worse than
  the baseline on the open class. Otherwise STOP Steps 1 and 2 and do R1
  instead.
- **Output.** A written go/no-go with the numbers. No production change.
- **Reproducibility.** Same corpus and labels produce the same numbers; that
  is the probe's "test."

## Step 1: satisfaction model (gated on Step 0)

### Schema and cursor (additive)

- `ContinuityNarrative`: add
  `goal_status: z.enum(['open', 'likely-done', 'cannot-tell']).optional()`
  (`continuity.ts`). Optional, so old records parse; absent reads as
  `cannot-tell`.
- `HarvestCursor`: add `intent_statuses?: readonly Status[]` parallel to
  `intents`. `readHarvestCursor` validates it and tolerates its absence on old
  cursors.

### Parser

- `parseTranscriptContent` stops discarding assistant turns. It collects them
  with turn linkage, classifies each retained user intent with the Step-0
  rule, and returns `{ intents, intent_statuses, summary }`. Keep the last-4
  truncation aligned across `intents` and `intent_statuses`.

### Selection

- Replace `goal = intents[last]` with the selection rule in resolved decision
  5. Persist the selected goal's status into `narrative.goal_status`. Derive
  `next` from the selected intent.

### Migration and locked tests

- The test asserting "freshest intent becomes the goal" flips to "newest open
  request wins" (`tests/runner/handoff-harvest.test.ts`, around line 145).
- Add the optional field without disturbing the staleness-locked brief lines.

### TDD (failing-first)

1. An answered-then-superseded intent is NOT selected as the goal.
2. An all-open session still selects the newest intent (no regression).
3. An old on-disk record with no `goal_status` still parses and restores.
4. An old cursor with no `intent_statuses` still parses and harvests.

## Step 2: render wins

### Run-backed (`composeHandoffBrief`)

- Read `record.run_ref.runtime_status` and map per the sign-off table. A closed
  run renders as closed, not injected as live; `escalated` is flagged. The
  record is already in scope, so this is a mapping, not a new read path.

### Ambient (`composeAmbientBrief`)

- When `goal_status === 'likely-done'`, label the "Latest request" line (for
  example "Latest request (likely already handled): ..."). Do not touch the
  staleness lines or the boundary clause.

### TDD (failing-first)

1. A run-backed record with `runtime_status: 'complete'` renders closed, not
   live.
2. `runtime_status: 'escalated'` renders flagged.
3. `handoff` and `stopped` render per the confirmed mapping.
4. A `likely-done` ambient goal gets the label; an `open` goal is unchanged.

## Dual-host parity

The `brief` CLI surface does not change, and both hosts render through the same
composer. No host hook changes for Steps 0 to 2 (PreCompact and host parity are
Step 4, out of scope here).

## Invariants preserved (CONT-I1..I18)

`goal_status` is optional and additive, so CONT-I14 (ambient field-presence
closure) holds, old records keep parsing (CONT-I18 spirit), and the
discriminator and index shapes are untouched. No new index field.

## Step order and gates

1. Step 0 first; it gates Steps 1 and 2. If it fails, stop and do R1.
2. Step 1 behind Step 0.
3. Step 2 behind Step 1.
4. Each ships failing-test-first; run full `npm run verify` before claiming
   done (do not pipe it through `tail`, which masks the real exit code); and
   regenerate the host runtime bundles afterward, since they bundle
   `handoff.ts` (`npm run build-plugin-runtime`).

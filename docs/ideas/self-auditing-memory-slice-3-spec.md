# Slice 3 Spec: Earned-Precision Injection (first behavior change)

Status: implemented. Run-start recall now uses flow-scoped earned-precision
gating through `src/app/history/run-start-recall.ts`,
`src/app/history/recall-precision.ts`, and `src/shared/relay-support.ts`. Some
path references below use the pre-`src/app/history` location from writing time.
Date: 2026-05-29
Parent design: [`self-auditing-memory.md`](./self-auditing-memory.md) (section 4 step 2, inject by earned precision; section 6, delivery model; section 8, build sequence item 3)
Depends on: [`self-auditing-memory-slice-1-spec.md`](./self-auditing-memory-slice-1-spec.md) (the `content_id` identity) and [`self-auditing-memory-slice-2-spec.md`](./self-auditing-memory-slice-2-spec.md) (the `history.memory-effect@v1` per-`(group_key, flow_id)` verdicts)

This is the concrete, schema-grounded build spec for Slice 3, verified against source at writing time. **Slice 3 is the first slice that changes a run's behavior.** It sits on the live run-start recall path and decides which recalled hints are *pushed* into the relay prompt, using the measured effect from Slice 2. Per the parent design, slices 3-4 are the only behavior-changing slices, and they earn that change only after slices 1-2 show the effect is real.

## 1. What Slice 3 is

A precision gate inserted into the existing run-start recall path. Today `prepareRunStartHistoryRecall` (`src/history/run-start-recall.ts`) tokenizes the operator goal, runs `queryHistory` with **no flow filter**, converts the top hits to `MemoryInputV0` records via `historyMemoryInputPreview`, caps them at `DEFAULT_RECALL_LIMIT` (3), and hands them to the runtime, which renders the "Prior Circuit History (hint-only)" block in `composeRelayPrompt` (`src/shared/relay-support.ts`) and records their ids in `memory_context.memory_input_ids` (`src/cli/circuit.ts`). Slice 3 inserts one step before the cap: **consult the Slice 2 effect report and re-rank/suppress candidates by measured effect and source freshness**, then record what the gate did in an audit sidecar and surface a one-line recall indicator (with the write-side-collision caveat spelled out in section 3).

It also closes the parent design's named recall limitation (section 6): run-start recall does not pass `options.flow` today even though `queryHistory` supports it, so today's recall is goal-lexical, not flow-scoped. Slice 3 passes the selected flow, which both narrows recall to the flow about to run and is the key under which the per-`(group_key, flow_id)` verdicts are looked up.

Deliverables:

- a shared content-identity module so the gate and the Slice 1 reader compute the same `content_id`,
- an effect-report loader (read-only, fail-open),
- the precision gate (a pure function over candidates + verdicts),
- flow-scoped recall (pass `options.flow`),
- a `history.recall-precision@v1` audit sidecar schema + writer (the indicator's guaranteed home),
- a one-line earned-precision recall indicator, surfaced with the source-record wiring described in section 3,
- contract + unit + integration tests.

## 2. Decisions (each marked for operator veto, per the Slice 1 default-and-flag pattern)

### D1 — The gate is suppress-negative-and-rank, not a strict positive-only allow-list

The parent design (section 4 step 2) says "push only a tiny set of hints with a non-negative measured effect and a fresh source." Read literally as a positive allow-list (push **only** `correlated_positive`), that is a problem on a real corpus: Slice 2 establishes that **every** verdict is `not_enough_data` until arms reach the sample floor, so a positive-only allow-list would push *nothing* for the entire cold-start window and would **turn off** the prior-run recall that ships today. That is a behavior regression, and the parent design's own section 11 notes the loop may sit pre-ratchet indefinitely on a single small repo.

Resolution: the gate **suppresses measured-negative hints and ranks the rest by measured effect and freshness**, taking the existing `DEFAULT_RECALL_LIMIT` from the top. Concretely, each candidate is assigned a tier (D3), `correlated_negative` candidates are dropped, and the budget fills from the best tier down. This **equals** the allow-list once the corpus is rich (positive hints win the budget, negatives are gone) but **degrades to today's behavior during cold-start** (when nothing is measured, neutral-but-fresh hints still fill the slots). The measurement loop's actual product — *removing a hint that measurably misled comparable runs* — is delivered; the cold-start regression is avoided.

**Veto path:** the tier-to-inject predicate is one function. An operator who wants the strict positive-only allow-list flips it to "inject only tier `positive_fresh`."

### D2 — Fail-open when the effect report is absent, unreadable, or stale

The gate reads Slice 2's verdicts. If `memory-effect.v1.json` is missing (Slice 2 never `--write`-en it) or unreadable, the gate **falls open to today's behavior** (no suppression, original rank order, flow-scoping still applied) and records a warning (`HistoryWarningCodeV1` gains `effect_report_unavailable`, additive — mirroring how Slice 1 added its own warning codes). It never **fails closed** (never silently drops all memory because the verdict source is unavailable), which would be both a regression and a violation of the design's hint-only, fail-open posture — memory orients but never overrules, and the absence of memory must never block a run.

There is deliberately **no** "index is `possibly_stale` ⇒ fail open" trigger: `HistoryMemoryEffectV1` carries no `index_state`/staleness field, so the gate cannot observe index freshness from the report it reads, and inventing such a trigger would be a capability the data does not support. Index freshness is already handled upstream — `prepareRunStartHistoryRecall` runs `queryHistory` with `rebuildIfStale: true`, so the candidate set the gate scores is built against a freshly-rebuilt index. The effect report's own `generated_at` is recorded in the sidecar (as `effect_report_generated_at`) so a reviewer can see how old the consulted verdicts are.

**Veto path:** one boolean (`failOpen`) selects the alternative for an operator who deliberately wants "no measured verdicts ⇒ inject nothing."

### D3 — The tiers, and how staleness sinks rather than hard-suppresses

Each candidate `m` (a `MemoryInputV0` from `historyMemoryInputPreview`) gets a `content_id` (D4); the gate forms its **`group_key`** exactly as Slice 1/2 do — `content_id` when content-addressed, else `unresolved:<m.memory_id>` — and looks up the `effect.item_effects` row whose `(group_key, flow_id)` equals `(this group_key, selected_flow)`. This is uniform across both cases and matches Slice 2's partition key precisely. One subtlety worth stating correctly: `m.memory_id` is **source-doc-scoped, not run-scoped** — `historyMemoryInputPreview` derives it as `prior-run-<fileStem(source run_id)>-<sha256(doc_id)[:12]>`, deterministic from the recalled *source* document, so the same source doc recalled in a later run yields the *same* `memory_id` (`src/history/memory-preview.ts:46-48`). A null-`content_id` candidate's `unresolved:<memory_id>` key therefore **can** match a Slice 2 unresolved-group row built from prior recalls of that same source doc (an earlier draft wrongly claimed it never could). In practice such a row is almost always `not_enough_data` — it would need two or more same-flow runs recalling that exact unhashed source doc to reach the sample floor — and `not_enough_data` tiers identically to `no_verdict`, so the gate behaves benignly whether or not the row exists; if it ever did reach a `correlated_negative`, suppressing it would be correct. Absent row ⇒ `no_verdict`. Tiers, highest injected first:

- **`suppressed`** — verdict is `correlated_negative`. Dropped from the push set entirely. (Still reachable by the Slice 4 pull surface; suppression is push-only.)
- **`positive_fresh`** — source `staleness.status === 'fresh'` and verdict `correlated_positive`.
- **`neutral_fresh`** — source fresh and verdict `not_enough_data | unresolved | no_verdict`.
- **`stale`** — source `staleness.status` is `stale` or `unknown` (any non-negative verdict). Sinks below every fresh tier.

Within a tier the existing query rank order is preserved. The push set is the top `DEFAULT_RECALL_LIMIT` after removing `suppressed`. Staleness **sinks** a hint rather than hard-suppressing it, because "fresh source" is a *preference* that should not, on its own, blank the recall block when only stale hints exist; `correlated_negative` is the only hard-suppress, because that is the one signal that is *measured harm*. This honors the staleness posture of [`project-execution-memory.md`](deprioritized-ledger.md) (section 6 re-verifies staleness at injection and shows it rather than hiding it) — stale facts are shown and de-prioritized, not dropped silently — while still letting fresh, measured-positive hints win the budget.

**Veto path:** an operator who wants stale sources hard-suppressed moves the `stale` tier into `suppressed`; one line.

### D4 — One content-identity function, shared by the Slice 1 reader and the gate

The gate must compute the **same** `content_id` Slice 1 used (which is the `group_key` for content-addressed items), or the verdict lookup silently misses. Today that logic is `contentIdentity` inside `src/history/memory-merge.ts`. Slice 3 lifts it into a small shared module `src/history/memory-identity.ts` exporting `contentIdentityOf(memory: MemoryInputV0)`, imported by both `memory-merge.ts` and the gate. A contract test asserts both call sites resolve identical ids for the same input, so the join key cannot drift. This is a pure refactor of already-built Slice 1 code (move a function, no behavior change) and is in scope for Slice 3 because Slice 3 is the second consumer.

**Veto path:** if the operator prefers no Slice 1 edit, the gate recomputes the identity inline with a parity contract test against the merge reader; the join key is still pinned, at the cost of a duplicated 6-line function.

### D5 — Flow-scoped recall, and where the gate sits in the control flow

Slice 3 passes the selected flow id into `prepareRunStartHistoryRecall`, which passes it to `queryHistory({ flow })`. This narrows candidates to documents of the flow about to run (the execution-first move named in the parent design section 6 and [`project-execution-memory.md`](deprioritized-ledger.md) section 5) and is the key for verdict lookup. The gate runs **inside** `prepareRunStartHistoryRecall`, after `historyMemoryInputPreview` and before `capReport`, so the cap applies to the *gated* set. The CLI wiring at `src/cli/circuit.ts:958` must therefore know the selected flow at recall time; if flow selection currently resolves after the recall call, the recall call moves after selection (a control-flow detail the builder confirms — the flow is already selected before the run executes, so this is a re-order, not new state).

**Veto path:** an operator who wants to keep goal-lexical recall (no flow filter) but still apply earned precision can disable flow-scoping; the gate still looks up `(group_key, selected_flow)` verdicts, it just scores over an unfiltered candidate set.

## 3. The audit surface: `history.recall-precision@v1`

Earned precision is a *meaningful* memory update (it changes what the agent sees), so the parent design's "never a silent meaningful update" rule (section 9) requires both a one-line indicator and a durable record. The frozen `HistoryRecallReportV1` is not extended; instead a new sidecar at `reports/history/recall-precision.json` records every candidate's gate decision, so the change is auditable and so a future Slice 2 extension can measure "did suppression correlate with better outcomes" without touching the recall schema.

```
RecallPrecisionTierV1 = enum(suppressed, positive_fresh, neutral_fresh, stale)

RecallPrecisionDecisionV1 {
  memory_input_id: string
  content_id: string | null
  staleness: MemoryStalenessStatus            # fresh | stale | unknown
  consulted_effect_status: MemoryMergeEffectStatusV1 | "no_verdict"
  tier: RecallPrecisionTierV1
  injected: boolean                            # made it into the push set within the budget
}

HistoryRecallPrecisionV1 {
  api_version: "history-recall-precision-v1"
  schema_version: 1
  generated_at: datetime
  flow_id?: string                             # the selected flow (absent if unknown)
  effect_report_available: boolean             # false ⇒ fail-open path was taken
  effect_report_generated_at?: datetime        # provenance of the consulted verdicts
  authority_notice: HISTORY_AUTHORITY_NOTICE
  budget: int>=0                               # DEFAULT_RECALL_LIMIT in effect
  indicator: string                            # the earned-precision recall indicator (see surfacing note)
  decisions: RecallPrecisionDecisionV1[]
  warnings: HistoryWarningV1[]
}
  refine: injected decisions count <= budget
  refine: no decision with tier 'suppressed' has injected === true
```

The `indicator` text (the sidecar is its guaranteed home; surfacing it on the run output is below):

- Cold corpus / fail-open: `"Memory (hint-only): 2 prior-run hints loaded for flow review; earned-precision active but no measured effects yet."`
- With a suppression: `"Memory (hint-only): suppressed 1 hint with measured negative effect; 2 hints loaded for flow review. Sources cited; rerun current checks before relying on them."`

**Surfacing note — the `surface_output.memory_indicator` collision.** `surface_output.memory_indicator` is **not** a free field the recall path can simply set. It is already *write-side*: `src/run-envelope/source-record.ts:632-639` derives it from the first `proposed`/`recorded` `memory_update_event`'s `operator_indicator` (the indicator for memory a run *wrote*, i.e. Slice 5's surface), and `surfaceFor` (`source-record.ts:519-540`) only accepts a single `memoryIndicator` input. Circuit's recall wiring in `circuit.ts` does not assemble `surface_output` at all — the envelope is built downstream in the source-record writer. So Slice 3 resolves the indicator in two layers: (1) the **recall-precision sidecar's `indicator`** is the guaranteed, always-written home (no collision, fully owned by Slice 3); (2) to *also* show it on `surface_output.memory_indicator`, Slice 3 threads the recall indicator into the source-record writer (a named deliverable, section 4) with an explicit **precedence rule**: a write-side `proposed`/`recorded` indicator, when present, wins the single field; the recall indicator fills it only when there is no memory-write event. On a Slice-3-only corpus there are no memory-write events (Slice 5 is the only writer), so the field is free and carries the recall indicator; once Slice 5 also runs, the write-side indicator takes precedence and the recall indicator remains available in the sidecar. This keeps one honest one-line surface without two subsystems silently overwriting each other.

## 4. Modules and surface

- `src/history/memory-identity.ts` (new): `contentIdentityOf(memory: MemoryInputV0): { contentId: string | null; unhashedSource: boolean }`, lifted verbatim from `memory-merge.ts` (D4). `memory-merge.ts` imports it; behavior unchanged.
- `src/history/memory-effect-read.ts` (new): `loadMemoryEffectReport(paths): { report?: HistoryMemoryEffectV1; warnings: HistoryWarningV1[] }` — reads `<index-dir>/memory-effect.v1.json` if present and parseable; returns no report (a warning only) otherwise. Read-only; never builds.
- `src/history/recall-precision.ts` (new): `applyEarnedPrecision({ candidates, flowId, effect, budget }): { memoryInputs: MemoryInputV0[]; precision: HistoryRecallPrecisionV1 }` — the **pure** gate. No I/O; unit-testable from in-memory inputs. Builds tiers (D3), drops `suppressed`, takes top `budget`, composes the indicator and the sidecar object.
- `src/history/run-start-recall.ts`: thread `flowId` through; call `applyEarnedPrecision` between `historyMemoryInputPreview` and `capReport`; return the precision sidecar alongside the recall report.
- `src/cli/circuit.ts`: pass the selected flow id into `prepareRunStartHistoryRecall`; thread the returned `precision` object into the runtime options (alongside the existing `historyRecallReport`, `circuit.ts:986`) so the runtime can persist it; thread `precision.indicator` toward the envelope writer. The existing `runEnvelopeMemoryContext` continues to record the *gated* `memory_input_ids` (so the consume side round-trips exactly the hints that were actually pushed).
- `src/runtime/run/graph-runner.ts`: write the precision sidecar to `reports/history/recall-precision.json`, next to where it already writes `reports/history/recall.json` (`graph-runner.ts:570-571`, the **sole** writer of the recall report). Keeping the sidecar write on the same runtime path as the recall report it mirrors avoids splitting file ownership between the CLI and the runtime — `circuit.ts` only threads the data in, it does not write the file.
- `src/run-envelope/source-record.ts`: accept a recall-derived `memoryIndicator` and apply the precedence rule from section 3 (a `proposed`/`recorded` memory-write indicator wins the single `surface_output.memory_indicator`; the recall indicator fills it only when no memory-write event exists). This is the one source-record change Slice 3 requires; it is additive (the `memoryIndicator` input already exists on `surfaceFor`, `source-record.ts:525`).
- No new CLI subcommand (Slice 3 is a runtime path change, not a report command). No change to `memory-preview.ts`'s producer logic, to the frozen `HistoryRecallReportV1`, or to the relay block renderer.

## 5. The cold-start reality, stated plainly

On today's corpus the gate is **dormant**: with every `effect_status` at `not_enough_data` (Slice 2, D3), nothing is `correlated_negative`, so nothing is suppressed, and Slice 3 reduces to "today's recall, flow-scoped, with stale hints sunk and an honest indicator." The only live behavior deltas today are (a) flow-scoping and (b) stale-source sinking. Flow-scoping is the more consequential and deserves a blunt caveat: on the actual corpus most flows have zero or one prior same-flow run (the prior reviews count 10 explore / 8 prototype / 2 review / 1 goal / 1 build, `self-auditing-memory-review.md`), so filtering candidates to `doc.flow_id === selected_flow` will frequently **shrink or entirely empty** the recall block for goal/build/review runs, not merely re-rank it. This is intended narrowing (flow-relevant hints only), not a fault; the D5 veto path (disable flow-scoping) is the lever for an operator who prefers goal-lexical breadth, and a run with an empty recall block is normal and fail-open. Earned-precision suppression activates only when `correlated_negative` verdicts exist, which requires the corpus recurrence the parent design (section 11) admits may never materialize on one small repo. This is the design working as intended, not an incomplete build: the gate is wired and inert, ready to bite when measured harm appears, and it costs nothing while it waits. The spec does not claim Slice 3 improves outcomes today; it claims Slice 3 makes injection *governable by measured effect* the moment that effect exists.

## 6. Definition of done (verification surface)

- `tests/contracts/recall-precision-schema.test.ts` — a valid sidecar parses; the budget and no-suppressed-injected refines reject their violations; `tier` and `consulted_effect_status` accept all values incl. `no_verdict`.
- `tests/contracts/memory-identity-parity.test.ts` — `contentIdentityOf` invoked directly and via the `memory-merge` reader yield identical `content_id` for the same `MemoryInputV0` (D4 join-key pin).
- `tests/unit/recall-precision.test.ts` — drives `applyEarnedPrecision` from in-memory candidates + a hand-built `HistoryMemoryEffectV1`:
  - cold corpus (no verdicts) → no suppression, original order preserved, today's set injected, indicator notes "no measured effects yet".
  - a `correlated_negative` content_id → that candidate is `suppressed`, absent from `memoryInputs`, present in the sidecar with `injected:false`.
  - a `correlated_positive` fresh candidate outranks a `neutral_fresh` one within the budget.
  - a `stale` candidate sinks below fresh candidates and is dropped first when the budget is tight, but is injected when it is the only candidate.
  - fail-open: no effect report → `effect_report_available:false`, an `effect_report_unavailable` warning, all candidates injected by original rank.
  - a `content_id: null` candidate → `no_verdict`, treated as `neutral_fresh`/`stale` by its staleness.
- `tests/runner/run-start-recall-precision.test.ts` — scoped to what `prepareRunStartHistoryRecall` actually produces (it returns an in-memory recall report + precision object and writes no file): flow is passed to `queryHistory`; the gate runs before the cap; the returned `precision` object carries its `indicator` and per-candidate decisions; **flow-scoping with no prior same-flow run yields an empty recall block, fail-open, no crash** (the section-5 caveat).
- `tests/runner/run-precision-envelope.test.ts` — the write/record surfaces, which live **downstream** of the recall function (section 3 notes `circuit.ts` does not assemble `surface_output`): the runtime writes the precision sidecar to the run folder (the path that already writes `recall.json`); `runEnvelopeMemoryContext` (`src/cli/circuit.ts`) records the gated `memory_input_ids` matching the pushed set; and `writeRunEnvelopeRecord` (`src/run-envelope/source-record.ts`) applies the indicator-precedence rule (with no memory-write event, `surface_output.memory_indicator` carries the recall indicator; with a `proposed`/`recorded` event present, the write-side indicator wins and the recall indicator stays only in the sidecar).
- Boundary assertions: gated `MemoryInputV0.authority` stays `hint_only`; suppression changes only the push set (the gate never mutates the underlying query result, so the Slice 4 pull path remains able to reach a suppressed hint); the gate never empties the block *because the effect report is missing* (fail-open), though flow-scoping legitimately can (section 5).
- `npm run check`, `npm run lint`, the targeted tests, then `npm run verify:fast` clean.
- Two consecutive adversarial reviews against this spec with no medium-or-above findings.

## 7. Explicit non-goals

- **No new authority.** Suppression is push-only; pull (Slice 4) still reaches every hint. Memory never gates a route, checkpoint, proof, policy, or write. `authority` stays `hint_only`.
- **No fail-closed default.** A missing or stale effect report never blanks the recall block (D2).
- **No project-fact production.** Slice 3 gates the existing `prior_run` recall path. The `kind:"project"` producer is Slice 5; its facts reuse this same gate once they exist (the gate keys on `content_id`/`group_key` + flow, which is producer-agnostic).
- **No new per-run capture.** Slice 3 consumes Slice 2's outcome-based verdicts; it adds no token/elapsed/retry capture.
- **No change to the frozen recall report or the relay block renderer.** The precision data lives in a new sidecar; the prompt block is unchanged in shape.
- **No strict positive-only allow-list by default** (D1), and **no semantic dedup** of hints (content-addressing only, inherited from Slice 1).
- **No persistent decay, promotion, or retirement of stored memory.** Slice 3 suppresses and ranks *per run, at injection time*; it is stateless with respect to the stored items and never retires, demotes, deletes, or promotes a stored hint. The lifecycle's decay/promotion/retire transitions (parent design section 4 step 5 — "Hints that never correlate with better runs decay" — and the section 5 lifecycle) are deferred beyond this slice; "earned precision" here means earned *injection*, not a mutated standing. The parent design's section 8 item 3 is written to match this reading (it defers the prune-and-promote / retire transitions explicitly).

## 8. Sequencing against the in-flight architecture-hardening work

Slice 3 is the first behavior-changing slice and it sits on the **live run-start recall path** (`run-start-recall.ts` → `queryHistory` → `memory-preview.ts`; `circuit.ts` recall wiring; `relay-support.ts` rendering). `queryHistory` imports the indexer/extract source enumerators that **SD-FIX-1** is consolidating, and the recall path is adjacent to the history hashing **SD-FIX-2** is migrating. Slice 3 must therefore land **after** Slices 1-2 exist *and* after SD-FIX-1/2 settle (REP-R1 and REP-R2 have already landed; only the SD-FIX hashing/enumerator work remains in flight), so the behavior change does not land on top of a moving recall/hashing surface. It reads only the stable on-disk `memory-effect.v1.json` (Slice 2's contract) and the stable `MemoryInputV0`/`HistoryRecallReportV1` schemas; it does **not** import the private `sourceStaleness` (it reuses the `staleness` already attached to each hit by `queryHistory`). There is no urgency: the gate is dormant until `correlated_negative` verdicts exist (section 5), so deferring Slice 3 behind the hardening phases costs nothing. Target stable contracts — the effect report, the recall/memory-input schemas, the `content_id` identity — not the current recall file layout.

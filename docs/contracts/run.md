---
contract: run
status: ratified-v0.1
version: 0.4
schema_source: src/schemas/run.ts
last_updated: 2026-07-09
depends_on: [trace_entry, snapshot, ids, change_kind, depth, flow, skill, acceptance-criteria]
closes: []
report_ids:
  - run.trace
  - run.projection
  - run.snapshot
  - run.manifest_snapshot
  - run.result
invariant_ids: [RUN-I1, RUN-I2, RUN-I3, RUN-I4, RUN-I5, RUN-I5a, RUN-I6, RUN-I7, RUN-I8]
property_ids: [run.prop.report_written_before_check, run.prop.attempt_monotonicity_per_step, run.prop.boundary_own_property_defense, run.prop.checkpoint_trace_entry_pairing, run.prop.close_outcome_semantic_adequacy, run.prop.deterministic_replay, run.prop.relay_trace_entry_pairing, run.prop.projection_is_a_function, run.prop.recorded_at_sanity, run.prop.step_trace_entry_causal_ordering]
---

# Run Contract

A **Run** is an instance of a **CompiledFlow** executing. A Run is not a single
type in the schema; it is the aggregate of three projections:

1. The **CompiledFlow manifest** snapshot taken at bootstrap (identified by
   `manifest_hash`).
2. The **trace** — an append-only sequence of `TraceEntry`s beginning with
   exactly one `run.bootstrapped` trace_entry, optionally ending with one
   `run.closed` trace_entry.
3. The derived **Snapshot** — a pure function of the trace plus the
   manifest.

The contract answers: what must be true of the log and snapshot for the Run
to be well-formed? Individual `TraceEntry` variants already validate themselves
(each is `.strict()` with kind-specific required fields; see
`src/schemas/trace-entry.ts`). This contract governs the *log-level* and
*projection-level* invariants that no single trace_entry can assert alone.

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#core-flow-language](../../UBIQUITOUS_LANGUAGE.md#core-flow-language)
for canonical definitions of **Run**, **TraceEntry**, **Snapshot**,
**CompiledFlow**, and **Session**. Note the explicit Run vs Session
distinction: a Session is the human-facing shell; a Run is the machine-facing
execution.

## Trace entry kinds

The authoritative list of `TraceEntry` kinds is the discriminated union in
`src/schemas/trace-entry.ts`. Every kind below is one variant of that union.
Names use `<subject>.<event>`. Grouped by subject:

**run**

- `run.bootstrapped` — the first entry. Freezes `flow_id`, `depth`, `goal`,
  `change_kind`, `manifest_hash`, and any catalog bindings a flow could not
  resolve (`reduced_bindings`).
- `run.power-inference` — the run's single auto-power resolution when the dial
  is `auto`. Records the recommendation, the operator bounds, and the clamped
  tier. Written at most once per run.
- `run.skill-hook` — a configured skill hook matched. Records the hook and the
  report-only decision it made.
- `run.skill-hook-error` — the post-step skill-hook dispatcher threw. Recorded
  so the failure surfaces as a warning instead of being swallowed.
- `run.equipment-reshape` — the engine's decision when a running relay surfaces
  an equipment discovery: re-equipped and continued, or parked as a finding.
- `run.context-pull` — one typed lookup a running step made against a parent
  report. Records whether the named slice was answered or parked.
- `run.context-delivery` — resolved slices folded into a starved step's
  envelope and the step re-run once. Records which outcome the run kept.
- `run.until-judgment` — one until-loop iteration's stop-judge disposition:
  `stop-clean`, `reenter`, or `needs-attention`.
- `run.closed` — the terminal entry. Carries the run outcome (`complete`,
  `aborted`, `evidence_invalid`, `handoff`, `stopped`, or `escalated`).
  `evidence_invalid` is the completed-but-unproven close: a relay finished and
  produced work, but its report failed validation. The reason carries the
  root-cause check failure and the result summary lists the files the worker
  reported, so the operator can salvage instead of discarding real work.

**step**

- `step.entered` — a step attempt started. Carries the attempt number and, in a
  slice loop, the slice index.
- `step.report_written` — a step wrote its report. Carries the report path and
  schema.
- `step.completed` — a step attempt finished and took a route. Carries
  `route_taken`.
- `step.aborted` — a step attempt ended without completing. Carries the reason.

**check**

- `check.evaluated` — a check ran. Carries `check_kind` and `outcome` (`pass`
  or `fail`), plus per-criterion detail for acceptance criteria.

**verification**

- `verification.command_evaluated` — one bounded verification command ran.
  Carries argv, cwd, exit code, status, duration, and output summaries.

**checkpoint**

- `checkpoint.requested` — a checkpoint paused for a selection. Carries the
  options and the boundary reference.
- `checkpoint.resolved` — a checkpoint was answered. Carries the selection, the
  route, and the resolution source (`declared-default`, `operator`, or
  `policy`). New entries also point to an immutable, attempt-specific response
  and carry its SHA-256 hash. The stable response path remains available as the
  latest answer, while earlier review comments stay preserved.

**relay**

- `relay.started` — a worker relay began. Carries the connector, role, resolved
  selection, resolved-from provenance, and any equipment enforcement evidence.
- `relay.request` — the SHA-256 of the request payload submitted to the
  connector, recorded before the connector replies.
- `relay.receipt` — the connector-returned receipt id, plus the CLI version and
  any dispatch-resolved model.
- `relay.result` — the SHA-256 of the result report bytes the connector
  returned.
- `relay.completed` — the relay returned a result. Carries the verdict,
  duration, result path, receipt path, and any token usage.
- `relay.failed` — the connector invocation itself failed before a result
  existed. Repeats the relay provenance plus the terminal failure reason.

**skills**

- `skills.loaded` — local skills were materialized for a relay attempt. Records
  each skill's id, cause, optional slot, path, hash, and byte count, never the
  instruction body.

**sub_run**

- `sub_run.started` — a child flow run started. Carries the child run id, flow
  id, entry mode, and depth.
- `sub_run.completed` — a child flow run closed. Carries the child outcome,
  verdict, duration, and the copied result path.

**fanout**

- `fanout.started` — a fanout expanded its branches. Carries the resolved
  branch ids, the child-failure policy, and the execution policy.
- `fanout.branch_started` — one branch started in its worktree. Carries the
  branch id, branch kind, child run id, and worktree path.
- `fanout.branch_completed` — one branch closed. Carries its outcome, verdict,
  result path, and any `reused_from` run id.
- `fanout.joined` — the branches were joined. Carries the join policy, any
  picked winner, the aggregate path, and the completed/failed counts.

**proof**

- `proof.assessed` — a proof-policy assessment ran. Carries the overall status
  and whether close is allowed.

**safe_apply**

- `safe_apply.result` — a SafeApply decision was recorded. Carries the
  change-packet, base, action, outcome, reason codes, and final-verification
  references.

**guidance**

- `guidance.decision` — the recorded authority for an action (relay execution,
  checkpoint resolution, proof policy, recovery route, or safe apply). Later
  action entries must match a prior matching decision (see RUN-I5a).

## Invariants

The runtime MUST reject any `RunTrace` or `RunProjection` that violates these.
All invariants are enforced via `src/schemas/run.ts` (`RunTrace.superRefine`
and `RunProjection.superRefine`) and tested in
`tests/contracts/runtrace-schema.test.ts` and
`tests/runtime/runtime-trace-contract.test.ts`.

- **RUN-I1 — First trace_entry is `run.bootstrapped`.** A `RunTrace` is a non-empty
  array of trace_entries whose index-0 trace_entry has `kind: 'run.bootstrapped'`. The
  bootstrap trace_entry carries `flow_id`, `invocation_id`, `depth`, `change_kind`,
  and `manifest_hash` — fields that cannot be inferred from any later trace_entry
  — so a log that begins with anything else has structurally-undefined
  framing. Enforced at `src/schemas/run.ts` `RunTrace.superRefine`.

- **RUN-I2 — Sequence is 0-based, contiguous, monotonic.** For every trace_entry
  at index `i`, `trace_entry.sequence === i`. Gaps, repeats, and out-of-order
  entries are rejected at parse time. This is the structural guarantee that
  makes `RunTrace` a faithful projection of `trace.ndjson`: an ingestion bug
  or concurrent-writer race that would produce a non-contiguous sequence
  fails before it can corrupt a Snapshot. **Scope caveat.** `sequence` is
  the *authoritative* ordering key. `recorded_at` is diagnostic metadata
  and may legitimately non-monotone under clock adjustments (NTP step, DST
  transitions, or machine clock skew in distributed relay). This
  invariant does NOT check that `recorded_at` is monotonically
  nondecreasing; a log with forward-jumping `sequence` and backward-
  jumping `recorded_at` is accepted. Timestamp-sanity is tracked as Stage
  2 property `run.prop.recorded_at_sanity` (see below) — closes Codex MED
  #4 (scope admission, not enforcement). Enforced at `src/schemas/run.ts`.

- **RUN-I3 — `run_id` is consistent across the log.** Every trace_entry in a
  `RunTrace` shares the `run_id` of the bootstrap trace_entry. Cross-run trace_entry
  smuggling is the single most dangerous corruption mode for trace_entry-sourced
  state (it silently merges two runs' histories), so the `RunTrace` aggregate
  enforces it even though no individual trace_entry can. **Defense-in-depth
  (closes Codex MED #3 at the identity-field layer).** Zod normally reads
  inherited properties during parse, which lets `Object.create({run_id:
  phantom})` smuggle a phantom `run_id` past the discriminated union. A
  `z.custom` own-property guard on the RunTrace pipe rejects any trace_entry whose
  `run_id`, `kind`, or `sequence` is inherited rather than own. Full
  recursive own-property defense for every required field on every trace_entry
  (nested objects, transitively) is a Stage 2 property
  (`run.prop.boundary_own_property_defense`); the three fields guarded
  here are the identity fields whose spoofing is load-bearing for the
  log-level invariants RUN-I1, RUN-I3, and RUN-I4. Enforced at
  `src/schemas/run.ts`.

- **RUN-I4 — Bootstrap singleton.** Exactly one `run.bootstrapped` trace_entry per
  `RunTrace`. A second bootstrap would make `change_kind`, `depth`, `manifest_hash`,
  and `flow_id` ambiguous at replay time; Circuit rejects the
  ambiguity at parse time rather than pick a silent convention (earliest-
  wins, latest-wins, last-bootstrap-for-each-field, etc.). Enforced at
  `src/schemas/run.ts`.

- **RUN-I5 — Closure singleton; no trace_entries after close.** At most one
  `run.closed` trace_entry per `RunTrace`, and if present it MUST be the final
  trace_entry. A closed run whose log grows again has silently re-opened — a
  transition that is never legal, because "closed" is the terminal state.
  The log must explicitly record closure; anything appended afterward is
  rejected. Enforced at `src/schemas/run.ts`.

- **RUN-I5a — Guidance decisions bind recorded actions.** When a `RunTrace`
  contains any `guidance.decision` entry, flow-selection guidance MUST be the
  first entry after `run.bootstrapped`, before any `step.entered`. Guidance
  `decision_id` values are unique within the run. A `relay.started` or
  `relay.failed` entry then requires a prior matching `guidance.decision` with
  `subject: 'relay_execution'`, the same step attempt, the same role and
  connector, the same model/effort where present, and the same relay request
  payload hash. If `skills.loaded` appears for the relay, the loaded skill ids
  and slots must match the guidance decision. This is the trace-level bridge
  from old relay provenance to recorded guidance authority.

  A `checkpoint.resolved` entry also requires a prior matching
  `guidance.decision` with `subject: 'checkpoint_resolution'`, the same step
  attempt, the same selected choice, the same route id, the same resolution
  source, and the same auto-resolved flag. Checkpoint resolution sources are
  `declared-default`, `policy`, or `operator`; the old `safe-default` and
  `safe-autonomous` names are not valid checkpoint trace sources. Enforced at
  `src/schemas/run.ts` and covered by `tests/contracts/runtrace-schema.test.ts`
  plus `tests/runtime/runtime-trace-contract.test.ts`.

  A `proof.assessed` entry also requires a prior matching `guidance.decision`
  with `subject: 'proof_policy'`. The assessment must reference that decision
  id, share the same run/flow scope, share the same step/attempt when the
  proof is step-scoped, and point to a durable proof assessment report or
  evidence ref. This records the proof check; later close gates decide which
  flows may complete from it.

  A `guidance.decision` with `subject: 'recovery_route'` must be followed by a
  `step.completed` entry for the same step attempt, and
  `selected.route_id` must match `step.completed.route_taken`. The decision
  records the typed recovery kind, failure cause, failure ref, and WorkContract
  binding ref. The failure ref must appear in the decision's `input_refs` and
  `evidence_refs`; trace failure refs must point to an earlier trace entry.
  This validates recorded recovery decisions without letting graph labels act
  as recovery authority.

  A `safe_apply.result` entry requires a prior matching `guidance.decision`
  with `subject: 'safe_apply'`. The result must reference that decision id,
  share the same run/flow/step scope, match the selected ChangePacket ref, base
  ref, protected-file decision, final verification ref, and action, and reject
  applied results without final verification. This records SafeApply decisions
  without adding any apply runtime in this slice.

- **RUN-I6 — Projection binding: bootstrap-frozen fields survive into the
  Snapshot unchanged.** A `RunProjection` pairs a `RunTrace` with a
  `Snapshot`. The Snapshot's `run_id`, `flow_id`, `manifest_hash`,
  `depth`, `change_kind`, and `invocation_id` MUST match the bootstrap trace_entry's.
  These are the *frozen* fields — set once at bootstrap and never overwritten
  by any later trace_entry. A Snapshot that disagrees with the bootstrap trace_entry on
  any of them is derived from a different Run or has been corrupted; the
  projection is rejected either way. Enforced at
  `src/schemas/run.ts` `RunProjection.superRefine`. Note: this establishes
  projection consistency, not reducer correctness; the reducer's total
  correctness is a Stage 2 property test (see `run.prop.deterministic_replay`
  below).

- **RUN-I7 — Projection binding: `trace_entries_consumed` equals `log.length`;
  `status` reflects closure.** `Snapshot.trace_entries_consumed === log.length`.
  A snapshot claiming fewer consumed trace_entries than the log contains is a
  **stale prefix cache**, not *the* current projection of this log; the
  contract rejects prefix-bound projections at parse time rather than
  accepting them with ambiguity. Prefix-snapshot semantics are Stage 2
  scope (see `run.prop.projection_is_a_function` below). Closes Codex
  HIGH #2.

  `Snapshot.status` reflects the log's closure state: if no `run.closed`
  trace_entry is present, `status === 'in_progress'`; if a `run.closed` trace_entry
  with `outcome: X` is present, `status === X` under the fixed mapping
  (complete→complete, aborted→aborted, evidence_invalid→evidence_invalid,
  handoff→handoff, stopped→stopped, escalated→escalated). **Total by
  construction (compile-time).** The
  mapping `SNAPSHOT_STATUS_FOR_OUTCOME` is typed as `Record<RunClosedOutcome,
  Exclude<SnapshotStatus, 'in_progress'>>`, and a bidirectional
  compile-time equality guard `OutcomeStatusEquality` rejects any future
  drift between the two enum sets at `tsc --strict` time (not test time).
  Closes Codex MED #6. **Semantic-adequacy caveat.** This invariant binds
  *labels*, not *semantics*: a log `[run.bootstrapped, run.closed(complete)]`
  with zero completed steps is accepted here, because assessing whether
  "complete" semantically requires any particular step-completion pattern
  is a Stage 2 property (`run.prop.close_outcome_semantic_adequacy`, see
  below). Closes Codex MED #5 (scope admission, not enforcement).
  Enforced at `src/schemas/run.ts`.

- **RUN-I8 — Strict surplus-key rejection, transitively, across every
  schema that crosses the TraceEntry/Snapshot boundary.** Every trace_entry variant
  in `src/schemas/trace-entry.ts` is `.strict()`; `src/schemas/snapshot.ts`
  declares `Snapshot` and `StepState` with `.strict()`. Surplus keys
  (typos, smuggled fields, injected tracing, etc.) fail parse rather than
  silently carrying through to a consumer. **Transitive closure (closes
  Codex HIGH #1 + LOW #9).** The `.strict()` discipline is applied
  transitively to every nested schema that can appear in an trace_entry or
  snapshot payload: `ChangeKindDeclaration` (all 6 variants), `ConnectorRef` (all
  3 variants), `CustomConnectorDescriptor`, `ProviderScopedModel`,
  `SkillOverride` (all 4 variants), `SelectionOverride`, `ResolvedSelection`,
  `SelectionResolution.applied[]` entries. A surplus key anywhere in the
  tree is rejected, not stripped. This extends `stage-I2`/`stage-I6`
  discipline from flow+stage to the trace and its derived
  snapshot. Enforced at `src/schemas/trace-entry.ts`, `src/schemas/snapshot.ts`,
  `src/schemas/change-kind.ts`, `src/schemas/connector.ts`,
  `src/schemas/selection-policy.ts`.

## Pre-conditions

- A `RunTrace` is produced by parsing `trace.ndjson` into an ordered array
  and passing the array to `RunTrace.safeParse`.
- A `RunProjection` is produced by pairing a parsed `RunTrace` with a parsed
  `Snapshot` and passing the pair to `RunProjection.safeParse`.
- Individual `TraceEntry` variants must already parse under
  `TraceEntry.safeParse` before being assembled into a `RunTrace`; the log-level
  parse assumes per-trace_entry validity.
- The referenced `CompiledFlowId` must exist in the flow catalog at the
  manifest_hash named by the bootstrap trace_entry (validated by the runtime, not
  the Zod schema).

## Post-conditions

After a `RunTrace` is accepted:

- `log[0].kind === 'run.bootstrapped'` (RUN-I1).
- For every `i`, `log[i].sequence === i` (RUN-I2).
- For every `i`, `log[i].run_id === log[0].run_id` (RUN-I3).
- Exactly one bootstrap trace_entry (RUN-I4); at most one close trace_entry, and if
  present at the tail (RUN-I5).

After a `RunProjection` is accepted:

- The Snapshot's bootstrap-frozen fields agree with the log's bootstrap
  trace_entry (RUN-I6).
- `Snapshot.trace_entries_consumed === log.length` (RUN-I7).
- `Snapshot.status` is consistent with the log's closure state under the
  fixed outcome-to-status mapping (RUN-I7).

## Property ids (reserved for Stage 2 testing)

These are the invariants that govern `TraceEntry` *sequences* within a log —
things `RunTrace` cannot enforce with a single-pass `superRefine` without
introducing full reducer semantics into the schema layer. They land when the
property-test harness + reducer exist in Stage 2.

### Sequencing and semantics (deferred from RUN-I2/I7 scope caveats)

- `run.prop.recorded_at_sanity` — For any valid `RunTrace`, `recorded_at`
  is weakly monotonic across `sequence` under a defined clock-skew
  tolerance (e.g., ≤ 5 minutes). This is diagnostic, not authoritative
  (see RUN-I2 scope caveat); the property detects ingestion bugs that
  `sequence` alone cannot catch (e.g., a writer with a wall-clock
  discontinuity). Closes Codex MED #4.

- `run.prop.close_outcome_semantic_adequacy` — For any valid `RunTrace`
  plus its corresponding CompiledFlow manifest, a terminal `run.closed`
  trace_entry's outcome is semantically consistent with the step-completion
  pattern in the log and the route target in the manifest: `outcome:
  'complete'` requires a completed step whose pass route targeted
  `@complete`; `outcome: 'stopped'` requires one targeted to `@stop`;
  `outcome: 'escalated'` requires one targeted to `@escalate`;
  `outcome: 'handoff'` requires one targeted to `@handoff`; `outcome:
  'aborted'` requires at least one `step.aborted` or a
  `run.bootstrapped`-followed-immediately-by-`run.closed` with an
  explicit early-abort rationale. Closes Codex MED #5. RUN-I7's
  semantic-adequacy caveat scopes this out of v0.1 because the
  manifest-aware log-wide reachability check belongs with the reducer, not
  the schema.

- `run.prop.boundary_own_property_defense` — For every trace_entry in a
  `RunTrace`, every required field (not just `run_id`, `kind`, `sequence`)
  is an *own* property, transitively through nested objects. RUN-I3
  guards only the three identity fields (as defense-in-depth against
  inherited-key cross-run smuggle); the full transitive defense belongs
  at the Stage 2 property harness because the recursion needed to check
  every nested object's own-property set is reducer-adjacent, not
  schema-level. Closes Codex MED #3 (full scope; the schema-level
  defense-in-depth in RUN-I3 addresses the load-bearing identity subset).

### Reducer-level (Stage 2 scope)

- `run.prop.deterministic_replay` — For any valid `RunTrace` plus its
  corresponding `CompiledFlow` manifest, two independent reducer runs produce
  bit-identical `Snapshot`s. This is the load-bearing property of the
  trace_entry-sourced architecture.

- `run.prop.attempt_monotonicity_per_step` — For every step_id that appears
  in the log, the sequence of `attempt` values observed on that step_id's
  trace_entries is weakly monotonic (each attempt value is ≥ the previous, strictly
  greater when a retry is observed, never decreasing).

- `run.prop.step_trace_entry_causal_ordering` — For every `(step_id, attempt)`
  pair in the log, the trace_entry kinds on that pair follow a legal protocol:
  `step.entered` precedes any sub-trace_entry on that pair, which precedes exactly
  one of `step.completed` or `step.aborted`. No sub-trace_entry may appear without
  a matching `step.entered`; no second terminal trace_entry may appear on the
  same pair.

- `run.prop.checkpoint_trace_entry_pairing` — For every `checkpoint.requested`
  trace_entry on a `(step_id, attempt)` pair, there is exactly one subsequent
  `checkpoint.resolved` trace_entry on the same pair before any terminal step
  trace_entry. Unresolved checkpoints are a runtime stall, not a log invariant,
  but a log that contains an unresolved `checkpoint.requested` followed by
  a `step.completed` represents an impossible state.

- `run.prop.relay_trace_entry_pairing` — For every `relay.started` trace_entry on
  a `(step_id, attempt)` pair, there is exactly one subsequent relay
  terminal trace_entry on the same pair before any terminal step trace_entry:
  `relay.completed` when the connector invocation returns a result, or
  `relay.failed` when the connector invocation itself fails before a
  result exists. A `relay.started` with neither terminal relay trace_entry
  is a reducer inconsistency.

  **Slice 37 §Amendment (durable relay transcript, ADR-0007 CC#P2-2).**
  The TraceEntry discriminated union additionally carries durable transcript
  variants: `relay.request` (SHA-256 of the request
  payload bytes, field `request_payload_hash`), `relay.receipt`
  (connector-returned receipt id, field `receipt_id`), and
  `relay.result` (SHA-256 of the result report bytes, field
  `result_report_hash`). The union also carries `skills.loaded`, emitted
  only when at least one local skill was materialized for the relay
  attempt. The canonical success sequence on a `(step_id, attempt)` pair
  with loaded skills is:

  ```
  relay.started → skills.loaded → relay.request → relay.receipt →
  relay.result → relay.completed
  ```

  If no skills are loaded, `skills.loaded` is absent and
  `relay.request` follows `relay.started` directly.

  Runtime-safety-floor Slice 3 adds the connector-invocation failure
  sequence for failures that happen before a connector receipt/result exists:

  ```
  relay.started → [skills.loaded] → relay.request → relay.failed
  ```

  `relay.failed` repeats the `relay.started` provenance surface
  (connector, role, resolved selection, resolved-from provenance) and the
  `relay.request` payload hash, plus the terminal failure reason. This
  keeps infrastructure failure distinct from model verdict failure while
  preserving the existing relay audit trail.

  Log-level pairing invariant (this property's scope): whenever any of
  the transcript trace_entries appears on a pair, each must appear at
  most once and MUST appear strictly between `relay.started` and
  the terminal relay trace_entry on that pair (i.e. after started, before
  completed/failed, and in the order `[skills.loaded] → request → receipt
  → result` if more than one returned-result transcript trace_entry is
  present). Zero transcript trace_entries is legal (dry-run connector path;
  transcript only required for non-dry-run connectors per CC#P2-2
  Enforcement binding). An out-of-order transcript trace_entry (e.g.
  `relay.receipt` preceding `relay.request` on the same pair, or any
  transcript trace_entry on a pair with no matching `relay.started`, or a
  transcript trace_entry appearing after `relay.completed` /
  `relay.failed`) is a reducer inconsistency.
  The tighter requirement that all three returned-result
  transcript trace_entries MUST appear for a non-dry-run connector lives at the
  connector-level close criterion (ADR-0007 CC#P2-2 Enforcement binding,
  enforced in the P2.4 round-trip test and the CI-skip local-smoke
  report), not here — the contract widens the schema; the connector
  contract obligates the writer.

  Per-step acceptance criteria add zero or more `check.evaluated`
  trace_entries with `check_kind: 'acceptance_criteria'` on the same
  `(step_id, attempt)` pair after `relay.completed` and before the step
  terminal trace_entry. Each entry records the criterion id, criterion kind,
  outcome, and, for command criteria, bounded output summaries.

- `run.prop.report_written_before_check` — For any compose step, every
  `check.evaluated` trace_entry with `outcome: 'pass'` on that step is preceded by
  at least one `step.report_written` trace_entry on the same `(step_id,
  attempt)` pair. (Failing checks can precede any write.)

- `run.prop.projection_is_a_function` — For any valid `RunTrace`, `reducer(log,
  manifest)` is a total function: it produces exactly one `Snapshot`, and
  that Snapshot satisfies the `RunProjection` binding. Combined with
  `deterministic_replay`, this is the full trace_entry-sourcing contract.

## Cross-contract dependencies

- **trace_entry** (`src/schemas/trace-entry.ts`) — `RunTrace` embeds `TraceEntry[]`. Every
  trace_entry variant is already `.strict()` (RUN-I8) and declares its own
  per-kind required fields; `RunTrace` adds log-level structural invariants
  on top.
- **snapshot** (`src/schemas/snapshot.ts`) — `RunProjection` pairs
  `RunTrace` with `Snapshot`. `Snapshot` and `StepState` are both `.strict()`
  (RUN-I8). The `SnapshotStatus` enum is intentionally a superset of
  `RunClosedOutcome` by exactly one value (`'in_progress'`), which is how
  RUN-I7's mapping from log-closure to snapshot-status is total without
  information loss.
- **flow** (`src/schemas/compiled-flow.ts`) — `RunBootstrappedTraceEntry.flow_id`
  must refer to a known `CompiledFlow.id` at the given `manifest_hash`. Not
  enforced at the schema layer; enforced at runtime by the flow
  catalog.
- **skill** (`src/schemas/skill.ts`) — `skills.loaded` trace entries
  record the local skill ids, optional slot ids, paths, hashes, and byte
  counts that were loaded for a relay attempt. Skill bodies are not
  stored in trace evidence.
- **change_kind** (`src/schemas/change-kind.ts`) — `RunBootstrappedTraceEntry.change_kind` is a
  required `ChangeKindDeclaration`. RUN-I6 binds it into the Snapshot; evidence
  invariant 3 (every Run carries change_kind) is load-bearing.
- **process** (`src/schemas/process.ts`) — the process dial and the compiled
  depth scalar; the resolved depth is frozen at bootstrap (RUN-I6).
- **ids** (`src/schemas/ids.ts`) — `RunId`, `CompiledFlowId`, `InvocationId`,
  `StepId` branded slugs.

## Failure modes (carried from evidence)

- `carry-forward:trace_entry-log-insufficient-to-replay` — Existing Circuit's
  `RunBootstrappedTraceEntry` was missing change_kind; `Snapshot` did not carry
  `manifest_hash`; richer `step.completed`/`step.aborted` trace_entries were
  missing.
  **Closed in Tier 0 skeleton** (`change_kind` + `manifest_hash` on both;
  `step.*_completed`/`step.aborted` added). Re-ratified here: `RunTrace`
  enforces the log-level invariants those changes were meant to support.

- `carry-forward:snapshot-divergence` — A reducer bug that produces a
  Snapshot inconsistent with its source log was historically silent; the
  Snapshot would simply disagree and nobody would notice until a downstream
  consumer saw wrong data. Closed by RUN-I6/I7: any projection that
  disagrees on bootstrap-frozen fields or closure state is rejected at
  `RunProjection.safeParse`. This is a *consistency* check, not a reducer-
  correctness proof (see `run.prop.deterministic_replay`).

- `carry-forward:surplus-key-silent-strip` — Prior to this contract,
  `TraceEntry` variants and `Snapshot` were not `.strict()`, so a typo in an
  trace_entry writer (`report_pahh` instead of `report_path`) parsed as a
  legal trace_entry with the misspelled key silently stripped. Closed by RUN-I8.

- `carry-forward:cross-run-smuggle` — A log produced by concatenating two
  runs' trace_entries would parse under the flat `TraceEntry` schema — individual
  trace_entries are valid; only the `run_id` inconsistency reveals the error.
  Closed by RUN-I3, with defense-in-depth via the identity-field own-
  property guard (prototype-chain attack class).

- `carry-forward:nested-surplus-key-silent-strip` — Prior to this slice,
  `.strict()` was applied only at the top level of `TraceEntry`/`Snapshot`.
  Surplus keys inside `change_kind`, `connector`, `resolved_selection`, or
  `resolved_selection.model` were silently stripped, which meant a
  snapshot-vs-bootstrap change_kind comparison could wrongly accept a polluted
  payload. Closed by RUN-I8's transitive-strict discipline across
  `ChangeKindDeclaration`, `ConnectorRef`, `ProviderScopedModel`, `SkillOverride`,
  `SelectionOverride`, `ResolvedSelection`, `SelectionResolution.applied[]`.

## Evolution

- **v0.1** — RUN-I1..I8 enforced at the schema layer:
  `RunTrace` aggregate with bootstrap/first-trace_entry, sequence monotonicity,
  run_id consistency, bootstrap singleton, closure singleton with
  no-post-closure-trace_entries. `RunProjection` aggregate binding log and
  snapshot with bootstrap-frozen field parity, exact `trace_entries_consumed`
  equality (no stale prefix), and closure-to-status mapping as a
  compile-time total function (`OutcomeStatusEquality`). `.strict()`
  extended transitively from every trace_entry variant + `Snapshot`/`StepState`
  through `ChangeKindDeclaration`, `ConnectorRef`, `ProviderScopedModel`,
  `SkillOverride`, `SelectionOverride`, `ResolvedSelection`, and
  `SelectionResolution.applied[]` entries. Identity-field own-property
  guard (`run_id`/`kind`/`sequence`) rejects prototype-chain smuggle at
  the RunTrace pipe boundary. ChangeKind equality uses a structural field-by-
  field comparator rather than `JSON.stringify` to stay robust under
  future key-order changes.

  Codex adversarial property-auditor pass completed (2026-04-18). 2 HIGH
  (#1 nested surplus, #2 prefix-snapshot) incorporated; 5 MED (#3
  prototype identity, #4 timestamp scope, #5 close semantic, #6
  compile-time mapping, #7 test breadth) incorporated or honestly scoped
  to Stage 2 property ids; 3 LOW (#8 invocation_id asymmetry, #9 change_kind
  comparison, #10 ratchet-vs-discipline) incorporated. The HIGH
  adversarial claims are closed at the schema layer; the deferred
  semantic/reachability/timestamp claims are tracked as
  `run.prop.close_outcome_semantic_adequacy`,
  `run.prop.boundary_own_property_defense`, and
  `run.prop.recorded_at_sanity` — NOT claimed closed by this draft.

- **v0.1-amendment (Slice 37, pre-P2.4 fold-in)** — TraceEntry discriminated
  union at `src/schemas/trace-entry.ts` widened with three durable-transcript
  variants (`relay.request`, `relay.receipt`, `relay.result`)
  required by ADR-0007 CC#P2-2's Enforcement binding. Runtime-safety-floor
  Slice 3 later widened the same trace_entry surface with additive
  `relay.failed` for connector invocation exceptions. The log-level
  pairing invariant `run.prop.relay_trace_entry_pairing` widened (not
  renamed) to govern ordering when transcript/failure trace_entries are present;
  full five-trace_entry success ordering is obligated at the connector level
  (CC#P2-2), not the contract level. Authorized by ADR-0007 §Amendment
  (Slice 37).

- **v0.2 (user skill loading slice)** — TraceEntry
  discriminated union widened with `skills.loaded`, emitted before
  `relay.request` when local skill instructions are loaded for a relay
  attempt. The event records `{id, slot?, path, sha256, bytes}` and
  deliberately omits the instruction body.

- **v0.3 (relay acceptance-criteria slice, 2026-05-20)** — Per-step
  acceptance criteria add zero or more `check.evaluated` trace_entries
  with `check_kind: 'acceptance_criteria'` on the same
  `(step_id, attempt)` pair after `relay.completed` and before the step
  terminal trace_entry. `acceptance-criteria` added to `depends_on`.

- **v0.4 (guidance authority slice)** — RUN-I5a added. `guidance.decision`
  entries bind recorded actions: relay execution, checkpoint resolution,
  proof assessment, and safe-apply each require a prior matching
  guidance decision with the same scope and payload identity. Checkpoint
  resolution sources are `declared-default`, `policy`, or `operator`.
  Enforced at `src/schemas/run.ts`; covered by
  `tests/contracts/runtrace-schema.test.ts` and
  `tests/runtime/runtime-trace-contract.test.ts`.

- **v0.4-amendment (pre-v1 reconciliation, 2026-07-09)** — adds the "Trace
  entry kinds" reference section enumerating all 33 `TraceEntry` kinds, grouped
  by subject, each with a one-line description. Documentation only; no schema or
  invariant change. Source of truth stays the discriminated union in
  `src/schemas/trace-entry.ts`.

- **v0.5 (Stage 1)** — Absorb Codex adversarial property-auditor pass
  findings. Ratify `property_ids` above by landing the corresponding
  property-test harness. Consider whether a typed `ReducerOutput` (log,
  snapshot, derived diagnostics) adds enough value over `RunProjection` to
  justify the cost. If evidence shows a class of `SnapshotStatus` drift
  that RUN-I7 doesn't catch, upgrade the mapping from an enum-valued
  record to a typed discriminated union.

- **v1.0 (Stage 2)** — Ratified invariants + property tests + mutation-
  score floor contribution + operator-facing error-message catalog. The
  six `run.prop.*` properties above become the acceptance check for any
  reducer implementation.

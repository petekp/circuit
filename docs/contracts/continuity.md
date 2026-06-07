---
contract: continuity
status: ratified-v0.1
version: 0.1
schema_source: src/schemas/continuity.ts
last_updated: 2026-06-06
depends_on: [ids, scalars, snapshot]
report_ids:
  - continuity.record
  - continuity.index
invariant_ids: [CONT-I1, CONT-I2, CONT-I3, CONT-I4, CONT-I5, CONT-I6, CONT-I7, CONT-I8, CONT-I9, CONT-I10, CONT-I11, CONT-I12, CONT-I13, CONT-I14, CONT-I15, CONT-I16, CONT-I17, CONT-I18]
property_ids: [continuity.prop.boundary_own_property_defense, continuity.prop.discriminator_field_presence_closure, continuity.prop.index_dangling_reference_surfaces, continuity.prop.index_pointer_kind_matches_record, continuity.prop.index_pointer_roundtrip, continuity.prop.index_pointer_run_id_coherence, continuity.prop.mode_kind_coherence, continuity.prop.record_id_stem_roundtrip, continuity.prop.run_ref_matches_log_at_save, continuity.prop.safety_boolean_non_contradiction]
---

# Continuity Contract

A **continuity record** is the cross-session handoff report that lets a
later session pick up where an earlier one left off. A **continuity index**
is the resolver that determines which record (if any) is authoritative for
the next resume and which run (if any) is currently attached.

Continuity is **strict**. Circuit accepts only the current continuity record
shape through normal runtime paths. If import is ever required, it must be a
separate source contract; the runtime schema stays strict.

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#continuity-language](../../UBIQUITOUS_LANGUAGE.md#continuity-language)
for canonical term definitions (**continuity record**, **resume contract**).
This slice adds to [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md):

- **Run-attached provenance** — the snapshot-of-state embedded in a
  run-backed continuity record (`current_stage`, `current_step`,
  `runtime_status`, `runtime_updated_at`). Enough for resume adjudication
  to compare "what was true at save time" against "what is true now."
- **Pending-record pointer** — the index entry that names which continuity
  record is authoritative for the next resume. Keyed by `record_id`, which
  is a `ControlPlaneFileStem` (see §Path-safe identity below).
- **Attached-run pointer** — the index entry that names which run is
  currently live in the session. Orthogonal to pending-record pointer;
  both may be null, both may be populated, or either alone may be
  populated.
- **Dangling reference (continuity)** — the failure state where the index
  `pending_record.record_id` names a file that is not present at
  `<control-plane>/continuity/records/${record_id}.json`. Runtime
  semantics: surface as an error at resume time; do not silently drop.
- **Ambient continuity record** — a continuity record harvested
  mechanically by a Stop/SessionEnd hook from the live transcript, rather
  than written by a deliberate `circuit handoff save`. Same narrative
  shape as a manual save, discriminated by `continuity_kind: 'ambient'`.
- **Ambient-capture provenance** — the snapshot of where an ambient
  record came from (`transcript_path`, optional `session_id`, and the
  `source` hook that fired). Lets resume weigh an auto-harvest against a
  manual save and lets an operator audit the capture.
- **Ambient-record pointer** — the index entry that names the harvested
  ambient record, kept separate from the pending-record pointer so a
  manual save and an auto-harvest never overwrite each other. Optional on
  pre-ambient indexes.

The distinction to keep straight: a **continuity record** is the report
at rest (a JSON file carrying narrative + resume contract + optional run
provenance). A **continuity index** is a resolver that points AT zero or
one records and zero or one attached runs. The record is the identity; the
index is the edge.

## Path-safe identity

`continuity.record.record_id` is a `path_derived_field`: its value is
joined into a filesystem path (`<control-plane>/continuity/records/
${record_id}.json`) at parse time, not at the call site. The schema
scalar is **`ControlPlaneFileStem`** (`src/schemas/scalars.ts`),
which enforces `/^[a-z0-9][a-z0-9._-]*$/`, rejects `.` / `..` / parent-
traversal sequences, and forbids `/` and `\` path separators. Authority
graph entries with `path_derived_fields` MUST cite `ControlPlaneFileStem`
by name (ADR-0003 §Machine enforcement; verified by
`scripts/audit.ts`).

The same scalar is used by `ContinuityIndex.pending_record.record_id`
(the index-side pointer), so the index→record join is type-aligned.

## Invariants

The runtime MUST reject any `ContinuityRecord` or `ContinuityIndex` that
violates these. All invariants are enforced via `src/schemas/continuity.ts`
and tested in `tests/contracts/continuity-schema.test.ts`.

- **CONT-I1 — `record_id` is a `ControlPlaneFileStem`.** The identity
  field IS the filename stem. Parse-time rejection for uppercase, path
  separators, `.`/`..`, and parent-traversal (`..` anywhere in the
  string). Closes the naive `z.string().min(1)` drift that would have
  shipped before Slice 7.

- **CONT-I2 — `schema_version` is `1` (number literal).** Circuit uses
  `z.literal(1)`. String versions are rejected by the runtime schema.

- **CONT-I3 — `continuity_kind` is a 3-variant discriminated union.**
  Exactly one of `standalone`, `run-backed`, or `ambient`. No fourth
  variant, no omission, no free-form string. (The `ambient` variant and
  its field-presence/mode/safety closure are CONT-I13..I16.)

- **CONT-I4 — Standalone vs run-backed field-presence closure.**
  - `standalone` records MUST NOT carry `run_ref` — enforced by
    `.strict()` on `StandaloneContinuity` (surplus-key rejection).
  - `run-backed` records MUST carry a fully-populated `run_ref`
    (see CONT-I7) — enforced by the field being required on
    `RunBackedContinuity`.

- **CONT-I5 — `resume_contract.mode` is bound to `continuity_kind`.**
  Per-variant literal on the inner schemas:
  - `StandaloneContinuity.resume_contract.mode === 'resume_standalone'`
  - `RunBackedContinuity.resume_contract.mode === 'resume_run'`
  Crossed pairings (`standalone` × `resume_run`; `run-backed` ×
  `resume_standalone`) are rejected at parse time.

- **CONT-I6 — Safety-boolean non-contradiction.** `auto_resume` and
  `requires_explicit_resume` are defense-in-depth booleans. Exactly one
  MUST be true:
  - `auto_resume=true AND requires_explicit_resume=true` — rejected
    (contradicts itself).
  - `auto_resume=false AND requires_explicit_resume=false` — rejected
    (silent-dead state; neither resume path is armed).
  Enforced by a per-variant `.refine()` asserting
  `auto_resume !== requires_explicit_resume`. Closes **pre-authoring
  review carryover #7**.

- **CONT-I7 — Run-attached provenance is a fixed shape.** A run-backed
  record's `run_ref` MUST carry:
  - `run_id: RunId`
  - `current_stage: StageId`
  - `current_step: StepId`
  - `runtime_status: SnapshotStatus` (one of the closed
    `SnapshotStatus` enum variants)
  - `runtime_updated_at` — ISO 8601 datetime
  - `invocation_id: InvocationId` — optional
  Closes **pre-authoring review carryover #8**. A record carrying only
  `run_id` is rejected; resume adjudication requires enough state to
  compare save-time vs resume-time.

- **CONT-I8 — Transitive `.strict()` on every nested object.** Applies
  to `GitState`, `ContinuityNarrative`, `StandaloneContinuity`,
  `RunBackedContinuity`, `AmbientContinuity`, all three `resume_contract`
  inner objects, `RunAttachedProvenance`, `AmbientProvenance`,
  `ContinuityIndex`, `PendingRecordPointer`, `AttachedRunPointer`, and
  `AmbientRecordPointer`. Surplus keys are rejected at every depth. This
  closes the aggregate-level HIGH flagged by the pre-authoring review
  (the prior schema only strict-checked the top level).

- **CONT-I9 — `ContinuityIndex` is a standalone aggregate.** The index
  is not an envelope around records; it is a separate on-disk report
  (`<control-plane>/continuity/index.json`) with its own
  `schema_version`, `project_root`, `pending_record` pointer,
  `current_run` pointer, and optional `ambient_record` pointer
  (CONT-I18). All pointers are nullable and independent.

- **CONT-I10 — `PendingRecordPointer.record_id` uses
  `ControlPlaneFileStem`.** The index-side pointer is type-aligned with
  the record-side identity (CONT-I1). A round-trip from index to record
  file is schema-safe. Mismatched stems (uppercase, path separator, etc.)
  are rejected at parse time. The dangling-reference case (stem valid but
  file missing) is surfaced at resume time per §Dangling reference
  policy.

- **CONT-I11 — `AttachedRunPointer` carries enough state to validate
  liveness.** `run_id`, `current_stage`, `current_step`,
  `runtime_status`, `attached_at`, `last_validated_at`. A pointer
  missing `runtime_status` or either timestamp is rejected. Resume
  semantics MAY later require re-validating `last_validated_at` against
  the on-disk run trace; that is resolver work, not schema work.

- **CONT-I12 — Raw-input own-property guard (prototype-chain defense).**
  `.strict()` rejects surplus own keys but does NOT defend against
  prototype-chain smuggle: Zod reads inherited properties during parse,
  so `Object.create({record_id: 'evil'})` would satisfy a `record_id`
  requirement through the prototype chain. The runtime wraps both
  `ContinuityRecord` and `ContinuityIndex` with a `z.custom` pre-parse
  guard that runs `Object.hasOwn` on load-bearing fields
  (`schema_version`, `record_id`, `continuity_kind`, `resume_contract`
  for the record; `schema_version`, `project_root`, `pending_record`,
  `current_run` for the index). Inherited values fail before Zod's own
  property access. Mirrors `RunTrace`'s identity-field defense (run.ts
  RUN MED #3). Closes Codex HIGH #1. Recursive defense over every
  nested required field is deferred to Stage 2 property
  `continuity.prop.boundary_own_property_defense`; v0.1 covers the
  load-bearing identity/discriminator surface.

- **CONT-I13 — Ambient records carry `ambient_provenance`, not `run_ref`.**
  An `ambient` record is harvested mechanically by a Stop/SessionEnd hook,
  so it cannot carry run-attached provenance. It MUST carry an
  `ambient_provenance` block (`transcript_path` required; `session_id`
  optional; `source` one of the closed enum `'stop' | 'session-end'`) and
  MUST NOT carry `run_ref` — enforced by `.strict()` on
  `AmbientContinuity` (surplus-key rejection). This is the ambient analog
  of CONT-I4's standalone/run-backed field-presence closure.

- **CONT-I14 — Ambient field-presence closure.** The discriminator
  `continuity_kind === 'ambient'` is present iff the record carries
  `ambient_provenance` and a `resume_ambient` resume contract. A record
  tagged `ambient` but missing `ambient_provenance` is rejected; a record
  carrying `ambient_provenance` under any other `continuity_kind` is
  rejected by that variant's `.strict()`.

- **CONT-I15 — Ambient `resume_contract.mode` is bound to the kind.**
  `AmbientContinuity.resume_contract.mode === 'resume_ambient'`. Crossed
  pairings (`ambient` × `resume_standalone`; `ambient` × `resume_run`;
  `standalone`/`run-backed` × `resume_ambient`) are rejected at parse
  time. Extends CONT-I5 to the third variant.

- **CONT-I16 — Ambient safety-boolean non-contradiction.** The ambient
  `resume_contract` reuses the same per-variant `.refine()` as the other
  two: exactly one of `auto_resume` / `requires_explicit_resume` is true;
  both-true and both-false are rejected. Extends CONT-I6 to the third
  variant. Note: an ambient record is a mechanical harvest, so the
  resolver SHOULD default it to a require-explicit-resume posture — but
  that posture choice is resolver work, not a schema invariant; the
  schema only forbids the contradiction.

- **CONT-I17 — `AmbientRecordPointer` is the index-side ambient entry.**
  A `.strict()` pointer carrying `record_id` (a `ControlPlaneFileStem`,
  type-aligned with CONT-I1/CONT-I10), `continuity_kind: 'ambient'`
  (literal — the pointer rejects `standalone`/`run-backed`), and
  `created_at` (ISO 8601 datetime). Same denormalized-hint caveat as
  `PendingRecordPointer`: the record is authority, the pointer is a hint.

- **CONT-I18 — Index `ambient_record` is optional and back-compatible.**
  `ContinuityIndex.ambient_record` is `AmbientRecordPointer.nullable().optional()`:
  populated when a harvest exists, `null` when explicitly cleared, and
  absent on pre-ambient index files so older indexes keep parsing. It is
  deliberately NOT in the index own-property guard (CONT-I12) — a missing
  key is legal, so requiring own-ness would reject valid older indexes.
  Kept in a separate pointer from `pending_record` so a manual save and an
  auto-harvest never clobber each other (see §Resolver precedence).

## Pre-conditions

- Continuity JSON must parse under `ContinuityRecord.safeParse`;
  `ContinuityIndex.safeParse` parses the index file separately.
- `record_id` MUST round-trip with the on-disk filename stem
  (enforced by the handoff writer, checked by the audit at commit time
  once the writer lands).
- If a record is `run-backed`, the named `run_id` SHOULD correspond to
  a run whose trace is reachable at runtime — but that is resolver-
  level liveness, not schema-level parse. A `run-backed` record with a
  live-at-save-time `run_id` that has since been garbage-collected is
  still parse-valid; the resume flow is the surface that adjudicates.

## Post-conditions

After a `ContinuityRecord` is accepted:

- `record_id` is safe to use as a filename segment without further
  escaping.
- The discriminator `continuity_kind` is closed (CONT-I3) and pair-
  consistent with `resume_contract.mode` (CONT-I5).
- Exactly one of the two safety booleans is true (CONT-I6); the record
  has an unambiguous resume posture.
- If `run-backed`, the attached run's stage/step/status snapshot is
  recoverable from the record alone (CONT-I7) without needing to read
  the run trace. This does NOT mean the snapshot is consistent with the
  run trace at resume time — that is a Stage 2 property
  (`continuity.prop.run_ref_matches_log_at_save`).

After a `ContinuityIndex` is accepted:

- Every pointer (`pending_record`, `current_run`, and the optional
  `ambient_record`) is either `null`/absent or schema-valid; no partial
  pointer can be stored (CONT-I9..I11, CONT-I17..I18).
- Dangling-reference (stem valid but file absent) is NOT rejected at
  parse time; it is a runtime adjudication at resume — and applies to the
  `ambient_record` pointer the same as to `pending_record`.

## Dangling reference policy

`continuity.index.pending_record.record_id` is a pointer into the records
directory. The schema MUST NOT attempt filesystem resolution at parse
time (zod schemas are pure). At resume time, the resolver:

1. Reads `<control-plane>/continuity/index.json` and validates under
   `ContinuityIndex`.
2. If `pending_record` is populated, resolves the record path and
   attempts to read `<control-plane>/continuity/records/
   ${pending_record.record_id}.json`.
3. If the record file is absent, surfaces the mismatch rather than
   silently dropping the pointer. The base policy is `error-at-resolve`:
   the brief resolves to `invalid` and carries an `operator_notice`. One
   resolver refinement applies to a dangling or invalid `pending_record`:
   when a valid `ambient_record` exists, the resolver falls through to it
   (returns `available`) and still surfaces the failure through
   `recovered_from` + `operator_notice`, so the error is reported and a
   usable fallback is restored at once (the A4 fall-through, §Resolver
   precedence case 0). A dangling `ambient_record` pointer has no further
   fallback and resolves to `invalid`.

## Resolver precedence (pending_record vs ambient_record vs current_run)

`ContinuityIndex.pending_record`, `ContinuityIndex.ambient_record`, and
`ContinuityIndex.current_run` are schema-independent (CONT-I9). The schema
accepts any combination, but the **resolver** adjudicates conflicts. Three
cases are material:

0. **Manual save outranks ambient harvest.** When both `pending_record`
   (a deliberate `circuit handoff save`) and `ambient_record` (a
   mechanical harvest) are populated, the resolver MUST prefer
   `pending_record`. The operator's explicit intent beats an auto-capture.
   The ambient pointer is the fallback safety net, used when no manual
   save is pending and also when a pending manual save cannot be loaded
   (its record file is missing, or the record fails schema validation).
   In that broken-manual-save case the resolver falls through to the
   ambient record and returns it as `available`, carrying a
   `recovered_from` marker and an `operator_notice` so the broken manual
   save is surfaced rather than silently masked (the A4 fall-through; see
   also §Dangling reference policy). When no usable ambient fallback
   exists, the broken manual save still surfaces as `invalid`. This
   precedence is resolver-level; the schema
   keeps the two pointers separate (CONT-I18) precisely so the resolver
   has both available rather than one having clobbered the other. An
   ambient record's resume posture SHOULD also be more conservative than a
   manual save's (mechanical capture was never reviewed by the operator),
   but that framing is resolver work, not a schema invariant.

1. **Pointer kind drift.** `pending_record.continuity_kind` and the
   pointed record's `continuity_kind` can disagree, because the index
   entry is a denormalized hint — not authority. The record is the
   source of truth. A resolver that branches on the index hint before
   reading the record bypasses CONT-I3/CONT-I5. The v0.1 schema does
   not enforce the coherence; Stage 2 property
   `continuity.prop.index_pointer_kind_matches_record` ratifies it. The
   prose here documents the non-authoritativeness. **v0.2 consideration:**
   remove `continuity_kind` from the pointer entirely if the audit
   reveals the hint is unused, OR make the resolver emit a warning on
   drift.

2. **Run identity drift.** When `pending_record` points at a
   run-backed record whose `run_ref.run_id` differs from
   `current_run.run_id`, the index describes split-brain state:
   authoritative pending record names run A; attached run pointer names
   run B. This is a legitimate transitional state (e.g. one run closed,
   a new one attached before the old pending record was cleared), but
   resume MUST surface the mismatch rather than silently picking one.
   The v0.1 schema does not enforce `run_id` agreement across the two
   pointers (cross-field refine would make the schema non-pure — it
   depends on semantic intent). Stage 2 property
   `continuity.prop.index_pointer_run_id_coherence` ratifies the
   resolver's handling. **v0.2 consideration:** add a resolver
   precedence table (pending-record-wins vs current-run-wins vs
   error-on-conflict) once the resume flow lands and the operator
   picks a policy.

## Property ids (reserved for Stage 2 testing)

- `continuity.prop.record_id_stem_roundtrip` — for every accepted
  `ContinuityRecord`, `record_id` joined into
  `<control-plane>/continuity/records/${record_id}.json` reverses back
  to the same `record_id` (no escaping introduced).
- `continuity.prop.discriminator_field_presence_closure` — for every
  accepted record, the `run_ref` field is present iff `continuity_kind
  === 'run-backed'`, and the `ambient_provenance` field is present iff
  `continuity_kind === 'ambient'`.
- `continuity.prop.mode_kind_coherence` — for every accepted record,
  `resume_contract.mode` and `continuity_kind` agree per CONT-I5.
- `continuity.prop.safety_boolean_non_contradiction` — for every
  accepted record, `auto_resume !== requires_explicit_resume`
  (CONT-I6).
- `continuity.prop.run_ref_matches_log_at_save` — for every accepted
  run-backed record, `run_ref.current_step` and `run_ref.runtime_status`
  are consistent with the run trace at save time. Resolver-level
  property; CONT-I7 is the schema scaffold.
- `continuity.prop.index_pointer_roundtrip` — for every accepted
  `ContinuityIndex` with `pending_record` populated, the pointed-at
  file's parsed `record_id` equals `pending_record.record_id`.
- `continuity.prop.index_dangling_reference_surfaces` — the resume
  resolver surfaces missing-file dangling references as an error rather
  than silently falling back to standalone resume.
- `continuity.prop.index_pointer_kind_matches_record` — for every
  accepted `ContinuityIndex` with `pending_record` populated, the
  pointer's `continuity_kind` equals the pointed record's
  `continuity_kind` at read time. Resolver property, NOT schema (the
  index is a denormalized hint).
- `continuity.prop.index_pointer_run_id_coherence` — when both
  `pending_record` and `current_run` are populated and the pointed
  record is run-backed, the resolver surfaces any mismatch between
  `pending_record`'s record's `run_ref.run_id` and `current_run.run_id`.
  Split-brain state is adjudicated, not silently resolved.
- `continuity.prop.boundary_own_property_defense` — recursive
  own-property guarding across every required field on every nested
  object. v0.1 covers load-bearing identity/discriminator fields
  (CONT-I12); Stage 2 extends.

## Cross-contract dependencies

- **ids**: `RunId`, `StageId`, `StepId`, `InvocationId` — used for
  run-attached provenance and attached-run pointer identity.
- **scalars**: `ControlPlaneFileStem` — used for `record_id` and
  `PendingRecordPointer.record_id`. ADR-0003 §Machine enforcement
  requires explicit naming.
- **snapshot**: `SnapshotStatus` — reused for `runtime_status` on both
  `RunAttachedProvenance` and `AttachedRunPointer`. The closed enum is
  load-bearing; a `runtime_status: 'frozen'` record is rejected.
- **run** (indirect): `run_id` in a run-backed record SHOULD correspond
  to a `RunId` present in a `RunTrace` somewhere on disk. Schema-level
  enforcement is infeasible (would require cross-report IO);
  property-level enforcement is `continuity.prop.run_ref_matches_log_at_save`.

## Failure modes addressed

- **carry-forward:contradictory-resume-state** — **Closed in v0.1 via
  CONT-I4 + CONT-I5.** `continuity_kind` + `resume_contract.mode` +
  field-presence closure make contradictory pairings un-expressible.
  Opens `bootstrap/adversarial-review-codex.md` §"Continuity Allows
  Contradictory Resume State" #9 (MED).

- **carry-forward:contradictory-safety-booleans** — **Closed in v0.1 via
  CONT-I6.** Exactly one of `auto_resume` / `requires_explicit_resume` is
  true. Closes pre-authoring review carryover #7.

- **carry-forward:under-provenance-on-resume** — **Closed in v0.1 via
  CONT-I7.** `run_ref` carries `current_stage`, `current_step`,
  `runtime_status`, `runtime_updated_at`; a bare `{run_id}` is rejected.
  Closes pre-authoring review carryover #8.

- **carry-forward:aggregate-level-strict-gap** — **Closed in v0.1 via
  CONT-I8.** Transitive `.strict()` on every nested object. Closes the
  aggregate-level HIGH flagged in the pre-authoring review.

- **carry-forward:path-derived-identity-without-scalar** — **Closed
  in v0.1 via CONT-I1 + CONT-I10.** Both `record_id` fields use
  `ControlPlaneFileStem`. ADR-0003 §Machine enforcement is satisfied.

- **carry-forward:missing-index-aggregate** — **Closed in v0.1 via
  CONT-I9..I11.** `ContinuityIndex` is a first-class schema with its
  own invariants. Prior to v0.1 the index was undocumented and unvalidated
  in Circuit; only the record existed. This closes the index-
  aggregate HIGH flagged in the pre-authoring review.

- **carry-forward:prototype-chain-smuggle** — **Closed in v0.1 via
  CONT-I12.** Raw-input own-property guards on ContinuityRecord and
  ContinuityIndex reject `Object.create(...)` prototype-chain attacks
  on load-bearing identity/discriminator fields. Mirrors run.ts RunTrace
  defense (RUN MED #3). Closes Codex v0.1 HIGH #1.

- **carry-forward:authority-graph-nested-path** — **Closed in v0.1 via
  `pending_record.record_id` as an explicit nested pointer.** Closes
  Codex v0.1 HIGH #2.

## Codex adversarial review (v0.1)

A narrow cross-model challenger pass (Codex via `/codex`) produced 2
HIGH + 3 MED + 1 LOW objections against this contract + schema. All
HIGHs and MED #5 + LOW #6 are folded into v0.1. MED #3 and MED #4 are
scoped to v0.2 with rationale in the §Resolver precedence section above.

## Evolution

- **v0.1 (this draft)** — initial contract covering both
  `continuity.record` and `continuity.index` aggregates. Twelve
  invariants (CONT-I1..I12; CONT-I12 added post-Codex). Ten Stage 2
  property ids reserved. All pre-authoring carryovers folded in (#7
  safety booleans, #8 resume provenance, plus the index-aggregate
  HIGH). Codex v0.1 HIGH #1 (prototype-chain defense) + HIGH #2
  (authority-graph nested path) + MED #5 (dangling-reference enum) +
  LOW #6 (coverage additions) folded in; MED #3 (pointer-kind
  denormalization) + MED #4 (split-brain resolver precedence) scoped
  to v0.2 as resolver-level concerns.
- **v0.1 + ambient (2026-06-06)** — additive third continuity kind for
  the warm-writer consolidation. Adds `AmbientContinuity` (a mechanically
  harvested cross-session resume point), `AmbientProvenance`,
  `AmbientResumeContract` (`mode: 'resume_ambient'`), and an
  `AmbientRecordPointer` carried in the index as an optional
  `ambient_record`. Six new invariants (CONT-I13..I18). Back-compatible:
  the index pointer is `.nullable().optional()`, so pre-ambient index
  files keep parsing, and the new kind widens (not narrows) the record
  union. Motivated by folding the personal warm-handoff writer into
  Circuit's per-repo continuity store so the two continuity layers stop
  disagreeing.
- **v0.1 + ambient resolver refinements (2026-06-06)** — resolver and
  harvest behavior added alongside the continuity-restore work, none of
  it schema-level: the brief falls through from a broken `pending_record`
  to a valid `ambient_record` and surfaces the failure (A4); an ambient
  record's rendered brief carries a relative-age staleness signal (A2);
  `handoff done --clear-ambient` additionally drops the ambient pointer
  and removes ambient record files (E1); harvest keys ambient records per
  session and parses the transcript incrementally via a per-repo cursor
  under `<control-plane>/continuity/cursors/` (D1, B1). None of these
  touch the record or index schema or CONT-I1..I18; the single
  `ambient_record` pointer (CONT-I17/I18) is preserved, and the new
  cursor files are not continuity reports (no schema, advisory only).
- **v0.2** — candidate scope items if evidence supports:
  - Introduce a `schema_version` fence (e.g., `2` for a future shape
    change), with a documented migration posture. Reopen condition:
    operator declares a shape change.
  - Narrow `AttachedRunPointer.last_validated_at` to a duration-bounded
    freshness window enforced at resume time. Reopen condition: a real
    staleness incident.
  - **Pointer-kind denormalization (Codex MED #3).** Decide whether
    `PendingRecordPointer.continuity_kind` should be removed, kept as
    a non-authoritative hint, or ratified via
    `continuity.prop.index_pointer_kind_matches_record`. Evidence
    needed: does any resolver or UI actually branch on the hint
    pre-record-read? If yes, keep + property-test; if no, remove.
    Reopen condition: a resolver ships that depends on the hint.
  - **Split-brain resolver precedence (Codex MED #4).** Pick a
    precedence rule for the case where `pending_record` points at a
    run-backed record whose `run_ref.run_id` disagrees with
    `current_run.run_id`. Three candidates: pending-record-wins;
    current-run-wins; error-on-conflict. Reopen condition: the
    resume flow ships OR a split-brain incident is observed in
    practice.
- **v1.0 (Stage 2)** — ratified invariants plus property tests:
  `continuity.prop.*` under `tests/properties/visible/continuity/`.
  Resolver-level properties (dangling reference, liveness validation)
  land with the resume implementation.

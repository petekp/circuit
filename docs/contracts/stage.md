---
contract: stage
status: ratified-v0.1
version: 0.1
schema_source: src/schemas/stage.ts
last_updated: 2026-04-19
depends_on: [ids, step]
closes: [adversarial-review-med-11-stage-path-policy]
report_ids:
  - stage.definition
invariant_ids: [stage-I1, stage-I2, stage-I3, stage-I4, stage-I5, stage-I6]
property_ids: [stage.prop.canonical_stage_reachability, stage.prop.canonical_set_is_enum, stage.prop.every_step_has_a_stage, stage.prop.omits_disjoint_from_declared, stage.prop.omits_pairwise_unique, stage.prop.partial_requires_rationale, stage.prop.review_semantic_adequacy, stage.prop.stage_path_partial_covers_complement, stage.prop.stage_path_strict_covers_all_seven, stage.prop.steps_closure, stage.prop.unique_canonicals, stage.prop.unique_ids, stage.prop.verify_semantic_adequacy]
---

# Stage Contract

A **Stage** is a named, ordered grouping of **Steps** within a **CompiledFlow**.
Stages may optionally align with the **canonical stage path** —
`frame → analyze → plan → act → verify → review → close` — or be flow-
specific. A Stage is an organizational layer over Steps; it does not own
execution semantics. Step invariants (routing, gating, writes) live in
[docs/contracts/step.md](step.md).

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#core-flow-language](../../UBIQUITOUS_LANGUAGE.md#core-flow-language)
for canonical definitions of **Stage**, **Step**, and the seven canonical-stage
labels. Do not introduce synonyms; new vocabulary must land in
[UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) before use here.

## Invariants

The runtime MUST reject any Stage that violates these. All invariants are
enforced via `src/schemas/stage.ts` + `src/schemas/compiled-flow.ts` and tested
in `tests/contracts/flow-graph-schema.test.ts` and
`tests/contracts/selection-schema.test.ts`.

- **stage-I1 — Non-empty steps.** `Stage.steps` contains at least one
  `StepId`. Enforced at `src/schemas/stage.ts` via `z.array(StepId).min(1)`.

- **stage-I2 — Strict surplus-key rejection.** `Stage` is declared with
  `.strict()`. Surplus keys are rejected at parse time, not silently
  stripped. This closes the same defense-in-depth gap adversarial-review
  MED #4 raised for `Step` and applies it to `Stage`: a YAML flow with
  a typo (e.g., `conanical: 'review'`) fails parse rather than silently
  dropping the canonical binding.

- **stage-I3 — Canonical label closed to enum.** When present,
  `Stage.canonical` MUST be one of the seven `CanonicalStage` values
  (`frame`, `analyze`, `plan`, `act`, `verify`, `review`, `close`).
  Enforced by `z.enum` in `src/schemas/stage.ts`.

- **stage-I4 — stage path policy declaration enforcement (closes
  adversarial-review MED #11 at the *declaration* layer only).** Every
  `CompiledFlow` MUST declare a `stage_path_policy` discriminated union. Two modes
  are accepted:

  - `mode: 'strict'` — every one of the seven canonical stages MUST appear
    as the `canonical` field on at least one `Stage` in `CompiledFlow.stages`.
  - `mode: 'partial'` — the CompiledFlow explicitly declares an
    `omits: CanonicalStage[]` array (non-empty, pairwise unique, disjoint
    from declared `Stage.canonical` values) plus a `rationale: string`
    (≥20 characters). Every canonical stage NOT in `omits` still MUST
    appear as a `Stage.canonical`.

  **Scope caveat — what this invariant does NOT guarantee.** stage-I4 is
  a *label-level* check. It guarantees that a canonical stage has been
  *named* in the manifest. It does not guarantee that the named stage
  contains a semantically-adequate step (for example, that a `review`
  stage actually relays a reviewer, or that a `verify` stage runs a
  check). It also does not guarantee that the named stage is reached by
  any entry-mode execution path. A determined author can satisfy the
  label bar while routing around review or verify at runtime. The
  Codex adversarial property-auditor (2026-04-18) flagged these as
  HIGH #1-3; they are tracked as property ids for Stage 2 enforcement
  (see `stage.prop.*_semantic_adequacy` and
  `stage.prop.*_reachability` below) and NOT claimed closed by this
  invariant.

  The 20-character rationale requirement is a structural *minimum* (a
  non-empty human-readable note), not a Goodhart-proof discipline check
  (`aaaaaaaaaaaaaaaaaaaa` satisfies it). A future version may upgrade
  `rationale` to a structured record if real flows justify the cost.

  Enforced in `src/schemas/compiled-flow.ts` `superRefine` + `src/schemas/stage.ts`
  (SpinePolicy discriminated union); negative coverage in
  `tests/contracts/flow-graph-schema.test.ts`.

- **stage-I5 — Canonical uniqueness within a flow.** No two
  `Stage`s in the same `CompiledFlow` may share the same defined
  `canonical` value. (Stages with `canonical: undefined` — flow-
  specific stages — are permitted in unlimited number.) A flow that
  declares two `canonical: 'review'` stages is structurally ambiguous
  about which is "the" review for audit/relay purposes; rather than
  pick a silent convention, Circuit rejects the ambiguity at
  parse time. Closes Codex adversarial-auditor MED #4. Enforced in
  `src/schemas/compiled-flow.ts` `superRefine`; negative coverage in
  `tests/contracts/flow-graph-schema.test.ts`.

- **stage-I6 — CompiledFlow-level strict surplus-key rejection.** The
  `CompiledFlow` schema itself is `.strict()`, so top-level surplus keys
  (e.g., misspelled `stage_path_plicy`, stray `audit_notes`, or alternate-
  stage path smuggling under a different name) are rejected at parse time.
  This is defense-in-depth against the same typo class stage-I2 handles
  at the Stage level. Closes Codex adversarial-auditor LOW #8. Enforced
  at `src/schemas/compiled-flow.ts`.

## Pre-conditions

- `Stage` objects must parse under `Stage.safeParse`.
- Every `StepId` in `Stage.steps` must be the `id` of a `Step` in the
  enclosing `CompiledFlow.steps` (enforced at the CompiledFlow level by WF-I3).
- The `Stage.id` must be unique within the enclosing CompiledFlow (WF-I6).

## Post-conditions

After a Stage is accepted in a CompiledFlow:

- `Stage.steps.length >= 1` (stage-I1).
- `Stage.canonical`, when present, is a valid `CanonicalStage` value
  (stage-I3).
- The enclosing CompiledFlow's stage path-policy contract is satisfied (stage-I4).
- `Stage.id` is unique within the CompiledFlow (WF-I6).
- Every `StepId` in `Stage.steps` resolves to a known Step (WF-I3).

## Property ids (reserved for Stage 2 testing)

Property-based tests will cover:

- `stage.prop.steps_closure` — For any valid CompiledFlow, every `StepId` in
  any Stage's `steps` list resolves to a sibling Step.
- `stage.prop.unique_ids` — For any valid CompiledFlow, Stage ids are
  pairwise distinct (covered at the CompiledFlow level; restated here for
  cross-contract clarity).
- `stage.prop.unique_canonicals` — For any valid CompiledFlow, defined
  `Stage.canonical` values are pairwise distinct (stage-I5).
- `stage.prop.canonical_set_is_enum` — For any valid Stage, if `canonical`
  is present it is an element of `CanonicalStage`.
- `stage.prop.stage_path_strict_covers_all_seven` — For any valid CompiledFlow
  with `stage_path_policy.mode === 'strict'`, the set of
  `Stage.canonical` values (ignoring undefined) is a superset of the seven
  canonical labels.
- `stage.prop.stage_path_partial_covers_complement` — For any valid CompiledFlow
  with `stage_path_policy.mode === 'partial'` and `omits = O`, the set of
  `Stage.canonical` values is a superset of `CanonicalStage \ O`.
- `stage.prop.omits_disjoint_from_declared` — For any valid CompiledFlow
  with `stage_path_policy.mode === 'partial'`, `omits ∩ declaredCanonicals
  === ∅`. A canonical cannot be both omitted and declared (closes Codex
  MED #6.a).
- `stage.prop.omits_pairwise_unique` — For any valid CompiledFlow with
  `stage_path_policy.mode === 'partial'`, `omits` has no duplicate entries
  (closes Codex MED #6.b).
- `stage.prop.partial_requires_rationale` — Any CompiledFlow with
  `stage_path_policy.mode === 'partial'` and `rationale.length < 20` is
  rejected.

### Reserved for Stage 2 (HIGH gaps from Codex adversarial-auditor pass)

These are the invariants stage-I4 is *not* strong enough to guarantee
alone. They land when the property-test harness + trace_entry-log seams
exist in Stage 2:

- `stage.prop.review_semantic_adequacy` — For any valid CompiledFlow whose
  stage path declares `review`, at least one Step in the review stage MUST
  be a `RelayStep` with `role: 'reviewer'`, or a `CheckpointStep`
  that relays a human reviewer. (Closes Codex HIGH #1 for
  `review`; analogous properties for other canonicals are tracked but
  not listed separately until Stage 2 design lands.)
- `stage.prop.verify_semantic_adequacy` — For any valid CompiledFlow whose
  stage path declares `verify`, at least one Step in the verify stage MUST
  carry a verification check or protocol. (Closes Codex HIGH #1 for
  `verify`.)
- `stage.prop.canonical_stage_reachability` — For every non-omitted
  canonical stage, at least one Step in that stage MUST be reachable
  from the CompiledFlow `starts_at` step along a valid route sequence.
  A flow cannot satisfy stage_path_policy and then route from `frame`
  directly to `@complete`, skipping all declared canonicals. (Closes
  Codex HIGH #2.)
- `stage.prop.every_step_has_a_stage` — For every Step in
  `CompiledFlow.steps`, exactly one `Stage` in `CompiledFlow.stages` lists the
  Step's id in its `steps` array. No Step may execute outside the Stage
  structure. (Closes Codex HIGH #3. A `utility: true` escape hatch for
  cross-stage helpers may be added in Stage 2 if evidence justifies it,
  but is not granted in v0.1.)

## Cross-contract dependencies

- **flow** (`src/schemas/compiled-flow.ts`) — CompiledFlow embeds `Stage[]`.
  stage path enforcement, Stage-id uniqueness (WF-I6), Stage-step closure
  (WF-I3), canonical uniqueness (stage-I5), CompiledFlow-level strict surplus
  rejection (stage-I6) all live on the CompiledFlow schema; they reference
  Stage shape but are owned by flow.md.
- **step** (`src/schemas/step.ts`) — Stage holds `StepId[]`. No direct
  Step-shape dependency from Stage itself; Stage just groups existing
  Steps.
- **selection-policy** (`src/schemas/selection-policy.ts`) —
  [UBIQUITOUS_LANGUAGE.md#configuration-language](../../UBIQUITOUS_LANGUAGE.md#configuration-language)
  lists `stage` as a selection
  layer, and `SelectionSource` includes `'stage'`. `Stage.selection:
  SelectionOverride.optional()` landed in `selection.md` v0.1 (SEL-I9),
  closing stage.md v0.1 Codex MED #7. Any `SelectionResolution.applied`
  entry claiming a `stage` source now resolves to an explicit
  `Stage.selection` field on the named stage.
- **ids** (`src/schemas/ids.ts`) — `StageId` and `StepId` branded slugs.

## Failure modes (carried from evidence)

- `carry-forward:stage-path-policy-too-loose` — Prior to this contract,
  `Stage.canonical` was optional with no cross-flow check that
  required canonical labels were present. A malformed flow could
  silently skip `review`, short-circuiting the cross-model-challenger
  check. [docs/contracts/compiled-flow.md](compiled-flow.md) v0.1 flagged this as
  `carry-forward:stage-path-policy-too-loose`. Closed by stage-I4.

- `carry-forward:surplus-key-silent-strip` — Prior to this contract,
  `Stage` was not `.strict()`, so a typo like `conanical` (three-char
  swap of `canonical`) parsed as a legal Stage with `canonical:
  undefined`, silently losing the stage path binding. Closed by stage-I2.

## Evolution

- **v0.1 (this draft)** — stage-I1..I6 enforced: non-empty steps, strict
  surplus-key rejection on Stage, canonical enum closure,
  stage path-policy declaration enforcement (stage-I4, MED #11 closed *at
  the declaration layer*; see scope caveat in the invariant), canonical
  uniqueness within a flow (stage-I5, closes Codex MED #4),
  CompiledFlow-level `.strict()` (stage-I6, closes Codex LOW #8). `omits`
  now enforces uniqueness + disjointness from declared canonicals
  (closes Codex MED #6). HIGH semantic/reachability/coverage objections
  from the Codex adversarial pass are honestly scoped as property_ids
  for Stage 2 (see "Reserved for Stage 2" section above); stage-I4
  prose was tightened to stop over-claiming closure.

- **v0.2 (Stage 1)** — Ratify `property_ids` above by landing the
  corresponding property-test harness. Upgrade `SpinePolicy.rationale`
  from a min(20) string to a structured record if evidence from real
  flows justifies the cost. Author `selection.md` and decide whether
  `Stage.selection: SelectionOverride` lands on Stage or derives from
  `CompiledFlow.default_selection` conditioned on `canonical` (closes Codex
  MED #7). Consider `stage_path_policy.renames` if a flow needs to
  rename `analyze` → `explore` (cosmetic; not a structural gap).

- **v1.0 (Stage 2)** — Ratified invariants + property tests + semantic-
  adequacy + reachability + every-step-has-a-stage (the three Codex
  HIGH gaps) + operator-facing error-message catalog + mutation-score
  floor contribution.

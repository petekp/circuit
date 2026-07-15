---
contract: step
status: draft
version: 0.7
schema_source: src/schemas/step.ts
last_updated: 2026-07-15
depends_on: [ids, check, selection-policy, scalars, skill, skill-hook, acceptance-criteria, equipment-scope]
report_ids:
  - step.definition
invariant_ids: [STEP-I1, STEP-I2, STEP-I3, STEP-I4, STEP-I5, STEP-I6, STEP-I7, STEP-I8, STEP-I9, STEP-I10, STEP-I11, STEP-I12, STEP-I13, STEP-I14, STEP-I15]
property_ids: [step.prop.budget_bounds, step.prop.relay_role_presence, step.prop.check_kind_source_kind_pairing, step.prop.check_source_ref_closure, step.prop.run_relative_paths, step.prop.writes_shape_per_variant, step.prop.skill_slots_unique, step.prop.skill_hooks_unique, step.prop.relay_acceptance_criteria_shape]
---

# Step Contract

A **Step** is the atomic unit of execution inside a **Stage**. Every Step
belongs to exactly one of six variants, discriminated by `kind`:

- **ComposeStep** — orchestrator writes a single report; checked by
  `schema_sections` against a `ReportSource`.
- **VerificationStep** — orchestrator runs bounded direct-argv verification
  commands and writes a single report; checked by `schema_sections` against a
  `ReportSource`.
- **CheckpointStep** — orchestrator pauses for selection (human or
  auto-resolver) under a typed `CheckpointPolicy`; checked by
  `checkpoint_selection` against a `CheckpointResponseSource`.
- **RelayStep** — worker executes remotely under a `RelayRole`; checked
  by `result_verdict` against a `RelayResultSource`, and may declare
  deterministic `acceptance_criteria` that gate advancement after the
  relay result is schema-valid.
- **SubRunStep** — orchestrator launches a child flow and checks the copied
  child result through `result_verdict`.
- **FanoutStep** — orchestrator expands static or dynamic branches and checks
  the aggregate with `fanout_aggregate`.

The shape of `writes` and `check` is coupled to `kind` at the Zod
`discriminatedUnion` layer (`src/schemas/step.ts` `Step`), so
`tsc --strict` rejects any Step literal that pairs a variant with a
non-matching check or writes shape.

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#core-flow-language](../../UBIQUITOUS_LANGUAGE.md#core-flow-language)
for canonical definitions of **Step**, **Check**, **RelayRole**, **ReportRef**,
and the six step variants. Do not introduce synonyms; new vocabulary must land
in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) before use here.

## Invariants

The runtime MUST reject any Step that violates these. All invariants are
enforced via `src/schemas/step.ts`, `src/schemas/check.ts`, and
`src/schemas/scalars.ts`, then tested in
`tests/contracts/step-schema.test.ts`.

- **STEP-I1 — Kind-variant binding.** `kind`, `executor`, `check.kind`, and
  the shape of `writes` are coupled per variant. A `compose` step MUST
  have `executor: 'orchestrator'`, `check.kind: 'schema_sections'`, and
  `writes: { report: ReportRef }`. A `verification` step MUST have
  `executor: 'orchestrator'`, `check.kind: 'schema_sections'`, and
  `writes: { report: ReportRef }`. A `checkpoint` step MUST have
  `executor: 'orchestrator'`, `check.kind: 'checkpoint_selection'`, a
  `policy: CheckpointPolicy`, and `writes: { request, response, report? }`.
  A `relay` step MUST have `executor: 'worker'`, `check.kind:
  'result_verdict'`, and
  `writes: { request, receipt, result, report? }`. Enforced by
  `ComposeStep`, `VerificationStep`, `CheckpointStep`, and `RelayStep` in
  `src/schemas/step.ts`.

- **STEP-I2 — Non-empty routes.** Every Step declares at least one route
  target. The `routes` record is refined on `StepBase.routes` in
  `src/schemas/step.ts`
  (`Object.keys(m).length > 0`). Route target closure is enforced at the
  CompiledFlow level (see
  [docs/contracts/compiled-flow.md](compiled-flow.md) WF-I4), not in the Step
  contract.

- **STEP-I3 — Check source closure (adversarial-review MED #7 closed).**
  `check.source.ref` MUST name a usable slot in the step's `writes`
  object. Enforced *primarily* at the Zod schema layer: `ref` is a
  literal per source kind (`ReportSource.ref = z.literal('report')`,
  `CheckpointResponseSource.ref = z.literal('response')`,
  `RelayResultSource.ref = z.literal('result')` — see
  `src/schemas/check.ts`). Combined with STEP-I1's per-variant `writes`
  shape, the ref necessarily names a required slot. Defense-in-depth:
  the `Step = z.discriminatedUnion(...).superRefine(...)` at
  `src/schemas/step.ts` rejects any step whose `check.source.ref`
  (a) fails `Object.hasOwn(step.writes, ref)` — forbids prototype-chain
  keys like `toString`, `__proto__` — or (b) resolves to `undefined`
  even though the key is present (guards the CheckpointStep/RelayStep
  optional-`report` corner). Negative coverage in
  `tests/contracts/step-schema.test.ts`: prototype-chain refs,
  cross-slot refs (`checkpoint_response` pointing at `request`;
  `relay_result` pointing at `receipt`), and the historical
  missing-slot rejections.

- **STEP-I4 — Check kind, source kind, and ref slot are all structurally
  bound per variant.** Each check variant constrains exactly one source
  schema: `SchemaSectionsCheck.source` is `ReportSource`,
  `CheckpointSelectionCheck.source` is `CheckpointResponseSource`,
  `ResultVerdictCheck.source` is `RelayResultSource`
  (`src/schemas/check.ts`). Within each source, `kind` is a `z.literal`
  and `ref` is a `z.literal` — so the TypeScript-inferred `source.kind`
  literal is constrained, and a cross-kind source fails Zod's
  discriminated-union parse at runtime. (TypeScript structural typing
  may allow surplus fields on variables that flow through loose
  interfaces; that is what STEP-I6's `.strict()` catches at parse time.)
  Paired with STEP-I1, this gives type-layer binding on literal fields
  plus parse-time rejection on everything else.

- **STEP-I5 — Budget bounds.** When `budgets` is present,
  `budgets.max_attempts` is an integer in `[1, 10]` and, if set,
  `budgets.wall_clock_ms` and `budgets.inactivity_ms` are positive
  integers. `wall_clock_ms` caps a relay's total elapsed time.
  `inactivity_ms` caps how long its connector subprocess may stay
  silent before the watchdog kills it; declare it on a step whose relay
  legitimately goes silent longer than the connector default. Enforced
  by `StepBase.shape.budgets` in `src/schemas/step.ts`.

- **STEP-I6 — Role only on relay; surplus keys rejected.** Only
  `RelayStep` carries a `role` field, and it is a required
  `RelayRole` (`researcher | implementer | reviewer`).
  `ComposeStep`, `VerificationStep`, and `CheckpointStep` have no `role`
  field in their schema, and because every Step variant, every `writes`
  object, every check variant, and every check `source` object is explicitly
  `.strict()`, a surplus key (including `role` on a non-relay step)
  is **rejected**, not stripped. This closes adversarial-review
  MED #4: the Zod-strict enforcement story is now backed by explicit
  `.strict()` calls at `src/schemas/step.ts` and `src/schemas/check.ts`.
  `orchestrator` is an executor, not a role; see
  [UBIQUITOUS_LANGUAGE.md#relay-language](../../UBIQUITOUS_LANGUAGE.md#relay-language).

- **STEP-I9 — Checkpoint policy and check agreement.** A `CheckpointStep`
  declares its selectable options one of two ways, and its check must agree.
  In the **static** form, `policy.choices` lists the option ids; the check's
  `allow` list MUST exactly match those ids (same set, order-independent), and
  any `safe_default_choice` MUST name one of them. In the **dynamic** form,
  `policy.choices_from` names a source the options are read from at runtime, and
  the check declares `allow_from` (which MUST reference `policy_choices`)
  instead of a static list, because no fixed id set exists yet to match. A
  policy declares exactly one of `choices` or `choices_from`; a check declares
  exactly one of `allow` or `allow_from`; a static `allow` requires static
  `policy.choices`. A checkpoint may also carry `auto_resolution` (a rubric
  that picks the highest-scoring branch from a named report) and
  `auto_continuable_when_nested` (opt-in: an unattended nested or headless run
  may auto-continue this gate through its fail-safe path, first the
  auto-resolution rubric and then the declared safe default, instead of failing
  closed; absent means fail closed loudly). There is no
  `safe_autonomous_choice` field. Every
  resolution is recorded in the trace with its source: `declared-default`,
  `operator`, or `policy` (see `checkpoint.resolved` in
  [docs/contracts/run.md](run.md)). This keeps the request report, the response
  check, and the auto-resolution policy from drifting apart. Enforced by the
  `CheckpointPolicy` refinement and the checkpoint branch of the `Step`
  `superRefine` in `src/schemas/step.ts`.

- **STEP-I10 — Skill slots are typed optional placeholders.** Every Step
  may carry `skill_slots: SkillSlot[]`; absence means no slots. Slot ids are
  kebab-case `SkillSlotId`s and must be unique within the step. A slot
  does not load a skill by itself; relay-time loading happens only when
  config binds the slot to a concrete local `SkillId`. v1 slots are
  optional only.

- **STEP-I11 — Relay acceptance criteria are deterministic and relay-only.**
  Only `RelayStep` may carry `acceptance_criteria`. V1 criteria are
  deterministic: `report_field` checks over the parsed relay result, or
  `command` checks using the bounded direct-argv verification command shape.
  The supported failure policies are `hard-fail` and `retry-with-feedback`;
  LLM-judged criteria and checkpoint edit-criterion behavior are not part of
  this contract. Enforced by `src/schemas/acceptance-criteria.ts`,
  `RelayStep` in `src/schemas/step.ts`, and schematic execution-shape
  validation in `src/schemas/flow-schematic.ts`.

- **STEP-I12 — Skill Hooks are hook names only.** Every Step may carry
  `skill_hooks: SkillHookName[]`; absence means the step publishes no
  authored hooks. The field names hooks only. It cannot carry concrete
  `SkillId`s, policy modes, host invocation options, or `{skills: [...]}` slot
  matrices. Runtime policy may later map these hooks to skills, but that
  mapping lives in config/policy, not in the flow step.

- **STEP-I7 — Protocol required.** Every Step carries a `ProtocolId`
  (`protocol:` field) — no default, no optional. Enforced by `StepBase`
  in `src/schemas/step.ts`. The `ProtocolId` brand is defined in
  `src/schemas/ids.ts`.

- **STEP-I8 — CompiledFlow-controlled paths are run-relative.** Every
  flow-controlled read/write path carried by a Step MUST be a portable
  POSIX-style path relative to the run folder. This covers
  `ReportRef.path`, `StepBase.reads[]`, checkpoint `writes.request`,
  checkpoint `writes.response`, checkpoint `writes.report.path`,
  relay `writes.request`, relay `writes.receipt`,
  relay `writes.result`, and relay `writes.report.path`. A valid
  path is non-empty, not absolute, contains no backslash, contains no
  colon or drive-letter form, and contains no empty, current-directory, or
  parent-directory segment. Enforced by `RunRelativePath` in
  `src/schemas/scalars.ts` and by the Step variant schemas in
  `src/schemas/step.ts`. Runtime call sites additionally resolve through
  `src/shared/run-relative-path.ts` before reading or writing.

- **STEP-I13 — Equipment scope is a declared per-step tool allowlist.** Every
  Step may carry `equipment_scope`, the tools sub-axis of the step's equipment.
  It has two fields. `tools` is either `'full'` (the worker keeps the
  connector's whole tool surface) or `{ allow: [...] }` (the worker is scoped to
  exactly that non-empty, duplicate-free tool list). `enforcement` is either
  `'trusted'` (the scope is offered to the worker as guidance and reported
  honestly as not enforced) or `'enforced'` (the scope is a real boundary).
  Enforcing `'full'` is rejected — there is nothing to restrict to, so an
  enforced scope MUST name an explicit allowlist. Absence equals the default
  `{ tools: 'full', enforcement: 'trusted' }`, which the compiler omits so
  flows that declare nothing stay byte-stable. Where a connector cannot restrict
  tools, the runtime downgrades an enforced binding to trusted and records a
  finding; it is never displayed as enforced after a downgrade. Enforced scope
  is gated to relay steps at the schematic layer. Enforced by `EquipmentScope`
  in `src/schemas/equipment-scope.ts`; the engine reads the field off the step,
  never from a catalog keyed by flow id.

- **STEP-I14 — Report-driven routing selects a declared route.** Every Step may
  carry `route_from_report`, a non-empty dotted `path` into the step's report
  body. When present, the compose and relay executors resolve the route from
  that path on a passing check instead of taking the default `pass` route. The
  path MUST descend through objects and resolve to a non-empty string; the
  resolved label MUST be one of the step's declared `routes`, or the run errors.
  The resulting `step.completed` entry records `route_source: 'report'`.
  Enforced by `RouteFromReport` in `src/schemas/step.ts`, resolved by
  `readRouteFromReport` in `src/runtime/executors/shared.ts`, and applied in
  `src/runtime/executors/relay.ts` and `src/runtime/executors/compose.ts`.

- **STEP-I15 — Result-verdict admission may require empty fields.** Relay and
  sub-run `result_verdict` checks may declare `require_empty`, a non-empty list
  of non-empty field paths. The runtime evaluates these paths only after the
  result's verdict appears in `check.pass`. Every named value must be an empty
  string, array, or object. A missing field, `null`, boolean, number, or
  non-empty value fails the check. Relay check failures still materialize a
  schema-valid typed report, so a recovery step can read the rejected result.
  Enforced by `ResultVerdictCheck` in `src/schemas/check.ts`, schematic
  execution-shape validation, and the shared result-verdict admission helper.

## Pre-conditions

- Step objects must parse under `Step.safeParse`.
- The referenced `ProtocolId` must exist in the running plugin's protocol
  registry at load time (validated by the runtime, not by the Zod schema).
- The `check.source.ref` slot must be writable by the step's kind —
  enforced structurally by STEP-I1 (writes shape) + STEP-I3 (ref closure).

## Post-conditions

After a Step is accepted:

- The Step's `id` is unique within its CompiledFlow (enforced at the CompiledFlow
  level; see WF-I1).
- The Step's `routes` record contains only terminal labels
  (`@complete | @stop | @escalate | @handoff`) or ids of sibling Steps
  (enforced at the CompiledFlow level; see WF-I4).
- The Step's `writes` slot named by `check.source.ref` is guaranteed to
  exist — the runtime may resolve `check.source` without a nil check.
- The Step's `check.kind` uniquely determines the shape of
  `check.source` — no runtime reconciliation of source-kind vs check-kind
  is needed after parse.
- The Step's flow-authored file paths are safe to resolve within a
  run folder. Runtime writers still call the run-relative resolver as
  defense-in-depth when typed data is bypassed.
- `skill_slots`, when present, is an array of typed optional slots.
- `skill_hooks`, when present, is an array of typed hook names.
- `acceptance_criteria`, when present, belongs to a relay step and is
  preserved into compiled and runtime flow projections.

## Property ids (reserved for Stage 2 testing)

Property-based tests will cover:

- `step.prop.check_source_ref_closure` — For any valid `Step`, the
  `check.source.ref` names a key in `step.writes`. (Generator should
  include adversarial refs sampled from non-writes strings.)
- `step.prop.check_kind_source_kind_pairing` — For any valid `Step`, the
  `check.kind → source.kind` map is the fixed pairing in STEP-I4, with no
  exceptions across the full variant space.
- `step.prop.relay_role_presence` — For any valid `Step` where
  `kind === 'relay'`, `role` is present and is a valid `RelayRole`;
  for any other variant, `role` is absent.
- `step.prop.writes_shape_per_variant` — For any valid `Step`, the
  `writes` object is exhaustively one of the three variant shapes — no
  extra keys, no missing required keys.
- `step.prop.run_relative_paths` — For any valid `Step`, every
  flow-controlled path surface named in STEP-I8 parses as
  `RunRelativePath` and resolves inside the run folder.
- `step.prop.budget_bounds` — For any valid `Step` with `budgets`
  present, `max_attempts ∈ [1, 10]`.
- `step.prop.skill_slots_unique` — For any valid `Step`,
  `skill_slots[].id` values are unique and parse as `SkillSlotId`.
- `step.prop.relay_acceptance_criteria_shape` — For any valid `Step`,
  `acceptance_criteria` is absent unless `kind === 'relay'`; when present,
  every criterion is one of the deterministic V1 kinds and every command uses
  the bounded verification command shape.

## Cross-contract dependencies

- **check** (`src/schemas/check.ts`) — Step embeds one check per variant;
  the check's kind-bound source schema is what makes STEP-I4 a
  type-layer invariant rather than a runtime refinement.
- **selection-policy** (`src/schemas/selection-policy.ts`) — Step's
  optional `selection: SelectionOverride` participates in the selection
  layer stack defined in
  [UBIQUITOUS_LANGUAGE.md#configuration-language](../../UBIQUITOUS_LANGUAGE.md#configuration-language).
- **skill** (`src/schemas/skill.ts`) — Step's `skill_slots` field uses
  `SkillSlot[]`. Slot binding and local skill resolution are relay-time
  concerns owned by config and the user skill registry.
- **skill-hook** (`src/schemas/skill-hook.ts`) — Step's
  `skill_hooks` field uses `SkillHookName[]`. Policy resolution and
  availability checks are Run/config concerns, not Step concerns.
- **acceptance-criteria** (`src/schemas/acceptance-criteria.ts`) — Relay
  steps may embed deterministic advancement gates; the relay executor records
  their results as `check.evaluated` trace entries.
- **equipment-scope** (`src/schemas/equipment-scope.ts`) — Step's optional
  `equipment_scope` field carries the tools-axis allowlist and its enforcement
  mode. The engine reads it off the step, never from a catalog keyed by flow id
  (STEP-I13).
- **flow** (`src/schemas/compiled-flow.ts`) — CompiledFlow-level invariants
  (WF-I1 unique step ids, WF-I4 closed route targets) reference Step
  identity; they are not repeated here.
- **ids** (`src/schemas/ids.ts`) — `StepId` and `ProtocolId` branded
  slugs.
- **scalars** (`src/schemas/scalars.ts`) — `RunRelativePath`
  supplies the portable run-folder-relative path grammar consumed by
  `ReportRef`, `reads`, and write slots.

## Failure modes (carried from evidence)

- `carry-forward:verdict-enum-bloat` — Existing Circuit uses a global
  verdict enum + per-protocol conditionals (see
  `bootstrap/adversarial-review-codex.md`). Circuit constrains the
  verdict vocabulary **per step kind** through the check variant
  (`ResultVerdictCheck.pass`, `CheckpointSelectionCheck.allow`,
  `SchemaSectionsCheck.required`). Adding a new protocol does not expand
  the verdict enum.
- `carry-forward:role-executor-confusion` — Existing Circuit allowed
  `orchestrator` as both an executor and a relay role (see
  adversarial-review MED #1). Circuit's `RelayRole` excludes
  `orchestrator` and STEP-I6 forbids `role` on compose/verification/checkpoint
  steps. The confusion is structurally eliminated.
- `carry-forward:check-source-opacity` — Prior to this contract, check
  sources were opaque strings (adversarial-review MED #7). Closed by
  STEP-I3 + STEP-I4; see
  [docs/contracts/compiled-flow.md](compiled-flow.md) "Check source tightening"
  for the transition record.

## Evolution

- **v0.1 (Slice 2)** — initial contract: STEP-I1..I7, kind-bound
  source schemas with **literal `ref` per source kind** (report →
  `'report'`, checkpoint_response → `'response'`, relay_result →
  `'result'`), strict surplus-key rejection via `.strict()` on every
  variant, writes-slot closure via Step-union `superRefine` with
  `Object.hasOwn` + undefined guard as defense-in-depth. MED #7 closed.
  Codex adversarial property-auditor pass completed — HIGH #1
  (prototype-chain `in` attack), HIGH #2 (cross-slot drift), HIGH #3
  (optional undefined slot), MED #4 (strict-mode prose), LOW #7 (TS
  exactness prose) all incorporated.
- **v0.2 (Slice 69)** — adds STEP-I8 so
  flow-controlled Step paths are `RunRelativePath` values and runtime
  call sites resolve them through a containment-checked helper.
- **v0.3 (user skill loading slice)** — adds STEP-I10 and
  the typed `skill_slots` field.
- **v0.4 (Stage 2)** — ratify `property_ids` above by landing the
  corresponding property-test harness; introduce a disambiguator only
  if a new relay step emerges that writes multiple result-like
  slots (current `relay_result.ref = 'result'` is the v0.1 answer);
  absorb any future Codex challenger findings.
- **v0.5 (Run-centered Skill Hook policy slice)** — adds
  STEP-I12 and the typed `skill_hooks` field. This is a hook-only
  authoring field; it deliberately rejects concrete skill binding matrices.
- **v0.6 (pre-v1 contract reconciliation, this version)** — rewrites STEP-I9
  to cover both static (`choices` + `allow`) and dynamic (`choices_from` +
  `allow_from`) checkpoints, plus `auto_resolution` and
  `auto_continuable_when_nested`. Adds STEP-I13 (`equipment_scope`, the
  per-step tools allowlist) and STEP-I14 (`route_from_report`, report-driven
  route selection on compose and relay steps).
- **v1.0 (Stage 2)** — ratified invariants + property tests + mutation
  score floor + operator-facing error-message catalog.

---
contract: selection
status: ratified-v0.1
version: 0.5
schema_source: src/schemas/selection-policy.ts
last_updated: 2026-06-11
depends_on: [ids, depth, skill, stage, config, run]
closes: [stage-md-v0.1-med-7-stage-level-selection]
report_ids:
  - selection.override
  - selection.resolution
invariant_ids: [SEL-I1, SEL-I2, SEL-I3, SEL-I4, SEL-I5, SEL-I6, SEL-I7, SEL-I8, SEL-I9]
property_ids: [selection.prop.config_layer_precompose_is_right_biased, selection.prop.invocation_options_merge_is_right_biased, selection.prop.overlapping_stage_composition_well_defined, selection.prop.override_empty_roundtrip, selection.prop.stage_source_only_when_stage_declared_selection, selection.prop.precedence_const_parity, selection.prop.resolved_matches_applied_composition, selection.prop.resolved_skills_are_unique_and_order_is_documented, selection.prop.skill_override_composition_total]
---

# Selection Contract

The **Selection** contract governs how model, reasoning effort, skill set,
depth tier, and invocation options are **layered** across config sources and
resolved into an effective record at relay time. Selection is not a single
type; it is a triplet of related schemas:

1. **`SelectionOverride`** — a partial record a single layer contributes.
2. **`ResolvedSelection`** — the effective record after all layers compose.
3. **`SelectionResolution`** — the pair `{ resolved, applied }`, where
   `applied` is the provenance trace of which layers contributed what.

The contract answers: what must be true of an override, of a resolved
record, and of a resolution's provenance chain for the triplet to be
well-formed and independently auditable?

Individual field shapes (provider-scoped model, effort tier, skill
operations) already validate themselves at the Zod layer. This contract
governs the **layer-level** and **resolution-level** invariants that no
single override can assert alone.

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#configuration-language](../../UBIQUITOUS_LANGUAGE.md#configuration-language)
for canonical definitions of **Config layer**, **Selection layer**, **Selection
override**, **Resolved selection**, **Provider-scoped model**, and **Effort**.
Do not introduce synonyms; new vocabulary must land in
[UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) before use here.

The distinction to keep straight: a **config layer** is a source of Config
(default, user-global, project, invocation — 4 sources). A **selection
layer** is a source of a `SelectionOverride` (default, user-global, project,
flow, stage, step, invocation — 7 sources). Selection layers are a
superset that includes flow/stage/step-authored defaults alongside
config-file layers.

## Invariants

The runtime MUST reject any `SelectionOverride`, `ResolvedSelection`, or
`SelectionResolution` that violates these. All invariants are enforced via
`src/schemas/selection-policy.ts` and — for the cross-schema invariants —
the schema files named per invariant (currently SEL-I9 at
`src/schemas/stage.ts`); tested in `tests/contracts/selection-schema.test.ts`.
Closes Codex LOW #12 (enforcement-location claim drift).

- **SEL-I1 — Selection precedence is declared, closed, and compile-time
  pinned to the `SelectionSource` enum.** `SELECTION_PRECEDENCE` is the
  frozen 7-tuple `['default', 'user-global', 'project', 'flow', 'stage',
  'step', 'invocation']`. The declaration is typed as `readonly
  SelectionSource[]` via `as const satisfies`, so any future drift between
  the enum and the precedence list (e.g., adding a source to the enum
  without adding it to the precedence order) fails `tsc --strict`, not
  just a runtime test. The precedence is strictly ordered across
  *categories*; within the `stage` and `step` categories multiple entries
  may appear (disambiguated by id — see SEL-I7). **Config-layer pre-
  compose.** `Config.defaults.selection` and
  `Config.circuits[flow_id].selection` live inside the same config
  file; they are pre-composed (defaults first, circuit-specific second)
  BEFORE contributing to the applied chain, so a single config layer emits
  at most one entry per its source label (`default`, `user-global`,
  `project`, `invocation`). Skill operations are normalized to the
  effective skill set for that config source when needed, so
  `defaults.selection.skills = replace` plus
  `circuits[flow_id].selection.skills = append` preserves both
  contributions. Intra-layer provenance within a config file is therefore
  lost at the applied-chain granularity; that loss is the v0.1 tradeoff for
  keeping SEL-I7 simple (closes Codex HIGH #6). Stage 2 property
  `selection.prop.config_layer_precompose_is_right_biased` validates the
  merge semantics at the composition layer. Enforced at
  `src/schemas/selection-policy.ts`.

- **SEL-I2 — `SelectionOverride` is `.strict()` with every field optional.**
  A layer that contributes nothing is expressible as `{}` when parsed as a
  raw override — but a raw empty override MUST NOT appear as an
  `applied[]` entry; see SEL-I7 (ghost-provenance rejection). A typo
  (`dpth: 'medium'` instead of `depth`) is **rejected**, not silently
  dropped as a surplus key; a silent strip would leave the effective
  selection at the prior layer's default and the author's intent would
  never reach the runtime. `invocation_options` is a recursive
  JSON-safe record (`JsonObject`) — arbitrary nesting of null, boolean,
  finite number, string, array, and string-keyed record. Functions,
  Dates, symbols, `undefined`, `NaN`, and `Infinity` are all rejected
  because they cannot be authored in YAML/TOML/JSON and would not
  survive trace_entry-log serialization (closes Codex MED #10). Merge
  semantics (right-biased by precedence) are a Stage 2 property. Enforced
  at `src/schemas/selection-policy.ts`.

- **SEL-I3 — `SkillOverride` is a typed discriminated union; no empty-
  array ambiguity; skills are unique within a single operation.** The
  four modes are `inherit`, `replace`, `append`, `remove`. Only
  `replace`, `append`, and `remove` carry a `skills: SkillId[]` field;
  `inherit` is a pure sentinel. The default value when no `skills` field
  is authored on a `SelectionOverride` is `{mode: 'inherit'}`. **Scope
  caveat — empty arrays are legal under the non-`inherit` modes.**
  `{mode: 'replace', skills: []}` means "clear the skill set"; `{mode:
  'append', skills: []}` is a no-op; `{mode: 'remove', skills: []}` is a
  no-op. **Uniqueness within an operation (closes Codex MED #8).** The
  `skills` array on `replace`, `append`, and `remove` rejects duplicate
  `SkillId`s at parse time, because set-algebra composition (union,
  difference) at the resolver layer expects set-typed inputs; a YAML
  typo that ships `['tdd', 'tdd']` was indistinguishable from an authored
  set and would propagate through composition unchanged. Canonical
  *order* of the composed resolver output is reducer-level and tracked
  as Stage 2 property
  `selection.prop.resolved_skills_are_unique_and_order_is_documented`.
  Legacy untyped skill channels (`CompiledFlow.default_skills`,
  `CircuitOverride.skills`) are removed in v0.1 so every skill
  contribution flows through a `SkillOverride` (closes Codex HIGH #5).
  Enforced at `src/schemas/selection-policy.ts`.

- **SEL-I4 — `ProviderScopedModel` replaces marketing-name enumeration.**
  A model identifier is `{provider: 'openai' | 'anthropic' | 'gemini' |
  'custom'; model: string.min(1)}`. The provider enum is closed; the
  model string is connector-owned (e.g., `claude-opus-4-7` for Anthropic,
  `gpt-5.4-reasoning` for OpenAI). Connector-specific validation or
  honoring of known model strings is a Stage 2 connector concern, not a
  schema concern; new model releases do not require a Circuit
  schema change. Slice 87 gives the current built-in connectors narrow
  handling: `claude-code` accepts provider `anthropic` and passes the model to
  Claude's `--model`; `codex` accepts provider `openai` and passes the model to
  Codex's `-m`; `cursor-agent` accepts provider
  `gemini` and passes the model to Cursor's `--model`. Provider mismatches
  fail before subprocess spawn. **Effort** is the closed 7-tier enum
  `none | minimal | low | medium | high | xhigh | max`. The current connector
  support matrix is explicit: `claude-code` honors `low | medium | high |
  xhigh | max`; `codex` honors `low | medium | high | xhigh`;
  `cursor-agent` currently honors `none`. Other effort/provider
  pairings fail before subprocess spawn until a connector has explicit support.
  Enforced at `src/schemas/selection-policy.ts` for shape and
  `src/connectors/*.ts` for connector-specific honoring.

- **SEL-I5 — `ResolvedSelection` is the effective record at relay
  time.** `ResolvedSelection` carries `{model?, effort?, skills:
  SkillId[] (unique), depth?, invocation_options: JsonObject}` and is
  `.strict()`. **Codex HIGH #4 fold-in:** `invocation_options` IS part
  of the effective record because connectors consume it at relay time;
  the v0.1 drafting that excluded it produced `RelayStartedTraceEntry`s
  that were identical under different invocation_options, insufficient
  for audit or replay. What `ResolvedSelection` still does NOT carry is
  a `SkillOverride` union — the resolver flattens the override chain
  into a final unique `SkillId[]`. **Cache-vs-truth scope caveat
  (closes Codex HIGH #3 at the prose layer).** `ResolvedSelection` is
  a *cache*; `SelectionResolution.applied` is the *truth*. The v0.1
  schema does **not** bind `resolved` to `applied` — a resolution whose
  `resolved.effort: 'high'` contradicts an applied chain whose only
  override sets `effort: 'low'` parses successfully. Binding is
  reducer-level and tracked as Stage 2 property
  `selection.prop.resolved_matches_applied_composition`. Enforced at
  `src/schemas/selection-policy.ts`.

  **Skill loading scope caveat.** `ResolvedSelection.skills` carries
  concrete local `SkillId`s selected through the normal selection
  layers. It does not carry built-in flow skill slots, bound slot names,
  loaded skill paths, hashes, or instruction bodies. Slot resolution and
  loaded-skill evidence are sibling relay-time products, recorded through
  `skills.loaded` trace entries rather than by widening
  `ResolvedSelection`.

- **SEL-I6 — `SelectionResolution.applied` is strictly ordered by
  `SELECTION_PRECEDENCE` at the *category* level.** Entries appear in
  the order their source categories appear in `SELECTION_PRECEDENCE`
  (index-increasing). A `flow` entry cannot precede a `user-global`
  entry; a `step` entry cannot precede a `stage` entry. Within the
  `stage` and `step` categories, multiple entries (distinct by
  `stage_id` / `step_id`) are legal and must appear contiguously — a
  `stage` entry followed by a `step` entry followed by a second `stage`
  entry is rejected. Reading `applied` top-down is the audit trail:
  each subsequent entry overrides or refines the prior. Enforced in
  `src/schemas/selection-policy.ts` via `SelectionResolution.superRefine`
  using the frozen `SELECTION_PRECEDENCE` index.

- **SEL-I7 — Each *identity* contributes at most once; no ghost
  provenance.** `applied[]` is a discriminated union on `source`. The
  `stage` and `step` variants carry a required disambiguator
  (`stage_id: StageId`, `step_id: StepId`); the five singleton-
  identified variants (`default`, `user-global`, `project`, `flow`,
  `invocation`) do not. Uniqueness is keyed on *identity*: source alone
  for the singletons, `(source, disambiguator)` for stage/step. Two
  distinct stage entries with different `stage_id`s are therefore legal
  (closes Codex HIGH #1 + HIGH #2 — the category-only-provenance
  attack and the overlapping-stages-cannot-be-represented attack).
  **Ghost-provenance rejection (closes Codex MED #7).** An applied
  entry whose override is *empty* (no model/effort/depth, skills at
  `{mode: 'inherit'}`, empty `invocation_options`) contributes nothing
  to the resolved record; admitting it fabricates provenance for a
  non-contributing layer. v0.1 rejects such entries at the schema layer
  via `SelectionResolution.superRefine`'s `overrideContributes` check.
  Enforced at `src/schemas/selection-policy.ts`.

- **SEL-I8 — Transitive strict surplus-key rejection.** `.strict()` is
  applied on every schema in the selection triplet: `ProviderScopedModel`,
  `SkillOverride` (all four variants), `SelectionOverride`,
  `ResolvedSelection`, `SelectionResolution`, and every
  `SelectionResolution.applied[]` entry object. Already landed
  transitively under RUN-I8 for the TraceEntry/Snapshot surface; restated
  here as the owning invariant of `src/schemas/selection-policy.ts` so
  any future schema added to this file inherits the discipline. Surplus
  keys are **rejected**, not stripped — a silent strip leaves the
  effective selection at the prior layer's default and the author's
  intent never reaches the runtime. Enforced at
  `src/schemas/selection-policy.ts`.

- **SEL-I9 — `Stage.selection` is present and symmetric with
  `Step.selection` / `CompiledFlow.default_selection` (closes stage.md v0.1
  Codex MED #7).** `Stage` carries an optional `selection:
  SelectionOverride` field. When present, it contributes to the applied
  chain under `source: 'stage'`. **Rationale for this design over the
  derived-from-canonical alternative.** Two options were weighed:
  (a) add `Stage.selection: SelectionOverride.optional()` (explicit,
  symmetric with Step and CompiledFlow); (b) derive stage-level selection
  from `CompiledFlow.default_selection` conditioned on `Stage.canonical`
  (indirect, avoids one field but requires a second precedence
  mechanism to encode the conditioning). Option (a) wins because it
  (1) is symmetric with `Step.selection` and `CompiledFlow.default_selection`,
  (2) keeps selection co-located with the Stage in YAML, (3) makes
  provenance auditability trivial (an `applied` entry with `source:
  'stage'` points at a single concrete field), and (4) is strictly more
  general than (b) — a canonical-conditional design can be added as a
  separate `CompiledFlow.selection_by_canonical?: Record<CanonicalStage,
  SelectionOverride>` field in v0.2 without disrupting option (a). Not
  doing (b) now is not a gap. Enforced at `src/schemas/stage.ts`;
  `Stage.safeParse({..., selection: {...}})` succeeds; `Stage.safeParse({..., selectoin: {...}})` (typo) fails under stage-I2 `.strict()`.

## Power dial materialization (post-stack)

The **Power** dial (`src/schemas/power.ts`, `low | medium | high`) is an
operator-facing sibling of Depth: how much model per unit of work. It is NOT
an eighth selection layer. The layered stack resolves first; then
`materializePowerSelection` (`src/selection/power-tiers.ts`) fills ONLY the
fields the stack left unset, at relay-guidance time
(`src/runtime/run/relay-guidance.ts`), before connector compatibility checks.

Rules, in order:

1. **Explicit model wins outright.** If the resolved stack carries a `model`,
   materialization returns it unchanged and records no `power` provenance.
   An explicitly configured `effort` likewise survives; the tier may only
   fill an unset effort.
2. **Dial resolution is layered and default-on.** The dial reads
   `Config.defaults.power` across config layers in the declared precedence
   (`default` → `user-global` → `project` → `invocation`); the highest-
   precedence opinion wins. When no layer has an opinion the dial is
   `medium`. The CLI flag `--power <auto|low|medium|high>` enters as the
   invocation layer. There is no off position.
   The dial *setting* (`PowerDialSetting`) is wider than the dial *value*
   (`Power`): a winning `auto` opinion defers the value to in-run inference
   (rule 2a); the allocation tables in rules 3–5 only ever see a concrete
   tier.

2a. **Auto resolves once, in-run, from the researcher.** When the winning
   setting is `auto`, the run's tier comes from the first accepted
   researcher report carrying a `recommended_power {value, rationale}`
   (the researcher is told to include it via a prompt notice; the engine
   never makes an extra model call — the researcher is already on the top
   tier at every dial position, so there is no circularity). The
   recommendation is clamped to the operator's `Config.power_auto
   {floor, ceiling}` bounds (per-field layered composition; a cross-layer
   inverted range resolves ceiling-wins because the ceiling is the spend
   cap), recorded durably as a `run.power-inference` trace entry, and held
   in a run-scoped first-write-wins channel that checkpoint resume reseeds
   from the trace. Before the inference lands — including the researcher's
   own relay — and on runs whose researcher never recommends,
   materialization uses the default-on `medium`. Resolution is
   best-effort: any failure leaves the medium fallback, never breaks the
   run.
3. **Dial × role → tier.** Allocation keeps judgment expensive and tunes
   execution: `high` = all roles high; `medium` = researcher high,
   implementer/reviewer medium; `low` = researcher high, implementer low,
   reviewer medium. The researcher never leaves the top tier.
4. **Tier × connector → spec.** `DEFAULT_POWER_TIERS` ships release-reviewed
   data: `claude-code` tiers by durable Anthropic aliases
   (haiku/sonnet/opus), `codex` tiers by reasoning effort only. A
   `power_tiers.<connector>` config entry overrides per tier per connector;
   connectors with no entry anywhere (cursor-agent, custom) leave the
   selection untouched — the dial is inert there.
5. **Escalation is monotonic and capped.** Attempt > 1 on the same
   (step, slice) work unit runs one tier up, never down, never past `high`,
   and stamps `power_escalated: true`.
6. **Provenance.** A materialized selection carries `power` (the dial) and,
   when rule 5 fired, `power_escalated` on `ResolvedSelection`; both flow
   into `relay.started` trace entries and the end-of-run receipt
   (`OperatorRunReceipt.power` / `.escalations`). A selection materialized
   under an `auto` setting additionally carries `power_source: 'auto'`, and
   the receipt reports the run's resolved inference (with
   `power_recommended` / `power_rationale` / `power_clamped`) rather than
   the first relay's pre-inference fallback.

## Pre-conditions

- A `SelectionOverride` is produced by parsing a layer's authored YAML /
  TOML / JSON into an object and passing it to `SelectionOverride.safeParse`.
- A `ResolvedSelection` is produced by the shared resolver
  (`src/selection/selection-resolver.ts`, Slice 85) folding an ordered
  sequence of overrides under the documented resolution semantics
  (`selection.prop.skill_override_composition_total`,
  `selection.prop.invocation_options_merge_is_right_biased`).
- A `SelectionResolution` is produced by pairing a `ResolvedSelection`
  with the ordered `applied` trace the resolver emitted during folding.
- Every `SkillId` in a `SkillOverride.skills[]` array or a
  `ResolvedSelection.skills[]` array is an explicit concrete local skill
  selection. It must resolve in the user skill registry before the relay
  connector is invoked for the selected step. Slot-bound skills are also
  explicit user config and must resolve when the matching slot is bound.
  Unbound slots are ignored.

## Post-conditions

After a `SelectionOverride` is accepted:

- The override shape is one of the 32 combinations of
  `{model?, effort?, skills?, depth?, invocation_options?}` × `{4
  SkillOverride variants}` (SEL-I2, SEL-I3).
- `invocation_options` is always present as an object (default `{}`),
  never absent, so downstream merge logic is total.
- Every value inside `invocation_options` is JSON-safe (SEL-I2 via
  `JsonObject`).

After a `SelectionResolution` is accepted:

- `applied` is category-ordered by `SELECTION_PRECEDENCE` (SEL-I6).
- Each identity — singleton source, or `(source, stage_id|step_id)` —
  appears at most once in `applied` (SEL-I7).
- Every `applied[i].override` contributes something (SEL-I7 ghost-
  provenance rule).
- `resolved.skills` is a unique flat `SkillId[]` (SEL-I3 / SEL-I5).
- Skill slots and loaded-skill evidence are not part of
  `resolved.skills`; they are resolved at relay time from
  `Step.skill_slots` plus config bindings.
- `resolved.invocation_options` is a JSON-safe merged object.
- **No post-condition binds `resolved` to `applied` at v0.1.** The
  claim that `resolved`'s fields derive from `applied` is a Stage 2
  property (`selection.prop.resolved_matches_applied_composition`), not
  a schema-enforced post-condition. Closes Codex HIGH #3 honestly
  rather than over-claiming.

## Property ids (Stage 2 runtime/property coverage)

These are the invariants that govern the *composition semantics* of
override chains — things the single-pass `SelectionResolution.superRefine`
cannot enforce without introducing full resolver semantics into the
schema layer. Slice 85 lands focused contract coverage for the runtime
resolver used by relay; broader generated property coverage remains a
Stage 2 harness task where noted below.

- `selection.prop.precedence_const_parity` — For every `SelectionSource`
  enum value, there is exactly one entry in `SELECTION_PRECEDENCE`, and
  their relative order is the documented 7-tuple. SEL-I1 gives a
  compile-time guard; this property provides a runtime guard once the
  property harness exists (defense in depth; also catches drift between
  the docs and the code).

- `selection.prop.resolved_matches_applied_composition` — For any valid
  `SelectionResolution`, re-folding `applied[]` under the documented
  resolution semantics produces a `ResolvedSelection` bit-equal to
  `resolved`. This is the "projection is a function" analog of RUN-I7
  for selection: `resolved` is a cache; `applied` is the truth. A
  resolver that emits a resolved record inconsistent with its own
  applied trace is broken, and the property catches it. The
  schema-level binding (would-be SEL-I8-equivalent) is deferred to
  Stage 2 because re-running the composition inside a single
  `superRefine` pass entangles schema with resolver logic in a way
  Circuit has elsewhere refused (see run.md's `run.prop.
  deterministic_replay` scope caveat).

- `selection.prop.skill_override_composition_total` — For any sequence
  of `SkillOverride` values drawn from `applied[]`, composing them
  under the documented set algebra (`inherit`: no-op; `replace`: set
  to skills; `append`: set union; `remove`: set difference) produces
  a well-defined `SkillId[]` with no undefined intermediate state. The
  fold is total regardless of input. (Closes the "empty-array-means-
  inherit" ambiguity at the semantic layer; SEL-I3 closed it at the
  syntactic layer.)

- `selection.prop.invocation_options_merge_is_right_biased` — Given
  multiple layers contributing `invocation_options` maps, the merged
  record is right-biased by precedence: the later (higher-precedence)
  layer wins on any conflicting key. No accidental deep-merge; no
  silent key collision. The property fuzzes over adversarial key
  overlap patterns to catch merge-logic regressions.

- `selection.prop.stage_source_only_when_stage_declared_selection` — An
  `applied[]` entry with `source: 'stage'` requires the CompiledFlow's
  named Stage to carry a non-empty `Stage.selection` field. A `stage`
  source without a corresponding stage-level declaration is either a
  resolver bug or a smuggled entry. This is a cross-schema semantic
  check (selection × flow) and belongs at Stage 2, not the
  single-schema layer.

- `selection.prop.override_empty_roundtrip` — For any
  `SelectionOverride` equal to `{skills: {mode: 'inherit'},
  invocation_options: {}}` (the canonical "contributes nothing"
  shape), folding it into any prior `ResolvedSelection` yields a
  bit-equal output. Identity under the resolver fold. (Enforced at
  SEL-I7 that such overrides never reach `applied[]`; the property
  guards resolver identity for any fold outside the chain.)

- `selection.prop.overlapping_stage_composition_well_defined` —
  Added to close Codex HIGH #2 at the composition layer. For any
  CompiledFlow where a step belongs to multiple stages each carrying
  `selection`, the composition of those stage overrides is deterministic
  and independent of applied-chain order permutation within the `stage`
  category (which SEL-I6 permits). The property fuzzes stage-
  composition orderings and checks bit-equality of the resulting
  `ResolvedSelection`.

- `selection.prop.config_layer_precompose_is_right_biased` — Added to
  close Codex HIGH #6. Within a single config layer,
  `defaults.selection` and `circuits[flow_id].selection` pre-compose
  right-biased by specificity (circuit-specific overrides defaults) to
  produce the single merged override contributed to the applied chain.
  The property fuzzes adversarial key-overlap and checks the merge
  matches the documented rule.

- `selection.prop.resolved_skills_are_unique_and_order_is_documented`
  — Added to close Codex MED #8. SEL-I3 enforces uniqueness within an
  individual `SkillOverride`; this property extends the guarantee to
  the composed `ResolvedSelection.skills` and checks that the resolver
  emits a documented canonical order (insertion or lexicographic — to
  be decided in v0.2).

## Cross-contract dependencies

- **stage** (`src/schemas/stage.ts`) — `Stage.selection:
  SelectionOverride.optional()` (SEL-I9). Cross-references
  [docs/contracts/stage.md](stage.md); the `Stage` schema now imports
  `SelectionOverride` and extends `StageBody` with the optional
  `selection` field. stage-I2 `.strict()` still governs surplus-key
  rejection; adding `selection` as a declared field expands what's
  allowed, not what's stripped.

- **step** (`src/schemas/step.ts`) — `StepBase.selection:
  SelectionOverride.optional()` is already declared on `StepBase`.
  Step-level contributions enter `applied[]` under `source: 'step'`.

- **flow** (`src/schemas/compiled-flow.ts`) —
  `CompiledFlow.default_selection: SelectionOverride.optional()` is declared.
  CompiledFlow-level contributions enter `applied[]` under `source:
  'flow'`. Not renamed to `CompiledFlow.selection` because
  `default_selection` signals "this is the baseline for all stages/steps
  unless overridden" more clearly than `selection` would.
  **Codex HIGH #5 fold-in:** the removed
  `CompiledFlow.default_skills: SkillId[]` channel is removed. Seed skill
  sets now flow through `default_selection.skills = {mode: 'replace',
  skills: [...]}`.

- **config** (`src/schemas/config.ts`) — `Config.defaults.selection:
  SelectionOverride.optional()` and `CircuitOverride.selection:
  SelectionOverride.optional()`. The `Config` file layers (default,
  user-global, project, invocation) map onto four of
  `SELECTION_PRECEDENCE`; the middle three (flow, stage, step) are
  in the flow schema. **Intra-layer pre-compose (SEL-I1 scope
  caveat).** Within one config layer, `defaults.selection` and
  `circuits[flow_id].selection` pre-compose defaults-first /
  circuit-specific-second BEFORE entering the applied chain. **Codex HIGH #5
  fold-in:** the removed `CircuitOverride.skills: string[]` channel is
  removed (it accepted arbitrary non-`SkillId` strings); per-circuit
  skill contribution flows through `CircuitOverride.selection.skills`
  via typed `SkillOverride`. Config reorganization is out of scope for
  this contract; see [docs/contracts/config.md](config.md) for layer
  materialization.
  `Config.skills.bindings` and `CircuitOverride.skill_bindings` are
  separate from `SelectionOverride.skills`: they bind optional flow
  slots to concrete local skills without adding slot ids to
  `ResolvedSelection.skills`.

- **trace_entry** (`src/schemas/trace-entry.ts`) — `RelayStartedTraceEntry`
  carries `resolved_selection: ResolvedSelection`, which is the
  effective record the runner records at relay time and exposes to
  injected relayers. Codex HIGH #4 fold-in:
  `resolved_selection.invocation_options` now carries
  the merged invocation_options so the trace_entry is audit-sufficient even
  when connectors consume those options. The full provenance trace
  (`applied`) still lives in `SelectionResolution` at resolution time;
  Slice 85's resolver feeds the trace_entry with the `resolved` projection.
  Promoting the trace_entry to carry the full `SelectionResolution` remains a
  v0.2 consideration driven by real audit needs.
  Loaded local skill evidence is recorded in sibling `skills.loaded`
  trace entries carrying `{id, slot?, path, sha256, bytes}` per loaded
  skill; `ResolvedSelection` stays focused on the effective selection
  cache.

- **skill** (`src/schemas/skill.ts`) — `SkillId` is the id space for
  `SkillOverride.skills[]` and `ResolvedSelection.skills[]`.
  `SkillSlotId` is a separate id space for optional built-in flow slot
  bindings. Skill existence closure is a runtime concern, not a schema
  concern.

- **depth** (`src/schemas/depth.ts`) — `SelectionOverride.depth` and
  `ResolvedSelection.depth` use the `CompiledDepth` enum (`low`, `medium`,
  `high`, `tournament`, `autonomous`). A `depth` contribution at the
  step layer overrides the flow's entry-mode depth at relay
  time; the precedence rule is SEL-I1.

- **ids** (`src/schemas/ids.ts`) — `SkillId` branded slug.

## Failure modes (carried from evidence)

- `carry-forward:selection-precedence-implicit` — Prior Circuit
  conflated config layers (default, user-global, project, invocation)
  with flow/stage/step-authored defaults. Precedence was folklore,
  not a typed constant. Closed by SEL-I1: the 7-tuple is compile-time
  pinned, and every `applied` record asserts ordering by construction.

- `carry-forward:skill-override-ambiguity` — Prior Circuit used empty
  array to mean "inherit", ambiguous with "replace-with-nothing". A
  YAML typo that stripped the skills list and a deliberate author
  choice to clear the set were indistinguishable. Closed by SEL-I3: the
  four modes make every operation typed; empty arrays under non-
  `inherit` modes are legal but mean what they say.

- `carry-forward:marketing-name-enum-drift` — Prior Circuit enumerated
  model names like `claude-opus-4.1`, `gpt-5`, `gpt-5.4`, which rot as
  providers ship new models, forcing coordinated schema + connector edits
  on every release. Closed by SEL-I4: `ProviderScopedModel.model` is an
  open string; connector-specific validation/honoring is owned by connector
  runtime work rather than this schema. Adversarial-review HIGH objection
  (Codex, Tier 0) is the ancestor.

- `carry-forward:applied-provenance-unaudited` — Prior Circuit resolved
  selection without emitting a provenance trace; a debugger reading
  `RelayStartedTraceEntry` couldn't tell *why* a step ran under a
  specific model (which config file? which flow YAML? which CLI
  flag?). Closed by the triplet `SelectionResolution { resolved,
  applied }` + SEL-I6/I7: `applied` is totally ordered and
  non-redundant, and the chain is a read-top-down audit trail.

- `carry-forward:nested-surplus-key-silent-strip` — Prior to the
  run.md v0.1 slice, `.strict()` was applied only at the top level of
  `TraceEntry`/`Snapshot`. A surplus key inside `ResolvedSelection.model` or
  `SelectionOverride.skills` was silently stripped, which masked
  authorial typos. Closed by SEL-I8 (which continues the transitive-
  strict discipline RUN-I8 landed across the trace_entry/snapshot surface).

- `carry-forward:removed-skill-channels` — Two pre-contract channels
  (`CompiledFlow.default_skills: SkillId[]` and `CircuitOverride.skills:
  string[]`) bypassed the typed `SkillOverride` discipline. The config
  channel was worse — it accepted arbitrary strings, not `SkillId`-
  validated values. Closed in v0.1 by removing both channels (Codex
  HIGH #5 fold-in). Seed skill sets flow through
  `default_selection.skills = {mode: 'replace', skills: [...]}`;
  per-circuit skills flow through `CircuitOverride.selection.skills`.

- `carry-forward:skill-slot-selection-confusion` — Slot ids are not
  concrete local `SkillId`s. Closed by keeping slots out of
  `ResolvedSelection.skills`: concrete direct selection stays in
  `SelectionOverride.skills`, while slot binding is resolved beside the
  selection cache at relay time.

- `carry-forward:invocation-options-non-json` — `z.record(z.unknown())`
  admitted functions, Dates, `undefined`, `NaN`, and `Infinity` — all
  non-JSON-serializable values that would break trace_entry-log replay and
  YAML/TOML round-trip. Closed by SEL-I2's `JsonObject` refinement
  (Codex MED #10 fold-in).

- `carry-forward:category-only-provenance` — A `source: 'stage'` or
  `source: 'step'` entry in the applied chain did not identify WHICH
  stage/step contributed. Closed by SEL-I7's discriminated-union
  applied entries with required `stage_id`/`step_id` disambiguators
  (Codex HIGH #1 fold-in).

- `carry-forward:ghost-provenance` — An applied entry with an empty
  override fabricated provenance for a non-contributing layer. Closed
  by SEL-I7's `overrideContributes` check (Codex MED #7 fold-in).

## Evolution

- **v0.1** — SEL-I1..I9 enforced at the schema layer.
  **Codex adversarial property-auditor pass 2026-04-19** produced
  opening verdict REJECT with 6 HIGH + 5 MED + 1 LOW. All 6 HIGH and
  4 of 5 MED folded in directly before commit; MED #9 (scalar
  tombstone semantics) scoped to v0.2 with rationale.

  Schema-level landings: `SELECTION_PRECEDENCE` 7-tuple + compile-time
  enum parity (`as const satisfies`); `SelectionOverride.strict()`
  with every field optional and JSON-safe `invocation_options`;
  `SkillOverride` 4-variant discriminated union with per-variant
  `.strict()` and unique-skills refinement; `ProviderScopedModel`
  4-provider enum × open model string; `ResolvedSelection.strict()`
  carrying `invocation_options` (the HIGH #4 flip from v0.1 drafting);
  discriminated-union `applied[]` entries with required
  `stage_id`/`step_id` on stage/step variants (HIGH #1, #2);
  `SelectionResolution.superRefine` that enforces category-level
  precedence (SEL-I6), identity-keyed uniqueness (SEL-I7), and ghost-
  provenance rejection (MED #7); transitive strict rejection across
  the entire selection triplet (SEL-I8); `Stage.selection:
  SelectionOverride.optional()` added to close stage.md v0.1 MED #7
  (SEL-I9); `CompiledFlow.default_skills` and
  `CircuitOverride.skills` channels removed (HIGH #5); support
  `SelectionPolicy` alias removed. Stage 2 property ids added for the
  honestly-scoped gaps: `resolved_matches_applied_composition` (HIGH
  #3), `config_layer_precompose_is_right_biased` (HIGH #6),
  `overlapping_stage_composition_well_defined` (HIGH #2 composition
  layer), `resolved_skills_are_unique_and_order_is_documented` (MED
  #8 composition layer).

- **v0.2 (Stage 1)** — Ratify `property_ids` above by landing the
  corresponding property-test harness at
  `tests/properties/visible/selection/`. <!-- path-ok --> **Decide scalar tombstone
  semantics (Codex MED #9 deferral).** Currently there is no way for a
  higher layer to clear a lower layer's `model`/`effort`/`depth` back
  to connector/default behavior (skills have `{mode: 'replace', skills:
  []}` as the clear operation; scalars do not). Adding a tombstone
  sentinel (`null`, `{reset: true}`, or an explicit `effort: 'inherit'`
  literal) is a material design change; v0.2 will decide driven by
  evidence from real flows. Decide whether
  `RelayStartedTraceEntry.resolved_selection` should be promoted to
  `RelayStartedTraceEntry.selection_resolution: SelectionResolution` for
  full in-trace_entry provenance. Consider whether
  `CompiledFlow.selection_by_canonical?: Record<CanonicalStage,
  SelectionOverride>` is warranted (the derive-from-canonical
  alternative weighed against in SEL-I9); only adopt if real flows
  demonstrate the pattern.

- **v0.3 (user skill loading slice)** — clarifies that
  `ResolvedSelection.skills` contains only concrete local `SkillId`s
  selected through selection layers. Optional skill slots are resolved
  from step schema plus config bindings, and loaded-skill evidence is
  emitted as `skills.loaded` trace entries instead of widening
  `ResolvedSelection`.

- **v0.4 (Power dial slice, 2026-06-10)** — adds post-stack Power dial
  materialization (see the section above): `ResolvedSelection` gains optional
  `power` and `power_escalated` provenance fields; `Config` gains
  `defaults.power` and `power_tiers`; the dial is default-on at `medium`
  (BREAKING vs the pre-flip behavior where an unset dial left empty model
  seats empty). Explicit selection config always wins; the dial fills, never
  overrides.

- **v0.5 (Auto power slice, 2026-06-11)** — widens the dial *setting* to
  `auto|low|medium|high` (`PowerDialSetting`; the `Power` value enum the
  allocation tables consume stays three-tier). `auto` resolves once per run
  from the first accepted researcher `recommended_power`, clamped to the new
  `Config.power_auto {floor, ceiling}` bounds, recorded as a
  `run.power-inference` trace entry, reseeded on resume. `ResolvedSelection`
  gains optional `power_source: 'auto'`; the receipt gains
  `power_source`/`power_recommended`/`power_rationale`/`power_clamped`.
  Depth stays manual by design: depth selects the compiled flow shape before
  any model runs, so inferring it would need a pre-run model call.

- **v1.0 (Stage 2)** — Ratified invariants + property tests + resolver
  implementation with `selection.prop.*` as acceptance check +
  operator-facing error-message catalog. The `selection.prop.*`
  properties above become the acceptance check for any resolver
  implementation.

---
contract: flow
status: draft
version: 0.6
schema_source: src/schemas/compiled-flow.ts
last_updated: 2026-06-10
depends_on: [step, stage, axes, rigor, change_kind, selection-policy, skill, acceptance-criteria]
report_ids:
  - flow.definition
  - flow.scalar_catalog
  - flow.schematic_definition
invariant_ids: [WF-I1, WF-I2, WF-I3, WF-I4, WF-I5, WF-I6, WF-I7, WF-I8, WF-I9, WF-I10, WF-I11, WF-I12]
property_ids: [flow.prop.start_reachability, flow.prop.no_dead_steps, flow.prop.stage_step_closure, flow.prop.route_target_closure, flow.prop.terminal_target_coverage]
---

# CompiledFlow Contract

A **CompiledFlow** is a typed, versioned definition of a multi-step automation.
It compiles to a stable execution graph the runtime can replay from trace_entries.

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#core-flow-language](../../UBIQUITOUS_LANGUAGE.md#core-flow-language)
for canonical term definitions.

## Invariants

The runtime MUST reject any CompiledFlow that violates these. All invariants
are enforced by the `CompiledFlow` Zod schema — some as literal fields on
`CompiledFlowBody` (e.g. WF-I7's `schema_version` literal), the remainder
inside `CompiledFlow.superRefine` — and tested in
`tests/contracts/flow-graph-schema.test.ts`,
`tests/contracts/flow-schematic.test.ts`, and related runtime projection tests.

- **WF-I1 — Unique step ids.** No two steps in `CompiledFlow.steps` share an `id`.
- **WF-I2 — Closed start reference.** `starts_at` must be the `id` of an
  existing step.
- **WF-I3 — Closed stage references.** Every `StepId` in `Stage.steps` must
  be the `id` of an existing step.
- **WF-I4 — Closed route targets.** Every route target in `Step.routes`
  must be either a terminal label (`@complete`, `@stop`, `@escalate`,
  `@handoff`) or the `id` of an existing step.
- **WF-I5 — No `entry_modes` array.** `CompiledFlow` declares `axes` plus
  `starts_at`; an `entry_modes` array is rejected by the strict schema.
- **WF-I6 — Unique stage ids.** No two `Stage`s share an `id`.
- **WF-I7 — Schema version is 3.** The literal `schema_version: '3'` is
  required. Older manifests are not accepted; there is no migration
  layer. Regenerate or recreate the artifact. Bump rules live in
  [docs/contracts/schema-versioning.md](schema-versioning.md).
- **WF-I8 — Terminal reachability.** For every step in `CompiledFlow.steps`,
  at least one chain of `routes` starting at that step eventually reaches
  a terminal route target (`@complete`, `@stop`, `@escalate`, `@handoff`).
  A flow that contains a step unable to reach any terminal is rejected
  at parse time. In particular, the `starts_at` step reaches a
  terminal, so a bootstrapped Run is always capable of closing. Without
  this invariant, a plugin-authored flow fixture could bootstrap a Run
  but never emit `run.closed`, producing a hung run state.
- **WF-I9 — No dead steps.** For every step in `CompiledFlow.steps`, there is
  at least one chain of `routes` from `starts_at` that reaches that step.
  A flow that declares a step unreachable from the start step is rejected
  at parse time. Unreachable steps are a silent
  declaration bug (the author believes the step will execute but it
  never will), not a feature; WF-I9 fails the fixture fast rather than
  letting it pass and then puzzling the operator.
- **WF-I10 — Pass-route presence.** Every step's `routes` map must
  contain the runtime success key `pass`. The `CheckEvaluatedTraceEntry.outcome` field in
  `src/schemas/trace-entry.ts` is `z.enum(['pass', 'fail'])` — uniform across
  all current check kinds (`schema_sections`, `checkpoint_selection`,
  `result_verdict`, `fanout_aggregate`, `acceptance_criteria`) — so the
  runtime's route pick on a successful check outcome looks up
  `routes['pass']`. A fixture whose routes use
  author-friendly aliases like `{ success: '@complete' }` would satisfy
  WF-I8 (the edge labelled `success` reaches a terminal) and still
  stall at runtime because `routes['pass']` is undefined. WF-I10 is
  the parse-time version of that binding. `fail`-route presence is
  **deferred** to v0.3 / Stage 2 — failure-path handling is not part of
  the narrow runtime-proof proof and the runtime abort-vs-stall
  behaviour on a missing `fail` route is not yet specified.
  Schematics may use the authored success aliases `continue` or
  `complete`; the compiler maps exactly one of those aliases to `pass`
  through `src/schemas/route-policy.ts`.
- **WF-I11 — Pass-route terminal reachability.** For every step in
  `CompiledFlow.steps`, following only `routes.pass` must eventually reach a
  terminal route target (`@complete`, `@stop`, `@escalate`, `@handoff`).
  WF-I8 remains the broad graph sanity check: a step must have at least
  one route chain to a terminal. WF-I11 is the runtime-liveness binding:
  the current runner follows only successful `pass` routes after checks
  pass, so a flow where `routes.pass` cycles while `routes.fail`
  points to `@complete` is rejected at parse time instead of hanging a
  run.
- **WF-I12 — Public built-in flows do not name concrete local skills.**
  Built-in public flow schematics must not ship concrete operator-local
  skill ids in `default_selection.skills` or step `selection.skills`.
  If a built-in wants to invite local skill use, it exposes optional
  step-level `skill_slots`; users bind those slots in config. User-authored
  flows may still use concrete `selection.skills` ids because they are
  not portable public defaults.

## Pre-conditions

- CompiledFlow YAML (or equivalent JSON) must parse under `CompiledFlow.safeParse`.
- Any concrete `SkillId` in `default_selection.skills` or step
  `selection.skills` resolves at relay time against the user skill
  registry when that relay executes. Built-in public flows must not use
  concrete local skill ids; they use optional step `skill_slots` instead.

## Post-conditions

After a CompiledFlow is accepted:

- The CompiledFlow's `id` is globally unique within the plugin's catalog.
- The CompiledFlow's `version` is monotonically increasing within its `id`
  (enforced by catalog compiler, not by schema).
- The CompiledFlow's step graph is closed under `WF-I1..4`.
- Any step-level `skill_slots` are typed `SkillSlot`s and remain optional
  until config binds them.
- Any relay-step `acceptance_criteria` remain inline, deterministic, and
  serializable in the compiled manifest snapshot.
- The CompiledFlow is serializable to the run-folder manifest snapshot.

## Property ids (reserved for Stage 2 testing)

Property-based tests will cover:

- `flow.prop.route_target_closure` — For any valid CompiledFlow, all route
  targets resolve.
- `flow.prop.stage_step_closure` — For any valid CompiledFlow, all stage
  step references resolve.
- `flow.prop.start_reachability` — `starts_at` names an existing step, and
  that step is reachable by at least one sequence of routes leading to a
  terminal target.
- `flow.prop.no_dead_steps` — Every step is reachable from `starts_at`.
  (Note: now also enforced structurally at parse time
  as **WF-I9**; this property id remains reserved for Slice 29's
  property-harness fast-check generation around the same semantics.
  The earlier "modulo `disposable`-change_kind flows" carveout is
  **removed in v0.2** — WF-I9 is unconditional, and the v0.1
  disposable-change_kind exception was never reflected in the schema.)
- `flow.prop.terminal_target_coverage` — Every step's routes either
  include a terminal target or every route target is itself a step whose
  routes eventually include one.
  **Scope note:** this is the broad WF-I8 property. Pass-route-only
  terminal reachability is a separate parse-time invariant, WF-I11,
  because runtime success flow follows only `routes.pass`.

## Cross-contract dependencies

- **step**: CompiledFlow embeds `Step[]`. Step variant invariants (WF-depends-
  on-Step) are in [docs/contracts/step.md](step.md).
- **stage**: CompiledFlow embeds `Stage[]`. Stage invariants in
  [docs/contracts/stage.md](stage.md) (ratified v0.1; stage-I1..I5 +
  stage_path_policy enforcement).
- **axes / rigor**: `axes` declares the allowed rigor, tournament, and
  autonomous support for this flow.
- **change_kind**: `EntryMode.default_change_kind` is optional; when present, must be
  a valid `ChangeKind` literal.
- **selection-policy**: `CompiledFlow.default_selection` is a
  `SelectionOverride` and obeys selection precedence (see
  [docs/contracts/selection.md](selection.md)).
- **skill**: `Step.skill_slots` uses `SkillSlot[]`. Concrete
  `SelectionOverride.skills` ids are runtime-resolved local skills;
  optional slots are config-bound local skills.
- **acceptance-criteria**: Relay `Step.acceptance_criteria` uses the
  deterministic V1 criteria schema and remains an optional additive compiled
  flow field.

## Failure modes (carried from evidence)

- `carry-forward:verdict-enum-bloat` — Existing Circuit uses per-protocol
  verdict conditionals. Circuit's Step discriminated union constrains
  verdicts per step kind, not per protocol.
- `carry-forward:prose-schema-drift` — Existing Circuit's SKILL.md can
  silently disagree with `circuit.yaml`. Circuit prevents this by
  generating host-facing flow surfaces from flow package sources.
- `carry-forward:stage path-policy-too-loose` — **Closed in stage.md v0.1.**
  `CompiledFlow.stage_path_policy` is a required discriminated union with two
  modes: `strict` (all seven canonical stages required) and `partial`
  (explicit `omits` + rationale ≥20 chars). Silent skip of `review` or
  `verify` is now rejected at parse time. See
  [docs/contracts/stage.md](stage.md) stage-I4. Adversarial-review MED #11 is
  closed.
- `carry-forward:built-in-local-skill-coupling` — **Closed in v0.4 by
  WF-I12.** Public built-in flows remain portable by exposing optional
  step `skill_slots` instead of shipping concrete local skill ids.

## Check source tightening

Adversarial-review MED objection #7 is **closed in step.md v0.1**. Check
sources are typed per check variant: `SchemaSectionsCheck.source` is
`ReportSource`, `CheckpointSelectionCheck.source` is
`CheckpointResponseSource`, `ResultVerdictCheck.source` is
`RelayResultSource`. The `Step` discriminated union validates
`check.source.ref` against the step variant's `writes` slots via
`superRefine`. See [docs/contracts/step.md](step.md) invariants STEP-I3 and
STEP-I4.

## Evolution

- **v0.1 (skeleton)**: initial contract with graph-closure invariants
  WF-I1..I7.
- **v0.2 (Stage 1, Slice 27)**: narrowed to what
  `runtime-proof` (Stage 1.5 Alpha Proof) structurally needs beyond the
  skeleton. Adds **WF-I8** (terminal reachability) and **WF-I9** (no
  dead steps) — both promoted from `flow.prop.*` reserved properties
  into parse-time invariants enforced by `CompiledFlow.superRefine`. Adds
  **WF-I10** (pass-route presence) as a Codex challenger HIGH #1
  fold-in — binds every step's `routes` map to the
  `CheckEvaluatedTraceEntry.outcome` enum at the parse layer so a fixture
  using author-friendly route aliases like `{ success: '@complete' }`
  cannot pass WF-I8 and then stall at runtime. Rationale for promoting
  graph semantics to parse-time invariants rather than property tests:
  preferring types over tests where the type can express the invariant.
- **v0.3 (Runtime Safety Floor Slice 4)**: adds
  **WF-I11** (pass-route terminal reachability) after runtime evidence
  showed WF-I8's broad
  graph rule was not enough for liveness. A flow can satisfy WF-I8 by
  routing `fail` to `@complete` while `pass` loops forever; because the
  current runner follows `routes.pass` after successful checks, WF-I11
  follows only pass edges and rejects self-cycles and multi-step
  pass-cycles at parse time. Check source tightening
  (v0.1 adversarial MED #7) **closed in step.md v0.1** — see the "Check
  source tightening" section above. stage path policy (v0.1 adversarial
  MED #11) **closed in stage.md v0.1** — `CompiledFlow.stage_path_policy` is a
  required discriminated union enforced in `CompiledFlow.superRefine`. See
  [docs/contracts/stage.md](stage.md) stage-I4. **Deferred to v0.3 / Stage 2:**
  (a) ratified property-test harness registration for the five reserved
  `flow.prop.*` ids (Slice 29 property registry scaffold);
  (b) `fail`-route presence — not part of the narrow runtime-proof
  proof and runtime failure-path behaviour is not yet specified;
  (c) exact-one-stage step membership (v0.1 bootstrap adversarial
  HIGH #1 subfinding, not closed in this slice — `Stage.steps` closure
  is enforced, but "every `CompiledFlow.steps[]` id appears in exactly one
  stage" is left for Stage 2 per [docs/contracts/stage.md](stage.md) §Evolution
  and will be revisited when manifest compilation starts consuming
  `Stage.steps` as an ordered execution plan).
- **v0.4 (user skill loading slice)**: adds **WF-I12** and
  step-level `skill_slots` pass-through from schematic to compiled flow.
  Public built-ins must not name concrete local skills in
  `default_selection.skills` or step `selection.skills`; user-authored
  flows may still select concrete skills directly.
- **v0.5 (per-step acceptance criteria slice)**: adds optional
  relay `acceptance_criteria` pass-through from schematic to compiled flow.
  The field is additive on `schema_version: '2'` manifests and remains
  deterministic-only in V1.
- **v0.6 (schema versioning slice, this version)**: bumps
  `schema_version` to `'3'` after the dead `entry` routing metadata was
  removed from the strict schema. The removal changed what the schema
  accepts, so the version moves with it per
  [docs/contracts/schema-versioning.md](schema-versioning.md). A
  pre-bump artifact now fails with a `schema_version` mismatch instead
  of an unrecognized-key error.
- **v1.0 (Stage 2)**: ratified invariants + property tests + operator
  documentation.

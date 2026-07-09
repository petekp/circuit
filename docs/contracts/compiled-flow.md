---
contract: flow
status: draft
version: 0.7
schema_source: src/schemas/compiled-flow.ts
last_updated: 2026-07-09
depends_on: [step, stage, axes, depth, change_kind, selection-policy, skill, acceptance-criteria, engine-flags, report-file-surface, axis-config-requirement]
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

The runtime MUST reject any CompiledFlow that violates WF-I1..WF-I11. Those
invariants are enforced by the `CompiledFlow` Zod schema — some as literal
fields on `CompiledFlowBody` (e.g. WF-I7's `schema_version` literal, WF-I5's
`.strict()`), the remainder inside `CompiledFlow.superRefine` — and tested in
`tests/contracts/flow-graph-schema.test.ts`,
`tests/contracts/flow-schematic.test.ts`, and related runtime projection tests.
WF-I12 is a catalog-level invariant: visibility (public vs user-authored) is
a catalog property the schema cannot see, so it is enforced by
`tests/contracts/catalog-completeness.test.ts` ("public built-in flows do not
name concrete local skill ids") rather than at parse time.

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
- Any `engine_flags`, `report_file_surfaces`, `runtime_surface`, and
  `required_config` are preserved verbatim into the run-folder manifest
  snapshot, so the engine reads them off the manifest without a by-id catalog
  lookup.
- The CompiledFlow is serializable to the run-folder manifest snapshot.

## Manifest-carried behavior fields

Beyond the graph, a CompiledFlow may carry four optional fields the engine reads
straight off the compiled manifest. They exist so a composed flow travels with
its own behavior instead of needing a lookup in a catalog keyed by flow id. Each
one absent means the flow declares none of that behavior. All are validated by
`CompiledFlowBody` in `src/schemas/compiled-flow.ts`.

### engine_flags

Opt-in switches the engine branches on. The shape is `EngineFlagsManifest`
(`src/schemas/engine-flags.ts`), shared with the authored schematic so a flow
declares behavior once and it travels to the manifest. The current flags:

- `binds_execution_depth_to_relay_selection` — the depth dial also picks which
  relay selection a step uses. Set by **build** and **prototype**.
- `binds_terminal_outcome_to_primary_result` — the run's terminal outcome is
  bound to the flow's primary result report, so a degraded result cannot close
  as a clean `complete`. Set by **review**, **fix**, **build**, **explainer**,
  and the internal **goal** flow (Converge).
- `iterates_slice_loop` — re-enter a `[head..tail]` span once per slice, over a
  list read from a named report, up to `max_slices`. Activates at `high` depth.
  Set by **build**.
- `iterates_until_condition` — the until loop, a while loop for flows, described
  below. Set by the internal **fix-until-green**, **sweep**, and
  **converge-proof** flows.

Both loop flags drive one re-entry counter, so the graph runner rejects a flow
that sets both.

#### The until loop (`iterates_until_condition`)

The until loop re-enters its body span once per iteration until a stop condition
or a ceiling. Its fields:

- `head_step`, `tail_step`, `body_steps` — the span to re-run. `body_steps`
  lists the whole span, head and tail included, because every step in it is
  iteration-scoped.
- `reenter_route` — the route that loops back for another iteration.
- `max_iterations` — the hard iteration ceiling.
- `stop_judge` — the tail proposes a goal-met boolean the engine disposes
  against an evidence floor. `report` + `goal_met_path` say where to read the
  proposal. `lesson_path` and `progress_path` are optional dotted paths to a
  carried lesson and an opaque progress marker.
- `needs_attention_route` — where a judge-gated loop exits when the judge is
  exhausted. It must be a non-`@complete` terminal, so an unfinished loop cannot
  masquerade as a clean close.
- `carried_notes` — a run file the engine appends one note to per iteration; the
  head re-reads it next pass. `max_entries` caps retained notes (default 20).
- `cumulative_usd_cap`, `cumulative_token_cap` — fail-closed spend ceilings
  summed across iterations from per-relay usage. At or above a cap the loop
  exits to needs-attention instead of spending more.
- `no_progress_ceiling` — how many consecutive no-progress iterations are
  tolerated before exiting to needs-attention. Requires
  `stop_judge.progress_path`.
- `iteration_commit_containment` — opt-in, default off. When set and the host
  injects a commit-containment runner, each iteration commits to a throwaway
  branch and the operator owns the merge. Absent means the engine makes no git
  calls.
- `frozen_paths` — a read-only eval surface (test files, the verify command's
  own definition, a spec). The engine fingerprints these at loop entry; if a
  body iteration changes one, it opens an honesty-ledger latch so the floor
  cannot honor that iteration's goal-met claim. This is a generic engine
  mechanism; no shipped flow sets it yet.
- `activate_when_depth_at_least` — the until loop activates only at `autonomous`
  depth.

See [docs/architecture/runtime.md](../architecture/runtime.md) for how the
stop-judge, honesty ledger, and needs-attention exit fit together at runtime.

### report_file_surfaces

A map, keyed by a report's schema name, that marks which written reports are
edit-file surfaces. Each entry has a `timing` (`before` or `after`) and an
`extractor` that names how to pull file paths out of the report: a named
string-array field, or the build-plan-and-slices file-extension reader. The
skill-hook edit-file surface table reads this. Shape: `ReportFileSurfaceMap`
(`src/schemas/report-file-surface.ts`).

### runtime_surface

The runtime binding the engine reads off the manifest. Only `primary_result`
lives here: a `schema_name` + `path` pair, derived at compile from the
close-stage compose step, that ties a terminal close to the flow's result
report. This is what `binds_terminal_outcome_to_primary_result` binds against.
The richer presentational surface (progress steps, the result label) stays
package-side and by-id. Shape: `CompiledFlowManifestRuntimeSurface`
(`src/schemas/compiled-flow.ts`).

### required_config

The CLI's up-front config gate: a non-empty list of requirements, each naming an
`axis` (`tournament` or `autonomous`), a config `path`, and an operator-facing
`message`. The CLI checks these before any worker runs, so a flow that needs
operator-provided config does not start and then stall. Today only Prototype's
tournament axis uses it, to require operator-provided variant models. Shape:
`AxisConfigRequirementList` (`src/schemas/axis-config-requirement.ts`).

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
- **axes / depth**: `axes` declares the allowed depths, tournament, and
  autonomous support for this flow.
- **change_kind**: the compiled flow itself carries no change_kind field
  (the dead `entry` metadata was removed in v0.6; see WF-I5). The
  schematic-side `FlowAxisSelection.default_change_kind`
  (`src/schemas/flow-schematic.ts`) is optional; when present, it must be
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
- **engine-flags** (`src/schemas/engine-flags.ts`): `CompiledFlow.engine_flags`
  is the optional `EngineFlagsManifest` the engine branches on, including the
  until-loop shape. See "Manifest-carried behavior fields" above.
- **report-file-surface** (`src/schemas/report-file-surface.ts`):
  `CompiledFlow.report_file_surfaces` marks which reports are edit-file
  surfaces for the skill-hook table.
- **axis-config-requirement** (`src/schemas/axis-config-requirement.ts`):
  `CompiledFlow.required_config` is the CLI's up-front config gate for
  tournament and autonomous axes.

## Failure modes (carried from evidence)

- `carry-forward:verdict-enum-bloat` — Existing Circuit uses per-protocol
  verdict conditionals. Circuit's Step discriminated union constrains
  verdicts per step kind, not per protocol.
- `carry-forward:prose-schema-drift` — Existing Circuit's SKILL.md can
  silently disagree with `circuit.yaml`. Circuit prevents this by
  generating host-facing flow surfaces from flow package sources.
- `carry-forward:stage-path-policy-too-loose` — **Closed in stage.md v0.1.**
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
- **v0.6 (schema versioning slice)**: bumps
  `schema_version` to `'3'` after the dead `entry` routing metadata was
  removed from the strict schema. The removal changed what the schema
  accepts, so the version moves with it per
  [docs/contracts/schema-versioning.md](schema-versioning.md). A
  pre-bump artifact now fails with a `schema_version` mismatch instead
  of an unrecognized-key error.
- **v0.7 (first-class composition reconciliation, this version)**: documents the
  four optional manifest-carried behavior fields the strict schema already
  accepts — `engine_flags` (including the full until-loop shape:
  `stop_judge`, `frozen_paths`, `cumulative_usd_cap`/`cumulative_token_cap`,
  `no_progress_ceiling`, `iteration_commit_containment`),
  `report_file_surfaces`, `runtime_surface.primary_result`, and
  `required_config`. No schema change; these fields moved onto the manifest in
  the Stage 3 / 3b first-class composition work so composed flows carry their
  behavior without a by-id catalog package, and the contract now describes them.
- **v1.0 (Stage 2)**: ratified invariants + property tests + operator
  documentation.

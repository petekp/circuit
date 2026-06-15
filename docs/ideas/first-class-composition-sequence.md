# Circuit: First-Class Block Composition Migration Plan

> **Superseded (2026-06-14).** This staged migration plan has shipped: first-class composition landed as milestones M1–M9 (merged to main). Where this plan and [`../architecture/first-class-composition-optimal-path.md`](../architecture/first-class-composition-optimal-path.md) disagree, the optimal-path doc governs. Kept as the historical design record that merged code cites by stage number (`schematic-catalog-check.ts`, `recovery-route-policy.ts`, `engine-flags.ts`, `operator-summary.ts`, `route-block-contract-availability.test.ts`). Read it for the original plan, not current behavior.

Status: proposal, 2026-06-13. Grounded by an automated codebase audit; treat file:line citations as verified at audit time.

## Leverage thesis

Today the engine asks "which flow is this?" and reads behavior off a catalog package keyed by `flow.id`. That single question is why the six prepackaged flows are special-cased and why anything composed runs thinner. Flip the question to "which blocks does this flow contain, and what does its manifest declare?" and the same change that makes a composed flow first-class also upgrades the six built-ins. The reason is structural: when behavior resolves from blocks plus manifest data, there is one shared assembly path instead of six special cases. Improve the block palette once and every flow that contains the block improves. Test a block once and it is trusted everywhere it appears. Wire the contract-availability check on the compile path and it protects Build and Fix exactly as much as it protects an authored flow. The built-ins stop being privileged; they become the first customers of the path everyone else will use.

---

## Verified inventory

Grouped by `final_classification`. Two framing notes up front, both corrected from an earlier draft:

- **Read `null` as unverified, not as agreement.** Every inventory item carries `verified: null` and `lookup_key_accurate: null`. `null` means the classifier's stamp was never re-checked by a second pass — it is silence, not endorsement. So this plan does not lean on "the skeptic agreed." Instead, the load-bearing anchors below were **independently spot-checked against the live tree at audit time**: `graph-runner.ts:270/320/344`, `run-close.ts:51-53`, `projections.ts:454-467`, `catalog.ts:64-67`, `create.ts:166-189`, `flow-schematic.ts:847-946`, the `route` block contracts in `block-catalog.json`, `selection-resolver.ts:94`, `connectors/resolver.ts:201-202`, `relay-selection.ts:39-56`, `compiled-flow-loading.ts:72`, `ids.ts:5`, and the eight schematics' `initial_contracts`. Those checks held. One item's optimism did **not** survive the check: `route_block_defined_but_wired_into_no_flow` was described as "fully defined and ready to drop in," but its input contract `flow.catalog@v1` has no producer (see Stage 4). Treat that as the proof that `null` is not "confirmed."
- Three `lookup_key` values are honestly `mixed` or `unclear` rather than a clean `flow_id`. Those are called out where they sit.

### already_global (no migration; these are the proof the target pattern works)

These already resolve from a block, a schema name, a trace-event kind, or operator config keyed by a flow-id **string**. They run correctly for any flow including a composed one. They are the model.

- **flow_connector_hints_resolution** — matches `hint.flow_id === flowId` from the operator's policy envelope, never calls `findCompiledFlowPackageById`. `src/runtime/run/relay-guidance.ts:153,158-161`.
- **per_flow_selection_and_connector_config_override** — the actual mechanism by which depth, power, and connector config bind per flow. `configLayerSelection` reads `circuits[flowId]` from layered operator config via `Object.hasOwn(circuits, flowId)` (`src/selection/selection-resolver.ts:90-95`); the connector resolver picks `relay.circuits[flowId]` (`src/connectors/resolver.ts:201-202`). Both key on a flow-id **string in operator config**, not on a catalog package, so a composed flow with id `X` is matched by `circuits.X` with zero engine change. **Confirmed not id-allowlisted:** `CompiledFlowId` is `z.string().regex(slugPattern).brand()` (`src/schemas/ids.ts:5`) — an open branded string, not a closed enum — and `config.circuits` / `relay.circuits` are `z.record(CompiledFlowId, …)` (`src/schemas/config.ts:41,263`), which accept any slug-shaped key. The depth-binding injection at `relay-selection.ts:39-56` already writes `circuits[flowId]` for an arbitrary id and `Config.parse` accepts it, which is the live proof the config record is open. The one stated dependency, not an assumption: **a composed flow inherits per-flow selection/connector config only if the operator writes config under its exact id.** No engine migration; surface this in the docs for composed flows.
- **run_receipt_and_spend_trailer** — `readRunReceipt` aggregates from `trace.ndjson` by event kind only. `src/app/operator-summary/writer.ts:640-802,809-888,1120`.
- **skill_hook_activation_summary** / **auto_resolution_summary** / **run_outcome_override_brief** — all key on trace kinds or the run-outcome enum, never `flow.id`. `writer.ts:912-964, 579-601, 450-524`.
- **relay_report_schema_registry_parse** / **run_file_report_validator_registry** — `parseReport`/`validateReportValue` look up by schema NAME across all packages, fail-closed on unknown. `src/runtime/executors/relay.ts:384,561,676`; `src/runtime/run-files/report-validator.ts:13-24`; `src/flows/catalog-derivations.ts:97-115`.
- **report_file_surface_schema_keyed_validation_pass** — `buildReportFileSurfaceRegistry` builds a global schema-keyed map, but its return is discarded as a validation-only pass. Confirmed at `src/flows/flow-definition.ts:382-385,397`. This is the registry Stage 5's skill-hook move re-points the runtime at.
- **weak_per_mode_producer_existence_check** (`computeReads`), **block_id_to_block_definition_lookup**, **block_execution_kind_and_stage_policy_lookup**, **schematic_item_block_field_enum_parse_gate** — all keyed by contract name or block id. `src/flows/compile-schematic-to-flow.ts:175-199,564`; `src/schemas/flow-schematic.ts:856-922`; `src/schemas/flow-schematic-policy.ts:9,13`; `src/schemas/flow-blocks.ts:25`.
- **fixture_eligibility_gate** / **published_custom_flow_allowlist** / **compose_writer_fail_closed_policy** / **custom_flow_slug_reservation** — the trust path decides by path containment and manifest membership, never by which of the eight flows. Confirmed `src/cli/runtime-routing-policy.ts:54-128`; `src/cli/create.ts:40,95-97`.
- Skill-hook dispatch internals that already run flow-agnostic: **check_outcome_hook_detection_from_trace_signals**, **edit_file_surface_detection_from_report_written_signal**, **skill_hook_policy_resolution_by_hook_name_across_config_layers**, **skill_hook_vocabulary_default_mode_and_metadata_by_hook_name**, **implementer_role_gate_for_skill_injection**, **auto_actuation_injection_channel_lifecycle**, **strict_unavailable_skill_decision_packet**, **operator_summary_projection_of_skill_hook_events**. `src/skill-hooks/dispatch.ts`, `policy.ts`, `injection.ts`, `decision-packet.ts`.

### declarative_manifest_flag (move the datum onto the manifest; no closures travel)

- **binds_execution_depth_to_relay_selection** — boolean. `src/runtime/run/graph-runner.ts:320-323`; `src/selection/relay-selection.ts:25-26,71-74`; setters `src/flows/build/data.ts:533-534`, `src/flows/prototype/data.ts:727-728`.
- **binds_terminal_outcome_to_primary_result** — boolean + a report path already in `runtimeSurface.primaryResult.path`; close path does an INDEPENDENT by-id resolve. Confirmed `src/runtime/run/run-close.ts:51-53`; setter `src/flows/goal/data.ts:629-630`.
- **iterates_slice_loop** — fully declarative `SliceLoopEngineFlag` struct (head/tail step ids, advance route, report+itemsPath, cap, depth floor). Only `flow_id` coupling is the lookup at `graph-runner.ts:344`. Setter `src/flows/build/data.ts:539-549`.
- **runtime_surface_primary_result_path** — `{schemaName, path, label}`, pure data. `src/flows/catalog-derivations.ts:168-180`; read at `writer.ts:1108`, `process-evidence/projection.ts:95`, `cli/run.ts:353`.
- **required_config_axis_prerequisite** — axis enum + dotted config path + message string. `src/cli/run.ts:408-421`; `src/flows/types.ts:128-136`.
- **internal_flow_visibility_guard** — single enum. `src/cli/run.ts:631-637`; `src/flows/types.ts:73,166`.
- **primary_result_report_path** (receipt-summary view of the same surface) — `{path,label}`. `writer.ts:1108,1192-1194`.
- **write_capable_worker_disclosure** — boolean, currently a hardcoded id set, derivable from "contains a write-capable relay block." `src/shared/write-capable-worker-disclosure.ts:1-7`; `writer.ts:1218-1221`.
- **explore_run_note_suppression** — one-bit presentation toggle, currently a bare `flowId === 'explore'` string literal. `writer.ts:1222-1224`. The most brittle coupling in the file.
- **run_note_and_result_summary_framing** — `lookup_key: mixed`. `friendlyRunNote` is already id-agnostic (title-cases any id); only `friendlyResultSummary`'s hardcoded name alternation needs the manifest display name. `src/shared/operator-summary/text.ts:28-41`.
- **runtime_does_not_load_block_catalog** — the enabler, not a flow-keyed behavior. The block catalog and schematic policy are pure data; no runtime/CLI/selection/app module imports them today. Wiring the strong validator in is a net-new data load, not a re-key. `scripts/flows/emit.ts:979-982`; `apps/designer/server.ts`.
- **custom_flow_descriptor_schema** (`archetype: 'build'`) — pure metadata, never read at runtime to branch. Relax `z.literal('build')` to an enum once composition exists. `src/schemas/custom-flow-descriptor.ts:4-13`.
- **flow_id_carried_on_recorded_event_as_descriptive_scope_only** — write-only provenance; no read site branches on it. Effectively a no-op for migration. `src/skill-hooks/dispatch.ts:96-99,205-208`.

### rehome_to_block (genuine code or a registry whose KEY is wrong; move it to the producing block/schema)

- **compiledPackage_lookup_at_run_start** — the root by-id resolve. Not a behavior so much as the indirection to dissolve. `graph-runner.ts:270`.
- **edit_file_surface_sources_for_skill_hooks** / **report_file_surface_runtime_population** / **edit_file_surface_source_table_built_from_running_flow_package** — the same defect seen from three subsystems: runtime reads `compiledPackage.reportFileSurfaces` (flow-id slice) instead of the existing global schema-keyed `buildReportFileSurfaceRegistry`. A composed flow whose id is absent silently gets `{}` and fires NO edit-file hooks. The leaf lookup at `dispatch.ts:180` is already schema-keyed; only the table assembly at `graph-runner.ts:271-273` is flow-scoped. `catalog-derivations.ts:182-197`.
- **html_projector_selection** — real closures, but each renders one report SCHEMA's typed body. Registry is already a registration Map; only the key (`flowId`) is wrong. `writer.ts:1129`; `src/shared/html/index.ts:13-21`; registered only for `build/explore/prototype/review` at `catalog.ts:64-67`.
- **summary_projection_dispatch** / **outcome_label_dispatch** / **next_action_review_branch** — closures that read one flow's typed result report. Rehome to the terminal block/schema that produced it. `next_action_review_branch` is `lookup_key: mixed` (one `flowId === 'review'` literal among outcome-label branches). `projections.ts:454-467`; `writer.ts:319-344,434-448`.
- **custom_flow_kind_policy_validation** — `canonicalSets[id]` plus a hardcoded `if (id === 'review')` branch. The same writer is already detectable by its global schema name `review.result@v1`, proving the block-keyed path is feasible. **This is a RUNTIME safety check, not just a create-time one:** `validateCompiledFlowKindPolicy` is called inside `loadCompiledFlow` (`src/cli/compiled-flow-loading.ts:72`), which the production run path invokes at `src/cli/run.ts:639` for EVERY flow it loads, and which the recovery attempt runner triggers transitively at `recovery-attempt-runner.ts:77`. Unknown id falls to `pass_through` (`src/policy/flow-kind-policy-core.ts:248-254`) — zero stage-set enforcement. The `if (id === 'review')` identity-separation branch is at `flow-kind-policy-core.ts:277-285`. `src/flows/canonical-stage-policy.ts:19-31`.
- **route_aware_contract_availability_validation** — the strong validator, keyed by block id and contract name, but called only by tests and the designer (confirmed zero callers under `src/flows`, `src/runtime`, `src/cli`, `scripts/flows`). `src/schemas/flow-schematic.ts:810,925-943`.
- **route_block_defined_but_wired_into_no_flow** — the inert seat, **with an unmet input-contract producer**. The `route` block exists in the catalog (`docs/flows/block-catalog.json:26-44`), referenced by zero schematics. Its declared inputs are `task.intake@v1` + `flow.catalog@v1` and its output is `route.decision@v1`. **`flow.catalog@v1` has NO producer**: no block in the catalog emits it, and none of the eight schematics declare it in `initial_contracts`. So "defined in the catalog" is not the same as "compose-able." Wiring it in needs net-new producer work — see Stage 4, which lists it as a hard sub-task rather than assuming the block drops in.

### irreducible_flow_specific (the one survivor)

- **template_clone_publish** — `circuit create` clones the compiled Build flow and overrides only `id` and `purpose`. Confirmed `src/cli/create.ts:159-189`; `archetype: 'build'` hardcoded at `create.ts:296`. Every "custom" flow today is structurally Build wearing a new name. This is irreducible ONLY because there is no block-composition authoring surface yet. The whole migration's success criterion for the create path is to make this reducible: replace "clone Build by id" with "assemble blocks from the manifest." Until then it stays flow-id-specific (build).

That is the entire irreducible core: one item, and it is irreducible by absence of a feature, not by nature. Nothing else survived scrutiny as truly flow-specific code.

---

## Staged sequence

Strangler-fig throughout: add the new path beside the old, migrate one behavior at a time with both live, delete the old path only once it is empty. Every stage is independently valuable and reversible. Every non-`already_global` behavior is assigned to exactly one stage.

### Stage 1 — Make capability loss loud

**Goal.** Before moving anything, surface silent degradation. Add a legibility assertion: at run start, for the resolved flow, record (to trace) which per-flow bindings resolved and which fell back to defaults. A flow that loses depth binding, the slice loop, edit-file surfaces, the HTML projector, or the summary projector should emit a `run.binding-resolved` (or similar) trace line, not vanish.

**Why now.** This is the safety net for every later stage. Right now a composed flow degrades with zero signal (the `?? {}` at `graph-runner.ts:272`, the `?? defaultProjector` at `projections.ts:466`, `getHtmlProjector` returning `undefined`). If we start moving behaviors without this, a regression looks identical to today's silent loss. With it, a regression is a visible trace line and a receipt note. Cheapest possible risk-retirement: pure addition, no behavior change.

**Behaviors moved.** None yet. This stage instruments the choke point **compiledPackage_lookup_at_run_start** (`graph-runner.ts:270`) and the degrade sites of **html_projector_selection**, **summary_projection_dispatch**, **edit_file_surface_sources_for_skill_hooks** without changing their resolution.

**Done when.** A hand-composed flow run (a Build clone with a deliberately unregistered id) produces trace lines naming every binding that fell back, and the receipt shows a "reduced bindings" note. Built-in flows show all bindings resolved.

**Risk.** Low. Additive trace only. The one trap is over-firing on flows that legitimately have no slice loop or no HTML projector (Fix never had one). The assertion must compare against what the flow's blocks/manifest DECLARE it should have, not against the full built-in set, so "Fix has no HTML projector" is not flagged as loss.

**Reversibility.** Delete the trace emission. Nothing depends on it yet.

### Stage 2 — Wire the contract-availability check on the compile path

**Goal.** Call the strong `validateFlowSchematicCatalogCompatibility` (or its route-aware core `collectRouteAwareAvailability`) on the compile path against the block catalog, alongside the existing weak `computeReads`. Do not remove `computeReads`; run both.

**Why now.** The validator already exists and is correct (`flow-schematic.ts:810-946`) but only tests and the designer call it. The compile path runs only the weaker producer-existence check (`compile-schematic-to-flow.ts:564`), which confirms SOME item writes a contract but never checks that the contract the item declares is one the named block is allowed to produce or consume on every reachable route. That gap is what lets a composed flow compile while wiring incompatible contracts, then fail closed mid-run at `report-schemas.ts:52-55`. Wiring the check forward retires fail-closed-mid-run risk and immediately protects the built-ins: it would catch a contract mismatch in Build or Fix at compile time too. This is the first stage that requires the engine/compiler to load the block catalog (**runtime_does_not_load_block_catalog**), so doing it here pays that one-time data-load cost early and makes Stage 4 cheaper.

**Behaviors moved.** **route_aware_contract_availability_validation** (off-path standalone → compile-path gate). Pays down **runtime_does_not_load_block_catalog** (load the catalog data so the validator can run). The `already_global` block-resolution primitives (**block_id_to_block_definition_lookup**, **block_execution_kind_and_stage_policy_lookup**, **schematic_item_block_field_enum_parse_gate**, **weak_per_mode_producer_existence_check**) are the substrate this stage activates; they do not move.

**Expect built-in violations — this is the likely case, not the exception.** The strong validator is **strictly stronger** than `computeReads`. `collectRouteAwareAvailability` (`flow-schematic.ts:810-845`) walks the route graph and INTERSECTS the available-contract set at every join point (`intersectContracts` narrowing at line 836), then fails any input that references a contract unavailable on *at least one* reachable route (lines 935-942). `computeReads` only requires SOME producer to exist anywhere reachable. The eight shipped schematics have NEVER been gated by the route-aware intersection — only by the weaker producer-existence check (`compile-schematic-to-flow.ts:564`) plus the parse-time block-id enum. Compounding this: the schematics declare `route.decision@v1` (and other intake contracts) in `initial_contracts` (e.g. `explore/goal/prototype/review/build/fix/pursue schematic.json:8`), meaning route decisions are modeled as engine-provided initial contracts rather than block outputs, so the contract graph the validator walks may not match the authors' mental model. Plan for the probe to surface real violations in the built-ins, and budget a sized sub-task to fix the offending schematics (or relax the validator to match intended semantics) before flipping to fail-closed.

**Stage 2 sub-tasks (sized):**
1. Load the catalog data into the compile path (one-time data-load wiring).
2. Run the validator over all eight schematics **report-only** and record every issue.
3. **Fix built-in schematic violations** — treat as the likely workstream, not a footnote. For each violation decide: correct the schematic, or relax the validator if the violation reflects intended engine-provided-initial-contract semantics.
4. Only after the eight pass clean, flip the gate to fail-closed.

**Probe result (recorded 2026-06-13 — sub-task 2 output, decision needed).** The report-only probe ran the strong validator over all eight shipped schematics against `FLOW_BLOCK_CATALOG`. Result: **128 issues across six of the eight**. Only Fix (0) and runtime-proof (0) are clean. Counts: `goal` 113, `explore` 7, `build` 3, `prototype` 2, `review` 2, `pursue` 1.

Root cause, confirmed on two flows: the block catalog is a **coarse, incomplete model**. Schematics reuse a generic block id for structurally distinct items. `goal` declares `block: goal` on ~9 items (dispatch, attempt, evaluation, recovery) but the `goal` block definition models only the single framing step (output `goal.contract@v1`, stage `frame`), so every other `goal`-blocked item violates on output, stage, evidence, inputs, and routes. `explore`'s `synthesize-step` declares `block: plan` but outputs `explore.compose@v1` (the `plan` block outputs `plan.strategy@v1`). Only Fix and runtime-proof were authored block-first to satisfy the validator; the other six were authored schematic-first and never conformed.

This is **larger than the "sized sub-task" this stage budgeted, and it is a block-model decision, not a mechanical edit.** The fork is: (a) define new blocks (e.g. `goal-dispatch`, `goal-attempt`, `goal-evaluation`) and re-point the offending items; (b) broaden the existing blocks to accept the wider shapes (risks making them meaningless); (c) treat the strong route-aware validator as designer-only and keep the compile path on the weaker `computeReads` check; or (d) some mix per cluster. Choosing (a)/(b)/(c) decides whether "blocks are the source of truth" is reachable for the built-ins or whether the built-ins keep a looser contract. **This is the semantic call to make with the operator before any schematic or block-definition edits.**

**What landed in Stage 2 given the probe (mechanism, not the flip).** A shared report-only seam `collectSchematicCatalogIssues(schematic)` (`src/flows/schematic-catalog-check.ts`) binds the validator to the in-process `FLOW_BLOCK_CATALOG`, so the compile path, the Stage 4 route probe, and the baseline test all check against one catalog. A committed **ratcheting baseline test** (`tests/contracts/schematic-catalog-check.test.ts`) records the 128 as a per-schematic ceiling: a fix lowers a count (never fails), a new violation in a built-in or a newly composed flow raises it (fails), and Fix + runtime-proof are pinned to exactly 0. This delivers sub-tasks 1 and 2 and protects the repo's flows from new violations without breaking the build. The fail-closed compile gate (sub-task 4) stays deferred behind the decision above, because flipping it now breaks six built-ins, and scoping the flip to composed-flows-only would reintroduce the exact built-in-vs-composed distinction the migration exists to delete.

**Done when (revised).** The report-only seam and the ratchet are committed; a deliberately broken composed schematic (item declaring a contract its block cannot produce, or a stage/route/output its block disallows) is caught by the seam with a precise block+contract message; `computeReads` still runs unchanged; `tests/contracts/flow-schematic.test.ts` and `orphan-blocks.test.ts` stay green. The fail-closed compile gate is explicitly **out of scope** until the block-model fork above is decided and the six built-ins are brought (or relaxed) to clean.

**Risk.** Medium-to-high, concentrated in the probe outcome. The real risk is that one or more of the eight existing schematics violate the route-aware intersection (expected, per above). Mitigation is the report-only-first sequencing plus the sized fix sub-task; this is exactly the file-set-audit-needs-a-probe rule.

**Reversibility.** Demote the gate back to report-only, or remove the call. `computeReads` is untouched so compile behavior reverts cleanly.

### Stage 3 — Re-key engineFlags onto the manifest (the pattern-setter)

**Goal.** Move the three `engineFlags` and the runtime-surface descriptors from "looked up by id off the catalog package" to "serialized on the manifest, read directly." Prove one built-in and one hand-composed flow both run the new path. This stage sets the template every later declarative move copies.

**Why now.** `engineFlags` is the cleanest possible first target: already pure declarative data (booleans and a struct), no closures, single consumers. The whole cost is "stop resolving the package by id; read the field off the flow value the engine already holds." It dissolves the root indirection (**compiledPackage_lookup_at_run_start**) for the runtime branches that read flags, which is the highest-traffic by-id resolve in the engine.

**Behaviors moved.**
- **binds_execution_depth_to_relay_selection** (`graph-runner.ts:320-323`).
- **binds_terminal_outcome_to_primary_result** + its independent close-path resolve (`run-close.ts:51-53`).
- **iterates_slice_loop** (`graph-runner.ts:344`).
- **runtime_surface_primary_result_path** / **primary_result_report_path** (the shared `{path,label}` surface read at `writer.ts:1108`, `projection.ts:95`, `cli/run.ts:353`).
- **internal_flow_visibility_guard** (`cli/run.ts:631-637`).
- **required_config_axis_prerequisite** (`cli/run.ts:408-421`).
- **custom_flow_descriptor_schema** archetype relaxation (`custom-flow-descriptor.ts:10`) — relax to an enum so a composed flow can declare a non-build archetype. Small, belongs with the manifest work.
- **flow_id_carried_on_recorded_event_as_descriptive_scope_only** — confirm it stays write-only provenance; no code change, just guard against anyone making it a selector.

**Done when.** Build runs through the manifest-read path with byte-identical traces to the by-id path (depth binding, slice loop, terminal outcome all behave the same). A hand-composed flow that declares `iteratesSliceLoop` in its manifest runs the slice loop; one that omits it does not. The `terminalOutcomeBoundToPrimaryResult` close path no longer calls `findCompiledFlowPackageById`. Stage 1's legibility net shows these bindings resolving from the manifest.

**Risk.** Medium. The slice loop and terminal-outcome bind are the two behaviors with the most subtle semantics (`run-close.ts` fail-open on a corrupt primary result; slice corridor caps and depth floor). The data moves cleanly but the consumers must read from the new source. Mitigation: write the failing test first for each (a composed flow that should and should not get the behavior), keep the by-id resolve as a fallback during the stage, remove it only when the manifest path is proven.

**Reversibility.** Each behavior keeps the by-id resolve as a fallback until proven; revert is dropping the manifest read and restoring the fallback as primary. Per-behavior, so a single regression rolls back one behavior, not the stage.

### Stage 4 — Make a block truly runtime-real, end to end (route block, after authoring its missing producer)

**Goal.** Prove a block can be runtime-real, not just defined: wire an inert/under-used block into a real flow and run it through the now-compile-checked path (Stage 2) — compile → run → trace → receipt — with no flow-specific engine branch. The `route` block is the intended demonstrator, but it is **not** drop-in: its input `flow.catalog@v1` has no producer. So Stage 4 has a hard prerequisite sub-task before any wiring.

**Why the route block is not "the cleanest target because it already exists."** Existence in the catalog is not compose-ability. Probed at audit time: the `route` block (`block-catalog.json:26-44`) consumes `task.intake@v1` + `flow.catalog@v1` and emits `route.decision@v1`. No catalog block produces `flow.catalog@v1`, and no schematic declares it in `initial_contracts` (all eight declare only `task.intake@v1` / `route.decision@v1` / other intake contracts). The moment a `route` item is wired into any flow, **both** Stage 2 checks reject it: `computeReads` fails because `flow.catalog@v1` "has no producer reachable in this mode and is not in initial_contracts" (`compile-schematic-to-flow.ts:186-191`), and the route-aware validator fails the same input as "unavailable contract on at least one reachable route" (`flow-schematic.ts:935-942`). Stage 2 is a hard prerequisite of Stage 4 precisely because it will catch this — so the producer must exist first.

**Stage 4 sub-tasks (in order):**
1. **Run the contract-availability probe on a candidate `route`-containing schematic FIRST** (it will fail on `flow.catalog@v1` — that is the expected signal, the file-set-audit rule applied).
2. **Author or identify the producer of `flow.catalog@v1`.** Two viable options, pick one deliberately:
   - a net-new `catalog` block that emits `flow.catalog@v1` (the catalog of available flows/schematics) at intake, wired ahead of the `route` item; or
   - declare `flow.catalog@v1` in the host flow's `initial_contracts` as an engine-provided run input (the same modeling already used for `route.decision@v1`), and have the engine populate it.
3. Only then wire a `route` item into a flow and re-run the probe to confirm it compiles clean.
4. Run it: emit a `route.decision@v1` report that the global schema registry parses, and show the route decision in the trace and receipt.

**Fallback if the producer work is out of scope for this stage:** pick a *different* inert or under-used block whose input contracts already have producers (or are already in `initial_contracts`) as the Stage 4 demonstrator, and treat route-block activation as a follow-on once `flow.catalog@v1` has a producer. The goal of Stage 4 is "prove one block runtime-real," which any compose-able block satisfies; route is the preferred subject only after its producer exists.

**Behaviors moved.** **route_block_defined_but_wired_into_no_flow** (inert → live in a flow, validated by Stage 2's check) — gated on the `flow.catalog@v1` producer sub-task above.

**Done when.** A flow contains a `route` item (or the chosen demonstrator block); it compiles, passing the Stage 2 catalog check including the previously-missing input contract; a run emits the block's output report that the global schema registry (`report-schemas.ts`, already `already_global`) parses and validates without a flow-id touch; the trace shows the block's decision. No engine file gains a flow-specific branch.

**Risk.** Medium. The risk the plan now retires up front is the missing producer; the residual risk is that even with a producer the block's declared contracts do not compose with any existing flow's route graph. Mitigation: Stage 2's validator surfaces that at compile time with a precise message before any run, and the Stage 4 probe runs before any wiring is locked.

**Reversibility.** Remove the `route` (or demonstrator) item from the schematic; the block returns to inert. If a net-new `catalog` producer block was added, it is unreferenced and harmless. No other flow depends on either.

**Probe result (recorded 2026-06-13).** Sub-task 1 ran. A faithful `route` item (frame stage, compose execution, inputs `task.intake@v1` + `flow.catalog@v1`, output `route.decision@v1`, the block's three evidence requirements, routes from `allowed_routes`) was wired into goal's real schematic and run through the shared Stage 2 check (`collectSchematicCatalogIssues`). Two findings, now locked by a committed regression test (`tests/runner/route-block-contract-availability.test.ts`):

1. **The missing producer is the *only* barrier.** Without `flow.catalog@v1`, the route item produces exactly one issue — `input "catalog" references unavailable contract "flow.catalog@v1" on at least one reachable route` — and zero block-compat issues. The `route` block definition is internally consistent and fully compose-able the moment its input contract is available; nothing else about it needs fixing.
2. **The cheap producer model clears it completely.** Declaring `flow.catalog@v1` in the host flow's `initial_contracts` (the engine-provided-input model already used for `route.decision@v1`, which goal declares in `initial_contracts` today) drops the route item to zero issues.

**Producer recommendation.** Of the two options in sub-task 2, prefer **option (b): declare `flow.catalog@v1` as an engine-provided initial contract**, because it matches an existing precedent (`route.decision@v1` is already an engine-provided initial contract consumed by goal's `clarify` block) and adds no new block. Option (a), a net-new `catalog` block, is the more "first-class" choice — it makes `flow.catalog@v1` a real, composable produced contract rather than an engine injection — and is the right move if a composed flow should ever assemble its own catalog step. This is a deliberate architectural fork (engine-injected run input vs. first-class produced contract); it is the analog of the Stage 2 block-model decision and belongs to the operator, not a silent default.

**Deferred to Stage 6 (the live run).** The compile-level proof above is shipped. The remaining "Done when" clause — *a run emits `route.decision@v1` that the global schema registry parses, shown in the trace and receipt* — requires runtime machinery that this stage cannot reach without getting ahead of the sequence: the `route` block's execution kinds are `compose` / `checkpoint` / `sub-run` / `fanout` (never `relay`), so a real run needs a registered compose writer that emits `route.decision@v1` plus a runnable host for the route-containing flow. A runnable host is either a ninth built-in (heavy surface) or the sanctioned composed-runtime path Stage 6 opens (and which depends on Stage 5's kind-policy rehome). So the live run is correctly Stage 6 work; Stage 4 lands the producer decision and the compile-clean proof, and hands the run to Stage 6.

### Stage 5 — Migrate the remaining flow-id behaviors behind the legibility net

**Goal.** Move every remaining `rehome_to_block` and `declarative_manifest_flag` behavior, one at a time, each with Stage 1's net watching. This is the bulk of the receipt/summary and skill-hook surface, plus the runtime kind-policy safety check.

**Why now.** Stages 1-4 have built the safety net (loud loss), the compile-time guard (contract check), the declarative-move template (engineFlags), and the proof a block can be runtime-real. Now the harder moves are de-risked: each one is "do what Stage 3 did, but for a registry whose key is `flowId` instead of a schema name."

**Behaviors moved, grouped by shape:**

*Skill-hook surface table (the three-faced defect — do first, it is the clearest second-class-citizen bug):*
- **edit_file_surface_sources_for_skill_hooks** / **report_file_surface_runtime_population** / **edit_file_surface_source_table_built_from_running_flow_package** — swap the runtime source at `graph-runner.ts:271-273` from `compiledPackage.reportFileSurfaces` (flow-id slice) to the existing global `buildReportFileSurfaceRegistry` (`catalog-derivations.ts:182`), looked up by the schema names the run's steps actually write. The leaf at `dispatch.ts:180` is already schema-keyed; no closures move, only the table source. This also makes **report_file_surface_schema_keyed_validation_pass**'s output finally consumed instead of discarded.

*Runtime kind-policy safety check (id-table → block-derived; HARD prerequisite of Stage 6, see dependency note):*
- **custom_flow_kind_policy_validation** — derive the canonical stage-set requirement from the flow's declared blocks/stages; the `review.result@v1` identity-separation rule belongs to the block that emits it (detection by global schema name already exists at `flow-kind-policy-core.ts:69-75`). Removes both `canonicalSets[id]` and the `if (id === 'review')` branch (`flow-kind-policy-core.ts:248-285`). **This must land before Stage 6.** It is invoked on the RUNTIME load path (`compiled-flow-loading.ts:72` via `run.ts:639`, and transitively in `recovery-attempt-runner.ts:77`), not only at create time. Today an unknown (composed) id falls to `pass_through` with zero stage-set enforcement (`flow-kind-policy-core.ts:248-254`). If Stage 6 opens the runtime path before this rehome, every published composed flow runs with NO canonical-stage check while the built-ins keep theirs — the exact second-class-citizen asymmetry the migration exists to kill, now on a safety check rather than a feature.

*Receipt / operator-summary projectors (real closures → register per producing schema):*
- **html_projector_selection** — re-register the four projectors against the report schema they render (`build checkpoint`, `explore tournament`, `prototype checkpoint`, `review.result@v1`) instead of `flowId`. `src/shared/html/index.ts:13-21`, `catalog.ts:64-67`.
- **summary_projection_dispatch** / **outcome_label_dispatch** — same re-key, against the terminal block/schema. `projections.ts:454-467`, `writer.ts:319-344`.
- **next_action_review_branch** — drop the `flowId === 'review'` literal; have the review projector emit `next_action` explicitly (the function already prefers an explicit "Next action:" detail). `writer.ts:434-448`.

*Receipt / operator-summary presentation flags (data, not code):*
- **write_capable_worker_disclosure** — manifest boolean derived from "contains a write-capable relay block." `write-capable-worker-disclosure.ts`.
- **explore_run_note_suppression** — manifest/projection boolean `suppressRunNote`; kill the bare string literal at `writer.ts:1222-1224`.
- **run_note_and_result_summary_framing** — derive `friendlyResultSummary`'s strip-prefix from the manifest display name; `friendlyRunNote` is already id-agnostic. `text.ts:28-41`.

*Lifecycle hooks (decide the seam, do not inherit a flow-name coupling):*
- **lifecycle_hooks_defined_in_vocabulary_but_not_dispatched** (`final_classification: uncertain`) — when wired, dispatch off stage-transition / step-metadata trace signals, NEVER off `selected-process:explore-architecture` flow name. This is a decision to make deliberately, not a behavior to move; flag it so the designer keeps the subsystem flow-agnostic. `src/schemas/skill-hook.ts:5-79`.

**Done when.** A composed flow that contains the review block gets the review HTML view, review summary projection, review outcome label, "rerun Review" next action, AND real canonical-stage enforcement — with no id registration anywhere. Edit-file skill hooks fire for any flow whose steps write a surface-bearing schema. The legibility net (Stage 1) reports full bindings for the composed flow.

**Risk.** Medium-high, concentrated in the projectors. They are real closures reading typed reports; the risk is a schema that more than one flow's terminal block writes, forcing a tie-break in the registry. Mitigation: the report-schema registries are already fail-closed on duplicate schema names (`catalog-derivations.ts:97-115`, `buildReportFileSurfaceRegistry` throws on dupes), so a collision surfaces at module load, not at runtime. Move one projector at a time; keep the old id-keyed registry as fallback per projector until proven.

**Reversibility.** Per-behavior fallback to the id-keyed lookup. Each projector, the kind-policy derivation, and each flag reverts independently.

### Stage 6 — Open the sanctioned runtime path for a composed manifest (LAST)

**Goal.** Let a composed manifest reach the runtime through the trust gate, and replace template-clone-of-Build with real block assembly at create time.

**Why now.** Last, deliberately. If we open this before Stages 3-5, a composed flow arrives thinner than a built-in (no depth binding, no projectors, no skill hooks, AND no canonical-stage enforcement). After Stages 3-5 — including the kind-policy rehome — a composed flow arrives first-class: it inherits every behavior AND every safety check from its blocks and manifest. Opening the gate now means the first composed flow an operator publishes is as capable AND as guarded as Build, not a degraded copy.

**Behaviors moved.** **template_clone_publish** (the irreducible core) — make it reducible: `circuit create` composes blocks per the manifest instead of cloning Build and overriding id/purpose. The trust gate itself (**fixture_eligibility_gate**, **published_custom_flow_allowlist**, **compose_writer_fail_closed_policy**, **custom_flow_slug_reservation**) is already `already_global` and id-agnostic (`runtime-routing-policy.ts:54-128`); it needs no change. The per-flow selection/connector config seam (**per_flow_selection_and_connector_config_override**) is also already id-agnostic; the only operator-facing note is that a composed flow inherits that config when written under its exact id. The work is the create/authoring surface, not the gate.

**Done when.** `circuit create` produces a flow whose behavior comes from its own block list, not from copying flow `build`; `archetype` is a genuine declarative field (Stage 3 already relaxed the literal); the published manifest reaches the runtime through the existing eligibility gate; a published composed flow runs with full bindings AND real canonical-stage enforcement (Stage 5's kind-policy rehome).

**Risk.** High, but isolated. This is net-new authoring, the largest single piece. It is last so it builds on a proven path. The compose-writer fail-closed policy (`runtime-routing-policy.ts:118-128`) already enforces the serialization principle: closures literally cannot ride the trusted path, so the authoring surface is forced to emit data, which is exactly what we want.

**Reversibility.** Keep template-clone as the fallback create mode until block-assembly is proven. Revert is defaulting `circuit create` back to clone-Build.

---

## The irreducible core

One behavior: **template_clone_publish** (`src/cli/create.ts:159-189`). And it is irreducible only because Circuit has no block-composition authoring surface yet, not because the behavior is intrinsically flow-specific. Everything else in the inventory is either already global, a datum that serializes onto the manifest, or genuine code that belongs to a block/report-schema and rehomes to a registry that already exists in registration form. Stage 6 retires even this last item by making composition the authoring path. After Stage 6 the irreducible core is empty: no behavior is selected by "which of the eight flows is this."

---

## Composer-layer scope — resolved (2026-06-13, recovery-binding probe)

The A/B sort (`first-class-composition-ab-sort.md`) surfaced 6 "type-B" route failures and framed them as control-flow that would need a new composer layer with combinators (a `reviseTo` backward-edge combinator and a `loop` combinator). A step-zero recovery-binding probe plus a three-lens adversarial verification overturned that. Authoritative finding: `first-class-composition-composer-scope.md`. The decision-relevant results, folded into this master plan:

- **Zero new combinators.** The engine already models and executes verdict-gated backward edges. The recovery-route subsystem (`RecoveryRouteBindingV0` + `RecoveryCorridor` + recovery-selection + the `run-transition.ts` cycle guard) auto-derives a binding for every recovery-named route and re-enters the earlier step at runtime. `reviseTo` is struck. Type-B is effectively empty: of the 6, one is the existing slice loop, three already project bindings and run, two are vocabulary name-twins of `retry`, and one (goal `run-next-gate-pass` self-loop) is a dead abort-trap to drop.
- **The route failures are a gate-recognition bug, not missing control-flow.** `validateFlowSchematicCatalogCompatibility` (`flow-schematic.ts:854-883`) flags a route via `block.allowed_routes.includes(route)` alone and never consults the recovery projection, so working corridor-driven recovery routes report "not allowed by block." The fix is one cross-flow change: recognize a route as legitimate when it is NORMAL or when `recoveryKindForRoute` binds it. That clears the route subset across all flows at once and touches no schematic.
- **Scope decision (pinned).** Pete's all-edges-vs-surfaced-6 question is dissolved, not traded off: the ~dozen unsurfaced backward edges are *already first-class* (NORMAL or recovery-bound), so the gate-recognition fix is inherently all-edges in one change — the correct shape of "migrate all in one pass," realized as one recognition reconciliation rather than N per-edge migrations. Do **not** hand-migrate already-correct edges (zero-behavior-change churn). The only per-flow work is goal's vocabulary cleanup.

> **Correction (2026-06-13, step 4 build).** The two bullets above mislabel the goal gate-pass routes. `recover` and `run-next-gate-pass` are NOT dead name-twins/abort-traps to drop — they are the *live* routes the gate-pass relay emits. The gate-pass items route from the reviewer report via `route_from_report:['next_route']`, and `GoalGate.next_route` is the enum `{run-next-gate-pass, recover, close}`. Deleting them from `step.routes` would make the engine throw "selected undeclared route" the moment the reviewer reports a blocked gate (→`recover`) or a mid-streak clean pass (→`run-next-gate-pass`), and would break three live assertions in `tests/runner/goal-flow.test.ts`. `retry` is the failed-check recovery fallback and `continue` survives only as the compiled `pass` twin the test mock returns on a clean check; neither is removable either. The real defect was the *block model lying*: `goal-gate-review.allowed_routes` listed `['continue','retry','stop']`, omitting the routes the block actually emits. **Step 4 as built = correct the block model, not delete edges:** set `allowed_routes` to `['continue','run-next-gate-pass','recover','retry','close','stop']`. `allowed_routes` is authoring/validation-only and never compiled, so this is runtime byte-identical (`generated/flows/goal/circuit.json` unchanged vs HEAD), and it clears the last 4 catalog issues honestly (goal 9→5). The inverted framing came from the recovery-binding probe reasoning about the *static* `allowed_routes` list without consulting the runtime `next_route` enum.
- **Corrects this plan's Task #14 flip condition.** Stage 2 above says flip the gate to fail-closed "after the type-B failures are promoted to combinators and removed from the denominator." Corrected: there are no combinators to promote. Flip after the **gate-recognition fix** lands, plus goal's vocabulary cleanup and the goal-block split. Decision #14 (warn-only until then) is unchanged; only its trigger condition is sharpened.

**Two notes from Pete carried into the build (per his sequencing approval):**

1. **"A week" is the optimistic branch, not the plan of record.** The composer-scope estimate is really "a week IF the goal split does not cascade." The goal-block split is ~98 of the 122 type-A fixes and carries the only real second-order risk (12 one-to-many aliases papering over a monolith; masks come off on split). Build the goal split first, behind the validator, so any newly-unmasked mismatch shows up in the first two days, not at the end. Plan for the good-case week but treat the split as the gate.
2. **Audit enforcement before shipping any `enforced` equipment label (Axis 3).** Once equipment is labeled "enforced," operators rely on it, and a label that claims more than the engine guarantees is worse than no label (the same disease as a digest reading "Verification: passed" when review was skipped). Add an explicit work item: verify the engine actually enforces what the label claims **at the write tier** before applying it. Correctness gate, not a sequencing blocker. (The ab-sort doc already flags this under Axis 3 and the risks list; this pins it as a work item.)

---

## Track B — the product bet (parallel, gated, no code)

Run the offline preference test on paper now, in parallel with Stage 1. Take the generative/JIT-compiled-flow UX as a paper proposal, put it in front of the preference test, and let the result gate whether the generative product is worth building on top of this refactor. This is design and judgment work, not engineering; it does not touch the tree and does not block any Track A stage.

The explicit claim: **Track A pays for itself regardless of Track B's verdict.** Even if the preference test comes back negative and Circuit never ships a generative flow, the six prepackaged flows are strictly better after this refactor: contract-checked at compile time (Stage 2), no silent capability loss (Stage 1), behavior that travels with blocks so the palette improves all flows at once (Stages 3-5), and a single shared assembly path instead of six special cases. Track B can fail and every Track A stage still stands as a correctness and maintainability win.

---

## Dependency note

**Hard blocks:**
- Stage 1 (legibility) should land before Stage 3 and Stage 5. It is the net that makes every later move's regressions visible. Stage 2 can technically precede it, but landing Stage 1 first is cheaper insurance.
- Stage 2 (compile-path contract check) blocks Stage 4 — and is the gate that *will reject* a naive `route`-block wiring. Wiring any block in is only safe once the catalog validator gates the compile path; for `route` specifically, Stage 2 will fail on the missing `flow.catalog@v1` producer, which is why that producer is a Stage 4 sub-task.
- Stage 2 also pays down the block-catalog data load (**runtime_does_not_load_block_catalog**) that Stage 4 needs.
- Stage 2's report-only probe is expected to surface built-in schematic violations (route-aware intersection has never gated them); fixing those is a sized Stage 2 sub-task that blocks flipping the gate to fail-closed.
- Stage 4 has its own hard prerequisite: author or declare a producer for `flow.catalog@v1` before wiring the `route` block. Until then, either use a different compose-able block as the Stage 4 demonstrator or defer route activation to a follow-on.
- Stage 3 (engineFlags template) should precede Stage 5's declarative moves. Stage 5's flag migrations copy Stage 3's pattern; proving it once on the cleanest data first de-risks the bulk.
- Stage 4 (one real block) should precede Stage 5's projector rehomes. Proving a block runtime-real end to end de-risks the harder per-block registry re-keys.
- **Stage 5's kind-policy rehome (custom_flow_kind_policy_validation) is a HARD prerequisite of Stage 6.** Its invocation site is the runtime load path (`compiled-flow-loading.ts:72` via `run.ts:639`, transitively `recovery-attempt-runner.ts:77`), not create-time. Opening the runtime path (Stage 6) before this rehome ships composed flows with `pass_through` (zero) stage-set enforcement while built-ins keep real enforcement.
- Stage 6 depends on Stages 3-5. It must come last so a composed flow arrives first-class — full bindings and full safety checks — not thinner.

**Can run in parallel:**
- Track B runs alongside everything from day one. No code dependency.
- Within Stage 5, the skill-hook table swap, the projector rehomes, the presentation flags, and the kind-policy derivation are independent of each other and can be parallelized once Stages 1-4 are in. Each has its own per-behavior fallback. The kind-policy derivation must complete before Stage 6 regardless of when it starts.
- Stage 1's instrumentation and Stage 2's report-only probe can be developed concurrently (both additive), then landed in the order above.

The critical path is Stage 1 → Stage 2 (incl. built-in-violation fixes) → Stage 4 (incl. `flow.catalog@v1` producer) → Stage 5 (incl. kind-policy rehome) → Stage 6, with Stage 3 sitting between Stage 1 and Stage 5 and the Stage 5 sub-items fanning out in parallel. Track B floats free.

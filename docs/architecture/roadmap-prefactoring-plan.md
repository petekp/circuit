# Roadmap Prefactoring Plan

Status: executed and closed (2026-07-02). The prep slices landed and the
roadmap they prepared completed via
[architecture-revamp-staged-plan.md](architecture-revamp-staged-plan.md).
Historical record, not open work.

Purpose: make the architecture roadmap easier before executing it. The point is not to do the roadmap twice. The point is to add the tests, seams, and small neutral modules that let later boundary moves land as boring, behavior-preserving changes.

Prefactoring rule: if a prep slice already moves ownership across the final boundary, it is no longer prep. It belongs in the roadmap itself.

## Starting Conditions

The roadmap target is [docs/architecture/architecture-improvement-roadmap.md](architecture-improvement-roadmap.md). It names ten rectifications: architecture fitness tests, Skill Hooks contract hardening, flow report surface declarations, Prototype connector planning, the `flows`/`policy` cycle, `shared` responsibility split, app/history/memory storage split, CLI thinning, explicit run transitions, and schema family barrels.

Current checkout reality matters:

- Skill Hooks are stable shipped ground now. The shipped surface uses `auto` and `mute`, defaults omitted mode to `auto`, and uses `edit-files` hook names.
- Keep using full `npm run verify` as the canonical baseline before source-moving architecture work.
- Prefactoring should stay scoped and avoid normalizing unrelated work if later branches introduce it.

## Ranked Prefactoring Sequence

| Rank | Prefactor | Makes These Roadmap Items Easier | Leverage | Risk |
| --- | --- | --- | --- | --- |
| 0 | Confirm clean verification baseline | all | very high | low |
| 1 | Extract shared architecture-test helpers | architecture fitness tests, every later move | very high | low |
| 2 | Add current import graph snapshot as an allow-listed ratchet | architecture fitness tests, shared split, policy cycle, memory cycle | very high | low |
| 3 | Characterize Skill Hook trace and actuation order | Skill Hooks, report surfaces, run transitions | high | medium |
| 4 | Add a neutral report-surface declaration type and adapter boundary | report surface declarations, Skill Hooks | high | medium |
| 5 | Extract connector planning as a read-only planning seam | Prototype connector planning, CLI/runtime relay planning | high | medium |
| 6 | Parameterize flow-kind policy checks | `flows`/`policy` cycle | high | low-medium |
| 7 | Extract run-corpus listing below app and memory | app/history/memory cycle | medium-high | low |
| 8 | Add CLI run/resume output characterization fixtures | CLI thinning | medium | low |
| 9 | Add run transition characterization tests | explicit run transitions | medium | medium |
| 10 | Add schema family barrel scaffolding tests | schema family barrels | medium | low |
| 11 | Create a `shared` ownership inventory before moving files | shared split | medium | low |

Ranks 0 through 7 should happen before the first major source-tree reshaping. Ranks 8 through 11 can happen in parallel with the relevant roadmap slice.

## Rank 0: Confirm Clean Verification Baseline

### Evidence

- The project guide says `npm run verify` is the canonical check before claiming a change is done.
- Skill Hooks/runtime work is no longer a baseline blocker.
- Treat a fresh full verify as the baseline gate for the next architecture branch.
- Keep future prefactoring patches scoped so verification failures can be attributed.

### Prep Change

Before source-moving architecture work starts, confirm:

- `npm run verify` passes on the baseline branch;
- `git status --short` makes the architecture branch's scope obvious;
- generated outputs are either intentionally checked in or absent;
- any repo-mutating generated-surface tests are isolated to a temp fixture tree or forced to run serially.

### What This Makes Easy

Every later slice can use `npm run verify` as a trustworthy stop rule. Without this, a failed verification run cannot distinguish architecture breakage from pre-existing WIP.

### Verification

Run:

```bash
npm run verify
git status --short
```

## Rank 1: Extract Shared Architecture-Test Helpers

### Evidence

- `tests/contracts/engine-flow-boundary.test.ts:37-70` already implements a recursive TypeScript walk plus static, re-export, and dynamic import parsing.
- `tests/contracts/architecture-boundaries.test.ts:1-20` has a smaller separate file walker.
- `tests/contracts/engine-flow-boundary.test.ts:94-114` uses those helpers to report clear boundary offenders.

### Prep Change

Create a small test helper such as `tests/helpers/source-imports.ts` that exports:

- `walkTsFiles(root)`;
- `importPathsFrom(file)`;
- `topLevelSourceModuleFor(file)`;
- `relativeImportTarget(file, importPath)`, if needed by the graph ratchet.

Then update only the existing boundary tests to use it. Do not add new architecture rules in this same slice.

### What This Makes Easy

The architecture fitness test can focus on policy rather than file walking. Later boundary tests for `shared`, `policy`, `memory`, and flow package imports can all use the same parser.

### What Not To Do Yet

Do not introduce dependency-cruiser or a new package. The existing regex approach is good enough for the current codebase and keeps `npm run verify` simple.

### Verification

Run:

```bash
npm run test -- tests/contracts/architecture-boundaries.test.ts tests/contracts/engine-flow-boundary.test.ts
npm run check
```

## Rank 2: Add The Import Graph Ratchet With Current Allow-List

### Evidence

- The roadmap import graph found cycles around `app -> memory`, `shared -> flows`, `flows -> policy`, and `shared -> policy -> flows`.
- Existing architecture tests already prove local boundaries, but not top-level cycles.

### Prep Change

Add a contract test that:

1. walks `src/**/*.ts`;
2. maps imports to top-level source modules;
3. computes top-level edges and cycles;
4. compares cycles against a named allow-list copied from the roadmap baseline;
5. fails if any new cycle appears.

Keep the current cycles allowed at first. Each later roadmap slice removes one allow-list entry when it breaks the corresponding cycle.

### What This Makes Easy

It lets large moves proceed safely. If a later `shared` split accidentally creates `runtime -> app -> runtime`, the test catches it immediately.

### What Not To Do Yet

Do not fail on existing cycles in the first version. That turns a ratchet into a wall.

### Verification

Run:

```bash
npm run test -- tests/contracts/architecture-boundaries.test.ts
npm run check
```

## Rank 3: Characterize Skill Hook Trace And Actuation Order

### Evidence

- `src/runtime/run/graph-runner.ts:1015-1090` appends `step.completed`, then dispatches Skill Hooks, records `run.skill-hook`, actuates `auto` events, and records dispatch failures as non-fatal trace evidence.
- `src/runtime/run/relay-guidance.ts:377-403` gates injected skills to implementer relays and passes the run skill registry into skill loading.
- `tests/runner/skill-hook-actuation.test.ts` already proves `before:edit-files` auto injection, omitted-mode default to `auto`, mute behavior, verification-failure retry injection, and no reviewer/researcher leak.

### Prep Change

Add one narrow characterization test over trace order:

- the step writes its report or check signal;
- `step.completed` is appended;
- `run.skill-hook` is appended after `step.completed`;
- the next implementer relay sees injected skills;
- researcher/reviewer relays do not.

The existing actuation tests prove behavior, but the planned run transition work needs exact order pinned.

### What This Makes Easy

Later report-surface and run-transition changes can move implementation details without silently changing when hooks fire.

### What Not To Do Yet

Do not change `dispatchSkillHooks`, report surface ownership, or the injection channel in this slice. Test first.

### Verification

Run:

```bash
npm run test -- tests/runner/skill-hook-actuation.test.ts tests/unit/skill-hook-injection.test.ts tests/runner/skill-hook-dispatch.test.ts
npm run check
```

## Rank 4: Add A Neutral Report-Surface Declaration Type And Adapter Boundary

### Evidence

- `src/skill-hooks/surface-sources.ts:1-13` says `before:edit-files` and `after:edit-files` surfaces are per-flow-declared self-report fields, but the current table lives in Skill Hooks.
- `src/skill-hooks/surface-sources.ts:54-72` maps `fix.change-set@v1` and `build.plan@v1` to extractors.
- `src/flows/report-declarations.ts:13-20` already carries report schema, channel, relay hint, cross-report validation, and writers.
- `src/flows/report-declarations.ts:28-71` already projects declarations into runtime registries.

### Prep Change

Add the type vocabulary for report surfaces without moving any current source yet:

- a `FlowReportSurfaceDeclaration` type, likely in `src/flows/report-declarations.ts`;
- a projected `reportSurfaces` collection that is empty by default;
- a small adapter function that can later translate declarations into the current Skill Hook lookup shape.

In this prep slice, every existing flow declaration can omit the new field. The current `EDIT_FILE_SURFACE_SOURCES` remains the live source.

### What This Makes Easy

The later surface migration becomes a data fill-in and reader swap, not a type-design change plus behavior move in one slice.

### What Not To Do Yet

Do not delete `EDIT_FILE_SURFACE_SOURCES`. Do not make Skill Hooks consume the new registry until the declaration projection is tested.

### Verification

Run:

```bash
npm run test -- tests/contracts/catalog-completeness.test.ts tests/runner/skill-hook-dispatch.test.ts
npm run check
```

## Rank 5: Extract Connector Planning As A Read-Only Planning Seam

### Evidence

- `src/connectors/resolver.ts:177-227` resolves connector choice from explicit connector, role config, flow config, default config, and auto fallback.
- `src/runtime/run/relay-guidance.ts:29-326` adds supplied connector identity checks, policy connector preferences, policy hard constraints, and relay execution planning around the base resolver.
- `src/flows/prototype/writers/variant-options.ts:1-5` imports connector resolver functions directly.
- `src/flows/prototype/writers/variant-options.ts:45-90` validates and resolves variant connector/model choices inside the flow writer.
- `src/flows/types.ts:122-135` defines flow-owned axis config prerequisites.
- `src/flows/prototype/data.ts:737-749` declares Prototype's tournament `variant_models` prerequisite.
- `tests/runner/cli-router.test.ts:992-1027` proves missing Prototype tournament config rejects up-front with no run folder.

### Prep Change

Extract a neutral connector planning contract, such as `src/selection/connector-planning.ts`, with one public planning shape that can serve both runtime relay guidance and Prototype variant planning later. This is now a smaller slice than the original roadmap note: keep Prototype's `requiredConfig` prerequisite exactly where it is and move only connector/model planning.

The first slice should move only pure planning code out of `relay-guidance.ts`:

- requested connector identity normalization;
- policy connector choice;
- policy hard constraint checks for connector/model/effort;
- final connector decision shape.

Then keep `planRelayGuidanceDecision` as the only caller. Prototype does not switch yet, and its up-front config validation remains unchanged. If the first extraction still needs adapters around `src/connectors/resolver.ts`, keep those adapters runtime-facing; the later Prototype migration should consume only the neutral contract, not a module under `src/connectors`.

### What This Makes Easy

The later Prototype migration can call the same planner without pulling runtime files into flow code.

### What Not To Do Yet

Do not change Prototype in this prep slice. Do not move `requiredConfig`, relay prompt, or skill loading logic into connector infrastructure. The connector planner should not know about prompts, reports, loaded skill bodies, or whether a flow's axis config was present, and the final flow-facing seam must not require flow packages to import `src/connectors`.

### Verification

Run:

```bash
npm run test -- tests/runtime/connectors.test.ts tests/runner/runner-relay-connector-identity.test.ts tests/contracts/codex-connector-schema.test.ts tests/runner/cli-runtime.test.ts tests/runner/cli-router.test.ts
npm run check
```

## Rank 6: Parameterize Flow-Kind Policy Checks

### Evidence

- `src/policy/flow-kind-policy-core.ts:7-10` imports canonical stage policy from `src/flows/canonical-stage-policy.ts`.
- `src/policy/flow-kind-policy-core.ts:54-57` re-exports the imported maps as policy constants.
- `src/policy/flow-kind-policy-core.ts:228-260` reads those module-level constants while checking a fixture.
- `src/flows/canonical-stage-policy.ts:1-28` derives the maps from `flowDefinitions`.

### Prep Change

Add a pure checker that accepts policy data as input:

```ts
checkCompiledFlowKindCanonicalPolicyWithTable(fixture, {
  canonicalSets,
  exemptFlowIds,
})
```

Keep the existing `checkCompiledFlowKindCanonicalPolicy(fixture)` wrapper unchanged and backed by the current imports. The wrapper can be removed or moved later.

### What This Makes Easy

The cycle-breaking slice can move the wrapper/adapter without redesigning the checker. Tests can begin targeting the pure function immediately.

### What Not To Do Yet

Do not move `canonical-stage-policy.ts` or change validation callers in the prep slice.

### Verification

Run:

```bash
npm run test -- tests/contracts/flow-kind-policy.test.ts tests/contracts/flow-schematic.test.ts
npm run check
```

## Rank 7: Extract Run-Corpus Listing Below App And Memory

### Evidence

- `src/app/history/indexer.ts:63-74` resolves history paths.
- `src/app/history/indexer.ts:76-122` owns `listCandidateRunFolders`.
- `src/memory/project-distill.ts:1-13` imports `listCandidateRunFolders` from `src/app/history/indexer.ts`.

### Prep Change

Extract only run-folder discovery into a lower module, such as `src/history/run-corpus.ts` or `src/run-corpus/index.ts`.

Move:

- `DEFAULT_RUNS_BASE`, if it is truly storage-core;
- candidate run folder detection;
- `listCandidateRunFolders`;
- any error type needed by both app history and memory, or a lower neutral error shape.

Then point both `src/app/history/indexer.ts` and `src/memory/project-distill.ts` to the lower module. Do not move query, indexing, memory injection, or recall precision.

### What This Makes Easy

The later app/history/memory cycle fix becomes smaller. Memory can mine run folders without importing app.

### What Not To Do Yet

Do not move history query or memory recall in this prep slice. The target is one lower storage primitive.

### Verification

Run:

```bash
npm run test -- tests/runner/history*.test.ts tests/unit/memory*.test.ts
npm run check
```

If glob expansion does not match, find the current tests with `rg "listCandidateRunFolders|project-distill|history recall|memory effect" tests`.

## Rank 8: Add CLI Run/Resume Output Characterization Fixtures

### Evidence

- `src/cli/circuit.ts:701-745` dispatches top-level commands.
- `src/cli/circuit.ts:748-852` contains resume orchestration and stdout output.
- `src/cli/circuit.ts:854-1354` contains fresh run orchestration and stdout output.
- `tests/runner/cli-router.test.ts:1-220` already has rich CLI relay fixtures and stream capture helpers.

### Prep Change

Before extracting `runExecutionCommand` and `runResumeCommand`, add or tighten tests that snapshot the stable shape of stdout JSON for:

- routed fresh run;
- explicit flow fresh run;
- checkpoint waiting;
- checkpoint resume;
- abort with reason.

Prefer structural assertions over full snapshots where paths and timestamps vary.

### What This Makes Easy

The later CLI thinning can move code without accidentally changing host-visible output.

### What Not To Do Yet

Do not extract the command handlers in this prep slice unless the tests reveal a tiny helper that is obviously safe to lift.

### Verification

Run:

```bash
npm run test -- tests/runner/cli-router.test.ts tests/runner/cli-runtime.test.ts
npm run check
```

## Rank 9: Add Run Transition Characterization Tests

### Evidence

- `src/runtime/run/graph-runner.ts:741-850` handles step entry, executor call, checkpoint waiting, and executor errors.
- `src/runtime/run/graph-runner.ts:852-864` handles slice-loop route rewriting.
- `src/runtime/run/graph-runner.ts:866-1013` handles target validation, recovery binding, cycle guards, recovery corridor changes, and recovery guidance.
- `src/runtime/run/graph-runner.ts:1015-1097` writes `step.completed`, dispatches Skill Hooks, closes terminal targets, or advances.
- `src/runtime/executors/sub-run.ts:261-290` now treats a non-complete child run with a declared `stop` route as a normal stopped transition, while complete-without-verdict remains a contract failure.
- `tests/runtime/sub-run.test.ts:290-330` already proves the stopped-parent case, and `tests/runtime/sub-run.test.ts:559-596` preserves the complete-without-verdict failure case.

### Prep Change

Add tests that pin current order and outcome for a minimal fixture:

- normal relay -> complete path;
- invalid route -> `step.aborted` before close;
- self-cycle -> abort reason;
- recovery retry -> legal re-entry;
- checkpoint waiting -> no `step.completed` for the waiting checkpoint until resume.
- preserve the existing sub-run child non-success case: declared `stop` route -> stopped parent, not aborted parent.

The tests should read the trace as the authority.

### What This Makes Easy

The later transition classifier can be extracted while preserving trace and routing behavior.

### What Not To Do Yet

Do not introduce a transition object in the prep slice. Test current behavior first.

### Verification

Run:

```bash
npm run test -- tests/runtime tests/runner/pass-route-cycle-guard.test.ts tests/runner/build-runtime-wiring.test.ts
npm run check
```

## Rank 10: Add Schema Family Barrel Scaffolding Tests

### Evidence

- `src/schemas/index.ts:1-50` re-exports every schema module.
- `tests/contracts/schemas-barrel.test.ts:1-58` requires that completeness.

### Prep Change

Before adding family barrels, add a test that documents the intended families and verifies the root barrel remains complete. Then add empty or minimal family barrels only when there is a first real importer.

### What This Makes Easy

Later imports can move from the root barrel to family barrels without arguing about whether the root barrel should be removed.

### What Not To Do Yet

Do not replace root imports repo-wide. Do not remove `src/schemas/index.ts`.

### Verification

Run:

```bash
npm run test -- tests/contracts/schemas-barrel.test.ts
npm run check
```

## Rank 11: Create A `shared` Ownership Inventory

### Evidence

- `src/shared/README.md` lists many unrelated helper groups under one directory.
- `src/shared/operator-summary-writer.ts` imports the flow catalog and summary/presentation helpers.
- `src/shared/relay-selection.ts` imports flow catalog/runtime-index data.
- `src/shared/skill-loading.ts` mixes selection, config, skill registry, trace evidence, and injected Skill Hook skills.
- `src/shared/html/index.ts` is a good inversion pattern: generic registry in shared, flow projectors registered by the catalog.

### Prep Change

Create a short inventory, either in `src/shared/README.md` or a new architecture note, classifying current shared files into:

- pure leaf helpers;
- app/reporting services;
- selection/skill services;
- policy-domain helpers;
- flow-aware registries.

Include the planned destination for only the cycle-causing clusters. This is a map, not a move.

### What This Makes Easy

The shared split becomes a sequence of named clusters instead of a directory-wide shuffle.

### What Not To Do Yet

Do not move low-risk pure helpers just because they are in `shared`. The first moves should target cycle-causing or high-level files.

### Verification

Run:

```bash
npm run check
```

If this is docs-only, also run the reference/range checker used for architecture docs.

## Recommended Execution Windows

### Window 0: Baseline

Confirm `npm run verify` is green and keep the branch scope obvious.

### Window 1: Guardrails

Implement ranks 1 and 2. This is the best first architecture branch because it gives every later branch a safety net.

### Window 2: Stable Runtime Seam

Implement rank 3, then rank 4. This freezes Skill Hook timing before moving report surface ownership.

### Window 3: Cycle-Prep Seams

Implement rank 5, rank 6, and rank 7 as separate branches. Each creates a lower neutral seam while preserving current callers.

### Window 4: Characterization Before Motion

Implement ranks 8 and 9 before thinning CLI or extracting a run transition classifier.

### Window 5: Low-Risk Reader Aids

Implement ranks 10 and 11 when the relevant roadmap work is about to start. They are useful, but not urgent enough to block higher-leverage seams.

## How To Keep This From Becoming Main-Roadmap Work

Use this test before each proposed prep slice:

1. Does it preserve all current callers?
2. Does it avoid moving ownership to the final destination?
3. Does it add a test, helper, type, or adapter that later work can use?
4. Can it be reverted without reverting the later roadmap concept?

If the answer to any question is no, it is probably not prefactoring. Move it into the main roadmap execution plan.

## Definition Of Ready For The Main Roadmap

The architecture roadmap is ready to execute when:

- baseline `npm run verify` is green;
- architecture test helpers exist;
- the top-level import graph ratchet exists with current-cycle allow-list;
- Skill Hook trace and role-separation behavior is characterized;
- report-surface declarations have a typed projection seam, even if no flow uses it yet;
- connector planning has a neutral flow-safe contract, with any connector-resolver adapter kept runtime-facing;
- flow-kind policy has a pure table-parameterized checker;
- memory no longer needs to import app just to list run folders, or the exact extraction slice is ready and tested;
- CLI and run transition behavior have characterization tests before code motion.

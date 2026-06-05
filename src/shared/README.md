# Shared Helpers

`src/shared/` is for helpers used across source layers. Keep it small enough
that a reader can tell why code does not belong in `src/runtime/`,
`src/flows/`, `src/cli/`, or `src/schemas/`.

Common groups:

- config and local skill loading,
- relay prompt and result helpers,
- operator summaries, HTML projectors, progress, and status rendering,
- deterministic proof, verification, verdict, and checkpoint helpers,
- fanout aggregation and scoring helpers,
- JSON extraction and schema conversion helpers,
- run-folder and runtime-source helpers.

Put flow-specific report writing in a flow package. Put engine-only graph state
in `src/runtime/`. Put persisted shapes in `src/schemas/` first.

Keep a helper here only when at least two source layers use it.

## Ownership Inventory

This inventory exists so architecture moves can target responsibility, not file
names.

| Cluster | Current files | Direction |
| --- | --- | --- |
| Relay support | none | Relay prompt support now lives in `src/runtime/run/` because it consumes flow runtime indexes and shape hints. Selection resolution lives in `src/selection/`. |
| Operator-facing projections and status | `operator-summary/`, `progress-output.ts`, `status-block-renderer.ts` | Stay shared while multiple layers use these smaller renderer/projection helpers. The operator summary writer now lives in `src/app/operator-summary/` because it composes app-level run artifacts and reads flow runtime surfaces. |
| HTML projection registry | `html/` | Keep shared as the inversion model: flow packages register projectors; shared HTML code does not import flow packages. |
| Config, skills, and connector-neutral relay helpers | `config-loader.ts`, `skill-loading.ts`, `user-skill-registry.ts`, `connector-relay.ts`, `write-capable-worker-disclosure.ts` | Stay shared while they serve CLI, runtime, and hooks without importing flow packages. |
| Run-folder and runtime-source helpers | `run-artifact-io.ts`, `run-file-paths.ts`, `run-relative-path.ts`, `result-path.ts`, `runtime-source.ts`, `manifest-snapshot.ts` | Stay shared unless a helper becomes engine-only or app-only. |
| Proof, verification, outcome, and checkpoint leaves | `proof-plan.ts`, `proof-assessment.ts`, `verification-resolver.ts`, `outcome.ts`, `checkpoint-auto-resolution.ts`, `checkpoint-boundary.ts` | Stay shared as leaf-like helpers. They should not gain flow-package imports. |
| Fanout and report utilities | `fanout-aggregate-report.ts`, `fanout-branch-template.ts`, `json-extraction.ts`, `json-report.ts`, `zod-to-response-schema.ts` | Stay shared while they remain generic utilities. |
| Runtime evidence and work contracts | `runtime-touched-files.ts`, `work-contract-projection.ts`, `relay-runtime-types.ts` | Stage 5 and Stage 6 will decide whether these remain shared contracts or move closer to runtime/policy ownership. |

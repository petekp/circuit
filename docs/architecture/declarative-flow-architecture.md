---
name: declarative-flow-architecture
description: Architecture decision record for the implemented declarative flow authoring model.
type: architecture-decision
date: 2026-05-16
status: implemented
---

# Declarative Flow Architecture

## Decision

Circuit uses typed `FlowDefinition` values as the source of truth for built-in
flow authoring.

Each retained flow is authored as a plain `FlowData` value in
`src/flows/<id>/data.ts` and bound in `src/flows/<id>/flow.ts`. The catalog
imports those flow definitions
and compiles them into the package surface used by the router, runtime
registries, generated schematic JSON, generated compiled manifests, and host
plugin mirrors.

The current production flow set, in catalog order, is owned by
`src/flows/catalog.ts` — the locked source of truth, which also marks which
flows are internal.

## Current State

The migration has landed for built-in flows.

Confirmed current source:

- `src/flows/catalog.ts` lists `flowDefinitions` and derives `flowPackages`
  with `compileFlowDefinitions()`.
- Every retained flow adapter calls `defineFlowData()`.
- Every retained flow owns a `data.ts` file typed as `FlowData`.
- `tests/runner/flow-facts.test.ts` locks the retained flow set, value-owned
  adapters, generated schematic parity, and production flow definitions.
- [docs/generated-surfaces.md](../generated-surfaces.md) marks schematic JSON,
  compiled manifests, host mirrors, command mirrors, and Codex skill mirrors as
  generated surfaces.
- `node scripts/flows/emit.ts --check` is the generated-surface drift check.

## What Landed

The implemented declarative kernel gives this repo a cleaner source model:

- FlowData is authored as a typed plain value;
- `flow.ts` files bind FlowData values to semantic report schemas, writers,
  relay hints, routing metadata, runtime progress, and engine flags;
- schematic JSON is generated from the typed definition;
- compiled flow manifests and public host mirrors are generated from catalog
  state;
- catalog derivation builds the runtime registries from compiled packages;
- the runtime continues to execute compiled flow graphs, not authoring-only
  structures.

This is the stabilizing center for new flow work. Adding or changing a built-in
flow should start in that flow's data, reports, command docs, semantic writers,
or relay hints. It should not add flow-specific branches to the runtime.

## What Did Not Land

This migration did not move the runtime to Effect or to a new event-store
kernel.

The runtime still uses the current graph runner, trace store, run file store,
connectors, child-runner, worktree runner, progress reporter, and clock
interfaces. That is intentional. The graph walk remains plain: enter step, run
executor, evaluate route, append trace, and move to the next step.

Future runtime changes should stay grounded in the current graph runner,
contracts, generated surfaces, and tests before claiming a new kernel.

## Generated Surface Policy

Generated outputs are emitted artifacts. Do not edit them by hand.

Use [docs/generated-surfaces.md](../generated-surfaces.md) as the source map for
authored sources, generated destinations, and drift checks. Use
[docs/flows/authoring-model.md](../flows/authoring-model.md#adding-a-flow) for
the host-ready flow-authoring checklist.

## Runtime Boundary Policy

Flow-specific behavior belongs in flow packages and registries. Runtime code
must stay flow-agnostic.

The engine boundary is protected by contract tests:

- runtime files may not import per-flow modules outside the catalog allowlist;
- one flow package may not import another flow package;
- non-catalog source files may not import a flow package index directly;
- tests may not bypass the engine boundary by importing writer or relay-hint
  internals.

If a new flow needs special engine behavior, add an explicit engine flag to the
compiled flow package and test that flag. Do not hide flow-specific decisions in
the runtime.

## Kernel Spike Disposition

The old `spike/kernel-replay` branch is research, not production source.

Useful ideas from that spike may be harvested later as narrow slices:

- property tests for replayable trace behavior;
- deterministic trace validation;
- clearer typed error values at runtime boundaries.

Do not merge the spike wholesale into current `main`. Current `main` already
has a newer flow definition kernel, generated-surface model, runtime contract
tests, and public plugin behavior.

## Stabilization Checks

Use these checks for source changes in this area:

```bash
npm run check
npm run lint
npm run test:fast
npm run test -- tests/runner/cli-router.test.ts
npm run check-evals
node scripts/flows/emit.ts --check
node scripts/release/emit-current-capabilities.ts --check
node scripts/release/check-public-claims.ts
node scripts/release/check-proof-coverage.ts
node scripts/release/render-readiness-report.ts --check
node scripts/release/audit-public-docs.ts
node scripts/release/audit-marketplace-safe-paths.ts
```

`npm run verify` remains the canonical implementation check before commit. For a
strict read-only audit, prefer the checks above because `check-plugin-runtime`
may emit gitignored `dist/*` sidecar files in check mode.

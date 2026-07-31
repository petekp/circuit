---
name: flow-authoring-model
description: Unified model for authoring Circuit flows from blocks, schematics, routes, checks, reports, and generated manifests.
type: product-architecture
date: 2026-05-01
status: active
---

# Flow Authoring Model

This is the canonical authoring model for Circuit flows.

Use it with:

- [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) for vocabulary.
- `src/schemas/flow-block-definitions.ts` for typed block definitions.
- [docs/flows/block-catalog.json](block-catalog.json) for the generated
  machine-readable block catalog.
- `src/schemas/flow-blocks.ts` for the block catalog schema.
- `src/schemas/flow-schematic.ts` for generated schematic shape.
- `src/flows/compile-schematic-to-flow.ts` for schematic to compiled-flow projection.
- `src/flows/catalog.ts` for the built-in flow catalog the engine derives from.
- [docs/generated-surfaces.md](../generated-surfaces.md) for generated
  command, skill, schematic, manifest, and plugin output ownership.
- [docs/contracts/compiled-flow.md](../contracts/compiled-flow.md) for runtime
  graph invariants.

Hand-authored intent and boundaries live here.
Do not hand-maintain current flow inventories here. Current flow data comes from
`src/flows/<id>/data.ts`; `src/flows/<id>/flow.ts` binds that plain value to the
compiler. Generated schematics live under
`src/flows/<id>/schematic.json`, generated compiled outputs live under
`generated/flows/<id>/`, and generated release surfaces such as
[docs/release/readiness-report.generated.md](../release/readiness-report.generated.md)
are derived.

## Short Version

A flow is an authored typed definition compiled through a generated schematic
into a runtime graph.

A flow definition should say:

- which block runs;
- what typed input the block needs;
- what typed output the step writes;
- which named routes are allowed;
- how the step executes;
- what model, effort, skills, and connector policy are preferred;
- what evidence must exist before the flow moves on.

This is deliberately not a freeform graph builder. Authors should mostly choose
or edit definitions made from known blocks.

## Authoring Layers

Circuit keeps four layers separate.

| Layer | Meaning | Source |
| --- | --- | --- |
| Block | Reusable kind of work. | `src/schemas/flow-block-definitions.ts` |
| FlowData step | Flow-specific use of a block. | `src/flows/<id>/data.ts` |
| Report schema | Typed fact written or consumed by a step. | `src/flows/<id>/reports.ts` |
| Route policy | Named outcomes and targets. | schematic routes plus route policy constants |

The block is reusable. The FlowData step is the flow-specific use of that block.

## Block Model

Every block has a stable identity, expected input contracts, one output
contract, allowed routes, and expected evidence.

The important point is that later steps consume named facts, not whatever text a
model happened to produce. A block can accept more than one input shape when the
work is genuinely reusable across paths. For example, Act can work from a brief
plus a diagnosis, a brief plus a plan, or all three. The block catalog records
those alternatives so schematic validation can reject under-specified steps
without forcing every flow through the same path.

Custom flows should compose built-in blocks first. Users should not define
arbitrary new block code in the first custom-flow surface. New block extension
can come later after the built-in catalog has proved itself across real
schematics.

## Schematic Step Model

A schematic step binds a block to a specific flow purpose.

Typical step concerns:

- `id`: stable step id.
- `block`: block id.
- `stage`: canonical stage for this step.
- `input`: named report contracts consumed by the step.
- `output`: report contract produced by the step.
- `evidence_requirements`: proof the step promises to leave behind.
- `execution`: whether the runtime composes, relays, verifies, checkpoints,
  runs a child flow, or fans out.
- `acceptance_criteria`: optional deterministic checks for relay steps that
  must pass after the relay result is schema-valid and before the flow advances.
- `selection`: optional model, effort, skill, depth, or invocation options.
- `routes`: named outcomes mapped to step ids or terminal targets.
- `route_overrides`: mode-specific route target overrides.
- `exhaustion_route`: optional fallback taken when a recovery route this step
  selects has already exhausted its target's retry budget.

The compiler normalizes the authored shape into a CompiledFlow. Runtime graph
invariants then apply to the compiled manifest, not to prose in this document.

## Contract Fit

Schematic assembly should fail early when a step cannot consume what came before
it.

Basic rule:

> A schematic step can run only when its required input contracts are available.

Availability is route-aware. A later schematic step does not make its output
available to an earlier branch just because it appears earlier in the JSON file.
If one branch can reach Close without passing through Review, Close cannot
require a Review report unless the schematic has a separate close path for the
skipped-review case.

Mode-specific routes are part of contract fit. If Lite skips Review, it should
route to a separate close step whose inputs do not require a Review report. That
keeps reviewed and unreviewed close paths honest.

## Routes

Routes should represent product outcomes, not clever control flow.

Common authored outcomes:

- continue
- connector-failed
- retry
- revise
- ask
- split
- stop
- handoff
- escalate
- complete

Schematics may use `continue` or `complete` as their success outcome. The
compiler preserves the authored label and also emits the runtime success route
`pass`, which is what step handlers follow after a successful check.

Branches help when they represent a real choice:

- evidence reproduced or did not reproduce;
- verification passed or failed;
- review accepted or requested fixes;
- the operator chose continue, stop, or handoff;
- the queue has more work or is empty;
- risk says split the work before continuing.

If a flow needs many tiny branches, that usually means the block model is
missing a better reusable block.

A step whose failure outcome retries earlier work should also declare
`exhaustion_route`: the route the engine takes when that retry budget is spent.
Without it, exhaustion aborts the run and discards every report in it. With it,
the run follows the named route — usually `continue`, so the failing report
travels forward to review and close as honest evidence. The named route must be
one of the step's own declared routes and must not target `@complete`; a spent
retry budget can never close as success.

## Human Decisions

Human Decision is a block, not a host-specific special case.

The schematic should declare the question, options, default policy, and
unattended behavior. Hosts can render the question through native affordances
when available:

- Claude Code can use its user-question surface.
- Codex can use its host question surface.
- Non-interactive runs can use the declared default, pause, or fail clearly.

The answer is recorded as typed evidence. Later steps should not care which host
collected it.

## Selection

Model, effort, skills, depth, and invocation options attach to authored
selection layers.

Blocks say what kind of work is happening. Schematics and config say how hard to
run that work for this flow and operator context. A Lite Fix path might skip
independent review after strong verification, while a Deep Fix path might run a
separate Review step with higher effort. Both paths can still use the same Act,
Run Verification, and Close blocks.

## Reports And Evidence

Each step should produce two useful surfaces:

1. A typed report for later steps and close writers.
2. Evidence that lets the operator audit what happened.

Typed reports keep the flow reliable. Evidence keeps the result explainable
without forcing the operator to read raw trace entries.

Block contracts are nominal. They live in `src/schemas/flow-block-definitions.ts` as
named identifiers such as `flow.brief@v1` or `verification.result@v1`.

Per-flow schemas are structural. They live in `src/flows/<id>/reports.ts` as
concrete Zod types with flow-specific fields.

Contract aliases bridge the two. Each schematic declares how generic block
contracts map to flow-specific schemas. The runtime uses the flow-specific
schema for actual parsing and field access.

## Relay Acceptance Criteria

Use `acceptance_criteria` when a relay step has a narrow, machine-checkable
meaning of done that should stop the flow before later steps build on a bad
result. V1 criteria are relay-only and deterministic:

- `report_field`: checks a field path in the parsed relay result with
  `present` or `non_empty`.
- `command`: runs a bounded direct-argv verification command and expects
  `passed`.

Criteria run only after the relay result verdict passes and the report schema
and cross-report validation succeed. Passing criteria add
`check.evaluated` trace entries with `check_kind: "acceptance_criteria"`.
Failing criteria do not write the canonical report for that relay attempt.

The default failure policy is `hard-fail`. A relay step may opt into
`retry-with-feedback` when its `retry` route re-enters the same step. That
retry uses the existing route and `budgets.max_attempts`; do not add a second
retry counter inside `acceptance_criteria`.

Example:

```json
{
  "acceptance_criteria": {
    "checks": [
      {
        "kind": "report_field",
        "id": "changed-files-present",
        "path": ["changed_files"],
        "predicate": "present"
      },
      {
        "kind": "report_field",
        "id": "evidence-non-empty",
        "path": ["evidence"],
        "predicate": "non_empty"
      }
    ],
    "on_failure": { "mode": "retry-with-feedback" }
  },
  "routes": {
    "continue": "verify-step",
    "retry": "act-step",
    "stop": "@stop"
  }
}
```

Do not use acceptance criteria for subjective review. Keep those verdicts in
Review or an explicit checkpoint. LLM-judged criteria and checkpoint
edit-criterion behavior are not part of V1.

## Fix As The Proving Shape

Fix is the public bug-fixing flow.

Older bug-fix evidence should inform Fix. It should not force Circuit to ship a
second public bug-fixing flow name.

Fix proves the reusable schematic path:

1. Frame the problem.
2. Gather context.
3. Diagnose.
4. Ask a human decision when evidence is uncertain.
5. Act.
6. Run verification.
7. Review when the mode requires it.
8. Close with evidence.
9. Handoff when work is paused.

Separate reports, commands, or runtime code for a second bug-fixing name stay out
of scope unless the public naming model is explicitly reopened.

## Adding A Flow

This is the flow-authoring playbook. Keep durable flow-authoring instructions
here instead of repeating them in agent guides, architecture notes, command
docs, or generated host output.

### 1. Own the flow package

Create `src/flows/<id>/` and keep flow-specific behavior there:

- `data.ts` owns the canonical `FlowData` value.
- `flow.ts` is the thin `defineFlowData(...)` adapter.
- `reports.ts` owns the flow's Zod report schemas.
- `contract.md` explains flow-specific operator and report contracts when the
  flow needs one.
- `relay-hints.ts` owns relay response shape hints when any relay step needs
  more guidance than the generic report schema.
- `writers/` owns compose, close, checkpoint, and verification writers.
- `index.ts` may export the current package surface when current imports need
  the `<id>CompiledFlowPackage` name. Do not add exports only to preserve old
  caller shapes.

The runtime should not import the new flow directly. Runtime registries derive
from `src/flows/catalog.ts`.

### 2. Decide command ownership

Command ownership decides whether hosts get a direct command or only a routed
flow.

- If the flow should be directly invocable, create
  `src/flows/<id>/command.md` and set `paths.command` to that file in
  `src/flows/<id>/data.ts`.
- If the flow should be public but routed only, leave `paths.command`
  undefined and document the intended entry path in the flow guide or
  `src/commands/run.md`.
- Do not put flow-owned commands in `src/commands/`. That directory is only for
  commands and CLI utilities that are not owned by a flow package, such as
  `run`, `handoff`, and the CLI-only `create` utility.

For a public flow with `paths.command`, the emitter creates all host-ready
command surfaces:

- `plugins/claude/commands/<id>.md`
- `plugins/codex/commands/<id>.md`
- `plugins/codex/skills/<id>/SKILL.md`

For every flow, the emitter creates generated flow package JSON:

- `src/flows/<id>/schematic.json`
- `generated/flows/<id>/*.json`

The `generated/flows/<id>/*.json` outputs include compiled flow manifests and
their matching WorkContract projection files. For a public flow, the emitter
also mirrors compiled flow manifests into host packages:

- `plugins/claude/skills/<id>/*.json`
- `plugins/codex/flows/<id>/*.json`

For an internal flow, host mirrors must not exist.

### 3. Wire the catalog and reports

Add the definition to `flowDefinitions` in `src/flows/catalog.ts`. The flow
definition should carry its visibility, paths, routing metadata, axes, contract
aliases, relay reports, report schemas, writers, structural hints, and any
explicit engine flags.

Use `CompiledFlowPackage.engineFlags` only for opt-in engine behavior that is
still flow-agnostic. Do not add flow-specific branches to runtime code.

### 4. Regenerate generated surfaces

After authored flow or command changes, run:

```bash
npm run emit-flows
```

Then inspect [docs/generated-surfaces.md](../generated-surfaces.md). It is the
generated source map for command, skill, schematic, compiled manifest, and
plugin mirror ownership. Do not hand-edit generated host files.

If you need to test installed host packages from this checkout, refresh the
local host plugin caches after regeneration:

```bash
npm run plugins:refresh-local
```

For Codex-only local testing, the narrower
`sync:codex-plugin-cache` / `check:codex-plugin-cache` pair is still available.
The refresh command is a local host-test step. It is not public release
publishing.

### 5. Update release truth when behavior changes

If the flow changes public behavior, command semantics, release claims, or
capability metadata, update release truth with the release scripts instead of
editing generated release output by hand.

Use these checks as the decision points:

- Run `npm run emit-release` when capability, parity, or readiness metadata
  should change.
- Run `npm run check-release-infra` before claiming release truth is current.
- Run `npm run capture-proofs:golden-runs` when a proof scenario asserts the
  behavior you changed: runtime control flow, route outcomes, report schemas,
  operator summaries, checkpoints, command semantics, or proof coverage.

Release proof artifacts under `docs/release/proofs/runs/` are evidence, not
examples. Preserve them unless a release check and proof capture path says they
are safe to change.

### 6. Prove the flow is host-ready

Choose focused proof before the final check:

- `tests/runner/flow-facts.test.ts`,
  `tests/contracts/catalog-completeness.test.ts`, and
  `tests/contracts/retired-flow-surface.test.ts` for catalog and flow package
  shape. `flow-facts` and `retired-flow-surface` pin the flow roster against
  the shared `tests/fixtures/retained-flow-ids.ts` list; update that one file
  when the set of flows changes.
- The flow's report-schema and runtime tests for behavior.
- `npm run check-flow-drift` for schematic, manifest, command, skill, plugin,
  and generated source-map drift.
- `npm run check-release-infra` for release truth and public-claim safety.
- `npm run verify` before calling the change done.

## What Not To Put Here

Do not add hand-maintained lists of:

- installed flows;
- axis support per flow;
- generated compiled-flow files;
- command ownership;
- current route inventories;
- release support status.

Those are derivable facts. Put them in generated outputs or tests that compare
docs against the code-owned source.

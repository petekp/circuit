---
contract: explainer
status: draft
version: 0.1
schema_source: generated/flows/explainer/circuit.json (compiled flow) + src/flows/explainer/reports.ts
last_updated: 2026-06-16
depends_on: [flow, stage, step, selection, depth, skill, connector]
report_ids:
  - explainer.intake
  - explainer.digest
  - explainer.ideas
  - explainer.tournament-proposal
  - explainer.tournament-aggregate
  - explainer.hardening
  - explainer.spec
  - explainer.build-result
  - explainer.verification
  - explainer.result
invariant_ids: []
property_ids: []
---

# Explainer Flow Contract

The **Explainer** flow turns a research paper into an interactive web
explainer. It codifies the operator's real paper-to-site pipeline as a fixed,
hand-authored flow: a lossless digest, persona-lensed ideation, a six-criteria
tournament, an adversarial fidelity pass, an operator pick, a house-style
build spec, a child build run, mechanical verification, an operator fidelity
sign-off, and an honest close.

Like the other flow-specific contracts (`explore`, `build`, `fix`, `review`),
this is the discipline layer over the base `CompiledFlow` schema for one flow:
`explainer`. It binds the canonical stage set, declares the report ids the
stages emit, and records the two operator decision points.

## Scope note

The compiled `explainer` flow at `generated/flows/explainer/circuit.json` is
validated by the base `CompiledFlow` schema. This contract names the report
ids the flow emits and the human-decision gates that bound it. The flow rides
the manifest like every built-in: generic blocks plus `contract_aliases`, no
engine edits.

## Axis Support

Explainer declares `axes.allowed_depths = [low, medium, high]`, supports
tournament and autonomous runs, and declares `plan-stage` as the tournament
fan-out stage. The default axis tuple is medium depth, non-tournament,
interactive, with `tournament_n = 3`. The tournament fan-out sizes the concept
field and the per-concept advocate branches from `tournament_n`.

## Canonical stage set

Explainer uses the full seven-stage canonical path, so
`stage_path_policy.mode = strict` (no omits). The flow-specific stage titles
translate to canonical ids as follows:

| Flow-specific title | Canonical stage id | Role |
|---|---|---|
| Frame             | `frame`   | Name the subject, source paper, house-style references, and success condition. |
| Digest            | `analyze` | Build the lossless ("unsummarizable") outline. |
| Ideate & Choose   | `plan`    | Draft concepts, run the tournament, harden against the wrong driver, take the operator pick, and write the build spec. |
| Build             | `act`     | Run the child build flow on the spec. |
| Verify            | `verify`  | Prove the built site with declared commands. |
| Sign Off          | `review`  | Operator fidelity gate and publish authorization. |
| Close             | `close`   | Emit the honest explainer result. |

The Ideate & Choose (`plan`) stage holds five steps — ideation, tournament
fan-out, hardening, the pick checkpoint, and the spec — the way explore embeds
its tournament inside one canonical plan stage.

## Report ids

- **Explainer intake** (`explainer.intake`): framing report — subject, source
  paper, house-style references, success condition.
- **Explainer digest** (`explainer.digest`): the lossless outline. A
  deterministic scaffold in v1; promoting it to a model-authored relay is the
  primary enrichment.
- **Explainer ideas** (`explainer.ideas`): N scoped concepts, one per persona
  lens, sized from `tournament_n`.
- **Explainer tournament proposal** (`explainer.tournament-proposal`): the
  per-branch advocate report. One relay argues the strongest evidence-backed
  case for its concept.
- **Explainer tournament aggregate** (`explainer.tournament-aggregate`): the
  engine-written fan-out join over the proposals, ranked by the six-criteria
  rubric.
- **Explainer hardening** (`explainer.hardening`): the adversarial fidelity
  pass over the survivors. The danger protagonist is always the seductive
  wrong driver, never the honest one.
- **Explainer spec** (`explainer.spec`): build-ready design law for the chosen
  concept — house-style direction, fidelity citations, and the build brief.
- **Explainer build result** (`explainer.build-result`): the child build run's
  `RunResult`, copied into the parent run.
- **Explainer verification** (`explainer.verification`): the mechanical proof
  of the built site.
- **Explainer result** (`explainer.result`): the aggregate close report.
  Persisted at `<run-folder>/reports/explainer-result.json`. The honest
  outcome binds to this primary result.

## Operator decision points

The flow has two human-decision checkpoints:

1. **Pick** (`pick-checkpoint-step`): the operator chooses one tournament
   survivor to build. Dynamic choices are read from the completed tournament
   branches; the hardening pass surfaces a recommendation.
2. **Sign off** (`signoff-checkpoint-step`): the operator's fidelity gate AND
   publish authorization. The safe default is `blocked` — Circuit never
   publishes without explicit operator authorization. The close binds the run
   outcome to this sign-off and the verification status: the site is shipped
   only when the operator authorized it and the build verified.

## Authority

This contract is the authority for the explainer canonical stage set, its
report ids, and its two operator decision points. Reopen on: a change to the
stage path, a new report id, or a change to either checkpoint's policy.

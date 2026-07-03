---
contract: pursue
status: draft
version: 0.1
schema_source: generated/flows/pursue/circuit.json + src/flows/pursue/reports.ts
last_updated: 2026-07-02
depends_on: [flow, stage, step, connector]
report_ids:
  - pursuit.result
invariant_ids:
  - PURSUE-I1
  - PURSUE-I2
  - PURSUE-I3
property_ids: []
---

# Pursue Flow Contract

The **Pursue** flow turns one or more rough operator goals into pursuit
contracts, coordinates their order, executes code-changing work serially,
verifies, reviews for cross-goal interference, and closes with evidence.
It walks six stages:

| Flow stage title | Canonical stage | Role |
|---|---|---|
| Frame | `frame` | Split the goal into pursuits, each with scope, proof plan, and risk. |
| Coordinate | `plan` | Build the pursuit dependency graph, then order execution waves. |
| Execute | `act` | Relay an implementer worker to run the serialized pursuit batch. |
| Verify | `verify` | Run the contract's verification commands and record pass or fail. |
| Review | `review` | Relay a reviewer worker to audit cross-pursuit coordination. |
| Close | `close` | Project the typed `pursuit.result` report from the six pursuit reports. |

The flow deliberately omits `analyze`. Pursuits V1 folds read-only
discovery policy into the coordination graph before acting; a separate
Analyze stage can be added when dynamic discovery fanout lands (see
`src/flows/pursue/assembly-spec.ts`).

## Axis Support

Pursue declares `axes.allowed_depths = [medium]`. It supports autonomous
runs and does not support tournament fan-out; an operator-supplied
tournament flag is rejected before execution.

## Scope Note

This is a flow-specific contract over the base `CompiledFlow` schema, the
same kind of discipline layer as `src/flows/review/contract.md`. The
compiled flow is validated by `src/schemas/compiled-flow.ts`; the report
shapes are validated by `src/flows/pursue/reports.ts`.

The compose stages use flow-registered writers: the contract writer
resolves verification commands from the target project (it fails closed
when the project exposes none), the graph and wave-plan writers derive
coordination structure from the contract, and the close writer reads all
six pursuit reports as required inputs. The verification step sources its
command list from the pursuit contract via
`src/flows/pursue/writers/verification.ts`.

## Report

This flow registers one primary report:

- `pursuit.result`: the close-stage report, persisted at
  `<run-folder>/reports/pursuit-result.json`. It carries:
  - `summary`: string
  - `outcome`: `complete | needs_attention | blocked | failed`
  - `verification_status`: `passed | failed`
  - `review_verdict`: `clean | needs-followup | blocked`
  - `total_pursuits` plus per-status counts (completed, skipped, blocked,
    failed) that must sum to the total
  - `serial_code_writes`: literal `true`
  - `evidence_links`: exactly six typed pointers, one per pursuit report

The contract, graph, wave-plan, batch, verification, and review reports
under `reports/pursuit/` are internal flow files, not authority-graph
reports.

## Invariants

<a id="PURSUE-I1"></a>

- **PURSUE-I1 — Serialized code writes.** Code-changing work MUST be
  serialized. The wave plan rejects `code-change` waves whose execution is
  not `serial`, the batch report requires `serialized_execution: true`,
  and the final report requires `serial_code_writes: true`.

  Enforced by the schema refinements in `src/flows/pursue/reports.ts`
  (`PursuitWavePlan`, `PursuitBatch`, `PursuitResult`).

<a id="PURSUE-I2"></a>

- **PURSUE-I2 — Batch covers the contract.** Every pursuit id declared in
  `pursuit.contract@v1` MUST appear exactly once across the batch's
  completed, skipped, blocked, and failed lists; unknown or duplicate ids
  fail the close projection.

  Enforced by `assertBatchCoversContract` in
  `src/flows/pursue/writers/result-projection.ts` plus the duplicate-id
  refinements in `src/flows/pursue/reports.ts`.

<a id="PURSUE-I3"></a>

- **PURSUE-I3 — Outcome honesty.** The final `outcome` MUST be `complete`
  only when verification passed, the review verdict is `clean`, and no
  pursuit was skipped, blocked, or failed. Any failed pursuit or failed
  verification forces `failed`; blocked pursuits, a blocked batch
  verdict, or a blocked review verdict force `blocked`; skipped pursuits,
  a partial batch verdict, or a needs-followup review force
  `needs_attention`.

  Computed by `projectPursuitResult` in
  `src/flows/pursue/writers/result-projection.ts` and enforced by the
  `PursuitResult` refinement in `src/flows/pursue/reports.ts`.

## Compiled Flow Binding

The compiled flow at `generated/flows/pursue/circuit.json` binds this
contract as follows:

| Stage | Step | Kind | Output |
|---|---|---|---|
| Frame / `frame` | `contract-step` | `compose` | `pursuit.contract@v1` at `reports/pursuit/contract.json` |
| Coordinate / `plan` | `graph-step` | `compose` | `pursuit.graph@v1` at `reports/pursuit/graph.json` |
| Coordinate / `plan` | `wave-plan-step` | `compose` | `pursuit.wave-plan@v1` at `reports/pursuit/wave-plan.json` |
| Execute / `act` | `batch-step` | `relay`, `role: "implementer"` | `pursuit.batch@v1` at `reports/pursuit/batch.json` |
| Verify / `verify` | `verify-step` | `verification` | `pursuit.verification@v1` at `reports/pursuit/verification.json` |
| Review / `review` | `review-step` | `relay`, `role: "reviewer"` | `pursuit.review@v1` at `reports/pursuit/review.json` |
| Close / `close` | `close-step` | `compose` | registered `pursuit.result@v1` report |

(The `compose`, `relay`, and `verification` literals are the serialized
step kind names in the runtime schema; see `UBIQUITOUS_LANGUAGE.md` for
the layered model that keeps these internal while product prose uses
Circuit writes / relay / check.)

The relay steps use:

- `batch-step`: `check.pass = ["accept", "partial"]`, relay files under
  `reports/relay/pursuit-batch.*`
- `review-step`: `check.pass = ["clean", "needs-followup", "blocked"]`,
  relay files under `reports/relay/pursuit-review.*`

## Pre-Conditions

- The compiled flow parses under the base `CompiledFlow` schema.
- The compiled flow top-level `id` is `pursue`.
- The canonical stage set is exactly `{frame, plan, act, verify, review,
  close}`.
- `stage_path_policy.mode` is `partial` with omits `{analyze}`.
- The close-stage report schema is `pursuit.result@v1`.

## Post-Conditions

After the compiled flow is accepted:

- The final report cannot claim `complete` without passed verification, a
  clean review, and full pursuit coverage (PURSUE-I2, PURSUE-I3).
- Code-changing execution stays serialized end to end (PURSUE-I1).
- The close writer fails closed when any of the six pursuit reports is
  missing, so a torn run cannot produce a final report.

## Reopen Conditions

This contract reopens if any of:

1. Pursue gains an analyze stage (dynamic discovery fanout). The stage
   path policy and this contract's stage table both change.
2. The final report path or schema id changes away from
   `reports/pursuit-result.json` / `pursuit.result@v1`.
3. The batch or review check vocabulary changes away from
   `accept | partial` / `clean | needs-followup | blocked`.
4. Parallel code writes become supported. PURSUE-I1 is then a
   contract-breaking amendment, not a relaxation.

## Authority

- `src/flows/pursue/assembly-spec.ts` (block sequence and stage policy)
- `src/flows/pursue/reports.ts` (report schemas)
- `src/flows/pursue/writers/result-projection.ts` (outcome projection)
- `generated/flows/pursue/circuit.json` (compiled flow)
- `docs/flows/pursue.md` (design note)

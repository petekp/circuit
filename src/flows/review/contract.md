---
contract: review
status: draft
version: 0.1
schema_source: generated/flows/review/circuit.json + src/flows/review/reports.ts
last_updated: 2026-04-28
depends_on: [flow, stage, step, connector]
report_ids:
  - review.result
invariant_ids:
  - REVIEW-I1
  - REVIEW-I2
property_ids: []
---

# Review Flow Contract

The **Review** flow is an audit-only review variant. It walks three stages:

| Flow stage title | Canonical stage | Role |
|---|---|---|
| Intake | `frame` | Resolve the review scope from the run goal. |
| Independent Audit | `analyze` | Relay a reviewer worker and collect findings. |
| Verdict | `close` | Aggregate findings into the final `review.result` report. |

(The runtime stage title in the compiled flow is `Verdict`; in product prose
we describe this as the Decision stage.)

The flow deliberately omits `plan`, `act`, `verify`, and nested `review`.
This is an audit-only flow; a verification-bearing variant would be a
separate flow kind.

## Axis Support

Review declares `axes.allowed_depths = [medium]` and does not support
tournament or autonomous runs. Operator-supplied tournament or autonomous
flags are rejected before execution.

## Scope Note

This is a flow-specific contract over the base `CompiledFlow` schema, the
same kind of discipline layer as `src/flows/explore/contract.md`. The
compiled flow is validated by `src/schemas/compiled-flow.ts`; the final report
shape is validated by `src/flows/review/reports.ts`.

At v0.2, the default runtime composer writer has a narrow review
registration: `review.intake@v1` writes the scoped intake object and
`review.result@v1` reads the analyze-stage relay result to produce the
typed close-stage report. Runtime compose steps fail closed when a
schema-specific writer is missing.

## Report

This flow registers one primary report:

- `review.result` — the close-stage report, persisted at
  `<run-folder>/reports/review-result.json`. It carries:
  - `scope`: string
  - `findings`: array of `{severity, id, text, file_refs}`
  - `verdict`: `CLEAN | ISSUES_FOUND` (the JSON field name remains `verdict`;
    in prose this is the review result)

The Intake report and analyze relay result are internal flow files, not
authority-graph reports.

## Invariants

<a id="REVIEW-I1"></a>

- **REVIEW-I1 — Reviewer identity separation.** The step that writes the
  `review` flow's primary report at canonical stage `close` MUST be
  preceded in `steps[]` by a relay step with `role: "reviewer"` at
  canonical stage `analyze`.

  Enforced today by the review-specific policy check in
  `src/policy/flow-kind-policy-core.ts` and by
  `tests/properties/visible/review-i1.test.ts`. The compiled flow satisfies
  this with `audit-step` before `verdict-step`.

<a id="REVIEW-I2"></a>

- **REVIEW-I2 — Decision determinism.** The `review.result` report MUST
  carry `verdict: "CLEAN"` if and only if every finding is severity
  `low` (or there are no findings). Any `critical`, `high`, or `medium`
  finding makes the verdict `ISSUES_FOUND`. `low` is reserved for
  informational notes the operator may safely defer.

  Enforced by `src/flows/review/reports.ts` and
  `tests/properties/visible/review-i2.test.ts`.

## Compiled Flow Binding

The compiled flow at `generated/flows/review/circuit.json` binds this
contract as follows:

| Stage | Step | Kind | Output |
|---|---|---|---|
| Intake / `frame` | `intake-step` | `compose` | internal `review.intake@v1` scope report |
| Independent Audit / `analyze` | `audit-step` | `relay`, `role: "reviewer"` | raw reviewer JSON at `stages/analyze/review-raw-findings.json` |
| Verdict / `close` | `verdict-step` | `compose` | registered `review.result@v1` report |

(The `compose` and `relay` literals are the serialized step kind names
in the runtime schema; see `UBIQUITOUS_LANGUAGE.md` for the layered model that
keeps these internal while product prose uses Circuit writes / relay.)

The analyze relay step uses:

- `writes.result = "stages/analyze/review-raw-findings.json"`
- `check.source = {kind: "relay_result", ref: "result"}`
- `check.pass = ["NO_ISSUES_FOUND", "ISSUES_FOUND"]`
- its JSON body uses `NO_ISSUES_FOUND` iff `findings.length === 0`;
  otherwise it uses `ISSUES_FOUND`. The final close-stage `review.result`
  decision remains severity-based per REVIEW-I2.

Those literals are pinned in
`tests/contracts/review-relay-shape.test.ts`.

## Pre-Conditions

- The compiled flow parses under the base `CompiledFlow` schema.
- The compiled flow top-level `id` is `review`.
- The canonical stage set is exactly `{frame, analyze, close}`.
- `stage_path_policy.mode` is `partial` with omits `{plan, act, verify,
  review}`.
- The close-stage report schema is `review.result@v1`.

## Post-Conditions

After the compiled flow is accepted:

- The review flow cannot claim a final-report writer unless the
  analyze-stage reviewer relay precedes it structurally.
- The final report schema exists and computes the decision deterministically
  from findings.
- Runtime wiring is intentionally narrow: only the audit-only review
  intake/result Circuit-written reports have a default registered writer.

## Reopen Conditions

This contract reopens if any of:

1. The review flow gains a verification rerun stage. That is a new
   flow kind or a contract-breaking amendment.
2. The final report path or schema id changes away from
   `reports/review-result.json` / `review.result@v1`.
3. The analyze relay check vocabulary changes away from
   `NO_ISSUES_FOUND` / `ISSUES_FOUND`.
4. The generic runtime composer writer is widened beyond the audit-only
   review registration to produce typed reports for additional flow
   kinds. This contract should then name any shared registry contract it
   starts depending on.

## Authority

- `src/policy/flow-kind-policy-core.ts` (canonical stage policy checks)
- `src/flows/canonical-stage-policy.ts` (catalog-derived canonical-set map)
- `src/flows/review/reports.ts` (report schemas)
- `generated/flows/review/circuit.json` (compiled flow)

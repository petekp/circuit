# Intent capture and enforcement: implementation spec (Build v1)

Implements the v2 design in
[`intent-capture-and-enforcement.md`](intent-capture-and-enforcement.md). Build
flow only. No engine change: every edit is inside `src/flows/build/`, tests, or
regenerated host surfaces. TDD: a failing test precedes each behavior.

## Plan revision (2026-06-08): enforcement mechanism changed after a runtime probe

The earlier draft enforced the reviewer's intent assessment with an *acceptance
criterion* using `retry-with-feedback` (re-ask the reviewer when the `alignment`
block is missing). Grounding the plan against the live runtime killed that
approach:

- The relay executor (`src/runtime/executors/relay.ts`) hard-requires that a step
  using acceptance `retry-with-feedback` declare its `retry` route re-entering
  **itself** (`retryTarget.stepId === step.id`).
- review-step's `retry` and `revise` routes both point at **act-step** (the
  implementer), so a rejected or incoherent review sends work back to be
  re-implemented. That is the correct semantic for a substantive reject.
- The recovery projection (`src/shared/work-contract-projection.ts` +
  `src/policy/recovery-route-policy.ts`) maps `retry`->different-step and
  `revise` to the `narrow_scope` kind, whose `allowedFailureCauses` includes
  `failed_check`. The `retry_same_step_with_feedback` kind (what `retry`->self
  would become) allows **both** `failed_check` and `failed_acceptance_criteria`.
  So pointing `retry` at itself makes a plain reject (`failed_check`) match the
  self-retry binding and re-review unchanged code instead of re-implementing —
  a semantic regression avoidable only through fragile route ordering.

**Resolved mechanism:** make `alignment` a **required** field of
`build.review@v1` and enforce coherence with `superRefine`. No acceptance
criterion, no route change, no engine change.

- Presence is enforced two ways: the engine converts the report's Zod schema to
  a structured-output response schema for capable connectors
  (`relay.ts` ~L546), so a required `alignment` is surfaced natively; and
  `parseReport` rejects a review that omits it.
- A review that omits or contradicts `alignment` fails schema validation, which
  the executor treats as `failed_check`. That routes through review-step's
  **existing** `narrow_scope` recovery (back to act-step), exactly like any
  other malformed review today. No new failure path.
- The "re-ask the reviewer rather than re-implement" refinement (a cause-specific
  recovery binding so `failed_acceptance_criteria` re-enters review-step while
  `failed_check` still re-implements) is a documented fast-follow, not v1.

## Decisions resolved (so execution does not re-litigate)

- **Capture point:** the analyze relay (`build.context@v1`). The researcher
  extracts operator-stated non-goals from the goal and proposes code-grounded
  invariants. Default empty.
- **Carry:** the plan compose builder copies `guardrails` from context into
  `build.plan@v1`. Deterministic, no model. Context read is already optional in
  `plan.ts`, so a context-less plan yields empty guardrails.
- **Enforce (presence):** `alignment` is a required field on `build.review@v1`.
  Native structured output surfaces it; `parseReport` rejects its absence.
- **Enforce (consistency):** a `superRefine` on `BuildReview`. If
  `scope_adherence === 'exceeds_scope'`, findings must be non-empty. If any
  guardrail status is `violated`, the verdict may not be `accept` and findings
  must be non-empty.
- **Never-inert spine:** `scope_adherence` is required inside `alignment` and is
  always assessable against the always-present brief, so the gate works with zero
  declared guardrails.
- **Soft guard at Act:** one advisory line in the implementer relay hint. Not
  enforcement.
- **Not used:** acceptance criteria on review-step (routing collision above);
  cross-report validators (a failure mis-routes to the implementer, not a
  reviewer re-ask).

## Schema shapes

In `src/flows/build/reports.ts`:

```ts
// Shared guardrails carried context -> plan.
export const BuildGuardrails = z
  .object({
    non_goals: z.array(z.string().min(1)).default([]),
    invariants: z.array(z.string().min(1)).default([]),
  })
  .strict();

// Per-guardrail review judgment.
const BuildAlignmentNonGoal = z.object({
  statement: z.string().min(1),
  status: z.enum(['respected', 'violated', 'not_applicable']),
  evidence: z.string().min(1),
}).strict();

const BuildAlignmentInvariant = z.object({
  statement: z.string().min(1),
  status: z.enum(['preserved', 'violated', 'not_applicable']),
  evidence: z.string().min(1),
}).strict();

export const BuildReviewAlignment = z.object({
  scope_adherence: z.enum(['within_scope', 'exceeds_scope']),
  non_goals: z.array(BuildAlignmentNonGoal).default([]),
  invariants: z.array(BuildAlignmentInvariant).default([]),
}).strict();
```

- `BuildContext`: add `guardrails: BuildGuardrails.default({ non_goals: [], invariants: [] })`.
- `BuildPlan`: add `guardrails: BuildGuardrails.default({ non_goals: [], invariants: [] })`.
  (Supply the complete default object, not `.default({})`: Zod v4's `.default(value)`
  returns the value as-is without re-parsing, so an empty-object default would NOT
  fill the inner `non_goals`/`invariants` arrays.)
- `BuildReview`: add `alignment: BuildReviewAlignment` (**required**), and extend
  the existing `superRefine`:
  - if `alignment.scope_adherence === 'exceeds_scope'` and findings empty -> issue.
  - if any `alignment.non_goals[].status === 'violated'` or
    `alignment.invariants[].status === 'violated'`:
    - if verdict === 'accept' -> issue on `verdict`.
    - if findings empty -> issue on `findings`.

`.default(...)` keeps existing fixtures valid on the capture side (context/plan):
omitting `guardrails` yields `{ non_goals: [], invariants: [] }`. On the review
side `alignment` is required, so every review fixture must include it (a review
without an intent-alignment assessment is incomplete by construction).

## Code changes

1. `src/flows/build/reports.ts`: schemas above. No `data.ts` route or acceptance
   change.
2. `src/flows/build/writers/plan.ts`: set `guardrails` on the plan output from
   `grounding?.guardrails ?? { non_goals: [], invariants: [] }`.
3. `src/flows/build/relay-hints.ts`:
   - `buildContextShapeHint`: add `guardrails` to the JSON shape and an
     instruction to extract operator-stated non-goals and propose code-grounded
     invariants, default empty arrays.
   - `buildImplementationShapeHint`: one advisory line to stay inside the plan's
     non-goals and preserve its invariants.
   - `buildReviewShapeHint`: add `alignment` to the JSON shape and an instruction
     to set `scope_adherence` against the brief and to add one entry per declared
     guardrail with a status and evidence. State that `alignment` is required.

## Tests (write first, watch fail, then implement)

- `tests/contracts/build-report-schemas.test.ts`:
  - context/plan accept omitted `guardrails` and default to empty.
  - context/plan accept populated `guardrails`.
  - review requires `alignment` (omission -> parse error).
  - review accepts a valid `alignment`.
  - review `superRefine`: `exceeds_scope` + empty findings -> parse error.
  - review `superRefine`: a `violated` guardrail + verdict `accept` -> parse error.
  - review `superRefine`: a `violated` guardrail + verdict `accept-with-fixes`
    + a finding -> ok.
  - existing minimal-review parses get an `alignment` block added.
- `tests/runner/build-grounded-planning.test.ts` (or a sibling): the plan
  composer carries `guardrails` from context; absent context -> empty guardrails.
- `tests/runner/relay-shape-hint-registry.test.ts`: update expected hint content
  for context/implementation/review.
- Update build review fixtures so review results include `alignment`:
  `tests/helpers/runtime-flow.ts` (shared), `tests/runner/build-runtime-wiring.ts`
  (`relayerWith` default + the reject/empty-fixes/followups overrides), and any
  other site a Build review body is synthesized or parsed.

## Regeneration and verification

- `npm run emit-flows` (regenerate schematic.json + host mirrors).
- `npm run check-flow-drift`.
- Focused: `npm run test -- build-report-schemas build-grounded-planning relay-shape-hint-registry build-runtime-wiring flow-runtime-smoke`.
- Then `npm run verify`.

## Out of scope (fast-follow)

Prototype/Fix parity; `allowed_touch_area` containment check; operator-declared
guardrails in the Frame template; close-stage memory proposal; cause-specific
recovery binding so a missing/incoherent `alignment` re-asks the reviewer
instead of re-implementing.

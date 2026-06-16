import { BuildResult, BuildScope } from '../reports.js';
import type {
  BuildBrief,
  BuildImplementation,
  BuildPlan,
  BuildReview,
  BuildScope as BuildScopeType,
  BuildTouchArea,
  BuildTouchAreaSummary,
  BuildVerification,
} from '../reports.js';

export type BuildResultProjectorInputs = {
  readonly brief: BuildBrief;
  readonly plan: BuildPlan;
  readonly implementation: BuildImplementation;
  readonly verification: BuildVerification;
  // review and touchArea are present for the full build flow, which always runs
  // both steps. A whole-grain (folded) build-derived flow drops those steps, so
  // the projector receives neither. Absence is represented honestly as "not
  // assessed", never as a fabricated pass.
  readonly review?: BuildReview | undefined;
  readonly touchArea?: BuildTouchArea | undefined;
  readonly evidenceLinks: BuildResult['evidence_links'];
};

// Project the full touch-area report down to the operator-facing summary the
// result carries. The git-proven containment verdict is already decided in the
// verification writer; close only surfaces it and gates on it.
function summarizeTouchArea(touchArea: BuildTouchArea): BuildTouchAreaSummary {
  return {
    enforcement: touchArea.enforcement,
    containment: touchArea.containment,
    out_of_bounds_paths: touchArea.out_of_bounds_paths,
  };
}

// Normalize a guardrail statement for coverage matching: trim, collapse inner
// whitespace, lowercase. The reviewer is instructed to echo each guardrail
// statement from the plan, so an exact-after-normalization match is the right
// coverage test; a reworded statement counts as unassessed and surfaces as a
// named gap rather than silently passing.
function normalizeStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
}

// The scope of a build whose flow ran no review. With no reviewer alignment to
// reconcile, every plan-declared guardrail is, by definition, unassessed; we
// name them all so the gap stays legible rather than reading as a clean pass.
// adherence stays 'within_scope' (the enum has no "not assessed" value), but
// the named unassessed guardrails plus the 'not_assessed' review verdict keep
// the result out of 'complete'.
function unassessedScope(plan: BuildPlan): BuildScopeType {
  return BuildScope.parse({
    adherence: 'within_scope',
    violated_guardrails: [],
    unassessed_guardrails: [...plan.guardrails.non_goals, ...plan.guardrails.invariants],
  });
}

// Reconcile the reviewer's alignment against the plan's declared guardrails.
// This is the single deterministic place the two reports meet: the reviewer
// self-reports per-guardrail status, and here we compute which declared
// guardrails the reviewer actually assessed and which it left untouched.
function computeScope(plan: BuildPlan, review: BuildReview): BuildScopeType {
  const { alignment } = review;
  const violated = [
    ...alignment.non_goals.filter((entry) => entry.status === 'violated'),
    ...alignment.invariants.filter((entry) => entry.status === 'violated'),
  ].map((entry) => entry.statement);

  const assessedNonGoals = new Set(
    alignment.non_goals.map((entry) => normalizeStatement(entry.statement)),
  );
  const assessedInvariants = new Set(
    alignment.invariants.map((entry) => normalizeStatement(entry.statement)),
  );
  const unassessed = [
    ...plan.guardrails.non_goals.filter(
      (statement) => !assessedNonGoals.has(normalizeStatement(statement)),
    ),
    ...plan.guardrails.invariants.filter(
      (statement) => !assessedInvariants.has(normalizeStatement(statement)),
    ),
  ];

  return BuildScope.parse({
    adherence: alignment.scope_adherence,
    violated_guardrails: violated,
    unassessed_guardrails: unassessed,
  });
}

export function projectBuildResult(inputs: BuildResultProjectorInputs): BuildResult {
  const { review, touchArea: touchAreaReport } = inputs;

  // Scope. With a review, reconcile its alignment against the plan; without one,
  // every declared guardrail is unassessed.
  const scope =
    review === undefined ? unassessedScope(inputs.plan) : computeScope(inputs.plan, review);
  const scopeClean =
    scope.adherence === 'within_scope' &&
    scope.violated_guardrails.length === 0 &&
    scope.unassessed_guardrails.length === 0;

  // Touch area. With a touch-area report, surface its git-proven verdict;
  // without one (a folded flow that ran no gate), mark it 'not_assessed', which
  // is honest (containment was never proven) and blocks 'complete'.
  const touchArea: BuildTouchAreaSummary =
    touchAreaReport === undefined
      ? { enforcement: 'not_assessed', containment: 'not_assessed', out_of_bounds_paths: [] }
      : summarizeTouchArea(touchAreaReport);
  // The git-proven containment gate. 'within' covers both a contained change and
  // a not-enforced gate (no declared area). 'out_of_bounds', 'undetermined'
  // (HEAD moved or a path hidden from git), and 'not_assessed' (no gate ran) all
  // block 'complete'.
  const touchAreaClean = touchArea.containment === 'within';

  // The result-level review verdict. A present review carries its real verdict;
  // an absent review is the honest 'not_assessed' sentinel, never a fabricated
  // 'accept'.
  const reviewVerdict: BuildResult['review_verdict'] =
    review === undefined ? 'not_assessed' : review.verdict;

  // Outcome derivation, in priority order:
  //   - verification not passing               -> failed
  //   - reviewer rejected                      -> failed
  //   - accept AND scope clean AND in bounds   -> complete
  //   - accept-with-fixes, a scope issue, an   -> needs_attention
  //     out-of-bounds/undetermined touch area,
  //     or a review/touch-area that never ran
  // A folded flow has no reviewer to reject and no gate to fail, so with a
  // passing verification it always lands at needs_attention: the work is done,
  // but no independent review or containment proof backs it.
  const outcome: BuildResult['outcome'] =
    inputs.verification.overall_status !== 'passed'
      ? 'failed'
      : reviewVerdict === 'reject'
        ? 'failed'
        : reviewVerdict === 'accept' && scopeClean && touchAreaClean
          ? 'complete'
          : 'needs_attention';

  return BuildResult.parse({
    summary: `Build result for ${inputs.brief.objective}: ${inputs.implementation.summary}`,
    outcome,
    verification_status: inputs.verification.overall_status,
    review_verdict: reviewVerdict,
    scope,
    touch_area: touchArea,
    evidence_links: inputs.evidenceLinks,
  });
}

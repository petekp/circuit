import { BuildResult, BuildScope } from '../reports.js';
import type {
  BuildBrief,
  BuildImplementation,
  BuildPlan,
  BuildReview,
  BuildScope as BuildScopeType,
  BuildVerification,
} from '../reports.js';

export type BuildResultProjectorInputs = {
  readonly brief: BuildBrief;
  readonly plan: BuildPlan;
  readonly implementation: BuildImplementation;
  readonly verification: BuildVerification;
  readonly review: BuildReview;
  readonly evidenceLinks: BuildResult['evidence_links'];
};

// Normalize a guardrail statement for coverage matching: trim, collapse inner
// whitespace, lowercase. The reviewer is instructed to echo each guardrail
// statement from the plan, so an exact-after-normalization match is the right
// coverage test; a reworded statement counts as unassessed and surfaces as a
// named gap rather than silently passing.
function normalizeStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
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
  const scope = computeScope(inputs.plan, inputs.review);
  const scopeClean =
    scope.adherence === 'within_scope' &&
    scope.violated_guardrails.length === 0 &&
    scope.unassessed_guardrails.length === 0;

  // Outcome derivation, in priority order:
  //   - verification not passing             -> failed
  //   - reviewer rejected                    -> failed
  //   - accept AND scope clean               -> complete
  //   - accept-with-fixes, or accept with a  -> needs_attention
  //     scope issue (exceeds-scope/unassessed)
  const outcome: BuildResult['outcome'] =
    inputs.verification.overall_status !== 'passed'
      ? 'failed'
      : inputs.review.verdict === 'reject'
        ? 'failed'
        : inputs.review.verdict === 'accept' && scopeClean
          ? 'complete'
          : 'needs_attention';

  return BuildResult.parse({
    summary: `Build result for ${inputs.brief.objective}: ${inputs.implementation.summary}`,
    outcome,
    verification_status: inputs.verification.overall_status,
    review_verdict: inputs.review.verdict,
    scope,
    evidence_links: inputs.evidenceLinks,
  });
}

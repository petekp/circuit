// Fix result projector — the single source of truth for how proof reports
// project into the FixResult shape. The close writer and any runtime
// self-check both go through this function so the runtime cannot drift from
// its own evidence: there is exactly one place that decides what counts as
// 'fixed', 'partial', 'not-reproduced', or 'failed'.
//
// Inputs are already-parsed proof reports. Pointers are built by the caller
// from compiled-flow context and passed in. The projector itself does not
// touch the filesystem or the flow registry — it is a pure function from
// proof state to FixResult.

import type {
  FixBrief,
  FixChange,
  FixChangeSet,
  FixDiagnosis,
  FixRegressionProof,
  FixRegressionRerun,
  FixResult,
  FixResultReportPointer,
  FixReview,
  FixVerification,
} from '../reports.js';
import { FixResult as FixResultSchema } from '../reports.js';

export interface FixResultProjectorInputs {
  brief: FixBrief;
  diagnosis: FixDiagnosis;
  regression: FixRegressionProof;
  regression_rerun: FixRegressionRerun;
  change: FixChange;
  change_set: FixChangeSet;
  verification: FixVerification;
  review?: FixReview;
  review_skip_reason?: string;
  evidence_links: FixResultReportPointer[];
}

export function projectFixResult(inputs: FixResultProjectorInputs): FixResult {
  const {
    brief,
    diagnosis,
    regression,
    regression_rerun: regressionRerun,
    change,
    change_set: changeSet,
    verification,
    review,
    review_skip_reason: reviewSkipReason,
    evidence_links,
  } = inputs;

  const verificationStatus: FixResult['verification_status'] =
    verification.overall_status === 'passed' ? 'passed' : 'failed';
  const regressionStatus: FixResult['regression_status'] =
    regression.status === 'proved' ? 'proved' : 'deferred';
  const regressionRerunStatus: FixResult['regression_rerun_status'] = regressionRerun.status;
  const changeSetStatus: FixResult['change_set_status'] = changeSet.status;
  const reviewStatus: FixResult['review_status'] = review === undefined ? 'skipped' : 'completed';
  const hasNoReproDecision = evidence_links.some(
    (pointer) => pointer.report_id === 'fix.no-repro-decision',
  );

  const fixedGate =
    verificationStatus === 'passed' &&
    regressionStatus === 'proved' &&
    regressionRerunStatus === 'cleared' &&
    changeSetStatus === 'pass' &&
    (review === undefined || review.verdict === 'accept');
  const partialGate =
    verificationStatus === 'passed' &&
    (regressionStatus !== 'proved' ||
      regressionRerunStatus !== 'cleared' ||
      changeSetStatus === 'fail' ||
      review?.verdict === 'accept-with-fixes');
  const noReproDecisionGate =
    hasNoReproDecision &&
    diagnosis.reproduction_status === 'not-reproduced' &&
    regressionStatus !== 'proved';

  const outcome: FixResult['outcome'] = fixedGate
    ? 'fixed'
    : noReproDecisionGate
      ? 'not-reproduced'
      : partialGate
        ? 'partial'
        : 'failed';

  return FixResultSchema.parse({
    summary: `Fix '${brief.problem_statement}': ${change.summary}`,
    outcome,
    verification_status: verificationStatus,
    regression_status: regressionStatus,
    regression_rerun_status: regressionRerunStatus,
    change_set_status: changeSetStatus,
    review_status: reviewStatus,
    ...(review === undefined ? {} : { review_verdict: review.verdict }),
    ...(review === undefined
      ? {
          review_skip_reason: reviewSkipReason ?? 'Low depth skipped review per route_overrides.',
        }
      : {}),
    residual_risks: [...diagnosis.residual_uncertainty],
    evidence_links,
  });
}

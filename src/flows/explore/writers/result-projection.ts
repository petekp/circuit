import { ExploreResult } from '../reports.js';
import type {
  ExploreBrief,
  ExploreCompose,
  ExploreDecision,
  ExploreReviewVerdict,
  ExploreTournamentReview,
} from '../reports.js';

export type ExploreResultProjectorInputs =
  | {
      readonly kind: 'default';
      readonly brief: ExploreBrief;
      readonly compose: ExploreCompose;
      readonly review: ExploreReviewVerdict;
      readonly evidenceLinks: ExploreResult['evidence_links'];
    }
  | {
      readonly kind: 'tournament';
      readonly brief: ExploreBrief;
      readonly review: ExploreTournamentReview;
      readonly decision: ExploreDecision;
      readonly evidenceLinks: ExploreResult['evidence_links'];
    };

function reviewHasFoldIns(review: ExploreReviewVerdict): boolean {
  return (
    review.verdict === 'accept-with-fold-ins' ||
    review.objections.length > 0 ||
    review.missed_angles.length > 0
  );
}

export function projectExploreResult(inputs: ExploreResultProjectorInputs): ExploreResult {
  if (inputs.kind === 'tournament') {
    return ExploreResult.parse({
      summary: `Explore '${inputs.brief.subject}': ${inputs.decision.decision}`,
      verdict_snapshot: {
        decision_verdict: inputs.decision.verdict,
        tournament_review_verdict: inputs.review.verdict,
        selected_option_id: inputs.decision.selected_option_id,
        objection_count: inputs.review.objections.length,
        missing_evidence_count: inputs.review.missing_evidence.length,
      },
      evidence_links: inputs.evidenceLinks,
    });
  }

  // Reached with the review still rejecting: the rework budget ran out. Hand
  // the recommendation over rather than discard it, and say in the same breath
  // that it did not pass, so a reader skimming one line cannot take it as
  // settled. The reviewer's objections ride along in review_fold_ins, which
  // the schema already requires whenever there are any.
  const rejected = inputs.review.verdict === 'reject';
  return ExploreResult.parse({
    summary: rejected
      ? `Explore '${inputs.brief.subject}': ${inputs.compose.recommendation} (did not pass review; the reviewer's objections are recorded with it)`
      : `Explore '${inputs.brief.subject}': ${inputs.compose.recommendation}`,
    ...(rejected ? { outcome: 'stopped' } : {}),
    verdict_snapshot: {
      compose_verdict: inputs.compose.verdict,
      review_verdict: inputs.review.verdict,
      objection_count: inputs.review.objections.length,
      missed_angle_count: inputs.review.missed_angles.length,
    },
    ...(reviewHasFoldIns(inputs.review)
      ? {
          review_fold_ins: {
            overall_assessment: inputs.review.overall_assessment,
            objections: inputs.review.objections,
            missed_angles: inputs.review.missed_angles,
          },
        }
      : {}),
    evidence_links: inputs.evidenceLinks,
  });
}

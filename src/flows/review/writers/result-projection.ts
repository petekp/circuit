import {
  type ReviewEvidence,
  type ReviewEvidenceSummary,
  type ReviewIntake,
  type ReviewRelayResult,
  ReviewResult,
  computeReviewVerdict,
} from '../reports.js';

function evidenceSummary(evidence: ReviewEvidence): ReviewEvidenceSummary {
  if (evidence.kind === 'unavailable') {
    return { kind: 'unavailable', message: evidence.reason };
  }
  return {
    kind: 'git-working-tree',
    untracked_content_policy: evidence.untracked_content_policy,
    untracked_file_count: evidence.untracked_file_count,
    untracked_files_sampled: evidence.untracked_files.length,
    untracked_files_truncated: evidence.untracked_files_truncated,
  };
}

export function projectReviewResult(input: {
  readonly intake: ReviewIntake;
  readonly relayResult: ReviewRelayResult;
}): ReviewResult {
  const verdict = computeReviewVerdict(input.relayResult.findings);
  const outcome = verdict === 'CLEAN' ? 'complete' : 'stopped';
  return ReviewResult.parse({
    scope: input.intake.scope,
    findings: input.relayResult.findings,
    verdict,
    outcome,
    assessment: input.relayResult.assessment,
    verification: input.relayResult.verification,
    confidence_limitations: input.relayResult.confidence_limitations,
    evidence_summary: evidenceSummary(input.intake.evidence),
    evidence_warnings: input.intake.evidence_warnings,
  });
}

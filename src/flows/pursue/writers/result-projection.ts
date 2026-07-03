import { PursuitResult } from '../reports.js';
import type {
  PursuitBatch,
  PursuitContract,
  PursuitReview,
  PursuitVerification,
} from '../reports.js';

export type PursuitResultProjectorInputs = {
  readonly contract: PursuitContract;
  readonly batch: PursuitBatch;
  readonly verification: PursuitVerification;
  readonly review: PursuitReview;
  readonly evidenceLinks: PursuitResult['evidence_links'];
};

function assertBatchCoversContract(contract: PursuitContract, batch: PursuitBatch): void {
  const expected = new Set(contract.pursuits.map((pursuit) => pursuit.id));
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const item of [...batch.completed, ...batch.skipped, ...batch.blocked, ...batch.failed]) {
    if (!expected.has(item.pursuit_id)) {
      issues.push(`unknown pursuit id '${item.pursuit_id}'`);
      continue;
    }
    if (seen.has(item.pursuit_id)) {
      issues.push(`duplicate pursuit id '${item.pursuit_id}'`);
      continue;
    }
    seen.add(item.pursuit_id);
  }
  for (const id of expected) {
    if (!seen.has(id)) issues.push(`missing pursuit id '${id}'`);
  }
  if (issues.length > 0) {
    throw new Error(`pursuit.batch@v1 does not cover pursuit.contract@v1: ${issues.join('; ')}`);
  }
}

// The review must attest every contracted pursuit exactly once. This is the
// cross-report half of the F12 fix: the schema forces a non-empty, per-pursuit
// attestation list, and this check ties those attestations to the real pursuit
// set so a review cannot close by naming a subset (or none) of the work.
function assertReviewCoversContract(contract: PursuitContract, review: PursuitReview): void {
  const expected = new Set(contract.pursuits.map((pursuit) => pursuit.id));
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const attestation of review.reviewed_pursuits) {
    if (!expected.has(attestation.pursuit_id)) {
      issues.push(`unknown pursuit id '${attestation.pursuit_id}'`);
      continue;
    }
    if (seen.has(attestation.pursuit_id)) {
      issues.push(`duplicate pursuit id '${attestation.pursuit_id}'`);
      continue;
    }
    seen.add(attestation.pursuit_id);
  }
  for (const id of expected) {
    if (!seen.has(id)) issues.push(`missing pursuit id '${id}'`);
  }
  if (issues.length > 0) {
    throw new Error(`pursuit.review@v1 does not attest pursuit.contract@v1: ${issues.join('; ')}`);
  }
}

export function projectPursuitResult(inputs: PursuitResultProjectorInputs): PursuitResult {
  assertBatchCoversContract(inputs.contract, inputs.batch);
  assertReviewCoversContract(inputs.contract, inputs.review);

  const completedCount = inputs.batch.completed.length;
  const skippedCount = inputs.batch.skipped.length;
  const blockedCount = inputs.batch.blocked.length;
  const failedCount = inputs.batch.failed.length;
  const verificationOk = inputs.verification.overall_status === 'passed';

  const outcome =
    failedCount > 0 || !verificationOk
      ? 'failed'
      : blockedCount > 0 ||
          inputs.batch.verdict === 'blocked' ||
          inputs.review.verdict === 'blocked'
        ? 'blocked'
        : skippedCount > 0 ||
            inputs.review.verdict === 'needs-followup' ||
            inputs.batch.verdict === 'partial'
          ? 'needs_attention'
          : 'complete';

  return PursuitResult.parse({
    summary: `Pursuits result for ${inputs.contract.objective}: ${inputs.batch.summary}`,
    outcome,
    verification_status: inputs.verification.overall_status,
    review_verdict: inputs.review.verdict,
    total_pursuits: inputs.contract.pursuits.length,
    completed_count: completedCount,
    skipped_count: skippedCount,
    blocked_count: blockedCount,
    failed_count: failedCount,
    serial_code_writes: true,
    evidence_links: inputs.evidenceLinks,
  });
}

/**
 * Merging per-unit reviewer verdicts into one review.
 *
 * The audit step fans out one reviewer per unit, and each reviewer answers
 * about the slice it was handed. The close step has to turn those answers into
 * a single verdict without ever letting the merge read wider than what actually
 * came back: a unit whose reviewer failed is not a clean unit, and a review
 * that quietly dropped it would be a review that lied about its coverage.
 *
 * So the merge does two things. It concatenates the substance — every finding,
 * every verification step, every limitation the reviewers reported. And it
 * turns each missing unit into a finding of its own, which is what stops a
 * partially covered target from closing CLEAN.
 */

import type {
  ReviewAuditAggregate,
  ReviewFinding,
  ReviewIntake,
  ReviewIntakeUnit,
  ReviewRelayResult,
} from '../reports.js';

export interface ReviewUnitMerge {
  /** The merged reviewer answer, shaped exactly like a single reviewer's. */
  readonly relayResult: ReviewRelayResult;
  /** Units the audit could not produce a verdict for, in intake order. */
  readonly missingUnitIds: readonly string[];
}

function unitLabel(units: ReadonlyMap<string, ReviewIntakeUnit>, unitId: string): string {
  const unit = units.get(unitId);
  return unit === undefined ? unitId : `${unitId} (${unit.label})`;
}

// A reviewer's prose is about one slice, so attributing it is the difference
// between a report a person can act on and a wall of paragraphs about "the
// code". A single-unit review is the whole target, so it says nothing extra
// and reads exactly as it did before Review split anything.
function attributed(text: string, label: string, multiUnit: boolean): string {
  return multiUnit ? `${label}: ${text}` : text;
}

/**
 * The finding that keeps a partial audit from closing clean.
 *
 * It is a finding rather than only a limitation on purpose: `computeReviewVerdict`
 * reads findings, so this is the mechanism that makes the verdict itself
 * non-CLEAN. A limitation alone would leave a green verdict over code nobody
 * looked at.
 */
function coverageFinding(
  missing: readonly string[],
  units: ReadonlyMap<string, ReviewIntakeUnit>,
): ReviewFinding {
  const names = missing.map((unitId) => unitLabel(units, unitId)).join(', ');
  const filesFromMissing = [
    ...new Set(missing.flatMap((unitId) => units.get(unitId)?.paths ?? [])),
  ];
  return {
    severity: 'medium',
    id: 'circuit-review-unit-not-reviewed',
    text:
      missing.length === 1
        ? `No reviewer verdict came back for one part of this target (${names}), so this Review cannot be reported as clean: that part was not reviewed.`
        : `No reviewer verdict came back for ${missing.length} parts of this target (${names}), so this Review cannot be reported as clean: those parts were not reviewed.`,
    file_refs: filesFromMissing,
  };
}

/**
 * The finding for a target the units never covered in the first place.
 *
 * Truncation happens before any reviewer runs: the target was larger than
 * Review could pack. It is the same honesty problem as a failed unit and gets
 * the same treatment.
 */
function truncationFinding(intake: ReviewIntake): ReviewFinding | undefined {
  const coverage = intake.unit_coverage;
  if (!coverage.truncated) return undefined;
  return {
    severity: 'medium',
    id: 'circuit-review-target-truncated',
    text: `This target was larger than Review could take in: it reviewed ${coverage.reviewed_file_count} of ${coverage.matched_file_count} files, so this Review cannot be reported as clean. Name a narrower path to review the rest.`,
    file_refs: [],
  };
}

export function mergeReviewUnits(input: {
  readonly intake: ReviewIntake;
  readonly aggregate: ReviewAuditAggregate;
}): ReviewUnitMerge {
  const units = new Map(input.intake.units.map((unit) => [unit.unit_id, unit]));
  const multiUnit = input.intake.units.length > 1;

  // Key by branch id, which is the unit id: the branch template builds it from
  // `$item.unit_id`, and the engine already rejected any reviewer that reported
  // under a different one (provenance_field).
  const bodies = new Map(
    input.aggregate.branches
      .filter((branch) => branch.admitted && branch.result_body !== undefined)
      .map((branch) => [branch.branch_id, branch.result_body]),
  );

  const findings: ReviewFinding[] = [];
  const assessments: string[] = [];
  const verification: string[] = [];
  const limitations: string[] = [];
  const missingUnitIds: string[] = [];

  // Walk the intake's units, not the aggregate's branches: the intake is the
  // list of everything that was supposed to be reviewed, so a unit that never
  // reached a branch at all is caught here rather than going unnoticed.
  for (const unit of input.intake.units) {
    const body = bodies.get(unit.unit_id);
    const label = unitLabel(units, unit.unit_id);
    if (body === undefined) {
      missingUnitIds.push(unit.unit_id);
      continue;
    }
    findings.push(...body.findings);
    assessments.push(attributed(body.assessment, label, multiUnit));
    verification.push(...body.verification.map((step) => attributed(step, label, multiUnit)));
    limitations.push(
      ...body.confidence_limitations.map((note) => attributed(note, label, multiUnit)),
    );
  }

  if (missingUnitIds.length === input.intake.units.length) {
    throw new Error(
      `Review cannot report a verdict: no reviewer produced a result for any of the ${input.intake.units.length} unit(s) in this target.`,
    );
  }

  if (missingUnitIds.length > 0) {
    findings.push(coverageFinding(missingUnitIds, units));
    limitations.push(
      `Review covered ${input.intake.units.length - missingUnitIds.length} of ${input.intake.units.length} parts of this target. Nothing is known about the rest.`,
    );
  }
  const truncation = truncationFinding(input.intake);
  if (truncation !== undefined) {
    findings.push(truncation);
    limitations.push(
      `Review read ${input.intake.unit_coverage.reviewed_file_count} of the ${input.intake.unit_coverage.matched_file_count} files this target matched.`,
    );
  }

  return {
    relayResult: {
      verdict: findings.length === 0 ? 'NO_ISSUES_FOUND' : 'ISSUES_FOUND',
      findings,
      assessment: assessments.join('\n\n'),
      verification,
      confidence_limitations: [...new Set(limitations)],
    },
    missingUnitIds,
  };
}

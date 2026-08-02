import { z } from 'zod';
import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER } from '../../policy/rubric.js';
import { RubricJudgment, RubricResult } from '../../schemas/rubric.js';
import { resultReportPointer } from '../report-schema-kit.js';

const EXPLORE_RESULT_SCHEMA_BY_ARTIFACT_ID = {
  'explore.brief': 'explore.brief@v1',
  'explore.analysis': 'explore.analysis@v1',
  'explore.compose': 'explore.compose@v1',
  'explore.review-verdict': 'explore.review-verdict@v1',
  'explore.decision-options': 'explore.decision-options@v1',
  'explore.tournament-aggregate': 'explore.tournament-aggregate@v1',
  'explore.tournament-review': 'explore.tournament-review@v1',
  'explore.decision': 'explore.decision@v1',
} as const;

const DEFAULT_RESULT_REPORT_IDS = [
  'explore.brief',
  'explore.analysis',
  'explore.compose',
  'explore.review-verdict',
] as const;

const TOURNAMENT_RESULT_REPORT_IDS = [
  'explore.brief',
  'explore.analysis',
  'explore.decision-options',
  'explore.tournament-aggregate',
  'explore.tournament-review',
  'explore.decision',
] as const;

export const ExploreBrief = z
  .object({
    subject: z.string().min(1),
    task: z.string().min(1),
    success_condition: z.string().min(1),
  })
  .strict();
export type ExploreBrief = z.infer<typeof ExploreBrief>;

export const ExploreEvidenceCitation = z
  .object({
    source: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();
export type ExploreEvidenceCitation = z.infer<typeof ExploreEvidenceCitation>;

export const ExploreAspect = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    evidence: z.array(ExploreEvidenceCitation).min(1),
  })
  .strict();
export type ExploreAspect = z.infer<typeof ExploreAspect>;

export const ExploreAnalysis = z
  .object({
    subject: z.string().min(1),
    aspects: z.array(ExploreAspect).min(1),
  })
  .strict();
export type ExploreAnalysis = z.infer<typeof ExploreAnalysis>;

export const ExploreComposeAspect = z
  .object({
    aspect: z.string().min(1),
    contribution: z.string().min(1),
    evidence_refs: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ExploreComposeAspect = z.infer<typeof ExploreComposeAspect>;

export const ExploreCompose = z
  .object({
    verdict: z.string().min(1),
    subject: z.string().min(1),
    recommendation: z.string().min(1),
    success_condition_alignment: z.string().min(1),
    supporting_aspects: z.array(ExploreComposeAspect).min(1),
  })
  .strict();
export type ExploreCompose = z.infer<typeof ExploreCompose>;

// 'reject' is schema-valid but deliberately absent from the review step's
// check.pass list: a reject is a handled non-pass outcome that routes the
// compose back to synthesize-step for rework (retry/revise), bounded by
// the engine's default max_attempts.
export const ExploreReviewVerdictValue = z.enum(['accept', 'accept-with-fold-ins', 'reject']);
export type ExploreReviewVerdictValue = z.infer<typeof ExploreReviewVerdictValue>;

export const ExploreReviewVerdict = z
  .object({
    verdict: ExploreReviewVerdictValue,
    overall_assessment: z.string().min(1),
    objections: z.array(z.string().min(1)),
    missed_angles: z.array(z.string().min(1)),
  })
  .strict();
export type ExploreReviewVerdict = z.infer<typeof ExploreReviewVerdict>;

export const ExploreReviewFoldIns = z
  .object({
    overall_assessment: z.string().min(1),
    objections: z.array(z.string().min(1)),
    missed_angles: z.array(z.string().min(1)),
  })
  .strict();
export type ExploreReviewFoldIns = z.infer<typeof ExploreReviewFoldIns>;

export const ExploreDecisionOptionId = z
  .string()
  .regex(/^option-[1-4]$/, { message: 'option id must be option-1 through option-4' });
export type ExploreDecisionOptionId = z.infer<typeof ExploreDecisionOptionId>;

export const ExploreRubricDimId = z.enum(THREE_AXIS_RUBRIC_TIE_BREAK_ORDER);
export type ExploreRubricDimId = z.infer<typeof ExploreRubricDimId>;

function refineExactExploreRubricDims(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
): void {
  const expected = new Set<string>(THREE_AXIS_RUBRIC_TIE_BREAK_ORDER);
  for (const dimId of THREE_AXIS_RUBRIC_TIE_BREAK_ORDER) {
    if (value[dimId] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [dimId],
        message: `missing rubric dim '${dimId}'`,
      });
    }
  }
  for (const dimId of Object.keys(value)) {
    if (!expected.has(dimId)) {
      ctx.addIssue({
        code: 'custom',
        path: [dimId],
        message: `unknown rubric dim '${dimId}'`,
      });
    }
  }
}

export const ExploreRubricModelJudgments = z
  .record(ExploreRubricDimId, RubricJudgment)
  .superRefine(refineExactExploreRubricDims);
export type ExploreRubricModelJudgments = z.infer<typeof ExploreRubricModelJudgments>;

export const ExploreDecisionOption = z
  .object({
    id: ExploreDecisionOptionId,
    label: z.string().min(1),
    summary: z.string().min(1),
    best_case_prompt: z.string().min(1),
    evidence_refs: z.array(z.string().min(1)).min(1),
    tradeoffs: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ExploreDecisionOption = z.infer<typeof ExploreDecisionOption>;

export const ExploreDecisionOptions = z
  .object({
    decision_question: z.string().min(1),
    options: z.array(ExploreDecisionOption).min(2).max(4),
    recommendation_basis: z.string().min(1),
  })
  .strict()
  .superRefine((report, ctx) => {
    const seen = new Set<ExploreDecisionOptionId>();
    for (const [index, option] of report.options.entries()) {
      if (seen.has(option.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', index, 'id'],
          message: `duplicate option id '${option.id}'`,
        });
      }
      seen.add(option.id);
    }
  });
export type ExploreDecisionOptions = z.infer<typeof ExploreDecisionOptions>;

export const ExploreTournamentProposal = z
  .object({
    verdict: z.literal('accept'),
    option_id: ExploreDecisionOptionId,
    option_label: z.string().min(1),
    case_summary: z.string(),
    assumptions: z.array(z.string().min(1)),
    evidence_refs: z.array(z.string().min(1)),
    risks: z.array(z.string().min(1)),
    next_action: z.string(),
    rubric_model_judgments: ExploreRubricModelJudgments,
  })
  .strict();
export type ExploreTournamentProposal = z.infer<typeof ExploreTournamentProposal>;

export const ExploreTournamentAggregateBranch = z
  .object({
    branch_id: ExploreDecisionOptionId,
    child_run_id: z.string().min(1),
    child_outcome: z.enum(['complete', 'aborted', 'handoff', 'stopped', 'escalated']),
    verdict: z.string().min(1),
    admitted: z.boolean(),
    result_path: z.string().min(1),
    duration_ms: z.number().nonnegative(),
    result_body: ExploreTournamentProposal.optional(),
    rubric_result: RubricResult.optional(),
  })
  .strict();
export type ExploreTournamentAggregateBranch = z.infer<typeof ExploreTournamentAggregateBranch>;

export const ExploreTournamentAggregate = z
  .object({
    schema_version: z.literal(1),
    join_policy: z.literal('aggregate-survivors'),
    branch_count: z.number().int().positive(),
    branches: z.array(ExploreTournamentAggregateBranch).min(1),
  })
  .strict()
  .superRefine((aggregate, ctx) => {
    if (aggregate.branch_count !== aggregate.branches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['branch_count'],
        message: 'branch_count must match branches.length',
      });
    }
    for (const [index, branch] of aggregate.branches.entries()) {
      if (branch.child_outcome === 'complete' && branch.result_body === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'result_body'],
          message: 'complete tournament branches must include result_body provenance',
        });
      }
      if (branch.child_outcome === 'complete' && branch.rubric_result === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'rubric_result'],
          message: 'complete tournament branches must include rubric_result provenance',
        });
      }
      if (
        branch.child_outcome === 'complete' &&
        branch.result_body !== undefined &&
        branch.result_body.option_id !== branch.branch_id
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'result_body', 'option_id'],
          message: `branch_id '${branch.branch_id}' must match result_body.option_id '${branch.result_body.option_id}'`,
        });
      }
    }
  });
export type ExploreTournamentAggregate = z.infer<typeof ExploreTournamentAggregate>;

export const ExploreTournamentReviewVerdict = z.enum([
  'recommend',
  'no-clear-winner',
  'needs-operator',
]);
export type ExploreTournamentReviewVerdict = z.infer<typeof ExploreTournamentReviewVerdict>;

export const ExploreTournamentReview = z
  .object({
    verdict: ExploreTournamentReviewVerdict,
    recommended_option_id: ExploreDecisionOptionId,
    comparison: z.string().min(1),
    objections: z.array(z.string().min(1)),
    missing_evidence: z.array(z.string().min(1)),
    tradeoff_question: z.string().min(1),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type ExploreTournamentReview = z.infer<typeof ExploreTournamentReview>;

export const ExploreDecisionRejectedOption = z
  .object({
    option_id: ExploreDecisionOptionId,
    reason: z.string().min(1),
  })
  .strict();
export type ExploreDecisionRejectedOption = z.infer<typeof ExploreDecisionRejectedOption>;

export const ExploreDecision = z
  .object({
    verdict: z.literal('decided'),
    decision_question: z.string().min(1),
    selected_option_id: ExploreDecisionOptionId,
    selected_option_label: z.string().min(1),
    decision: z.string().min(1),
    rationale: z.string().min(1),
    rejected_options: z.array(ExploreDecisionRejectedOption),
    evidence_links: z.array(z.string().min(1)).min(1),
    assumptions: z.array(z.string().min(1)),
    residual_risks: z.array(z.string().min(1)),
    next_action: z.string().min(1),
    follow_up_workflow: z.string().min(1),
  })
  .strict();
export type ExploreDecision = z.infer<typeof ExploreDecision>;

export const ExploreResultReportId = z.enum([
  'explore.brief',
  'explore.analysis',
  'explore.compose',
  'explore.review-verdict',
  'explore.decision-options',
  'explore.tournament-aggregate',
  'explore.tournament-review',
  'explore.decision',
]);
export type ExploreResultReportId = z.infer<typeof ExploreResultReportId>;

export const ExploreResultReportPointer = resultReportPointer(
  ExploreResultReportId,
  EXPLORE_RESULT_SCHEMA_BY_ARTIFACT_ID,
);
export type ExploreResultReportPointer = z.infer<typeof ExploreResultReportPointer>;

export const ExploreDefaultResultVerdictSnapshot = z
  .object({
    compose_verdict: z.string().min(1),
    review_verdict: ExploreReviewVerdictValue,
    objection_count: z.number().int().nonnegative(),
    missed_angle_count: z.number().int().nonnegative(),
  })
  .strict();
export type ExploreDefaultResultVerdictSnapshot = z.infer<
  typeof ExploreDefaultResultVerdictSnapshot
>;

export const ExploreTournamentResultVerdictSnapshot = z
  .object({
    decision_verdict: z.literal('decided'),
    tournament_review_verdict: ExploreTournamentReviewVerdict,
    selected_option_id: ExploreDecisionOptionId,
    objection_count: z.number().int().nonnegative(),
    missing_evidence_count: z.number().int().nonnegative(),
  })
  .strict();
export type ExploreTournamentResultVerdictSnapshot = z.infer<
  typeof ExploreTournamentResultVerdictSnapshot
>;

export const ExploreResultVerdictSnapshot = z.union([
  ExploreDefaultResultVerdictSnapshot,
  ExploreTournamentResultVerdictSnapshot,
]);
export type ExploreResultVerdictSnapshot = z.infer<typeof ExploreResultVerdictSnapshot>;

function refineExploreEvidenceLinks(
  result: { readonly evidence_links: readonly ExploreResultReportPointer[] },
  ctx: z.RefinementCtx,
  expectedReportIds: readonly ExploreResultReportId[],
): void {
  const seen = new Set<ExploreResultReportId>();
  for (const [index, pointer] of result.evidence_links.entries()) {
    if (seen.has(pointer.report_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence_links', index, 'report_id'],
        message: `duplicate report_id '${pointer.report_id}'`,
      });
    }
    seen.add(pointer.report_id);
  }
  const matchesSet =
    result.evidence_links.length === expectedReportIds.length &&
    expectedReportIds.every((reportId) => seen.has(reportId));
  if (!matchesSet) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence_links'],
      message: `evidence_links must contain exactly: ${expectedReportIds.join(', ')}`,
    });
  }
}

export const ExploreDefaultResult = z
  .object({
    summary: z.string().min(1),
    verdict_snapshot: ExploreDefaultResultVerdictSnapshot,
    review_fold_ins: ExploreReviewFoldIns.optional(),
    // Set only when the close was reached with the review still rejecting,
    // which happens when the rework budget ran out. A literal rather than a
    // free enum: 'stopped' is the one non-clean state this close can reach, so
    // no other word can be written here. Absent means the review accepted, and
    // the engine already reads an absent flow outcome as clean.
    //
    // Explore arms `binds_terminal_outcome_to_primary_result`, so this word is
    // what stops an unaccepted recommendation from closing the run as a
    // success.
    outcome: z.literal('stopped').optional(),
    evidence_links: z.array(ExploreResultReportPointer).min(1),
  })
  .strict()
  .superRefine((result, ctx) => {
    refineExploreEvidenceLinks(result, ctx, DEFAULT_RESULT_REPORT_IDS);

    const snapshot = result.verdict_snapshot;
    // The no-false-success guard, enforced by the schema rather than trusted to
    // the writer: a rejected review must carry the stopped outcome, and an
    // accepted one must not claim to have stopped.
    if (snapshot.review_verdict === 'reject' && result.outcome !== 'stopped') {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message:
          "outcome must be 'stopped' when the Explore review verdict is 'reject': a recommendation the reviewer never accepted cannot close the run as a success",
      });
    }
    if (snapshot.review_verdict !== 'reject' && result.outcome !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: "outcome is set only when the Explore review verdict is 'reject'",
      });
    }
    const requiresFoldIns =
      snapshot.review_verdict === 'accept-with-fold-ins' ||
      snapshot.objection_count > 0 ||
      snapshot.missed_angle_count > 0;
    if (requiresFoldIns && result.review_fold_ins === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['review_fold_ins'],
        message:
          'review_fold_ins is required when the default Explore review verdict or counts report fold-ins',
      });
    }

    const foldIns = result.review_fold_ins;
    if (foldIns === undefined) return;
    if (foldIns.objections.length !== snapshot.objection_count) {
      ctx.addIssue({
        code: 'custom',
        path: ['review_fold_ins', 'objections'],
        message: 'review_fold_ins.objections length must match verdict_snapshot.objection_count',
      });
    }
    if (foldIns.missed_angles.length !== snapshot.missed_angle_count) {
      ctx.addIssue({
        code: 'custom',
        path: ['review_fold_ins', 'missed_angles'],
        message:
          'review_fold_ins.missed_angles length must match verdict_snapshot.missed_angle_count',
      });
    }
  });
export type ExploreDefaultResult = z.infer<typeof ExploreDefaultResult>;

export const ExploreTournamentResult = z
  .object({
    summary: z.string().min(1),
    verdict_snapshot: ExploreTournamentResultVerdictSnapshot,
    evidence_links: z.array(ExploreResultReportPointer).min(1),
  })
  .strict()
  .superRefine((result, ctx) => {
    refineExploreEvidenceLinks(result, ctx, TOURNAMENT_RESULT_REPORT_IDS);
  });
export type ExploreTournamentResult = z.infer<typeof ExploreTournamentResult>;

export const ExploreResult = z.union([ExploreDefaultResult, ExploreTournamentResult]);
export type ExploreResult = z.infer<typeof ExploreResult>;

import { z } from 'zod';
import { VerificationCommand } from './verification.js';

export const AcceptanceCriterionId = z.string().min(1);
export type AcceptanceCriterionId = z.infer<typeof AcceptanceCriterionId>;

export const AcceptanceCriteriaReportFieldPredicate = z.enum([
  'present',
  'non_empty',
  // Cross-checks a worker's self-reported path list against the real working
  // tree: every claimed path must actually differ on disk. Catches an
  // overclaiming worker that lists a file it never touched.
  'changed_on_disk',
]);
export type AcceptanceCriteriaReportFieldPredicate = z.infer<
  typeof AcceptanceCriteriaReportFieldPredicate
>;

export const AcceptanceCriteriaCommandCriterion = z
  .object({
    kind: z.literal('command'),
    id: AcceptanceCriterionId,
    command: VerificationCommand,
    expected_status: z.literal('passed'),
  })
  .strict();
export type AcceptanceCriteriaCommandCriterion = z.infer<typeof AcceptanceCriteriaCommandCriterion>;

export const AcceptanceCriteriaReportFieldCriterion = z
  .object({
    kind: z.literal('report_field'),
    id: AcceptanceCriterionId,
    path: z.array(z.string().min(1)).min(1),
    predicate: AcceptanceCriteriaReportFieldPredicate,
  })
  .strict();
export type AcceptanceCriteriaReportFieldCriterion = z.infer<
  typeof AcceptanceCriteriaReportFieldCriterion
>;

export const AcceptanceCriterion = z.discriminatedUnion('kind', [
  AcceptanceCriteriaCommandCriterion,
  AcceptanceCriteriaReportFieldCriterion,
]);
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const AcceptanceCriteriaFailurePolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('hard-fail') }).strict(),
  z.object({ mode: z.literal('retry-with-feedback') }).strict(),
]);
export type AcceptanceCriteriaFailurePolicy = z.infer<typeof AcceptanceCriteriaFailurePolicy>;

export const AcceptanceCriteria = z
  .object({
    checks: z.array(AcceptanceCriterion).min(1),
    on_failure: AcceptanceCriteriaFailurePolicy.default({ mode: 'hard-fail' }),
  })
  .strict();
export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteria>;

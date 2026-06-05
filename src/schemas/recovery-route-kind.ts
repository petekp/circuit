import { z } from 'zod';
import { StepId } from './ids.js';
import { Ref } from './ref.js';

export const RecoveryRouteKind = z.enum([
  'retry_same_step_with_feedback',
  'narrow_scope',
  'run_verification',
  'run_independent_review',
  'checkpoint_authority',
  'safe_apply_reject',
  'stop_unsafe',
  'escalate',
  'handoff',
]);
export type RecoveryRouteKind = z.infer<typeof RecoveryRouteKind>;

export const RecoveryFailureCause = z.enum([
  'failed_check',
  'failed_acceptance_criteria',
  'weak_proof',
  'unproved_claim',
  'contradicted_evidence',
  'scope_drift',
  'checkpoint_boundary',
  'relay_connector_failed',
  'relay_result_invalid',
  'base_mismatch',
  'apply_conflict',
  'budget_exceeded',
  'protected_file_touched',
  'generated_surface_drift',
  'unknown_failure',
]);
export type RecoveryFailureCause = z.infer<typeof RecoveryFailureCause>;

export const RecoveryRequiredRefKind = z.enum([
  'failed_check',
  'acceptance_feedback',
  'proof_assessment',
  'runtime_diff',
  'relay_result',
  'checkpoint_request',
  'safe_apply_result',
  'budget_state',
  'change_packet',
  'generated_surface_evidence',
  'trace',
  'report',
]);
export type RecoveryRequiredRefKind = z.infer<typeof RecoveryRequiredRefKind>;

export type RecoveryRefRequirement = {
  readonly anyOf: readonly RecoveryRequiredRefKind[];
  readonly message: string;
};

export type RecoveryKindContractRule = {
  readonly allowedFailureCauses: readonly RecoveryFailureCause[];
  readonly defaultRequiredRefs: readonly RecoveryRequiredRefKind[];
  readonly rejectsUnknownFailure?: boolean;
  readonly requiredRefs?: RecoveryRefRequirement;
  readonly causeRequiredRefs?: Partial<Record<RecoveryFailureCause, RecoveryRefRequirement>>;
};

export const RECOVERY_KIND_CONTRACT_RULES = {
  retry_same_step_with_feedback: {
    allowedFailureCauses: ['failed_check', 'failed_acceptance_criteria', 'relay_result_invalid'],
    defaultRequiredRefs: ['failed_check', 'acceptance_feedback', 'budget_state'],
    rejectsUnknownFailure: true,
  },
  narrow_scope: {
    allowedFailureCauses: ['failed_check', 'scope_drift', 'weak_proof', 'unproved_claim'],
    defaultRequiredRefs: ['proof_assessment', 'runtime_diff'],
  },
  run_verification: {
    allowedFailureCauses: [
      'failed_check',
      'weak_proof',
      'unproved_claim',
      'generated_surface_drift',
    ],
    defaultRequiredRefs: ['proof_assessment', 'generated_surface_evidence'],
    rejectsUnknownFailure: true,
  },
  run_independent_review: {
    allowedFailureCauses: ['weak_proof', 'contradicted_evidence', 'scope_drift'],
    defaultRequiredRefs: ['proof_assessment', 'report'],
    rejectsUnknownFailure: true,
  },
  checkpoint_authority: {
    allowedFailureCauses: [
      'checkpoint_boundary',
      'protected_file_touched',
      'budget_exceeded',
      'unknown_failure',
    ],
    defaultRequiredRefs: ['checkpoint_request', 'runtime_diff', 'budget_state'],
    causeRequiredRefs: {
      protected_file_touched: {
        anyOf: ['runtime_diff', 'change_packet'],
        message: 'protected_file_touched requires runtime_diff or change_packet refs',
      },
    },
  },
  safe_apply_reject: {
    allowedFailureCauses: [
      'base_mismatch',
      'apply_conflict',
      'protected_file_touched',
      'generated_surface_drift',
    ],
    defaultRequiredRefs: ['safe_apply_result', 'runtime_diff', 'generated_surface_evidence'],
    requiredRefs: {
      anyOf: ['safe_apply_result', 'runtime_diff', 'change_packet'],
      message: 'safe_apply_reject requires safe_apply_result, runtime_diff, or change_packet refs',
    },
    causeRequiredRefs: {
      protected_file_touched: {
        anyOf: ['runtime_diff', 'change_packet'],
        message: 'protected_file_touched requires runtime_diff or change_packet refs',
      },
    },
  },
  stop_unsafe: {
    allowedFailureCauses: [
      'failed_check',
      'contradicted_evidence',
      'scope_drift',
      'budget_exceeded',
      'unknown_failure',
    ],
    defaultRequiredRefs: ['failed_check', 'trace'],
  },
  escalate: {
    allowedFailureCauses: ['relay_connector_failed', 'budget_exceeded', 'unknown_failure'],
    defaultRequiredRefs: ['relay_result', 'trace'],
  },
  handoff: {
    allowedFailureCauses: ['checkpoint_boundary', 'budget_exceeded', 'unknown_failure'],
    defaultRequiredRefs: ['trace', 'report'],
  },
} satisfies Record<RecoveryRouteKind, RecoveryKindContractRule>;

export const RecoveryOperatorAuthority = z.enum([
  'not_required',
  'required_before_route',
  'required_to_continue_after_route',
]);
export type RecoveryOperatorAuthority = z.infer<typeof RecoveryOperatorAuthority>;

const RecoveryAttemptBudget = z
  .object({
    consumes_step_attempt: z.boolean(),
    must_respect_max_attempts: z.boolean(),
    retry_target: z.enum(['same_step', 'declared_step']).optional(),
  })
  .strict();
export type RecoveryAttemptBudget = z.infer<typeof RecoveryAttemptBudget>;

const RecoveryGuidanceRule = z
  .object({
    subject: z.literal('recovery_route'),
    must_match_step_completed: z.literal(true),
  })
  .strict();
export type RecoveryGuidanceRule = z.infer<typeof RecoveryGuidanceRule>;

export const RecoveryRouteBindingV0 = z
  .object({
    schema_version: z.literal(0),
    step_id: StepId,
    route_id: z.string().min(1),
    route_target: z.string().min(1),
    kind: RecoveryRouteKind,
    allowed_failure_causes: z.array(RecoveryFailureCause).min(1),
    required_refs: z.array(RecoveryRequiredRefKind).min(1),
    operator_authority: RecoveryOperatorAuthority,
    attempt_budget: RecoveryAttemptBudget,
    guidance: RecoveryGuidanceRule,
    source_ref: Ref,
  })
  .strict()
  .superRefine((binding, ctx) => {
    const requiredRefs = new Set(binding.required_refs);
    const causes = new Set(binding.allowed_failure_causes);
    const rule: RecoveryKindContractRule = RECOVERY_KIND_CONTRACT_RULES[binding.kind];
    const hasAnyRequiredRef = (requirement: RecoveryRefRequirement) =>
      requirement.anyOf.some((ref) => requiredRefs.has(ref));

    if (binding.kind === 'retry_same_step_with_feedback') {
      if (binding.route_target !== binding.step_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['route_target'],
          message: 'retry_same_step_with_feedback must target the same step',
        });
      }
      if (!requiredRefs.has('acceptance_feedback')) {
        ctx.addIssue({
          code: 'custom',
          path: ['required_refs'],
          message: 'retry_same_step_with_feedback requires acceptance_feedback refs',
        });
      }
      if (!binding.attempt_budget.consumes_step_attempt) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt_budget', 'consumes_step_attempt'],
          message: 'retry_same_step_with_feedback consumes the step attempt budget',
        });
      }
      if (!binding.attempt_budget.must_respect_max_attempts) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt_budget', 'must_respect_max_attempts'],
          message: 'retry_same_step_with_feedback must respect max_attempts',
        });
      }
      if (binding.attempt_budget.retry_target !== 'same_step') {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt_budget', 'retry_target'],
          message: 'retry_same_step_with_feedback requires retry_target same_step',
        });
      }
    }

    if (causes.has('unknown_failure') && rule.rejectsUnknownFailure === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowed_failure_causes'],
        message: 'unknown_failure cannot route to retry, verification, or independent review',
      });
    }

    if (rule.requiredRefs !== undefined && !hasAnyRequiredRef(rule.requiredRefs)) {
      ctx.addIssue({
        code: 'custom',
        path: ['required_refs'],
        message: rule.requiredRefs.message,
      });
    }

    const causeRequiredRefs = {
      ...(rule.causeRequiredRefs ?? {}),
      ...(causes.has('generated_surface_drift')
        ? {
            generated_surface_drift: {
              anyOf: ['generated_surface_evidence'],
              message: 'generated_surface_drift requires generated_surface_evidence refs',
            } satisfies RecoveryRefRequirement,
          }
        : {}),
    };
    for (const cause of binding.allowed_failure_causes) {
      const requirement = causeRequiredRefs[cause];
      if (requirement === undefined || hasAnyRequiredRef(requirement)) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['required_refs'],
        message: requirement.message,
      });
    }

    if (binding.source_ref.kind !== 'work_contract') {
      ctx.addIssue({
        code: 'custom',
        path: ['source_ref', 'kind'],
        message: 'recovery route bindings must point back to WorkContract refs',
      });
    }
  });
export type RecoveryRouteBindingV0 = z.infer<typeof RecoveryRouteBindingV0>;

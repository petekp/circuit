import { describe, expect, it } from 'vitest';

import {
  RECOVERY_KIND_CONTRACT_RULES,
  RecoveryRouteBindingV0,
  RecoveryRouteKind,
  StepId,
} from '../../src/index.js';

const workContractRef = {
  kind: 'work_contract' as const,
  ref: 'generated/flows/fix/circuit.work-contract.v0.json',
  sha256: 'a'.repeat(64),
  flow_id: 'fix',
};

function retryBinding(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 0,
    step_id: StepId.parse('act-step'),
    route_id: 'retry',
    route_target: 'act-step',
    kind: 'retry_same_step_with_feedback',
    allowed_failure_causes: ['failed_acceptance_criteria'],
    required_refs: ['retry_feedback'],
    operator_authority: 'not_required',
    attempt_budget: {
      consumes_step_attempt: true,
      must_respect_max_attempts: true,
      retry_target: 'same_step',
    },
    guidance: {
      subject: 'recovery_route',
      must_match_step_completed: true,
    },
    source_ref: workContractRef,
    ...overrides,
  };
}

describe('RecoveryRouteKind schema foundation', () => {
  it('keeps schema-local contract rules exhaustive over recovery kinds', () => {
    expect(Object.keys(RECOVERY_KIND_CONTRACT_RULES).sort()).toEqual(
      RecoveryRouteKind.options.slice().sort(),
    );
  });

  it('rejects route ids and older prose names as recovery kinds', () => {
    expect(RecoveryRouteKind.safeParse('retry').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('revise').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('retry-with-feedback').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('retry_with_feedback').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('retry_same_step_with_feedback').success).toBe(true);
  });

  it('accepts a same-step retry binding with feedback and attempt-budget rules', () => {
    expect(RecoveryRouteBindingV0.safeParse(retryBinding()).success).toBe(true);
  });

  it('rejects same-step retry bindings that target another step or skip feedback refs', () => {
    expect(
      RecoveryRouteBindingV0.safeParse(retryBinding({ route_target: 'review-step' })).success,
    ).toBe(false);

    expect(
      RecoveryRouteBindingV0.safeParse(retryBinding({ required_refs: ['failed_check'] })).success,
    ).toBe(false);
  });

  it('rejects retry bindings that bypass the step attempt budget', () => {
    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: true,
            retry_target: 'same_step',
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          attempt_budget: {
            consumes_step_attempt: true,
            must_respect_max_attempts: false,
            retry_target: 'same_step',
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects unknown failure routed to retry or verification work', () => {
    for (const kind of [
      'retry_same_step_with_feedback',
      'run_verification',
      'run_independent_review',
    ]) {
      expect(
        RecoveryRouteBindingV0.safeParse(
          retryBinding({
            kind,
            allowed_failure_causes: ['unknown_failure'],
          }),
        ).success,
      ).toBe(false);
    }
  });

  it('requires safe-apply reject bindings to cite safe-apply, diff, or change-packet refs', () => {
    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          route_id: 'reject',
          route_target: '@stop',
          kind: 'safe_apply_reject',
          allowed_failure_causes: ['apply_conflict'],
          required_refs: ['trace'],
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: false,
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          route_id: 'reject',
          route_target: '@stop',
          kind: 'safe_apply_reject',
          allowed_failure_causes: ['apply_conflict'],
          required_refs: ['safe_apply_result'],
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: false,
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('requires generated-surface and protected-file failures to carry the right refs', () => {
    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          kind: 'run_verification',
          allowed_failure_causes: ['generated_surface_drift'],
          required_refs: ['trace'],
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: false,
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          kind: 'run_verification',
          allowed_failure_causes: ['generated_surface_drift'],
          required_refs: ['generated_surface_evidence'],
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: false,
          },
        }),
      ).success,
    ).toBe(true);

    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          kind: 'checkpoint_authority',
          allowed_failure_causes: ['protected_file_touched'],
          required_refs: ['trace'],
          operator_authority: 'required_before_route',
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: false,
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          kind: 'checkpoint_authority',
          allowed_failure_causes: ['protected_file_touched'],
          required_refs: ['runtime_diff'],
          operator_authority: 'required_before_route',
          attempt_budget: {
            consumes_step_attempt: false,
            must_respect_max_attempts: false,
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('requires recovery bindings to point back to a WorkContract ref', () => {
    expect(
      RecoveryRouteBindingV0.safeParse(
        retryBinding({
          source_ref: {
            kind: 'policy',
            ref: 'policy.runtime.policy_v2',
          },
        }),
      ).success,
    ).toBe(false);
  });
});

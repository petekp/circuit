import {
  RECOVERY_KIND_CONTRACT_RULES,
  type RecoveryAttemptBudget,
  type RecoveryFailureCause,
  type RecoveryOperatorAuthority,
  type RecoveryRequiredRefKind,
  type RecoveryRouteKind,
} from '../schemas/recovery-route-kind.js';

// 'advance' is the slice-loop forward edge (deep-rigor Build): a successful
// slice verify re-enters the head step for the next slice. It carries no
// recovery mechanics, exactly like 'continue'.
export const NORMAL_ROUTE_IDS = new Set(['pass', 'continue', 'complete', 'close', 'advance']);

type RecoveryRouteSelector = {
  readonly routeId: string;
  readonly target?: 'same_step' | 'different_step';
};

type RecoveryAttemptBudgetPolicy = {
  readonly consumesStepAttempt: boolean;
  readonly retryTarget: NonNullable<RecoveryAttemptBudget['retry_target']>;
};

type RecoveryRouteProjectionPolicy = {
  readonly selectors: readonly RecoveryRouteSelector[];
  readonly contract: (typeof RECOVERY_KIND_CONTRACT_RULES)[RecoveryRouteKind];
  readonly operatorAuthority: RecoveryOperatorAuthority;
  readonly attemptBudget: RecoveryAttemptBudgetPolicy;
};

export const RECOVERY_ROUTE_PROJECTION_POLICY = {
  retry_same_step_with_feedback: {
    selectors: [{ routeId: 'retry', target: 'same_step' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.retry_same_step_with_feedback,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: true, retryTarget: 'same_step' },
  },
  narrow_scope: {
    selectors: [{ routeId: 'revise' }, { routeId: 'retry', target: 'different_step' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.narrow_scope,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  run_verification: {
    selectors: [],
    contract: RECOVERY_KIND_CONTRACT_RULES.run_verification,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  run_independent_review: {
    selectors: [{ routeId: 'run-review' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.run_independent_review,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  checkpoint_authority: {
    selectors: [{ routeId: 'checkpoint' }, { routeId: 'ask' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.checkpoint_authority,
    operatorAuthority: 'required_before_route',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  safe_apply_reject: {
    selectors: [],
    contract: RECOVERY_KIND_CONTRACT_RULES.safe_apply_reject,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  stop_unsafe: {
    selectors: [{ routeId: 'blocked' }, { routeId: 'stop' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.stop_unsafe,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  escalate: {
    selectors: [{ routeId: 'escalate' }, { routeId: 'connector-failed' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.escalate,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  handoff: {
    selectors: [{ routeId: 'handoff' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.handoff,
    operatorAuthority: 'required_to_continue_after_route',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
} satisfies Record<RecoveryRouteKind, RecoveryRouteProjectionPolicy>;

function selectorMatches(input: {
  readonly selector: RecoveryRouteSelector;
  readonly routeId: string;
  readonly routeTarget: string;
  readonly stepId: string;
}): boolean {
  if (input.selector.routeId !== input.routeId) return false;
  if (input.selector.target === undefined) return true;
  const targetRelation = input.routeTarget === input.stepId ? 'same_step' : 'different_step';
  return input.selector.target === targetRelation;
}

export function recoveryKindForRoute(input: {
  readonly routeId: string;
  readonly routeTarget: string;
  readonly stepId: string;
}): RecoveryRouteKind | undefined {
  for (const [kind, policy] of Object.entries(RECOVERY_ROUTE_PROJECTION_POLICY) as Array<
    [RecoveryRouteKind, RecoveryRouteProjectionPolicy]
  >) {
    if (
      policy.selectors.some((selector) =>
        selectorMatches({
          selector,
          routeId: input.routeId,
          routeTarget: input.routeTarget,
          stepId: input.stepId,
        }),
      )
    ) {
      return kind;
    }
  }
  return undefined;
}

export function recoveryAllowedFailureCausesForKind(
  kind: RecoveryRouteKind,
): RecoveryFailureCause[] {
  return [...RECOVERY_ROUTE_PROJECTION_POLICY[kind].contract.allowedFailureCauses];
}

export function recoveryRequiredRefsForKind(kind: RecoveryRouteKind): RecoveryRequiredRefKind[] {
  return [...RECOVERY_ROUTE_PROJECTION_POLICY[kind].contract.defaultRequiredRefs];
}

export function recoveryOperatorAuthorityForKind(
  kind: RecoveryRouteKind,
): RecoveryOperatorAuthority {
  return RECOVERY_ROUTE_PROJECTION_POLICY[kind].operatorAuthority;
}

export function recoveryAttemptBudgetForKind(kind: RecoveryRouteKind): RecoveryAttemptBudget {
  const policy = RECOVERY_ROUTE_PROJECTION_POLICY[kind].attemptBudget;
  return {
    consumes_step_attempt: policy.consumesStepAttempt,
    must_respect_max_attempts: true,
    retry_target: policy.retryTarget,
  };
}

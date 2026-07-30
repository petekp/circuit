import type { RouteTarget, TerminalTarget } from '../domain/route.js';

export type RouteDeclarationTransition =
  | {
      readonly kind: 'declared_route';
      readonly target: RouteTarget;
    }
  | {
      readonly kind: 'undeclared_route_abort';
      readonly reason: string;
    };

export type RouteTargetTransition =
  | {
      readonly kind: 'step_advance';
      readonly targetStepId: string;
    }
  | {
      readonly kind: 'terminal_close';
      readonly terminalTarget: TerminalTarget;
    }
  | {
      // Recovery budget spent, but the step declared where exhaustion goes:
      // take `routeId` (one of the step's own declared routes) instead of
      // aborting. The reason string is preserved for the trace.
      readonly kind: 'exhaustion_reroute';
      readonly routeId: string;
      readonly reason: string;
    }
  | {
      readonly kind:
        | 'self_pass_cycle_abort'
        | 'completed_step_cycle_abort'
        | 'recovery_attempts_exhausted_abort';
      readonly reason: string;
    };

const ROUTE_TARGET_ABORT_KINDS: ReadonlySet<RouteTargetTransition['kind']> = new Set([
  'self_pass_cycle_abort',
  'completed_step_cycle_abort',
  'recovery_attempts_exhausted_abort',
]);

export function isRouteTargetAbort(transition: RouteTargetTransition): transition is Extract<
  RouteTargetTransition,
  {
    readonly kind:
      | 'self_pass_cycle_abort'
      | 'completed_step_cycle_abort'
      | 'recovery_attempts_exhausted_abort';
  }
> {
  return ROUTE_TARGET_ABORT_KINDS.has(transition.kind);
}

export function classifyRouteDeclarationTransition(input: {
  readonly stepId: string;
  readonly route: string;
  readonly target: RouteTarget | undefined;
}): RouteDeclarationTransition {
  if (input.target === undefined) {
    return {
      kind: 'undeclared_route_abort',
      reason: `step '${input.stepId}' selected undeclared route '${input.route}'`,
    };
  }
  return { kind: 'declared_route', target: input.target };
}

// Shared abort predicate for re-entering an already completed step: re-entry
// is allowed only while a recovery route still has attempts left, and never
// counts the corridor's sanctioned return-to-origin hop. graph-runner applies
// the same rule at step entry (with a resume-checkpoint exemption);
// classifyRouteTargetTransition applies it at route selection.
export function isCompletedStepReentryAbort(input: {
  readonly completedCount: number;
  readonly isRecoveryReturnToOrigin: boolean;
  readonly routeHasRecoveryMechanics: boolean;
  readonly maxAttempts: number;
}): boolean {
  return (
    input.completedCount > 0 &&
    !input.isRecoveryReturnToOrigin &&
    (!input.routeHasRecoveryMechanics || input.completedCount >= input.maxAttempts)
  );
}

export function classifyRouteTargetTransition(input: {
  readonly stepId: string;
  readonly route: string;
  readonly target: RouteTarget;
  readonly targetCompletedCount: number;
  readonly isRecoveryReturnToOrigin: boolean;
  readonly routeHasRecoveryMechanics: boolean;
  readonly targetMaxAttempts: number;
  readonly recoveryReasonSuffix: string;
  // The step's declared fallback for a spent recovery budget. When set (and
  // not the exhausted route itself), exhaustion becomes a reroute through this
  // declared route instead of an abort, so honest instrumented work survives
  // to a close the flow chose. Absent = abort, exactly as before.
  readonly exhaustionRoute?: string;
}): RouteTargetTransition {
  if (input.target.kind === 'terminal') {
    return { kind: 'terminal_close', terminalTarget: input.target.target };
  }

  if (input.target.stepId === input.stepId && input.route === 'pass') {
    return {
      kind: 'self_pass_cycle_abort',
      reason: `route cycle detected: step '${input.stepId}' routes via '${input.route}' to itself`,
    };
  }

  if (
    isCompletedStepReentryAbort({
      completedCount: input.targetCompletedCount,
      isRecoveryReturnToOrigin: input.isRecoveryReturnToOrigin,
      routeHasRecoveryMechanics: input.routeHasRecoveryMechanics,
      maxAttempts: input.targetMaxAttempts,
    })
  ) {
    if (input.routeHasRecoveryMechanics) {
      const reason = `route '${input.route}' for step '${input.target.stepId}' exhausted max_attempts=${input.targetMaxAttempts}${input.recoveryReasonSuffix}`;
      if (input.exhaustionRoute !== undefined && input.exhaustionRoute !== input.route) {
        return { kind: 'exhaustion_reroute', routeId: input.exhaustionRoute, reason };
      }
      return { kind: 'recovery_attempts_exhausted_abort', reason };
    }
    return {
      kind: 'completed_step_cycle_abort',
      reason: `route cycle detected: step '${input.stepId}' routes via '${input.route}' to already completed step '${input.target.stepId}'${input.recoveryReasonSuffix}`,
    };
  }

  return { kind: 'step_advance', targetStepId: input.target.stepId };
}

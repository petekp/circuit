import { describe, expect, it } from 'vitest';

import {
  classifyRouteDeclarationTransition,
  classifyRouteTargetTransition,
  isRouteTargetAbort,
} from '../../src/runtime/run/run-transition.js';

describe('run transition classifier', () => {
  it('names undeclared route aborts before step completion', () => {
    expect(
      classifyRouteDeclarationTransition({
        stepId: 'review',
        route: 'missing',
        target: undefined,
      }),
    ).toEqual({
      kind: 'undeclared_route_abort',
      reason: "step 'review' selected undeclared route 'missing'",
    });
  });

  it('names terminal close transitions', () => {
    expect(
      classifyRouteTargetTransition({
        stepId: 'close',
        route: 'pass',
        target: { kind: 'terminal', target: '@complete' },
        targetCompletedCount: 0,
        isRecoveryReturnToOrigin: false,
        routeHasRecoveryMechanics: false,
        targetMaxAttempts: 2,
        recoveryReasonSuffix: '',
      }),
    ).toEqual({ kind: 'terminal_close', terminalTarget: '@complete' });
  });

  it('names normal step advances', () => {
    expect(
      classifyRouteTargetTransition({
        stepId: 'plan',
        route: 'pass',
        target: { kind: 'step', stepId: 'act' },
        targetCompletedCount: 0,
        isRecoveryReturnToOrigin: false,
        routeHasRecoveryMechanics: false,
        targetMaxAttempts: 2,
        recoveryReasonSuffix: '',
      }),
    ).toEqual({ kind: 'step_advance', targetStepId: 'act' });
  });

  it('names self-pass cycle aborts', () => {
    const transition = classifyRouteTargetTransition({
      stepId: 'act',
      route: 'pass',
      target: { kind: 'step', stepId: 'act' },
      targetCompletedCount: 0,
      isRecoveryReturnToOrigin: false,
      routeHasRecoveryMechanics: false,
      targetMaxAttempts: 2,
      recoveryReasonSuffix: '',
    });

    expect(transition).toMatchObject({
      kind: 'self_pass_cycle_abort',
      reason: "route cycle detected: step 'act' routes via 'pass' to itself",
    });
    expect(isRouteTargetAbort(transition)).toBe(true);
  });

  it('names completed-step cycle aborts', () => {
    expect(
      classifyRouteTargetTransition({
        stepId: 'review',
        route: 'pass',
        target: { kind: 'step', stepId: 'act' },
        targetCompletedCount: 1,
        isRecoveryReturnToOrigin: false,
        routeHasRecoveryMechanics: false,
        targetMaxAttempts: 2,
        recoveryReasonSuffix: '; last recovery reason: prior mismatch',
      }),
    ).toEqual({
      kind: 'completed_step_cycle_abort',
      reason:
        "route cycle detected: step 'review' routes via 'pass' to already completed step 'act'; last recovery reason: prior mismatch",
    });
  });

  it('names exhausted recovery attempts but permits recovery returns to origin', () => {
    expect(
      classifyRouteTargetTransition({
        stepId: 'change-set',
        route: 'retry',
        target: { kind: 'step', stepId: 'act' },
        targetCompletedCount: 2,
        isRecoveryReturnToOrigin: false,
        routeHasRecoveryMechanics: true,
        targetMaxAttempts: 2,
        recoveryReasonSuffix: '; last recovery reason: change-set mismatch',
      }),
    ).toEqual({
      kind: 'recovery_attempts_exhausted_abort',
      reason:
        "route 'retry' for step 'act' exhausted max_attempts=2; last recovery reason: change-set mismatch",
    });

    expect(
      classifyRouteTargetTransition({
        stepId: 'change-set',
        route: 'retry',
        target: { kind: 'step', stepId: 'act' },
        targetCompletedCount: 1,
        isRecoveryReturnToOrigin: true,
        routeHasRecoveryMechanics: true,
        targetMaxAttempts: 2,
        recoveryReasonSuffix: '; last recovery reason: change-set mismatch',
      }),
    ).toEqual({ kind: 'step_advance', targetStepId: 'act' });
  });
});

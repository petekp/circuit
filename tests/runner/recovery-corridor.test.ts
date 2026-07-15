import { describe, expect, it } from 'vitest';

import type { RouteTarget } from '../../src/runtime/domain/route.js';
import type { ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import type { RecoveryFailureEvidence } from '../../src/runtime/run/recovery-binding-verdict.js';
import {
  RecoveryCorridor,
  type RecoveryCorridorDeps,
} from '../../src/runtime/run/recovery-corridor.js';
import { CompiledFlowId, RunId, StepId } from '../../src/schemas/ids.js';
import type { Ref } from '../../src/schemas/ref.js';

function stepRoute(stepId: string): RouteTarget {
  return { kind: 'step', stepId };
}

// Minimal step stub: the corridor only reads `id` and `routes`.
function step(id: string, routes: Record<string, RouteTarget>): ExecutableStep {
  return { id: StepId.parse(id), routes } as unknown as ExecutableStep;
}

function evidenceRef(): Ref {
  return {
    kind: 'trace',
    ref: 'trace.ndjson#sequence=1',
    run_id: RunId.parse('40000000-0000-4000-8000-000000000001'),
    flow_id: CompiledFlowId.parse('recovery-corridor'),
    step_id: StepId.parse('act'),
    attempt: 1,
    sequence: 1,
  };
}

function makeCorridor(
  steps: ReadonlyMap<string, ExecutableStep>,
  options: {
    readonly recoveryRoutes?: ReadonlySet<string>;
    readonly latestRef?: Ref | undefined;
  } = {},
): RecoveryCorridor {
  const recoveryRoutes = options.recoveryRoutes ?? new Set<string>();
  const deps: RecoveryCorridorDeps = {
    steps,
    bindings: undefined,
    routeHasRecoveryMechanics: ({ route }) => route !== undefined && recoveryRoutes.has(route),
    latestStepReportOrRelayRef: () => options.latestRef,
  };
  return new RecoveryCorridor(deps);
}

describe('RecoveryCorridor', () => {
  it('starts inert: no route is active and nothing returns to an origin', () => {
    const corridor = makeCorridor(new Map());
    expect(corridor.isActiveRoute('retry')).toBe(false);
    expect(corridor.isReturnToOrigin({ stepId: 'act', route: 'pass' })).toBe(false);
    expect(corridor.lastReasonSuffix()).toBe('');
  });

  it('tracks the active recovery route and reason suffix after entering', () => {
    const corridor = makeCorridor(new Map());
    corridor.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: 'verification failed',
      recoveryFailure: undefined,
      retryFeedback: undefined,
    });
    expect(corridor.isActiveRoute('retry')).toBe(true);
    expect(corridor.isActiveRoute('pass')).toBe(false);
    expect(corridor.lastReasonSuffix()).toBe('; last recovery reason: verification failed');
  });

  it('recognizes a return to origin only via non-recovery routes', () => {
    // act --retry(recovery)--> verify --fix--> act ; verify --pass--> close
    const steps = new Map<string, ExecutableStep>([
      ['act', step('act', { retry: stepRoute('verify'), pass: stepRoute('close') })],
      ['verify', step('verify', { fix: stepRoute('act'), pass: stepRoute('close') })],
      ['close', step('close', {})],
    ]);
    const corridor = makeCorridor(steps, { recoveryRoutes: new Set(['retry']) });
    corridor.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: 'needs repair',
      recoveryFailure: undefined,
      retryFeedback: undefined,
    });

    // Stepping back into 'act' from 'verify' via the non-recovery 'fix' route is
    // a legitimate corridor return.
    expect(corridor.isReturnToOrigin({ stepId: 'verify', route: 'fix' })).toBe(true);
    // The active recovery route itself is never a "return" to origin.
    expect(corridor.isReturnToOrigin({ stepId: 'verify', route: 'retry' })).toBe(false);
  });

  it('surfaces corridor evidence only when failure evidence backs the corridor', () => {
    const corridor = makeCorridor(new Map(), { latestRef: evidenceRef() });
    const failure: RecoveryFailureEvidence = { ref: evidenceRef(), cause: 'failed_check' };

    // Before entering with failure evidence, there is nothing to surface.
    expect(corridor.evidenceFor({ stepId: 'act', attempt: 1, binding: undefined })).toBeUndefined();

    corridor.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: 'failed',
      recoveryFailure: failure,
      retryFeedback: undefined,
    });

    expect(corridor.evidenceFor({ stepId: 'act', attempt: 2, binding: undefined })).toEqual({
      ref: evidenceRef(),
      cause: 'failed_check',
    });
  });

  it('clears the corridor when its origin step completes without recovery mechanics', () => {
    const corridor = makeCorridor(new Map());
    corridor.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: 'failed',
      recoveryFailure: undefined,
      retryFeedback: undefined,
    });
    expect(corridor.isActiveRoute('retry')).toBe(true);

    // A different step completing does not clear the corridor.
    corridor.clearIfExitingOrigin({ stepId: 'verify', routeHasRecoveryMechanics: false });
    expect(corridor.isActiveRoute('retry')).toBe(true);

    // The origin completing while still taking a recovery route keeps it open.
    corridor.clearIfExitingOrigin({ stepId: 'act', routeHasRecoveryMechanics: true });
    expect(corridor.isActiveRoute('retry')).toBe(true);

    // The origin completing on a non-recovery route exits the corridor.
    corridor.clearIfExitingOrigin({ stepId: 'act', routeHasRecoveryMechanics: false });
    expect(corridor.isActiveRoute('retry')).toBe(false);
    expect(corridor.lastReasonSuffix()).toBe('');
  });
});

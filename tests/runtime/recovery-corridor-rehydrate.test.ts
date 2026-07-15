import { describe, expect, it } from 'vitest';

import type { RouteTarget } from '../../src/runtime/domain/route.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import type { ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import {
  RecoveryCorridor,
  type RecoveryCorridorDeps,
} from '../../src/runtime/run/recovery-corridor.js';
import { RunId, StepId } from '../../src/schemas/ids.js';

// RecoveryCorridor.seedFromTrace rehydration tests.
//
// On a non-checkpoint resume the live `active` corridor state is lost (it lives
// only in the loop's RecoveryCorridor instance). seedFromTrace replays the
// durable `step.completed` entries through the SAME enter / clearIfExitingOrigin
// predicates the live loop applies, so a fresh corridor lands on the structural
// corridor identity (which route is active, with what origin) the live run held.
//
// Faithfulness boundary (proven by the third test): only `route_taken` survives
// to the durable trace, so seedFromTrace reproduces the STRUCTURAL fields
// (originStepId, route) and not the executor-outcome payload (reason,
// retryFeedback). It must not pretend otherwise.

function stepRoute(stepId: string): RouteTarget {
  return { kind: 'step', stepId };
}

// Minimal step stub: the corridor only reads `id` and `routes`.
function step(id: string, routes: Record<string, RouteTarget>): ExecutableStep {
  return { id: StepId.parse(id), routes } as unknown as ExecutableStep;
}

const RUN_ID = RunId.parse('40000000-0000-4000-8000-000000000001');

// Durable step.completed trace entry, as TraceStore.append would have written it
// (schema_version / recorded_at / sequence auto-filled, run_id branded).
function completed(input: {
  readonly stepId: string;
  readonly attempt: number;
  readonly route: string;
  readonly sequence: number;
}): TraceEntry {
  return {
    schema_version: 1,
    sequence: input.sequence,
    recorded_at: '2026-06-16T00:00:00.000Z',
    run_id: RUN_ID,
    kind: 'step.completed',
    step_id: StepId.parse(input.stepId),
    attempt: input.attempt,
    route_taken: input.route,
  } as TraceEntry;
}

function makeDeps(
  steps: ReadonlyMap<string, ExecutableStep>,
  recoveryRoutes: ReadonlySet<string>,
): RecoveryCorridorDeps {
  return {
    steps,
    bindings: undefined,
    routeHasRecoveryMechanics: ({ route }) => route !== undefined && recoveryRoutes.has(route),
    latestStepReportOrRelayRef: () => undefined,
  };
}

// act --retry(recovery)--> verify --fix--> act ; act --pass--> close
function fixLoopSteps(): ReadonlyMap<string, ExecutableStep> {
  return new Map<string, ExecutableStep>([
    ['act', step('act', { retry: stepRoute('verify'), pass: stepRoute('close') })],
    ['verify', step('verify', { fix: stepRoute('act'), pass: stepRoute('close') })],
    ['close', step('close', {})],
  ]);
}

describe('RecoveryCorridor.seedFromTrace', () => {
  it('rehydrates the active corridor a live run held after a recovery route was taken', () => {
    const steps = fixLoopSteps();
    const recoveryRoutes = new Set(['retry']);

    // Live run reference: act takes the recovery `retry` route (enter), then a
    // normal `verify` step completes via the non-recovery `fix` route. The
    // corridor stays active because the origin (act) has not re-completed
    // without mechanics yet.
    const live = new RecoveryCorridor(makeDeps(steps, recoveryRoutes));
    live.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: undefined,
      recoveryFailure: undefined,
      retryFeedback: undefined,
    });
    live.clearIfExitingOrigin({ stepId: 'act', routeHasRecoveryMechanics: true });
    live.clearIfExitingOrigin({ stepId: 'verify', routeHasRecoveryMechanics: false });

    // Durable trace those two completions wrote.
    const trace: readonly TraceEntry[] = [
      completed({ stepId: 'act', attempt: 1, route: 'retry', sequence: 1 }),
      completed({ stepId: 'verify', attempt: 1, route: 'fix', sequence: 2 }),
    ];

    const rehydrated = new RecoveryCorridor(makeDeps(steps, recoveryRoutes));
    rehydrated.seedFromTrace(trace);

    // The structural corridor identity matches the live run's: the recovery
    // route is active and a return-to-origin through non-recovery routes is
    // recognized, exactly as the live corridor reports.
    expect(rehydrated.isActiveRoute('retry')).toBe(live.isActiveRoute('retry'));
    expect(rehydrated.isActiveRoute('retry')).toBe(true);
    expect(rehydrated.isReturnToOrigin({ stepId: 'verify', route: 'fix' })).toBe(
      live.isReturnToOrigin({ stepId: 'verify', route: 'fix' }),
    );
    expect(rehydrated.isReturnToOrigin({ stepId: 'verify', route: 'fix' })).toBe(true);
  });

  it('rehydrates to no active corridor when the origin re-completed without mechanics (entered then exited)', () => {
    const steps = fixLoopSteps();
    const recoveryRoutes = new Set(['retry']);

    // Live run: act --retry(recovery)--> verify --fix--> act (re-entered), then
    // act completes via the non-recovery `pass` route, exiting the corridor.
    const live = new RecoveryCorridor(makeDeps(steps, recoveryRoutes));
    live.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: undefined,
      recoveryFailure: undefined,
      retryFeedback: undefined,
    });
    live.clearIfExitingOrigin({ stepId: 'act', routeHasRecoveryMechanics: true });
    live.clearIfExitingOrigin({ stepId: 'verify', routeHasRecoveryMechanics: false });
    // act re-completes on a non-recovery route -> corridor exits.
    live.clearIfExitingOrigin({ stepId: 'act', routeHasRecoveryMechanics: false });
    expect(live.isActiveRoute('retry')).toBe(false);

    const trace: readonly TraceEntry[] = [
      completed({ stepId: 'act', attempt: 1, route: 'retry', sequence: 1 }),
      completed({ stepId: 'verify', attempt: 1, route: 'fix', sequence: 2 }),
      completed({ stepId: 'act', attempt: 2, route: 'pass', sequence: 3 }),
    ];

    const rehydrated = new RecoveryCorridor(makeDeps(steps, recoveryRoutes));
    rehydrated.seedFromTrace(trace);

    // No corridor is active, matching the live run.
    expect(rehydrated.isActiveRoute('retry')).toBe(false);
    expect(rehydrated.isReturnToOrigin({ stepId: 'verify', route: 'fix' })).toBe(false);
    expect(rehydrated.lastReasonSuffix()).toBe('');
  });

  it('honestly does not rehydrate executor-outcome payload — it is not in the durable trace', () => {
    const steps = fixLoopSteps();
    const recoveryRoutes = new Set(['retry']);
    const retryFeedback = {
      kind: 'response_validation' as const,
      step_id: 'act',
      report_schema: 'example.report@v1',
      reason: 'expected boolean, received string',
    };

    // The live run entered with a recovery reason and retry feedback from the
    // executor outcome.
    const live = new RecoveryCorridor(makeDeps(steps, recoveryRoutes));
    live.enter({
      originStepId: 'act',
      route: 'retry',
      recoveryReason: 'verification failed',
      recoveryFailure: undefined,
      retryFeedback,
    });
    expect(live.lastReasonSuffix()).toBe('; last recovery reason: verification failed');
    expect(live.retryFeedbackForReentry({ stepId: 'act', incomingRoute: 'retry' })).toEqual(
      retryFeedback,
    );

    // step.completed carries only route_taken — never details.reason — so the
    // rehydrated corridor must NOT fabricate a reason. The structural identity
    // (active route) matches; the payload is honestly absent.
    const trace: readonly TraceEntry[] = [
      completed({ stepId: 'act', attempt: 1, route: 'retry', sequence: 1 }),
    ];
    const rehydrated = new RecoveryCorridor(makeDeps(steps, recoveryRoutes));
    rehydrated.seedFromTrace(trace);

    expect(rehydrated.isActiveRoute('retry')).toBe(true);
    // Honest gap: neither payload is reconstructable from the trace.
    expect(rehydrated.lastReasonSuffix()).toBe('');
    expect(
      rehydrated.retryFeedbackForReentry({ stepId: 'act', incomingRoute: 'retry' }),
    ).toBeUndefined();
  });
});

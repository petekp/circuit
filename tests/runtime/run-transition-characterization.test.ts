import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { executeExecutableFlowOutcome } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlowId, StepId } from '../../src/schemas/ids.js';
import type { RecoveryRouteBindingV0 } from '../../src/schemas/recovery-route-kind.js';
import { RunTrace } from '../../src/schemas/run.js';

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-run-transition-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function composeStep(
  id: string,
  routes: Record<
    string,
    { kind: 'step'; stepId: string } | { kind: 'terminal'; target: '@complete' | '@stop' }
  >,
  extras: { exhaustionRoute?: string } = {},
): ExecutableFlow['steps'][number] {
  return {
    id,
    kind: 'compose' as const,
    writer: `${id}-writer`,
    check: {
      kind: 'schema_sections' as const,
      source: { kind: 'report' as const, ref: 'report' as const },
      required: ['summary'],
    },
    routes,
    ...(extras.exhaustionRoute === undefined ? {} : { exhaustionRoute: extras.exhaustionRoute }),
  };
}

function transitionFlow(
  steps: ExecutableFlow['steps'],
  entry = steps[0]?.id ?? 'first-step',
): ExecutableFlow {
  return {
    id: 'runtime-transition-characterization',
    version: '0.0.0',
    entry,
    stages: [{ id: 'stage', stepIds: steps.map((step) => step.id) }],
    steps,
    purpose: 'Characterize graph transition order before extraction.',
  };
}

const recoveryWorkContractRef = {
  kind: 'work_contract' as const,
  ref: 'runtime/work-contract/run-transition-characterization.json',
  sha256: 'b'.repeat(64),
  flow_id: CompiledFlowId.parse('runtime-transition-characterization'),
};

function recoveryBinding(): RecoveryRouteBindingV0 {
  return {
    schema_version: 0,
    step_id: StepId.parse('change-set-step'),
    route_id: 'retry',
    route_target: 'act-step',
    kind: 'narrow_scope',
    allowed_failure_causes: ['failed_check'],
    required_refs: ['trace'],
    operator_authority: 'not_required',
    attempt_budget: {
      consumes_step_attempt: false,
      must_respect_max_attempts: true,
      retry_target: 'declared_step',
    },
    guidance: {
      subject: 'recovery_route',
      must_match_step_completed: true,
    },
    source_ref: recoveryWorkContractRef,
  };
}

function composeExecutor(
  routeFor: (stepId: string, attempt: number) => StepOutcome,
): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => routeFor(step.id, context.activeStepAttempt ?? 1),
  };
}

async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

function transitionKinds(entries: Awaited<ReturnType<typeof trace>>) {
  return entries
    .filter(
      (entry) =>
        entry.kind === 'step.entered' ||
        entry.kind === 'step.completed' ||
        entry.kind === 'step.aborted' ||
        entry.kind === 'run.closed',
    )
    .map((entry) =>
      entry.kind === 'run.closed'
        ? [entry.kind, entry.outcome]
        : [entry.kind, entry.step_id, 'attempt' in entry ? entry.attempt : undefined],
    );
}

describe('run transition characterization', () => {
  it('records normal step advance before entering the next step', async () => {
    const runDir = join(runFolderBase, 'normal-advance');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('first-step', { pass: { kind: 'step', stepId: 'second-step' } }),
        composeStep('second-step', { pass: { kind: 'terminal', target: '@complete' } }),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000001',
        goal: 'characterize normal advance',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 0, 0)),
        executors: composeExecutor(() => ({ route: 'pass' })),
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result.outcome).toBe('complete');
    expect(transitionKinds(await trace(runDir))).toEqual([
      ['step.entered', 'first-step', 1],
      ['step.completed', 'first-step', 1],
      ['step.entered', 'second-step', 1],
      ['step.completed', 'second-step', 1],
      ['run.closed', 'complete'],
    ]);
  });

  it('aborts an undeclared route before recording step completion', async () => {
    const runDir = join(runFolderBase, 'invalid-route');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('first-step', { pass: { kind: 'terminal', target: '@complete' } }),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000002',
        goal: 'characterize invalid route',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 5, 0)),
        executors: composeExecutor(() => ({ route: 'missing-route' })),
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result).toMatchObject({
      outcome: 'aborted',
      reason: "step 'first-step' selected undeclared route 'missing-route'",
    });
    expect(transitionKinds(await trace(runDir))).toEqual([
      ['step.entered', 'first-step', 1],
      ['step.aborted', 'first-step', 1],
      ['run.closed', 'aborted'],
    ]);
  });

  it('aborts a route cycle before re-entering an already completed step', async () => {
    const runDir = join(runFolderBase, 'route-cycle');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('first-step', { pass: { kind: 'step', stepId: 'second-step' } }),
        composeStep('second-step', { pass: { kind: 'step', stepId: 'first-step' } }),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000003',
        goal: 'characterize route cycle',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 10, 0)),
        executors: composeExecutor(() => ({ route: 'pass' })),
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result.reason).toContain(
      "route cycle detected: step 'second-step' routes via 'pass' to already completed step 'first-step'",
    );
    expect(transitionKinds(await trace(runDir))).toEqual([
      ['step.entered', 'first-step', 1],
      ['step.completed', 'first-step', 1],
      ['step.entered', 'second-step', 1],
      ['step.aborted', 'second-step', 1],
      ['run.closed', 'aborted'],
    ]);
  });

  it('allows a declared recovery route to re-enter the origin corridor', async () => {
    const runDir = join(runFolderBase, 'recovery-retry');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('act-step', { pass: { kind: 'step', stepId: 'verify-step' } }),
        composeStep('verify-step', { pass: { kind: 'step', stepId: 'change-set-step' } }),
        composeStep('change-set-step', {
          pass: { kind: 'terminal', target: '@complete' },
          retry: { kind: 'step', stepId: 'act-step' },
        }),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000004',
        goal: 'characterize recovery retry',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 15, 0)),
        workContractRef: recoveryWorkContractRef,
        recoveryRouteBindings: [recoveryBinding()],
        executors: {
          compose: async (step, context) => {
            if (step.id === 'change-set-step' && context.activeStepAttempt === 1) {
              await context.trace.append({
                run_id: context.runId,
                kind: 'check.evaluated',
                step_id: step.id,
                attempt: context.activeStepAttempt,
                check_kind: 'schema_sections',
                outcome: 'fail',
                reason: 'change-set mismatch',
              });
              return { route: 'retry', details: { reason: 'change-set mismatch' } };
            }
            return { route: 'pass' };
          },
        },
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result.outcome).toBe('complete');
    const completions = (await trace(runDir)).filter((entry) => entry.kind === 'step.completed');
    expect(completions.map((entry) => [entry.step_id, entry.attempt, entry.route_taken])).toEqual([
      ['act-step', 1, 'pass'],
      ['verify-step', 1, 'pass'],
      ['change-set-step', 1, 'retry'],
      ['act-step', 2, 'pass'],
      ['verify-step', 2, 'pass'],
      ['change-set-step', 2, 'pass'],
    ]);
  });
});

// The executor that never lets change-set-step pass: every attempt records a
// failed check and selects the bound recovery route, so the retry budget on the
// route's target is guaranteed to exhaust.
function alwaysFailingChangeSetExecutors(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.id === 'change-set-step') {
        await context.trace.append({
          run_id: context.runId,
          kind: 'check.evaluated',
          step_id: step.id,
          attempt: context.activeStepAttempt ?? 1,
          check_kind: 'schema_sections',
          outcome: 'fail',
          reason: 'change-set mismatch',
        });
        return { route: 'retry', details: { reason: 'change-set mismatch' } };
      }
      return { route: 'pass' };
    },
  };
}

describe('declared exhaustion routes', () => {
  it('aborts on a spent recovery budget when no exhaustion route is declared', async () => {
    const runDir = join(runFolderBase, 'exhaustion-default-abort');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('act-step', { pass: { kind: 'step', stepId: 'verify-step' } }),
        composeStep('verify-step', { pass: { kind: 'step', stepId: 'change-set-step' } }),
        composeStep('change-set-step', {
          pass: { kind: 'terminal', target: '@complete' },
          retry: { kind: 'step', stepId: 'act-step' },
          stop: { kind: 'terminal', target: '@stop' },
        }),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000005',
        goal: 'characterize exhaustion default abort',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 20, 0)),
        workContractRef: recoveryWorkContractRef,
        recoveryRouteBindings: [recoveryBinding()],
        executors: alwaysFailingChangeSetExecutors(),
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result.outcome).toBe('aborted');
    expect(outcome.result.reason).toContain(
      "route 'retry' for step 'act-step' exhausted max_attempts=2",
    );
  });

  it('routes a spent recovery budget through the declared exhaustion route to an honest stop', async () => {
    const runDir = join(runFolderBase, 'exhaustion-reroute-stop');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('act-step', { pass: { kind: 'step', stepId: 'verify-step' } }),
        composeStep('verify-step', { pass: { kind: 'step', stepId: 'change-set-step' } }),
        composeStep(
          'change-set-step',
          {
            pass: { kind: 'terminal', target: '@complete' },
            retry: { kind: 'step', stepId: 'act-step' },
            stop: { kind: 'terminal', target: '@stop' },
          },
          { exhaustionRoute: 'stop' },
        ),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000006',
        goal: 'characterize exhaustion reroute to stop',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 25, 0)),
        workContractRef: recoveryWorkContractRef,
        recoveryRouteBindings: [recoveryBinding()],
        executors: alwaysFailingChangeSetExecutors(),
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result.outcome).toBe('stopped');
    expect(outcome.result.reason).toContain(
      "route 'retry' for step 'act-step' exhausted max_attempts=2",
    );
    expect(outcome.result.reason).toContain('change-set mismatch');

    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'step.exhaustion_rerouted',
        step_id: 'change-set-step',
        attempt: 2,
        from_route: 'retry',
        to_route: 'stop',
        reason: expect.stringContaining('exhausted max_attempts=2'),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'step.completed',
        step_id: 'change-set-step',
        attempt: 2,
        route_taken: 'stop',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'run.closed', outcome: 'stopped' }),
    );
    expect(entries).not.toContainEqual(expect.objectContaining({ kind: 'step.aborted' }));
    const parsed = RunTrace.safeParse(entries);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('continues through a forward fallback step when the exhaustion route advances', async () => {
    const runDir = join(runFolderBase, 'exhaustion-reroute-forward');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep('act-step', { pass: { kind: 'step', stepId: 'verify-step' } }),
        composeStep('verify-step', { pass: { kind: 'step', stepId: 'change-set-step' } }),
        composeStep(
          'change-set-step',
          {
            pass: { kind: 'terminal', target: '@complete' },
            retry: { kind: 'step', stepId: 'act-step' },
            close: { kind: 'step', stepId: 'summary-step' },
          },
          { exhaustionRoute: 'close' },
        ),
        composeStep('summary-step', { pass: { kind: 'terminal', target: '@complete' } }),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000007',
        goal: 'characterize exhaustion reroute to a fallback step',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 30, 0)),
        workContractRef: recoveryWorkContractRef,
        recoveryRouteBindings: [recoveryBinding()],
        executors: alwaysFailingChangeSetExecutors(),
      },
    );

    expect(outcome.kind).toBe('closed');
    if (outcome.kind !== 'closed') throw new Error('expected closed outcome');
    expect(outcome.result.outcome).toBe('complete');
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'step.exhaustion_rerouted',
        step_id: 'change-set-step',
        attempt: 2,
        from_route: 'retry',
        to_route: 'close',
      }),
    );
    expect(transitionKinds(entries).slice(-3)).toEqual([
      ['step.entered', 'summary-step', 1],
      ['step.completed', 'summary-step', 1],
      ['run.closed', 'complete'],
    ]);
  });

  it('rejects an exhaustion route that does not name a declared route', async () => {
    const runDir = join(runFolderBase, 'exhaustion-route-undeclared');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep(
          'change-set-step',
          { pass: { kind: 'terminal', target: '@complete' } },
          { exhaustionRoute: 'missing' },
        ),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000008',
        goal: 'characterize undeclared exhaustion route rejection',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 35, 0)),
      },
    );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('expected rejected outcome');
    expect(outcome.reason).toContain(
      "exhaustion route 'missing' must name one of the step's declared routes",
    );
  });

  it('rejects an exhaustion route that targets @complete', async () => {
    const runDir = join(runFolderBase, 'exhaustion-route-complete');
    const outcome = await executeExecutableFlowOutcome(
      transitionFlow([
        composeStep(
          'change-set-step',
          {
            pass: { kind: 'terminal', target: '@complete' },
            retry: { kind: 'step', stepId: 'change-set-step' },
          },
          { exhaustionRoute: 'pass' },
        ),
      ]),
      {
        runDir,
        runId: '73000000-0000-4000-8000-000000000009',
        goal: 'characterize complete-target exhaustion route rejection',
        now: deterministicNow(Date.UTC(2026, 5, 5, 1, 40, 0)),
      },
    );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('expected rejected outcome');
    expect(outcome.reason).toContain("must not target '@complete'");
  });
});

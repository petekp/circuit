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
    { kind: 'step'; stepId: string } | { kind: 'terminal'; target: '@complete' }
  >,
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

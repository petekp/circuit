import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import {
  executeExecutableFlowOutcome,
  executeExecutableFlowWithWaiting,
  isGraphRejectedOutcome,
} from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';

function singleStepFlow(): ExecutableFlow {
  return {
    id: 'typed-outcome-fixture',
    version: '0.0.0',
    entry: 'compose-step',
    stages: [{ id: 'stage', stepIds: ['compose-step'] }],
    steps: [
      {
        id: 'compose-step',
        kind: 'compose',
        writer: 'typed-outcome-fixture',
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
        },
      },
    ],
  };
}

function checkpointFlow(): ExecutableFlow {
  return {
    id: 'typed-checkpoint-fixture',
    version: '0.0.0',
    entry: 'checkpoint-step',
    stages: [{ id: 'stage', stepIds: ['checkpoint-step'] }],
    steps: [
      {
        id: 'checkpoint-step',
        protocol: 'typed-checkpoint@v1',
        kind: 'checkpoint',
        choices: ['continue'],
        policy: {
          prompt: 'Choose whether to continue.',
          choices: [{ id: 'continue', label: 'Continue' }],
          safe_default_choice: 'continue',
        },
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          continue: { kind: 'terminal', target: '@complete' },
        },
        writes: {
          request: { path: 'reports/checkpoint-request.json' },
          response: { path: 'reports/checkpoint-response.json' },
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      },
    ],
  };
}

function composeExecutor(route: string): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (): Promise<StepOutcome> => ({ route }),
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-graph-outcome-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('graph execution outcome values', () => {
  it('returns complete and aborted closed Runs as typed values', async () => {
    const complete = await executeExecutableFlowOutcome(singleStepFlow(), {
      runDir: join(runFolderBase, 'complete'),
      runId: '71000000-0000-0000-0000-000000000001',
      goal: 'complete through a typed outcome',
      now: deterministicNow(Date.UTC(2026, 4, 18, 12, 0, 0)),
      executors: composeExecutor('pass'),
    });
    expect(complete.kind).toBe('closed');
    if (complete.kind !== 'closed') throw new Error('expected closed outcome');
    expect(complete.result.outcome).toBe('complete');

    const aborted = await executeExecutableFlowOutcome(singleStepFlow(), {
      runDir: join(runFolderBase, 'aborted'),
      runId: '71000000-0000-0000-0000-000000000002',
      goal: 'abort through a typed outcome',
      now: deterministicNow(Date.UTC(2026, 4, 18, 12, 10, 0)),
      executors: composeExecutor('missing-route'),
    });
    expect(aborted.kind).toBe('closed');
    if (aborted.kind !== 'closed') throw new Error('expected closed outcome');
    expect(aborted.result.outcome).toBe('aborted');
    expect(aborted.result.reason).toBe(
      "step 'compose-step' selected undeclared route 'missing-route'",
    );
  });

  it('returns checkpoint waiting as a typed value', async () => {
    const runDir = join(runFolderBase, 'checkpoint');
    const outcome = await executeExecutableFlowOutcome(checkpointFlow(), {
      runDir,
      runId: '71000000-0000-0000-0000-000000000003',
      goal: 'wait through a typed outcome',
      depth: 'deep',
      now: deterministicNow(Date.UTC(2026, 4, 18, 12, 20, 0)),
    });

    expect(outcome.kind).toBe('checkpoint_waiting');
    if (outcome.kind !== 'checkpoint_waiting') {
      throw new Error('expected checkpoint waiting outcome');
    }
    expect(outcome.checkpoint.stepId).toBe('checkpoint-step');
    expect(outcome.checkpoint.allowedChoices).toEqual(['continue']);
    const entries = await new TraceStore(runDir).load();
    expect(entries.some((entry) => entry.kind === 'checkpoint.requested')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'step.aborted')).toBe(false);
    expect(entries.some((entry) => entry.kind === 'run.closed')).toBe(false);
  });

  it('returns rejected setup failures as values while compatibility runners still throw', async () => {
    const runDir = join(runFolderBase, 'not-fresh');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'sentinel.txt'), 'already used');

    const outcome = await executeExecutableFlowOutcome(singleStepFlow(), {
      runDir,
      runId: '71000000-0000-0000-0000-000000000004',
      goal: 'reject through a typed outcome',
      now: deterministicNow(Date.UTC(2026, 4, 18, 12, 30, 0)),
      executors: composeExecutor('pass'),
    });

    expect(isGraphRejectedOutcome(outcome)).toBe(true);
    if (!isGraphRejectedOutcome(outcome)) throw new Error('expected rejected outcome');
    expect(outcome.reason).toContain('runtime baseline requires a fresh run directory');

    await expect(
      executeExecutableFlowWithWaiting(singleStepFlow(), {
        runDir,
        runId: '71000000-0000-0000-0000-000000000005',
        goal: 'compatibility runner still throws',
        now: deterministicNow(Date.UTC(2026, 4, 18, 12, 40, 0)),
        executors: composeExecutor('pass'),
      }),
    ).rejects.toThrow(outcome.reason);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import {
  executeCheckpoint,
  executeCheckpointResult,
} from '../../src/runtime/executors/checkpoint.js';
import {
  executeVerification,
  executeVerificationResult,
} from '../../src/runtime/executors/verification.js';
import type { ExecutableFlow, ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import { buildRuntimePackageIndex } from '../../src/runtime/manifest/runtime-package-index.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { nodeExternalFileReader } from '../../src/runtime/run/external-files.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { CheckpointPolicy } from '../../src/schemas/step.js';

function contextFor(
  flow: ExecutableFlow,
  runDir: string,
  overrides: Partial<RunContext> = {},
): RunContext {
  return {
    flow,
    packageIndex: buildRuntimePackageIndex(flow),
    runId: '72000000-0000-0000-0000-000000000001',
    runDir,
    goal: 'prove executor result values',
    manifestHash: `runtime:${flow.id}@${flow.version}`,
    now: deterministicNow(Date.UTC(2026, 4, 18, 13, 0, 0)),
    files: new RunFileStore(runDir),
    trace: new TraceStore(runDir),
    externalFiles: nodeExternalFileReader,
    ...overrides,
  };
}

function onlyStep<TKind extends ExecutableStep['kind']>(
  flow: ExecutableFlow,
  kind: TKind,
): Extract<ExecutableStep, { readonly kind: TKind }> {
  const step = flow.steps[0];
  if (step === undefined || step.kind !== kind) throw new Error(`expected ${kind} step`);
  return step as Extract<ExecutableStep, { readonly kind: TKind }>;
}

function verificationFlow(): ExecutableFlow {
  return {
    id: 'verification-result-fixture',
    version: '0.0.0',
    entry: 'verify-step',
    stages: [{ id: 'stage', stepIds: ['verify-step'] }],
    steps: [
      {
        id: 'verify-step',
        kind: 'verification',
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
        },
        writes: {
          report: { path: 'reports/verification.json', schema: 'fixture.verification@v1' },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
      },
    ],
  };
}

function checkpointFlow(
  policy: CheckpointPolicy,
  depth: string,
): {
  readonly flow: ExecutableFlow;
  readonly contextOverrides: Partial<RunContext>;
} {
  const flow: ExecutableFlow = {
    id: 'checkpoint-result-fixture',
    version: '0.0.0',
    entry: 'checkpoint-step',
    stages: [{ id: 'stage', stepIds: ['checkpoint-step'] }],
    steps: [
      {
        id: 'checkpoint-step',
        protocol: 'checkpoint-result@v1',
        kind: 'checkpoint',
        choices: ['continue'],
        policy,
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
  return { flow, contextOverrides: { depth } };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-executor-result-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('executor result values', () => {
  it('returns verification blocked paths as failure values while the adapter still throws', async () => {
    const flow = verificationFlow();
    const step = onlyStep(flow, 'verification');
    const context = contextFor(flow, join(runFolderBase, 'verification-blocked'));

    const result = await executeVerificationResult(step, context);
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed verification result');
    expect(result.reason).toContain('requires projectRoot');

    await expect(executeVerification(step, context)).rejects.toThrow(result.reason);
  });

  it('returns checkpoint waiting and failed selections as values while the adapter preserves behavior', async () => {
    const waitingFixture = checkpointFlow(
      {
        prompt: 'Choose whether to continue.',
        choices: [{ id: 'continue', label: 'Continue' }],
        safe_default_choice: 'continue',
      },
      'high',
    );
    const waitingStep = onlyStep(waitingFixture.flow, 'checkpoint');
    const waiting = await executeCheckpointResult(
      waitingStep,
      contextFor(
        waitingFixture.flow,
        join(runFolderBase, 'checkpoint-waiting'),
        waitingFixture.contextOverrides,
      ),
    );
    expect(waiting.kind).toBe('outcome');
    if (waiting.kind !== 'outcome') throw new Error('expected checkpoint outcome');
    if (!('kind' in waiting.outcome)) throw new Error('expected waiting checkpoint outcome');
    expect(waiting.outcome.kind).toBe('waiting_checkpoint');

    const failedFixture = checkpointFlow(
      {
        prompt: 'Choose whether to continue.',
        choices: [{ id: 'continue', label: 'Continue' }],
      },
      'medium',
    );
    const failedStep = onlyStep(failedFixture.flow, 'checkpoint');
    const failedContext = contextFor(
      failedFixture.flow,
      join(runFolderBase, 'checkpoint-failed'),
      failedFixture.contextOverrides,
    );
    const failed = await executeCheckpointResult(failedStep, failedContext);
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed') throw new Error('expected failed checkpoint result');
    expect(failed.reason).toContain('safe default choice');

    await expect(executeCheckpoint(failedStep, failedContext)).rejects.toThrow(failed.reason);
  });
});

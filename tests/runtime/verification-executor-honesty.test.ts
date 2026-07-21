import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { BuildPlan } from '../../src/flows/build/reports.js';
import { executeVerificationResult } from '../../src/runtime/executors/verification.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { buildRuntimePackageIndex } from '../../src/runtime/manifest/runtime-package-index.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { nodeExternalFileReader } from '../../src/runtime/run/external-files.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { VerificationCommand } from '../../src/schemas/verification.js';

let runFolder: string;
let projectRoot: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-verification-honesty-run-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'circuit-verification-honesty-project-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

function verificationFlow(): ExecutableFlow {
  return {
    id: 'verification-honesty-fixture',
    version: '0.0.0',
    entry: 'plan-step',
    stages: [{ id: 'stage', stepIds: ['plan-step', 'verify-step'] }],
    steps: [
      {
        id: 'plan-step',
        kind: 'compose',
        writer: 'noop',
        routes: { pass: { kind: 'terminal', target: '@complete' } },
        writes: { report: { path: 'reports/build/plan.json', schema: 'build.plan@v1' } },
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
      },
      {
        id: 'verify-step',
        kind: 'verification',
        reads: [{ path: 'reports/build/plan.json', schema: 'build.plan@v1' }],
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          retry: { kind: 'terminal', target: '@stop' },
        },
        writes: {
          report: { path: 'reports/build/verification.json', schema: 'build.verification@v1' },
        },
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
      },
    ],
  };
}

function writeBuildPlan(commands: readonly VerificationCommand[]): void {
  const path = join(runFolder, 'reports/build/plan.json');
  mkdirSync(join(path, '..'), { recursive: true });
  const plan = BuildPlan.parse({
    objective: 'prove the verification executor is honest about timeouts',
    approach: 'run direct argv commands under a tiny budget',
    slices: [{ id: 'slice-1', intent: 'exercise the honesty seam' }],
    allowed_touch_area: [],
    verification: { commands },
  });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
}

function failingCommand(id: string): VerificationCommand {
  return {
    id,
    cwd: '.',
    argv: [process.execPath, '-e', 'process.exit(1)'],
    timeout_ms: 5_000,
    max_output_bytes: 1_000,
    env: {},
  };
}

function timeoutCommand(id: string): VerificationCommand {
  return {
    id,
    cwd: '.',
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    timeout_ms: 200,
    max_output_bytes: 1_000,
    env: {},
  };
}

function contextFor(flow: ExecutableFlow): RunContext {
  return {
    flow,
    packageIndex: buildRuntimePackageIndex(flow),
    runId: '73000000-0000-0000-0000-000000000001',
    runDir: runFolder,
    projectRoot,
    goal: 'prove the verification executor names honest failure reasons',
    manifestHash: `runtime:${flow.id}@${flow.version}`,
    now: deterministicNow(Date.UTC(2026, 6, 10, 13, 0, 0)),
    files: new RunFileStore(runFolder),
    trace: new TraceStore(runFolder),
    externalFiles: nodeExternalFileReader,
  };
}

describe('verification executor honesty', () => {
  it('uses an injected proof runner instead of spawning the command directly', async () => {
    const command = failingCommand('sandboxed-tests');
    writeBuildPlan([command]);
    const flow = verificationFlow();
    const step = flow.steps[1];
    if (step === undefined || step.kind !== 'verification') throw new Error('expected step');
    const calls: string[] = [];
    const context: RunContext = {
      ...contextFor(flow),
      proofCommandRunner: async (requested, requestedRoot) => {
        calls.push(`${requestedRoot}:${requested.id}`);
        return {
          command: requested,
          exit_code: 0,
          status: 'passed',
          duration_ms: 1,
          stdout_summary: 'sandboxed proof passed',
          stderr_summary: '',
          timed_out: false,
        };
      },
    };

    const result = await executeVerificationResult(step, context);

    expect(result.kind).toBe('outcome');
    expect(calls).toEqual([`${projectRoot}:sandboxed-tests`]);
  });

  it('names the exit code and the timeout+budget for a mixed failure, and still routes to recovery', async () => {
    writeBuildPlan([failingCommand('unit-tests'), timeoutCommand('full-suite')]);
    const flow = verificationFlow();
    const step = flow.steps[1];
    if (step === undefined || step.kind !== 'verification') throw new Error('expected step');
    const context = contextFor(flow);

    const result = await executeVerificationResult(step, context);

    // Not every failure timed out, so the step still routes to recovery
    // (retry-with-feedback is a legitimate response to a real red command).
    expect(result.kind).toBe('outcome');
    if (result.kind !== 'outcome') throw new Error('expected a routed outcome');
    if ('checkpoint' in result.outcome)
      throw new Error('expected a routed outcome, not a checkpoint');
    expect(result.outcome.route).toBe('retry');
    const reason = result.outcome.details?.reason;
    // The reason names each command by id AND by the command string that ran
    // (R5: the operator must see WHAT failed without opening the run folder).
    expect(reason).toMatch(/command 'unit-tests' \(`.*?`\) exited 1/);
    expect(reason).toMatch(/command 'full-suite' \(`.*?`\) timed out after \d+ms \(budget 200ms\)/);
  });

  it('skips recovery routing and fails directly when every failing command timed out', async () => {
    writeBuildPlan([timeoutCommand('full-suite')]);
    const flow = verificationFlow();
    const step = flow.steps[1];
    if (step === undefined || step.kind !== 'verification') throw new Error('expected step');
    const context = contextFor(flow);

    const result = await executeVerificationResult(step, context);

    // Every failing observation timed out against the same fixed budget:
    // retrying would hit the identical deterministic wall, so the step fails
    // directly instead of taking the 'retry' route that is otherwise available.
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected a failed verification result');
    expect(result.reason).toMatch(/timed out after \d+ms \(budget 200ms\)/);
  });
});

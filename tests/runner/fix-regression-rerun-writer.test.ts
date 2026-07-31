// Unit tests for the fix.regression-rerun@v1 writer.
//
// loadCommands sources the exact command fix-regression-baseline recorded in
// fix.regression-proof@v1, so the two steps cannot disagree about which command
// is the proof. A baseline that captured no proof leaves nothing to rerun.
// buildResult maps the observation to one of three statuses:
//   - cleared: rerun command exited 0 (the fix worked)
//   - still-failing: rerun command exited non-zero (fix didn't clear it)
//   - deferred: no command ran (the baseline proved nothing)
//
// These tests exercise loadCommands' baseline-reading and buildResult's status
// mapping; the runtime spawn loop is not interesting here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fixCompiledFlowPackage } from '../../src/flows/fix/index.js';
import type { FixRegressionProof, FixRegressionRerun } from '../../src/flows/fix/reports.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../src/flows/registries/verification-writers/types.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';

function requireFixRegressionRerunWriter(): VerificationBuilder {
  const writer = fixCompiledFlowPackage.writers.verification.find(
    (w) => w.resultSchemaName === 'fix.regression-rerun@v1',
  );
  if (writer === undefined) {
    throw new Error('fix.regression-rerun@v1 verification writer is not registered');
  }
  return writer;
}

const writer = requireFixRegressionRerunWriter();

const tempRoots: string[] = [];

function tempRunFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'fix-regression-rerun-writer-'));
  tempRoots.push(root);
  return root;
}

function writeJson(runFolder: string, relPath: string, body: unknown): void {
  const fullPath = join(runFolder, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

const REGRESSION_COMMAND = {
  id: 'regression',
  cwd: '.',
  argv: ['node', '-e', 'process.exit(1)'] as string[],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {} as Record<string, string>,
} as const;

const PROVED_OBSERVATION = {
  command_id: REGRESSION_COMMAND.id,
  cwd: REGRESSION_COMMAND.cwd,
  argv: [...REGRESSION_COMMAND.argv],
  timeout_ms: REGRESSION_COMMAND.timeout_ms,
  max_output_bytes: REGRESSION_COMMAND.max_output_bytes,
  env: {},
  exit_code: 1,
  command_status: 'failed',
  duration_ms: 1,
  stdout_summary: '',
  stderr_summary: '',
} as const;

const PROVED_BASELINE: FixRegressionProof = {
  status: 'proved',
  overall_status: 'passed',
  command_source: 'declared',
  baseline: { ...PROVED_OBSERVATION, argv: [...PROVED_OBSERVATION.argv], env: {} },
};

const DEFERRED_BASELINE: FixRegressionProof = {
  status: 'deferred',
  overall_status: 'passed',
  reason: 'nothing was runnable',
};

function makeFixture(baseline: FixRegressionProof): { context: VerificationBuildContext } {
  const runFolder = tempRunFolder();
  writeJson(runFolder, 'reports/fix/regression-proof.json', baseline);
  const flow = {
    steps: [
      {
        id: 'fix-regression-baseline',
        kind: 'verification',
        writes: {
          report: {
            schema: 'fix.regression-proof@v1',
            path: 'reports/fix/regression-proof.json',
          },
        },
      },
      {
        id: 'fix-regression-rerun',
        kind: 'verification',
        writes: {
          report: { schema: 'fix.regression-rerun@v1', path: 'reports/fix/regression-rerun.json' },
        },
      },
    ],
  } as unknown as CompiledFlow;
  const step = {
    id: 'fix-regression-rerun',
    kind: 'verification',
    reads: ['reports/fix/regression-proof.json'],
    writes: {
      report: { schema: 'fix.regression-rerun@v1', path: 'reports/fix/regression-rerun.json' },
    },
  } as unknown as VerificationBuildContext['step'];
  return { context: { runFolder, flow, step } };
}

function observation(
  command: VerificationCommand,
  exitCode: 0 | 1,
): VerificationCommandObservation {
  return {
    command,
    exit_code: exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    duration_ms: 1,
    stdout_summary: '',
    stderr_summary: '',
    timed_out: false,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fixRegressionRerunWriter.loadCommands', () => {
  it('reruns the exact command the baseline proved', () => {
    const commands = writer.loadCommands(makeFixture(PROVED_BASELINE).context);
    expect(commands).toEqual([REGRESSION_COMMAND]);
  });

  it('returns no commands when the baseline captured no proof', () => {
    expect(writer.loadCommands(makeFixture(DEFERRED_BASELINE).context)).toEqual([]);
  });

  // A baseline that ran the project's own check and found it already green
  // proved nothing. Re-running it here would pass and let 'cleared' mean
  // nothing, so it must not run at all.
  it('returns no commands when an adopted check was already green pre-fix', () => {
    const notCaptured: FixRegressionProof = {
      status: 'not-captured',
      overall_status: 'passed',
      command_source: 'adopted-verification',
      reason: "this project's own check already passed before the fix",
      baseline: {
        ...PROVED_OBSERVATION,
        argv: [...PROVED_OBSERVATION.argv],
        env: {},
        exit_code: 0,
        command_status: 'passed',
      },
    };
    expect(writer.loadCommands(makeFixture(notCaptured).context)).toEqual([]);
  });

  it('throws when the schematic does not declare the baseline read', () => {
    const { context } = makeFixture(PROVED_BASELINE);
    const stepWithoutReads = {
      ...context.step,
      reads: [],
    } as VerificationBuildContext['step'];
    expect(() => writer.loadCommands({ ...context, step: stepWithoutReads })).toThrow(
      /requires step .* to read/,
    );
  });
});

describe('fixRegressionRerunWriter.buildResult', () => {
  it("returns 'deferred' when no observations are present", () => {
    const { context } = makeFixture(DEFERRED_BASELINE);
    const result = writer.buildResult([], context) as FixRegressionRerun;
    expect(result.status).toBe('deferred');
    expect(result.overall_status).toBe('passed');
    expect(result.rerun).toBeUndefined();
    expect(result.reason).toMatch(/nothing to rerun/);
  });

  it("returns 'cleared' when the rerun observation passed", () => {
    const { context } = makeFixture(PROVED_BASELINE);
    const result = writer.buildResult(
      [observation(REGRESSION_COMMAND, 0)],
      context,
    ) as FixRegressionRerun;
    expect(result.status).toBe('cleared');
    expect(result.overall_status).toBe('passed');
    expect(result.command_source).toBe('declared');
    expect(result.rerun?.exit_code).toBe(0);
    expect(result.rerun?.command_status).toBe('passed');
  });

  it("returns 'still-failing' when the rerun observation failed", () => {
    const { context } = makeFixture(PROVED_BASELINE);
    const result = writer.buildResult(
      [observation(REGRESSION_COMMAND, 1)],
      context,
    ) as FixRegressionRerun;
    expect(result.status).toBe('still-failing');
    expect(result.overall_status).toBe('failed');
    expect(result.rerun?.exit_code).toBe(1);
    expect(result.rerun?.command_status).toBe('failed');
    expect(result.reason).toMatch(/still fails after it/);
  });
});

// Unit tests for the fix.regression-rerun@v1 writer.
//
// loadCommands sources the same VerificationCommand the brief declared for
// the regression test (or empty when the brief deferred). buildResult maps
// the observation to one of three statuses:
//   - cleared: rerun command exited 0 (the fix worked)
//   - still-failing: rerun command exited non-zero (fix didn't clear it)
//   - deferred: no command ran (brief deferred the regression test)
//
// These tests exercise loadCommands' brief-reading and buildResult's
// status mapping; the runtime spawn loop is not interesting here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fixCompiledFlowPackage } from '../../src/flows/fix/index.js';
import type { FixBrief, FixRegressionRerun } from '../../src/flows/fix/reports.js';
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

function makeFixture(brief: Pick<FixBrief, 'regression_contract'>): {
  context: VerificationBuildContext;
} {
  const runFolder = tempRunFolder();
  const fullBrief: FixBrief = {
    problem_statement: 'something is broken',
    expected_behavior: 'should work',
    observed_behavior: 'does not work',
    scope: 'unit-test fixture',
    regression_contract: brief.regression_contract,
    success_criteria: ['rerun-writer test'],
    verification_command_candidates: [
      {
        id: 'noop',
        cwd: '.',
        argv: ['node', '-e', 'process.exit(0)'],
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
      },
    ],
  } as FixBrief;
  writeJson(runFolder, 'reports/fix/brief.json', fullBrief);
  const flow = {
    steps: [
      {
        id: 'fix-frame',
        kind: 'compose',
        writes: { report: { schema: 'fix.brief@v1', path: 'reports/fix/brief.json' } },
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
    reads: ['reports/fix/brief.json'],
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
  it('returns the brief regression command when status is failing-before-fix', () => {
    const { context } = makeFixture({
      regression_contract: {
        expected_behavior: 'pass',
        actual_behavior: 'fail',
        repro: { kind: 'command', command: REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: REGRESSION_COMMAND },
      },
    });
    const commands = writer.loadCommands(context);
    expect(commands).toEqual([REGRESSION_COMMAND]);
  });

  it('returns no commands when the brief deferred the regression test', () => {
    const { context } = makeFixture({
      regression_contract: {
        expected_behavior: 'pass',
        actual_behavior: 'fail',
        repro: { kind: 'not-reproducible', deferred_reason: 'no repro available' },
        regression_test: { status: 'deferred', deferred_reason: 'no test yet' },
      },
    });
    const commands = writer.loadCommands(context);
    expect(commands).toEqual([]);
  });

  it('throws when the schematic does not declare the brief read', () => {
    const { context } = makeFixture({
      regression_contract: {
        expected_behavior: 'pass',
        actual_behavior: 'fail',
        repro: { kind: 'command', command: REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: REGRESSION_COMMAND },
      },
    });
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
    const { context } = makeFixture({
      regression_contract: {
        expected_behavior: 'pass',
        actual_behavior: 'fail',
        repro: { kind: 'not-reproducible', deferred_reason: 'no repro available' },
        regression_test: { status: 'deferred', deferred_reason: 'no test yet' },
      },
    });
    const result = writer.buildResult([], context) as FixRegressionRerun;
    expect(result.status).toBe('deferred');
    expect(result.overall_status).toBe('passed');
    expect(result.rerun).toBeUndefined();
    expect(result.reason).toMatch(/deferred/);
  });

  it("returns 'cleared' when the rerun observation passed", () => {
    const { context } = makeFixture({
      regression_contract: {
        expected_behavior: 'pass',
        actual_behavior: 'fail',
        repro: { kind: 'command', command: REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: REGRESSION_COMMAND },
      },
    });
    const result = writer.buildResult(
      [observation(REGRESSION_COMMAND, 0)],
      context,
    ) as FixRegressionRerun;
    expect(result.status).toBe('cleared');
    expect(result.overall_status).toBe('passed');
    expect(result.rerun?.exit_code).toBe(0);
    expect(result.rerun?.command_status).toBe('passed');
  });

  it("returns 'still-failing' when the rerun observation failed", () => {
    const { context } = makeFixture({
      regression_contract: {
        expected_behavior: 'pass',
        actual_behavior: 'fail',
        repro: { kind: 'command', command: REGRESSION_COMMAND },
        regression_test: { status: 'failing-before-fix', command: REGRESSION_COMMAND },
      },
    });
    const result = writer.buildResult(
      [observation(REGRESSION_COMMAND, 1)],
      context,
    ) as FixRegressionRerun;
    expect(result.status).toBe('still-failing');
    expect(result.overall_status).toBe('failed');
    expect(result.rerun?.exit_code).toBe(1);
    expect(result.rerun?.command_status).toBe('failed');
    expect(result.reason).toMatch(/regression/i);
  });
});

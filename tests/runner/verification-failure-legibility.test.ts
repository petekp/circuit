import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';
import { initGitProjectRoot, reflectChangedFiles } from '../helpers/working-tree.js';

import { BuildPlan } from '../../src/flows/build/reports.js';
import { FixBaselineSnapshot, FixChange } from '../../src/flows/fix/reports.js';
import { executeVerificationResult } from '../../src/runtime/executors/verification.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { buildRuntimePackageIndex } from '../../src/runtime/manifest/runtime-package-index.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { nodeExternalFileReader } from '../../src/runtime/run/external-files.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { VerificationCommand } from '../../src/schemas/verification.js';

// R5 — a verification abort must name the failing command, not just say a
// check failed. The failure reason carries: the command string (argv), the
// exit code, and the last non-empty stdout/stderr line(s) — so the operator
// reading the abort knows what ran, how it died, and what it said on the way
// out, without opening the run folder.

let runFolder: string;
let projectRoot: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-verification-legibility-run-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'circuit-verification-legibility-project-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

function verificationFlow(): ExecutableFlow {
  return {
    id: 'verification-legibility-fixture',
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

function reportLevelFailureFlow(): ExecutableFlow {
  return {
    id: 'verification-report-reason-fixture',
    version: '0.0.0',
    entry: 'baseline-source',
    stages: [
      {
        id: 'stage',
        stepIds: ['baseline-source', 'change-source', 'fix-change-set'],
      },
    ],
    steps: [
      {
        id: 'baseline-source',
        kind: 'compose',
        writer: 'noop',
        routes: { pass: { kind: 'step', stepId: 'change-source' } },
        writes: {
          report: {
            path: 'reports/fix/baseline-snapshot.json',
            schema: 'fix.baseline-snapshot@v1',
          },
        },
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
      },
      {
        id: 'change-source',
        kind: 'compose',
        writer: 'noop',
        routes: { pass: { kind: 'step', stepId: 'fix-change-set' } },
        writes: {
          report: { path: 'reports/fix/change.json', schema: 'fix.change@v1' },
        },
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
      },
      {
        id: 'fix-change-set',
        kind: 'verification',
        reads: [
          {
            path: 'reports/fix/baseline-snapshot.json',
            schema: 'fix.baseline-snapshot@v1',
          },
          { path: 'reports/fix/change.json', schema: 'fix.change@v1' },
        ],
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          retry: { kind: 'terminal', target: '@stop' },
        },
        writes: {
          report: { path: 'reports/fix/change-set.json', schema: 'fix.change-set@v1' },
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
    objective: 'prove the verification failure reason names the failing command',
    approach: 'run direct argv commands that fail with observable output',
    slices: [{ id: 'slice-1', intent: 'exercise the failure-reason seam' }],
    allowed_touch_area: [],
    verification: { commands },
  });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
}

function contextFor(flow: ExecutableFlow): RunContext {
  return {
    flow,
    packageIndex: buildRuntimePackageIndex(flow),
    runId: '74000000-0000-0000-0000-000000000001',
    runDir: runFolder,
    projectRoot,
    goal: 'prove the verification failure reason is legible',
    manifestHash: `runtime:${flow.id}@${flow.version}`,
    now: deterministicNow(Date.UTC(2026, 6, 12, 13, 0, 0)),
    files: new RunFileStore(runFolder),
    trace: new TraceStore(runFolder),
    externalFiles: nodeExternalFileReader,
  };
}

async function failureReasonFor(commands: readonly VerificationCommand[]): Promise<string> {
  writeBuildPlan(commands);
  const flow = verificationFlow();
  const step = flow.steps[1];
  if (step === undefined || step.kind !== 'verification') throw new Error('expected step');
  const result = await executeVerificationResult(step, contextFor(flow));
  if (result.kind === 'failed') return result.reason;
  if (result.kind === 'outcome' && !('checkpoint' in result.outcome)) {
    const reason = result.outcome.details?.reason;
    if (typeof reason === 'string') return reason;
  }
  throw new Error('expected a failure reason');
}

// The head line is concatenated at runtime so the contiguous text 'suite
// started' exists ONLY in the command's output, never in its argv — letting
// the not-in-reason assertion below target the output dump specifically.
const NOISY_FAILING_SOURCE =
  'console.log("suite " + "started"); console.log("2 tests failed"); console.error("assertion blew up"); process.exit(1)';

describe('verification failure reasons name the failing command', () => {
  it('names the command string, exit code, and last output lines', async () => {
    const command: VerificationCommand = {
      id: 'unit-tests',
      cwd: '.',
      argv: [process.execPath, '-e', NOISY_FAILING_SOURCE],
      timeout_ms: 5_000,
      max_output_bytes: 10_000,
      env: {},
    };

    const reason = await failureReasonFor([command]);

    expect(reason).toContain("verification step 'verify-step' failed:");
    // The command is named by id AND by what actually ran.
    expect(reason).toMatch(/command 'unit-tests' \(`.*`\) exited 1/);
    // The last non-empty line of each stream is quoted, so the operator sees
    // WHAT the command said as it failed — not the head of an output dump.
    expect(reason).toContain('last stdout: "2 tests failed"');
    expect(reason).toContain('last stderr: "assertion blew up"');
    // The head-of-output lines must NOT crowd the reason.
    expect(reason).not.toContain('suite started');
  });

  it('uses a failed verification report reason when every helper command passed', async () => {
    initGitProjectRoot(projectRoot);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const reportsDir = join(runFolder, 'reports/fix');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, 'baseline-snapshot.json'),
      `${JSON.stringify(
        FixBaselineSnapshot.parse({
          overall_status: 'passed',
          head_sha: headSha,
          entries: [],
          hidden_index_flags: [],
        }),
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(reportsDir, 'change.json'),
      `${JSON.stringify(
        FixChange.parse({
          verdict: 'accept',
          summary: 'declare only the intended file',
          diagnosis_ref: 'fixture diagnosis',
          changed_files: ['src/declared.ts'],
          evidence: ['fixture evidence'],
        }),
        null,
        2,
      )}\n`,
    );
    reflectChangedFiles(projectRoot, ['src/declared.ts', 'src/undeclared.ts']);

    const flow = reportLevelFailureFlow();
    const step = flow.steps[2];
    if (step === undefined || step.kind !== 'verification') throw new Error('expected step');
    const result = await executeVerificationResult(step, contextFor(flow));
    const reason =
      result.kind === 'failed'
        ? result.reason
        : result.kind === 'outcome' && !('checkpoint' in result.outcome)
          ? result.outcome.details?.reason
          : undefined;

    expect(reason).toContain("verification step 'fix-change-set' failed:");
    expect(reason).toContain('undeclared extras: src/undeclared.ts');

    const trace = await new TraceStore(runFolder).load();
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'verification.command_evaluated',
        step_id: 'fix-change-set',
        command_id: 'fix-change-set-git-state',
        status: 'passed',
      }),
    );
  });

  it('says plainly when the failing command produced no output', async () => {
    const command: VerificationCommand = {
      id: 'silent-check',
      cwd: '.',
      argv: [process.execPath, '-e', 'process.exit(3)'],
      timeout_ms: 5_000,
      max_output_bytes: 10_000,
      env: {},
    };

    const reason = await failureReasonFor([command]);

    expect(reason).toMatch(/command 'silent-check' \(`.*`\) exited 3/);
    expect(reason).toContain('the command produced no output');
  });

  it('keeps the command string and budget on a timed-out command', async () => {
    const command: VerificationCommand = {
      id: 'slow-suite',
      cwd: '.',
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
      timeout_ms: 200,
      max_output_bytes: 10_000,
      env: {},
    };

    const reason = await failureReasonFor([command]);

    expect(reason).toMatch(/command 'slow-suite' \(`.*`\) timed out after \d+ms \(budget 200ms\)/);
  });
});

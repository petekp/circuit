import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { BuildPlan, BuildVerification } from '../../src/flows/build/reports.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { ProofAssessment } from '../../src/schemas/proof-assessment.js';
import { RunTrace } from '../../src/schemas/run.js';

function writeJson(root: string, rel: string, body: unknown): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(body, null, 2)}\n`);
}

function readJson(root: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown;
}

function commandPlan(command: {
  argv: string[];
  timeout_ms?: number;
  max_output_bytes?: number;
  cwd?: string;
  env?: Record<string, string>;
}) {
  return commandsPlan([
    {
      id: 'node-check',
      ...command,
    },
  ]);
}

function commandsPlan(
  commands: Array<{
    id: string;
    argv: string[];
    timeout_ms?: number;
    max_output_bytes?: number;
    cwd?: string;
    env?: Record<string, string>;
  }>,
) {
  return BuildPlan.parse({
    objective: 'Verify a Build run',
    approach: 'Run the planned command directly',
    slices: [{ id: 'slice-1', intent: 'Execute verification', anticipated_file_extensions: [] }],
    verification: {
      commands: commands.map((command) => ({
        id: command.id,
        cwd: command.cwd ?? '.',
        argv: command.argv,
        timeout_ms: command.timeout_ms ?? 5_000,
        max_output_bytes: command.max_output_bytes ?? 20_000,
        env: command.env ?? {},
      })),
    },
  });
}

function verificationCompiledFlow(options: { verifyRoutes?: Record<string, string> } = {}): {
  bytes: Buffer;
} {
  const raw = {
    schema_version: '2',
    id: 'build-verification-exec-test',
    version: '0.1.0',
    purpose: 'test Build verification execution',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'seed-plan-step',
    stages: [
      {
        id: 'verify-stage',
        title: 'Verify',
        canonical: 'verify',
        steps: ['seed-plan-step', 'verify-step'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'act', 'review', 'close'],
      rationale: 'test-only Build verification command execution substrate.',
    },
    steps: [
      {
        id: 'seed-plan-step',
        title: 'Seed plan',
        protocol: 'test-seed-build-plan@v1',
        reads: [],
        routes: { pass: 'verify-step' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: { report: { path: 'reports/build/plan.json', schema: 'build.plan@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['objective', 'verification'],
        },
      },
      {
        id: 'verify-step',
        title: 'Verify',
        protocol: 'build-verify@v1',
        reads: ['reports/build/plan.json'],
        routes: options.verifyRoutes ?? { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'verification',
        writes: {
          report: { path: 'reports/build/verification.json', schema: 'build.verification@v1' },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['overall_status', 'commands'],
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(raw));
  CompiledFlow.parse(raw);
  return { bytes };
}

function planWriter(plan: unknown): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      if (step.id !== 'seed-plan-step') {
        throw new Error(`unexpected compose step ${step.id}`);
      }
      const report = step.writes?.report;
      if (report === undefined) {
        throw new Error(`seed step '${step.id}' must write a report`);
      }
      writeJson(context.runDir, report.path, plan);
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        report_schema: report.schema ?? 'runtime.compose',
      });
      return { route: 'pass', details: { report: report.path } };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = join(tmpdir(), `circuit-build-verification-${randomUUID()}`);
  mkdirSync(runFolderBase, { recursive: true });
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('Build verification command execution', () => {
  it('runs a direct argv command and writes passed build.verification evidence', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'pass');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000000',
      goal: 'Run verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 0, 0)),
      executors: planWriter(
        commandPlan({
          argv: [process.execPath, '-e', "process.stdout.write('verified')"],
        }),
      ),
    });

    expect(outcome.outcome).toBe('complete');
    const verification = BuildVerification.parse(
      readJson(runFolder, 'reports/build/verification.json'),
    );
    expect(verification).toMatchObject({
      overall_status: 'passed',
      commands: [
        {
          command_id: 'node-check',
          argv: [process.execPath, '-e', "process.stdout.write('verified')"],
          cwd: '.',
          exit_code: 0,
          status: 'passed',
          stdout_summary: 'verified',
        },
      ],
    });
    const proof = ProofAssessment.parse(
      readJson(runFolder, 'reports/proof/verify-step-attempt-1.assessment.json'),
    );
    expect(proof).toMatchObject({
      overall_status: 'proven',
      close_allowed: true,
      evidence: [
        expect.objectContaining({
          kind: 'command',
          producer: 'runtime',
          independence: 'runtime',
          result: 'pass',
        }),
      ],
      results: [
        expect.objectContaining({
          status: 'proven',
          missing: [],
          contradictions: [],
        }),
      ],
    });
    const trace = await new TraceStore(runFolder).load();
    expect(trace.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'guidance.decision',
        'verification.command_evaluated',
        'proof.assessed',
        'run.closed',
      ]),
    );
    const commandEntry = trace.find((entry) => entry.kind === 'verification.command_evaluated');
    expect(commandEntry).toMatchObject({
      step_id: 'verify-step',
      attempt: 1,
      command_id: 'node-check',
      cwd: '.',
      argv: [process.execPath, '-e', "process.stdout.write('verified')"],
      exit_code: 0,
      status: 'passed',
      stdout_summary: 'verified',
      stderr_summary: '',
    });
    expect(commandEntry?.duration_ms).toEqual(expect.any(Number));
    const commandIndex = trace.findIndex(
      (entry) => entry.kind === 'verification.command_evaluated',
    );
    const reportIndex = trace.findIndex(
      (entry) => entry.kind === 'step.report_written' && entry.step_id === 'verify-step',
    );
    const proofIndex = trace.findIndex((entry) => entry.kind === 'proof.assessed');
    const closeIndex = trace.findIndex((entry) => entry.kind === 'run.closed');
    expect(commandIndex).toBeGreaterThan(-1);
    expect(reportIndex).toBeGreaterThan(commandIndex);
    expect(proofIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(proofIndex);
    expect(RunTrace.safeParse(trace).success).toBe(true);
  });

  it('writes failed verification evidence and aborts when a command exits nonzero', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'fail');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000001',
      goal: 'Run failing verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 5, 0)),
      executors: planWriter(
        commandPlan({
          argv: [process.execPath, '-e', "process.stderr.write('nope'); process.exit(2)"],
        }),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/verification step 'verify-step' failed/);
    const verification = BuildVerification.parse(
      readJson(runFolder, 'reports/build/verification.json'),
    );
    expect(verification.overall_status).toBe('failed');
    expect(verification.commands[0]).toMatchObject({
      exit_code: 2,
      status: 'failed',
      stderr_summary: 'nope',
    });
    const proof = ProofAssessment.parse(
      readJson(runFolder, 'reports/proof/verify-step-attempt-1.assessment.json'),
    );
    expect(proof).toMatchObject({
      overall_status: 'contradicted',
      close_allowed: false,
      evidence: [
        expect.objectContaining({
          kind: 'command',
          producer: 'runtime',
          independence: 'runtime',
          result: 'fail',
        }),
      ],
      results: [
        expect.objectContaining({
          status: 'contradicted',
          contradictions: [expect.stringContaining('node-check')],
        }),
      ],
    });
    const trace = await new TraceStore(runFolder).load();
    const commandEntry = trace.find((entry) => entry.kind === 'verification.command_evaluated');
    expect(commandEntry).toMatchObject({
      step_id: 'verify-step',
      attempt: 1,
      command_id: 'node-check',
      exit_code: 2,
      status: 'failed',
      stderr_summary: 'nope',
    });
    expect(RunTrace.safeParse(trace).success).toBe(true);
  });

  it('blocks the proof plan when an npm script is missing before spawn', async () => {
    const { bytes } = verificationCompiledFlow({
      verifyRoutes: { pass: '@complete', retry: 'seed-plan-step' },
    });
    const runFolder = join(runFolderBase, 'missing-npm-script');
    const projectRoot = join(runFolderBase, 'missing-script-project');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } })}\n`,
    );

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot,
      runId: 'b2000000-0000-0000-0000-000000000009',
      goal: 'Run stale verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 45, 0)),
      executors: planWriter(
        commandPlan({
          argv: ['npm', 'run', 'check'],
        }),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/missing package script "check"/);
    expect(outcome.reason).not.toMatch(/failed one or more commands|retry/);
    expect(existsSync(join(runFolder, 'reports/build/verification.json'))).toBe(false);
  });

  it('keeps completed command trace evidence when a later command blocks', async () => {
    const { bytes } = verificationCompiledFlow({
      verifyRoutes: { pass: '@complete', retry: 'seed-plan-step' },
    });
    const runFolder = join(runFolderBase, 'partial-command-trace');
    const projectRoot = join(runFolderBase, 'partial-command-project');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } })}\n`,
    );

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot,
      runId: 'b2000000-0000-0000-0000-000000000010',
      goal: 'Run partially blocked verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 47, 0)),
      executors: planWriter(
        commandsPlan([
          {
            id: 'first-check',
            argv: [process.execPath, '-e', "process.stdout.write('first')"],
          },
          {
            id: 'missing-script',
            argv: ['npm', 'run', 'check'],
          },
        ]),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/missing package script "check"/);
    expect(existsSync(join(runFolder, 'reports/build/verification.json'))).toBe(false);

    const trace = await new TraceStore(runFolder).load();
    const commandEntries = trace.filter((entry) => entry.kind === 'verification.command_evaluated');
    expect(commandEntries).toHaveLength(1);
    expect(commandEntries[0]).toMatchObject({
      step_id: 'verify-step',
      attempt: 1,
      command_id: 'first-check',
      exit_code: 0,
      status: 'passed',
      stdout_summary: 'first',
    });
    expect(RunTrace.safeParse(trace).success).toBe(true);
  });

  it('blocks the proof plan when the command binary cannot launch', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'missing-binary');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000011',
      goal: 'Run unavailable binary',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 50, 0)),
      executors: planWriter(
        commandPlan({
          argv: ['definitely-not-a-circuit-verifier', '--version'],
        }),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/could not launch/);
    expect(existsSync(join(runFolder, 'reports/build/verification.json'))).toBe(false);
  });

  it('blocks the proof plan when cwd is invalid', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'missing-cwd');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000012',
      goal: 'Run invalid cwd verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 55, 0)),
      executors: planWriter(
        commandPlan({
          cwd: 'does-not-exist',
          argv: [process.execPath, '-e', "process.stdout.write('never')"],
        }),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/verification cwd rejected.*does not exist/);
    expect(outcome.reason).not.toMatch(/report writer failed/);
    expect(existsSync(join(runFolder, 'reports/build/verification.json'))).toBe(false);
  });

  it('fails closed on timeout while keeping typed verification evidence', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'timeout');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000002',
      goal: 'Run timed verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 10, 0)),
      executors: planWriter(
        commandPlan({
          argv: [process.execPath, '-e', 'setTimeout(() => {}, 500)'],
          timeout_ms: 25,
        }),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    const verification = BuildVerification.parse(
      readJson(runFolder, 'reports/build/verification.json'),
    );
    expect(verification.overall_status).toBe('failed');
    expect(verification.commands[0]?.stderr_summary).toMatch(/ETIMEDOUT|SIGTERM/);
  });

  it('rejects unsafe verification command payloads before execution', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'unsafe');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000003',
      goal: 'Reject unsafe verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 15, 0)),
      executors: planWriter({
        objective: 'Unsafe',
        approach: 'Do not run',
        slices: [{ id: 'slice-1', intent: 'Reject', anticipated_file_extensions: [] }],
        verification: {
          commands: [
            {
              id: 'shell',
              cwd: '.',
              argv: ['sh', '-c', 'echo unsafe'],
              timeout_ms: 1_000,
              max_output_bytes: 20_000,
              env: {},
            },
          ],
        },
      }),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toMatch(/direct argv execution|shell executable/);
    expect(existsSync(join(runFolder, 'reports/build/verification.json'))).toBe(false);
  });

  it('rejects project cwd escapes and symlinked cwd ancestors before execution', async () => {
    const { bytes } = verificationCompiledFlow();
    const projectRoot = join(runFolderBase, 'project');
    const outside = join(runFolderBase, 'outside');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(projectRoot, 'linked-outside'));
    const marker = join(outside, 'marker.txt');

    const lexicalRunFolder = join(runFolderBase, 'cwd-lexical');
    const lexical = await runCompiledFlow({
      runDir: lexicalRunFolder,
      flowBytes: bytes,
      projectRoot,
      runId: 'b2000000-0000-0000-0000-000000000004',
      goal: 'Reject lexical cwd escape',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 20, 0)),
      executors: planWriter({
        objective: 'Unsafe cwd',
        approach: 'Do not run',
        slices: [{ id: 'slice-1', intent: 'Reject', anticipated_file_extensions: [] }],
        verification: {
          commands: [
            {
              id: 'cwd-escape',
              cwd: '../outside',
              argv: [
                process.execPath,
                '-e',
                "require('node:fs').writeFileSync('marker.txt', 'bad')",
              ],
              timeout_ms: 1_000,
              max_output_bytes: 20_000,
              env: {},
            },
          ],
        },
      }),
    });
    expect(lexical.outcome).toBe('aborted');
    expect(lexical.reason).toMatch(/cwd must not escape|cwd/);

    const symlinkRunFolder = join(runFolderBase, 'cwd-symlink');
    const symlinked = await runCompiledFlow({
      runDir: symlinkRunFolder,
      flowBytes: bytes,
      projectRoot,
      runId: 'b2000000-0000-0000-0000-000000000005',
      goal: 'Reject symlink cwd escape',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 25, 0)),
      executors: planWriter(
        commandPlan({
          cwd: 'linked-outside',
          argv: [process.execPath, '-e', "require('node:fs').writeFileSync('marker.txt', 'bad')"],
        }),
      ),
    });

    expect(symlinked.outcome).toBe('aborted');
    expect(symlinked.reason).toMatch(/symlink/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(symlinkRunFolder, 'reports/build/verification.json'))).toBe(false);
  });

  it('uses declared projectRoot instead of ambient process cwd', async () => {
    const { bytes } = verificationCompiledFlow();
    const projectRoot = join(runFolderBase, 'declared-project');
    mkdirSync(projectRoot, { recursive: true });
    expect(realpathSync(projectRoot)).not.toBe(realpathSync(process.cwd()));
    const runFolder = join(runFolderBase, 'declared-root');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot,
      runId: 'b2000000-0000-0000-0000-000000000006',
      goal: 'Use declared project root',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 30, 0)),
      executors: planWriter(
        commandPlan({
          argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
        }),
      ),
    });

    expect(outcome.outcome).toBe('complete');
    const verification = BuildVerification.parse(
      readJson(runFolder, 'reports/build/verification.json'),
    );
    expect(verification.commands[0]?.stdout_summary).toBe(realpathSync(projectRoot));
  });

  it('uses an explicit environment policy instead of inheriting arbitrary parent env', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'env');
    const priorParent = process.env.CIRCUIT_PARENT_ONLY_SECRET;
    process.env.CIRCUIT_PARENT_ONLY_SECRET = 'leaked';
    try {
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        projectRoot: process.cwd(),
        runId: 'b2000000-0000-0000-0000-000000000007',
        goal: 'Constrain verification env',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 3, 25, 2, 35, 0)),
        executors: planWriter(
          commandPlan({
            argv: [
              process.execPath,
              '-e',
              "process.stdout.write(`parent=${process.env.CIRCUIT_PARENT_ONLY_SECRET ?? ''};explicit=${process.env.CIRCUIT_EXPLICIT ?? ''}`)",
            ],
            env: { CIRCUIT_EXPLICIT: 'present' },
          }),
        ),
      });

      expect(outcome.outcome).toBe('complete');
      const verification = BuildVerification.parse(
        readJson(runFolder, 'reports/build/verification.json'),
      );
      expect(verification.commands[0]?.stdout_summary).toBe('parent=;explicit=present');
    } finally {
      if (priorParent === undefined) {
        Reflect.deleteProperty(process.env, 'CIRCUIT_PARENT_ONLY_SECRET');
      } else {
        process.env.CIRCUIT_PARENT_ONLY_SECRET = priorParent;
      }
    }
  });

  it('fails closed and bounds captured stdout when output exceeds max_output_bytes', async () => {
    const { bytes } = verificationCompiledFlow();
    const runFolder = join(runFolderBase, 'output-limit');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: 'b2000000-0000-0000-0000-000000000008',
      goal: 'Bound verification output',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 2, 40, 0)),
      executors: planWriter(
        commandPlan({
          argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(10000))"],
          max_output_bytes: 256,
        }),
      ),
    });

    expect(outcome.outcome).toBe('aborted');
    const verification = BuildVerification.parse(
      readJson(runFolder, 'reports/build/verification.json'),
    );
    expect(verification.overall_status).toBe('failed');
    const command = verification.commands[0];
    expect(command).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(Buffer.byteLength(command?.stdout_summary ?? '')).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(command?.stderr_summary ?? '')).toBeLessThanOrEqual(256);
    expect(command?.stderr_summary).toMatch(/ENOBUFS|SIGTERM|spawnSync/);
  });
});

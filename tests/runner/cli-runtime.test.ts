import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/circuit.js';
import { renderCommandHelp } from '../../src/cli/help.js';
import {
  CLI_RUNTIME_ROUTING_POLICY,
  COMPOSE_WRITER_RUNTIME_POLICY,
  RUNTIME_POLICY_REASONS,
} from '../../src/cli/runtime-routing-policy.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';
import { RunResult } from '../../src/schemas/result.js';
import type { ComposeWriterFn, RelayFn } from '../../src/shared/relay-runtime-types.js';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

const REVIEW_RELAY_BODY = JSON.stringify({
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function relayerWithBody(body: string): RelayFn {
  return makeStubRelayer(body, { receipt_id: 'stub-receipt-cli-runtime' });
}

function buildRelayer(): RelayFn {
  const buildContextBody = JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches.' }],
    observations: ['The target module is small and self-contained.'],
    open_questions: [],
    anticipated_file_extensions: ['.ts'],
  });
  const buildImplementationBody = JSON.stringify({
    verdict: 'accept',
    summary: 'Build relay completed',
    changed_files: ['src/example.ts'],
    evidence: ['stub implementation'],
  });
  const buildReviewBody = JSON.stringify({
    verdict: 'accept',
    summary: 'No blocking issue found',
    findings: [],
    alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
  });
  return makeStubRelayer(
    (input) => {
      if (input.prompt.includes('Step: analyze-step')) return buildContextBody;
      return input.prompt.includes('Step: review-step') ? buildReviewBody : buildImplementationBody;
    },
    { receipt_id: 'stub-receipt-cli-runtime-build' },
  );
}

async function captureMain(
  argv: readonly string[],
  options: {
    readonly relayer?: RelayFn;
    readonly composeWriter?: ComposeWriterFn;
    readonly configCwd?: string;
    readonly runId?: string;
  } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const { result, stdout, stderr } = await captureStreams(() =>
    main(argv, {
      ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
      ...(options.composeWriter === undefined ? {} : { composeWriter: options.composeWriter }),
      now: deterministicNow(Date.UTC(2026, 4, 3, 20, 0, 0)),
      runId: options.runId ?? '85000000-0000-4000-8000-000000000001',
      configHomeDir: join(runFolderBase, 'empty-home'),
      // Isolate the project-config dir like configHomeDir above: never read the
      // developer's real <cwd>/.circuit/config.yaml (C1). Fresh-repo default;
      // tests that need a real project root still pass configCwd explicitly.
      configCwd: options.configCwd ?? join(runFolderBase, 'empty-cwd'),
    }),
  );
  return { code: result, stdout, stderr };
}

function withRuntimeDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
  const original = process.env.CIRCUIT_SHOW_RUNTIME_DECISION;
  process.env.CIRCUIT_SHOW_RUNTIME_DECISION = '1';
  return operation().finally(() => {
    process.env.CIRCUIT_SHOW_RUNTIME_DECISION = original;
  });
}

function writeProjectRoot(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'package.json'),
    `${JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
}

function firstTraceEntry(runFolder: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runFolder, 'trace.ndjson'), 'utf8').split(/\r?\n/, 1)[0] ?? '{}',
  ) as Record<string, unknown>;
}

function expectStdoutKeys(output: Record<string, unknown>, keys: readonly string[]): void {
  expect(Object.keys(output)).toEqual(keys);
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = join(tmpdir(), `circuit-cli-runtime-${randomUUID()}`);
  mkdirSync(runFolderBase, { recursive: true });
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('CLI runtime', () => {
  it('documents current runtime routing without migration flags', () => {
    // The routing policy must stay operator-discoverable: `circuit run --help`
    // (rendered by renderCommandHelp) carries it verbatim.
    const text = renderCommandHelp('run');
    expect(text).toContain(CLI_RUNTIME_ROUTING_POLICY);
    expect(text).toContain('CIRCUIT_SHOW_RUNTIME_DECISION=1');
    expect(text).toContain('includes runtime_reason');
    expect(text).toContain('untrusted fixtures');
    expect(text).not.toContain(`CIRCUIT_${2}_RUNTIME`);
    expect(text).not.toContain('rollback');
  });

  it('documents composeWriter injection as unsupported for CLI runs', () => {
    expect(COMPOSE_WRITER_RUNTIME_POLICY).toMatchObject({
      status: 'unsupported',
      runtimeCustomization: 'executor-injection-or-generated-reports',
      reason: RUNTIME_POLICY_REASONS.composeWriter,
    });
  });

  it('runs Review through the default runtime without runtime identity fields', async () => {
    const runFolder = join(runFolderBase, 'review');
    const result = await captureMain(
      ['run', 'review', '--goal', 'review this patch', '--run-folder', runFolder],
      { relayer: relayerWithBody(REVIEW_RELAY_BODY) },
    );

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      flow_id: 'review',
      selected_flow: 'review',
      routed_by: 'explicit',
      outcome: 'complete',
    });
    const expectedKeys = [
      'schema_version',
      'run_id',
      'flow_id',
      'resolved_axes',
      'selected_flow',
      'routed_by',
      'router_reason',
      'run_folder',
      'outcome',
      'trace_entries_observed',
      'result_path',
      'operator_summary_path',
      'operator_summary_markdown_path',
      'operator_summary_status_text',
      'run_envelope_path',
      'run_process_evidence_path',
      'run_surface_markdown_path',
      'run_surface_status_text',
    ];
    if (typeof output.operator_summary_html_path === 'string') {
      expectedKeys.splice(
        expectedKeys.indexOf('run_envelope_path'),
        0,
        'operator_summary_html_path',
      );
    }
    expectStdoutKeys(output, expectedKeys);
    expect(output).not.toHaveProperty('runtime');
    expect(output).not.toHaveProperty('runtime_reason');
    expect(firstTraceEntry(runFolder)).toMatchObject({
      schema_version: 1,
      kind: 'run.bootstrapped',
      flow_id: 'review',
    });
    expect(
      RunResult.parse(JSON.parse(readFileSync(join(runFolder, 'reports/result.json'), 'utf8'))),
    ).toMatchObject({ flow_id: 'review', outcome: 'complete' });
  });

  it('ignores MCP-looking environment variables and preserves valid workspace symlinks', async () => {
    const realProject = join(runFolderBase, 'ordinary-real-project');
    const workspaceAlias = join(runFolderBase, 'ordinary-workspace-alias');
    const codexHome = join(runFolderBase, 'ordinary-codex-home');
    const runFolder = join(runFolderBase, 'ordinary-symlink-review');
    const target = join(realProject, 'src', 'target.ts');
    const linked = join(realProject, 'src', 'linked.ts');
    writeProjectRoot(realProject);
    mkdirSync(join(realProject, 'src'), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: realProject });
    writeFileSync(target, 'export const answer = 42;\n');
    execFileSync('git', ['add', 'package.json', 'src/target.ts'], { cwd: realProject });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Circuit',
        '-c',
        'user.email=circuit@example.test',
        'commit',
        '--quiet',
        '-m',
        'base',
      ],
      { cwd: realProject },
    );
    symlinkSync('target.ts', linked);
    execFileSync('git', ['add', 'src/linked.ts'], { cwd: realProject });
    symlinkSync(realProject, workspaceAlias, 'dir');

    let relayedPrompt = '';
    const result = await withScopedEnv(
      {
        CIRCUIT_HOST_KIND: undefined,
        CIRCUIT_MCP_ACTIVATE: '1',
        CIRCUIT_MCP_PROOF_RUNNER: '/outside/ordinary-cli-must-ignore-this',
        CODEX_HOME: codexHome,
      },
      () =>
        captureMain(
          ['run', 'review', '--goal', 'review the staged symlink', '--run-folder', runFolder],
          {
            configCwd: workspaceAlias,
            relayer: makeStubRelayer(
              (input) => {
                relayedPrompt = input.prompt;
                return REVIEW_RELAY_BODY;
              },
              { receipt_id: 'stub-receipt-ordinary-symlink' },
            ),
          },
        ),
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      flow_id: 'review',
      selected_flow: 'review',
      outcome: 'complete',
    });
    expect(relayedPrompt).toContain('src/linked.ts');
    expect(relayedPrompt).toContain('+target.ts');
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linked)).toBe('target.ts');
    expect(existsSync(join(codexHome, 'circuit', 'mcp', 'v1'))).toBe(false);
  });

  it('keeps successful run stdout when post-run artifact writers fail', async () => {
    const runFolder = join(runFolderBase, 'review-post-run-writer-failure');
    const relayer = makeStubRelayer(
      () => {
        mkdirSync(join(runFolder, 'reports', 'operator-summary.json'), { recursive: true });
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'stub-receipt-cli-runtime' },
    );
    const result = await captureMain(
      ['run', 'review', '--goal', 'review this patch', '--run-folder', runFolder],
      { relayer },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      flow_id: 'review',
      outcome: 'complete',
      result_path: join(runFolder, 'reports/result.json'),
    });
    expect(output).not.toHaveProperty('operator_summary_path');
    expect(output.post_run_artifact_warnings).toEqual([
      expect.objectContaining({ label: 'operator-summary' }),
    ]);
    expect(result.stderr).toContain('warning: post-run artifact operator-summary failed:');
  });

  it('keeps progress JSONL parseable when post-run artifact writers fail', async () => {
    const runFolder = join(runFolderBase, 'review-post-run-writer-failure-progress');
    const relayer = makeStubRelayer(
      () => {
        mkdirSync(join(runFolder, 'reports', 'operator-summary.json'), { recursive: true });
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'stub-receipt-cli-runtime-progress' },
    );
    const result = await captureMain(
      [
        'run',
        'review',
        '--goal',
        'review this patch',
        '--progress',
        'jsonl',
        '--run-folder',
        runFolder,
      ],
      { relayer },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      flow_id: 'review',
      outcome: 'complete',
      result_path: join(runFolder, 'reports/result.json'),
      post_run_artifact_warnings: [expect.objectContaining({ label: 'operator-summary' })],
    });
    expect(result.stderr).not.toContain('warning: post-run artifact');
    const progress = result.stderr
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ProgressEvent.parse(JSON.parse(line)));
    expect(progress.map((event) => event.type)).toContain('run.completed');
  });

  it('emits selector diagnostics only when requested', async () => {
    const runFolder = join(runFolderBase, 'review-diagnostics');
    const result = await withRuntimeDiagnostics(() =>
      captureMain(['run', 'review', '--goal', 'review this patch', '--run-folder', runFolder], {
        relayer: relayerWithBody(REVIEW_RELAY_BODY),
      }),
    );

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      flow_id: 'review',
      outcome: 'complete',
      runtime_reason: expect.stringContaining(
        "runtime supports fresh review axis selection 'default'",
      ),
    });
    expect(output).not.toHaveProperty('runtime');
  });

  it('accepts generated explicit fixtures', async () => {
    const runFolder = join(runFolderBase, 'generated-fixture');
    const result = await captureMain(
      [
        'run',
        'review',
        '--goal',
        'review this patch',
        '--fixture',
        join(process.cwd(), 'generated/flows/review/circuit.json'),
        '--run-folder',
        runFolder,
      ],
      { relayer: relayerWithBody(REVIEW_RELAY_BODY) },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ flow_id: 'review', outcome: 'complete' });
    expect(firstTraceEntry(runFolder)).toMatchObject({
      schema_version: 1,
      kind: 'run.bootstrapped',
      flow_id: 'review',
    });
  });

  it('nudges once per repo to install the Codex handoff hook on a Codex run (A3)', async () => {
    const projectRoot = join(runFolderBase, 'codex-assure-project');
    writeProjectRoot(projectRoot);
    // An empty CODEX_HOME means the Codex handoff hook is not installed.
    const codexHome = join(runFolderBase, 'codex-home');
    mkdirSync(codexHome, { recursive: true });

    const prevHost = process.env.CIRCUIT_HOST_KIND;
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CIRCUIT_HOST_KIND = 'codex';
    process.env.CODEX_HOME = codexHome;
    try {
      const first = await captureMain(
        [
          'run',
          'review',
          '--goal',
          'review this patch',
          '--run-folder',
          join(runFolderBase, 'a3-run-1'),
        ],
        { relayer: relayerWithBody(REVIEW_RELAY_BODY), configCwd: projectRoot },
      );
      expect(first.code, first.stderr).toBe(0);
      expect(first.stderr).toContain('install --host codex');

      // Once-per-repo: the next Codex run in the same repo does not nag again.
      const second = await captureMain(
        [
          'run',
          'review',
          '--goal',
          'review this patch again',
          '--run-folder',
          join(runFolderBase, 'a3-run-2'),
        ],
        { relayer: relayerWithBody(REVIEW_RELAY_BODY), configCwd: projectRoot },
      );
      expect(second.code, second.stderr).toBe(0);
      expect(second.stderr).not.toContain('install --host codex');
    } finally {
      if (prevHost === undefined) Reflect.deleteProperty(process.env, 'CIRCUIT_HOST_KIND');
      else process.env.CIRCUIT_HOST_KIND = prevHost;
      if (prevCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
      else process.env.CODEX_HOME = prevCodexHome;
    }
  });

  it('rejects untrusted explicit fixtures before writing a run folder', async () => {
    const fixturePath = join(runFolderBase, 'fixtures/review.json');
    mkdirSync(join(runFolderBase, 'fixtures'), { recursive: true });
    writeFileSync(fixturePath, readFileSync('generated/flows/review/circuit.json'));
    const runFolder = join(runFolderBase, 'untrusted-fixture');

    const result = await captureMain(
      [
        'run',
        'review',
        '--goal',
        'review this patch',
        '--fixture',
        fixturePath,
        '--run-folder',
        runFolder,
      ],
      { relayer: relayerWithBody(REVIEW_RELAY_BODY) },
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(RUNTIME_POLICY_REASONS.externalFixtureOrRoot);
    expect(existsSync(runFolder)).toBe(false);
  });

  it('rejects programmatic composeWriter injection before writing a run folder', async () => {
    const runFolder = join(runFolderBase, 'compose-writer');
    let writerCalled = false;
    const result = await captureMain(
      ['run', 'review', '--goal', 'review this patch', '--run-folder', runFolder],
      {
        relayer: relayerWithBody(REVIEW_RELAY_BODY),
        composeWriter: () => {
          writerCalled = true;
        },
      },
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(RUNTIME_POLICY_REASONS.composeWriter);
    expect(writerCalled).toBe(false);
    expect(existsSync(runFolder)).toBe(false);
  });

  it('keeps Build checkpoint resume on the saved run-folder marker', async () => {
    const projectRoot = join(runFolderBase, 'project');
    writeProjectRoot(projectRoot);
    const runFolder = join(runFolderBase, 'build-checkpoint');
    const paused = await captureMain(
      [
        'run',
        'build',
        '--goal',
        'Add a small feature',
        '--process',
        'high',
        '--run-folder',
        runFolder,
      ],
      { configCwd: projectRoot, relayer: buildRelayer() },
    );

    expect(paused.code, paused.stderr).toBe(0);
    const pausedOutput = JSON.parse(paused.stdout) as Record<string, unknown>;
    expect(pausedOutput).toMatchObject({
      flow_id: 'build',
      outcome: 'checkpoint_waiting',
    });
    expectStdoutKeys(pausedOutput, [
      'schema_version',
      'run_id',
      'flow_id',
      'selected_flow',
      'routed_by',
      'router_reason',
      'entry_mode',
      'entry_mode_source',
      'run_folder',
      'outcome',
      'trace_entries_observed',
      'operator_summary_path',
      'operator_summary_markdown_path',
      'operator_summary_status_text',
      'operator_summary_html_path',
      'run_envelope_path',
      'run_process_evidence_path',
      'run_surface_markdown_path',
      'run_surface_status_text',
      'run_decision_packet_paths',
      'checkpoint',
    ]);

    const resumed = await withRuntimeDiagnostics(() =>
      captureMain(['resume', '--run-folder', runFolder, '--checkpoint-choice', 'continue'], {
        configCwd: projectRoot,
        relayer: buildRelayer(),
      }),
    );

    expect(resumed.code, resumed.stderr).toBe(0);
    const output = JSON.parse(resumed.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      flow_id: 'build',
      outcome: 'complete',
      runtime_reason: 'checkpoint resume follows the saved run folder engine marker',
    });
    expectStdoutKeys(output, [
      'schema_version',
      'run_id',
      'flow_id',
      'run_folder',
      'outcome',
      'trace_entries_observed',
      'result_path',
      'runtime_reason',
      'operator_summary_path',
      'operator_summary_markdown_path',
      'operator_summary_status_text',
      'run_envelope_path',
      'run_process_evidence_path',
      'run_surface_markdown_path',
      'run_surface_status_text',
    ]);
    expect(output).not.toHaveProperty('runtime');
  });
});

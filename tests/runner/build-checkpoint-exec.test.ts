import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureJson,
  captureStreams,
  deterministicNow,
  makeStubRelayer,
} from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

import { main } from '../../src/cli/circuit.js';
import { BuildBrief, BuildVerification } from '../../src/flows/build/reports.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { resumeCompiledFlow } from '../../src/runtime/run/checkpoint-resume.js';
import {
  type CompiledFlowRunOptions,
  runCompiledFlowWithWaiting,
} from '../../src/runtime/run/compiled-flow-runner.js';
import {
  type GraphExecutionResult,
  isGraphCheckpointWaitingResult,
} from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { ChangeKindDeclaration } from '../../src/schemas/change-kind.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { SkillId } from '../../src/schemas/ids.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
import { manifestSnapshotPath, writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

const INVALID_RUN_FOLDER_MESSAGE = 'run folder is not a resumable Circuit run folder';

function change_kind(): ChangeKindDeclaration {
  return {
    change_kind: 'ratchet-advance',
    failure_mode: 'Build cannot honestly claim Frame parity while checkpoint steps throw',
    acceptance_evidence:
      'runtime checkpoint step can write build.brief, safely resolve, or leave the run paused-open',
    alternate_framing:
      'add the product Build fixture now — rejected because the checkpoint substrate must be proven first',
  };
}

function readJson(root: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown;
}

function rewriteJsonObjectFile(
  path: string,
  rewrite: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} did not contain a JSON object`);
  }
  writeFileSync(path, `${JSON.stringify(rewrite(parsed as Record<string, unknown>), null, 2)}\n`);
}

function rewriteTraceEntry(
  runFolder: string,
  index: number,
  rewrite: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const tracePath = join(runFolder, 'trace.ndjson');
  const text = readFileSync(tracePath, 'utf8');
  const lines = text.trimEnd().split('\n');
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`trace entry ${index} is missing`);
  }
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`trace entry ${index} did not contain a JSON object`);
  }
  lines[index] = JSON.stringify(rewrite(parsed as Record<string, unknown>));
  writeFileSync(tracePath, `${lines.join('\n')}\n`);
}

async function readTraceEntries(runFolder: string): Promise<readonly TraceEntry[]> {
  return await new TraceStore(runFolder).load();
}

function snapshotFromResult(result: GraphExecutionResult | GraphRunResult): {
  readonly status: string;
  readonly current_step?: string;
} {
  if (isGraphCheckpointWaitingResult(result)) {
    return { status: 'in_progress', current_step: result.checkpoint.stepId };
  }
  return { status: result.outcome };
}

async function runCompiledFlow(invocation: {
  readonly runFolder: string;
  readonly flow?: CompiledFlow;
  readonly flowBytes: Buffer;
  readonly projectRoot?: string;
  readonly runId: string;
  readonly goal: string;
  readonly depth?: string;
  readonly unattended?: boolean;
  readonly change_kind?: ChangeKindDeclaration;
  readonly now?: () => Date;
  readonly relayer?: RelayFn;
  readonly selectionConfigLayers?: CompiledFlowRunOptions['selectionConfigLayers'];
}): Promise<{
  readonly result: GraphExecutionResult;
  readonly trace_entries: readonly TraceEntry[];
  readonly snapshot: { readonly status: string; readonly current_step?: string };
}> {
  const result = await runCompiledFlowWithWaiting({
    runDir: invocation.runFolder,
    flowBytes: invocation.flowBytes,
    runId: String(invocation.runId),
    goal: invocation.goal,
    ...(invocation.depth === undefined ? {} : { depth: invocation.depth }),
    ...(invocation.unattended === undefined ? {} : { unattended: invocation.unattended }),
    ...(invocation.projectRoot === undefined ? {} : { projectRoot: invocation.projectRoot }),
    ...(invocation.now === undefined ? {} : { now: invocation.now }),
    ...(invocation.relayer === undefined ? {} : { relayer: invocation.relayer }),
    ...(invocation.selectionConfigLayers === undefined
      ? {}
      : { selectionConfigLayers: invocation.selectionConfigLayers }),
  });
  const trace_entries = await readTraceEntries(invocation.runFolder);
  return { result, trace_entries, snapshot: snapshotFromResult(result) };
}

async function resumeCompiledFlowCheckpoint(invocation: {
  readonly runFolder: string;
  readonly selection: string;
  readonly projectRoot?: string;
  readonly now?: () => Date;
  readonly relayer?: RelayFn;
  readonly selectionConfigLayers?: CompiledFlowRunOptions['selectionConfigLayers'];
}): Promise<{
  readonly result: GraphRunResult;
  readonly trace_entries: readonly TraceEntry[];
  readonly snapshot: { readonly status: string; readonly current_step?: string };
}> {
  const result = await resumeCompiledFlow({
    runDir: invocation.runFolder,
    selection: invocation.selection,
    ...(invocation.now === undefined ? {} : { now: invocation.now }),
    ...(invocation.relayer === undefined ? {} : { relayer: invocation.relayer }),
  });
  const trace_entries = await readTraceEntries(invocation.runFolder);
  return { result, trace_entries, snapshot: snapshotFromResult(result) };
}

async function captureStdout(fn: () => Promise<number>): Promise<{
  readonly code: number;
  readonly output: Record<string, unknown>;
}> {
  const { result, json } = await captureJson<Record<string, unknown>>(fn);
  return { code: result, output: json };
}

async function captureOutput(fn: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const { result, stdout, stderr } = await captureStreams(fn);
  return { code: result, stdout, stderr };
}

function checkpointCompiledFlow(options: {
  safeDefault?: string;
  autoContinuableWhenNested?: boolean;
}): { flow: CompiledFlow; bytes: Buffer } {
  const raw = {
    schema_version: '3',
    id: 'build-checkpoint-exec-test',
    version: '0.1.0',
    purpose: 'test Build checkpoint execution',
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame-step',
    stages: [
      {
        id: 'frame-stage',
        title: 'Frame',
        canonical: 'frame',
        steps: ['frame-step'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
      rationale: 'test-only Build checkpoint substrate.',
    },
    steps: [
      {
        id: 'frame-step',
        title: 'Frame',
        protocol: 'build-frame@v1',
        reads: [],
        routes: { pass: '@complete', continue: '@complete', revise: '@stop' },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Frame the Build work',
          choices: [
            { id: 'continue', label: 'Continue with the framed work' },
            { id: 'revise', label: 'Revise the frame' },
          ],
          ...(options.safeDefault === undefined
            ? {}
            : { safe_default_choice: options.safeDefault }),
          ...(options.autoContinuableWhenNested === undefined
            ? {}
            : { auto_continuable_when_nested: options.autoContinuableWhenNested }),
          report_template: {
            scope: 'Only prove checkpoint execution',
            success_criteria: ['Frame checkpoint is represented honestly'],
            verification_command_candidates: [
              {
                id: 'verify',
                cwd: '.',
                argv: [process.execPath, '-e', "process.stdout.write('ok')"],
                timeout_ms: 1_000,
                max_output_bytes: 20_000,
                env: {},
              },
            ],
          },
        },
        writes: {
          request: 'reports/checkpoints/frame-step-request.json',
          response: 'reports/checkpoints/frame-step-response.json',
          report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue', 'revise'],
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(raw));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function checkpointToRelayCompiledFlow(): { flow: CompiledFlow; bytes: Buffer } {
  const raw = {
    schema_version: '3',
    id: 'build-checkpoint-relay-test',
    version: '0.1.0',
    purpose: 'test checkpoint resume context for relay',
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
      { id: 'act-stage', title: 'Act', canonical: 'act', steps: ['relay-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'test-only checkpoint-to-relay resume.',
    },
    steps: [
      {
        id: 'frame-step',
        title: 'Frame',
        protocol: 'build-frame@v1',
        reads: [],
        routes: { pass: 'relay-step', continue: 'relay-step' },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Frame',
          choices: [{ id: 'continue' }],
          safe_default_choice: 'continue',
          report_template: {
            scope: 'Relay resume context test',
            success_criteria: ['Resume preserves original selection context'],
            verification_command_candidates: [
              {
                id: 'verify',
                cwd: '.',
                argv: [process.execPath, '-e', "process.stdout.write('ok')"],
                timeout_ms: 1_000,
                max_output_bytes: 20_000,
                env: {},
              },
            ],
          },
        },
        writes: {
          request: 'reports/checkpoints/frame-step-request.json',
          response: 'reports/checkpoints/frame-step-response.json',
          report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      },
      {
        id: 'relay-step',
        title: 'Relay',
        protocol: 'build-act@v1',
        reads: ['reports/build/brief.json'],
        routes: { pass: '@complete' },
        executor: 'worker',
        kind: 'relay',
        role: 'implementer',
        writes: {
          request: 'transcript/relay-request.txt',
          receipt: 'transcript/relay-receipt.json',
          result: 'transcript/relay-result.md',
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: ['accept'],
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(raw));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function checkpointToVerificationCompiledFlow(commandCwd = '.'): {
  flow: CompiledFlow;
  bytes: Buffer;
} {
  const raw = {
    schema_version: '3',
    id: 'build-checkpoint-verification-test',
    version: '0.1.0',
    purpose: 'test checkpoint resume context for verification',
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
      { id: 'plan-stage', title: 'Plan', canonical: 'plan', steps: ['plan-step'] },
      { id: 'verify-stage', title: 'Verify', canonical: 'verify', steps: ['verify-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'act', 'review', 'close'],
      rationale: 'test-only checkpoint-to-verification resume.',
    },
    steps: [
      {
        id: 'frame-step',
        title: 'Frame',
        protocol: 'build-frame@v1',
        reads: [],
        routes: { pass: 'plan-step', continue: 'plan-step' },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Frame',
          choices: [{ id: 'continue' }],
          safe_default_choice: 'continue',
          report_template: {
            scope: 'Verification resume context test',
            success_criteria: ['Resume preserves original project root'],
            verification_command_candidates: [
              {
                id: 'marker-check',
                cwd: commandCwd,
                argv: [process.execPath, '-e', "require('node:fs').accessSync('marker.txt')"],
                timeout_ms: 1_000,
                max_output_bytes: 20_000,
                env: {},
              },
            ],
          },
        },
        writes: {
          request: 'reports/checkpoints/frame-step-request.json',
          response: 'reports/checkpoints/frame-step-response.json',
          report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      },
      {
        id: 'plan-step',
        title: 'Plan',
        protocol: 'build-plan@v1',
        reads: ['reports/build/brief.json'],
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
        routes: { pass: '@complete' },
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
  return { flow: CompiledFlow.parse(raw), bytes };
}

let runFolderBase: string;
let homeDir: string;
let originalHome: string | undefined;

function writeSkill(id: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `Skill ${id}`, 'utf8');
}

beforeEach(() => {
  runFolderBase = join(tmpdir(), `circuit-build-checkpoint-${randomUUID()}`);
  homeDir = join(runFolderBase, 'home');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  mkdirSync(runFolderBase, { recursive: true });
  writeSkill('tdd');
});

afterEach(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, 'HOME');
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(runFolderBase, { recursive: true, force: true });
});

async function startPausedBuildCheckpoint(input: {
  readonly runFolder: string;
  readonly runId: string;
  readonly goal: string;
}): Promise<void> {
  const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
  await runCompiledFlow({
    runFolder: input.runFolder,
    flow,
    flowBytes: bytes,
    projectRoot: process.cwd(),
    runId: RunId.parse(input.runId),
    goal: input.goal,
    depth: 'high',
    change_kind: change_kind(),
    now: deterministicNow(Date.UTC(2026, 3, 25, 5, 0, 0)),
  });
}

function writeInvalidCheckpointFolder(input: {
  readonly runFolder: string;
  readonly runId: string;
  readonly goal: string;
}): void {
  const { bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
  mkdirSync(input.runFolder, { recursive: true });
  const capturedAt = new Date(Date.UTC(2026, 3, 25, 5, 0, 0)).toISOString();
  const manifest = writeManifestSnapshot(input.runFolder, {
    run_id: RunId.parse(input.runId),
    flow_id: CompiledFlowId.parse('build-checkpoint-exec-test'),
    captured_at: capturedAt,
    bytes,
  });
  writeFileSync(
    join(input.runFolder, 'trace.ndjson'),
    `${JSON.stringify({
      sequence: 0,
      recorded_at: capturedAt,
      run_id: input.runId,
      kind: 'run.bootstrapped',
      flow_id: 'build-checkpoint-exec-test',
      depth: 'high',
      goal: input.goal,
      manifest_hash: manifest.hash,
    })}\n`,
  );
}

describe('Build checkpoint execution substrate', () => {
  it('resolves medium depth through a declared safe default choice', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'safe-default');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000000'),
      goal: 'Frame a Build run',
      depth: 'medium',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 0, 0)),
    });

    expect(outcome.result.outcome).toBe('complete');
    const brief = BuildBrief.parse(readJson(runFolder, 'reports/build/brief.json'));
    expect(brief.objective).toBe('Frame a Build run');
    expect(brief.checkpoint).toMatchObject({
      request_path: 'reports/checkpoints/frame-step-request.json',
      response_path: 'reports/checkpoints/frame-step-response.json',
      allowed_choices: ['continue', 'revise'],
    });
    const packet = brief.checkpoint_packet;
    expect(packet).toBeDefined();
    if (packet === undefined) throw new Error('expected checkpoint packet');
    expect(packet.kind).toBe('build.checkpoint_packet@v1');
    expect(packet.recommendation.choice_id).toBe('continue');
    expect(packet.choices.map((choice) => choice.id)).toEqual(['continue', 'revise']);
    const requested = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'checkpoint.requested',
    );
    if (requested?.kind !== 'checkpoint.requested') {
      throw new Error('expected checkpoint.requested trace');
    }
    expect(requested.boundary_ref).toMatchObject({
      kind: 'work_contract',
      flow_id: 'build-checkpoint-exec-test',
      step_id: 'frame-step',
    });
    expect(requested.boundary_hash).toBe(requested.boundary_ref?.sha256);
    const requestBody = readJson(runFolder, 'reports/checkpoints/frame-step-request.json') as {
      execution_context?: Record<string, unknown>;
    };
    expect(requestBody.execution_context?.checkpoint_boundary_ref).toEqual(requested.boundary_ref);
    expect(requestBody.execution_context?.checkpoint_boundary_hash).toBe(requested.boundary_hash);
    const resolved = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'checkpoint.resolved',
    );
    expect(resolved).toMatchObject({
      selection: 'continue',
      auto_resolved: true,
      resolution_source: 'declared-default',
    });
  });

  it('leaves high depth paused-open with no run.closed and no result report', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'waiting');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000001'),
      goal: 'Frame a deep Build run',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 5, 0)),
    });

    const waiting = outcome.result;
    if (waiting.outcome !== 'checkpoint_waiting') {
      throw new Error(`expected checkpoint_waiting, got ${waiting.outcome}`);
    }
    expect(waiting.checkpoint).toMatchObject({
      stepId: 'frame-step',
      requestPath: join(runFolder, 'reports/checkpoints/frame-step-request.json'),
      allowedChoices: ['continue', 'revise'],
    });
    expect(outcome.snapshot.status).toBe('in_progress');
    expect(outcome.snapshot.current_step).toBe('frame-step');
    expect(outcome.trace_entries.some((trace_entry) => trace_entry.kind === 'run.closed')).toBe(
      false,
    );
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
    expect(existsSync(join(runFolder, 'reports/checkpoints/frame-step-response.json'))).toBe(false);
    const brief = BuildBrief.parse(readJson(runFolder, 'reports/build/brief.json'));
    expect(brief.objective).toBe('Frame a deep Build run');
    // Brief is fully populated at first write — response_path always
    // resolves to step.writes.response, even before operator selection.
    // The response file itself is created only at resolution.
    expect(brief.checkpoint.response_path).toBe('reports/checkpoints/frame-step-response.json');
    const packet = brief.checkpoint_packet;
    expect(packet).toBeDefined();
    if (packet === undefined) throw new Error('expected checkpoint packet');
    expect(packet.recommendation).toMatchObject({
      choice_id: 'continue',
      label: 'Continue with the framed work',
    });
    expect(packet.choices[0]).toMatchObject({
      id: 'continue',
      route: { key: 'continue', target: '@complete' },
    });
    // The parked request file carries the labeled choices so downstream
    // surfaces (the operator summary page) can name options without
    // re-deriving labels from flow-specific reports.
    const waitingRequestBody = readJson(
      runFolder,
      'reports/checkpoints/frame-step-request.json',
    ) as {
      allowed_choices?: readonly string[];
      choices?: readonly { id: string; label?: string }[];
    };
    expect(waitingRequestBody.allowed_choices).toEqual(['continue', 'revise']);
    expect(waitingRequestBody.choices).toEqual([
      { id: 'continue', label: 'Continue with the framed work' },
      { id: 'revise', label: 'Revise the frame' },
    ]);
    expect(packet.proof.status).toBe('planned');
    expect(packet.salience.hidden_routine_work.join('\n')).toContain('test execution');
    expect(packet.risk.summary).toContain('scope mismatch');
  });

  it('resumes a paused-open checkpoint through an operator selection', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'resume-waiting');

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000004'),
      goal: 'Resume a deep Build run',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 20, 0)),
    });

    const resumed = await resumeCompiledFlowCheckpoint({
      runFolder,
      selection: 'continue',
      projectRoot: process.cwd(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 25, 0)),
    });

    expect(resumed.result.outcome).toBe('complete');
    expect(resumed.snapshot.status).toBe('complete');
    const resolved = resumed.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'checkpoint.resolved',
    );
    expect(resolved).toMatchObject({
      selection: 'continue',
      auto_resolved: false,
      resolution_source: 'operator',
      response_path: 'reports/checkpoints/frame-step-response.json',
    });
    const brief = BuildBrief.parse(readJson(runFolder, 'reports/build/brief.json'));
    expect(brief.objective).toBe('Resume a deep Build run');
    expect(brief.checkpoint.response_path).toBe('reports/checkpoints/frame-step-response.json');
    expect(readJson(runFolder, 'reports/result.json')).toMatchObject({ outcome: 'complete' });

    // Resume-crash recoverability invariant: the brief is written
    // exactly once for the frame-step checkpoint — at request creation —
    // and is never re-stamped during resolution. This eliminates the
    // crash window between a stamped-brief write and the
    // checkpoint.resolved trace_entry. A second step.report_written would
    // mean the brief is being mutated post-request, re-opening that
    // window.
    const briefReportWrites = resumed.trace_entries.filter(
      (trace_entry) =>
        trace_entry.kind === 'step.report_written' &&
        (trace_entry.step_id as unknown as string) === 'frame-step' &&
        trace_entry.report_path === 'reports/build/brief.json',
    );
    expect(briefReportWrites).toHaveLength(1);
  });

  it('fails closed for invalid checkpoint resume even when runtime is enabled', async () => {
    const runFolder = join(runFolderBase, 'resume-kept-with-strict-runtime');
    writeInvalidCheckpointFolder({
      runFolder,
      runId: 'b3000000-0000-0000-0000-000000000018',
      goal: 'Resume invalid checkpoint with runtime enabled',
    });
    await withScopedEnv({ CIRCUIT_SHOW_RUNTIME_DECISION: '1' }, async () => {
      const { code, stdout, stderr } = await captureOutput(() =>
        main(['resume', '--run-folder', runFolder, '--checkpoint-choice', 'continue'], {
          now: deterministicNow(Date.UTC(2026, 3, 25, 5, 30, 0)),
          configCwd: process.cwd(),
        }),
      );

      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr.trim()).toBe(`error: ${INVALID_RUN_FOLDER_MESSAGE}`);
    });
  });

  it('fails closed for invalid checkpoint folders in status and resume', async () => {
    const runFolder = join(runFolderBase, 'kept-status-and-resume');
    writeInvalidCheckpointFolder({
      runFolder,
      runId: 'b3000000-0000-0000-0000-000000000019',
      goal: 'Project invalid checkpoint before resume',
    });

    const status = await captureStdout(() =>
      main(['runs', 'show', '--run-folder', runFolder, '--json']),
    );
    expect(status.code).toBe(0);
    expect(status.output).toMatchObject({
      api_version: 'run-status-v1',
      engine_state: 'invalid',
      reason: 'trace_invalid',
      legal_next_actions: ['none'],
      error: {
        code: 'trace_bootstrap_invalid',
        message: 'trace is missing or invalid for this run folder',
      },
    });

    await withScopedEnv({ CIRCUIT_SHOW_RUNTIME_DECISION: '1' }, async () => {
      const resumed = await captureOutput(() =>
        main(['resume', '--run-folder', runFolder, '--checkpoint-choice', 'continue'], {
          now: deterministicNow(Date.UTC(2026, 3, 25, 5, 45, 0)),
          configCwd: process.cwd(),
        }),
      );

      expect(resumed.code).toBe(2);
      expect(resumed.stdout).toBe('');
      expect(resumed.stderr.trim()).toBe(`error: ${INVALID_RUN_FOLDER_MESSAGE}`);
    });
  });

  it('rejects checkpoint resume choices outside the declared allow list', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'resume-reject');

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000005'),
      goal: 'Reject bad resume choice',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 30, 0)),
    });

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'ship-it-anyway',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 3, 35, 0)),
      }),
    ).rejects.toThrow(/not allowed/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when manifest flow_id differs from the flow bytes', async () => {
    const runFolder = join(runFolderBase, 'resume-manifest-flow-id-mismatch');
    await startPausedBuildCheckpoint({
      runFolder,
      runId: 'b3000000-0000-0000-0000-000000000013',
      goal: 'Reject manifest flow id mismatch',
    });
    rewriteJsonObjectFile(manifestSnapshotPath(runFolder), (manifest) => ({
      ...manifest,
      flow_id: 'different-flow-id',
    }));

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 5, 5, 0)),
      }),
    ).rejects.toThrow(
      /manifest snapshot flow_id mismatch: expected 'build-checkpoint-exec-test' but found 'different-flow-id'/,
    );
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when manifest run_id differs from the bootstrap trace', async () => {
    const runFolder = join(runFolderBase, 'resume-manifest-run-id-mismatch');
    await startPausedBuildCheckpoint({
      runFolder,
      runId: 'b3000000-0000-0000-0000-000000000014',
      goal: 'Reject manifest run id mismatch',
    });
    rewriteJsonObjectFile(manifestSnapshotPath(runFolder), (manifest) => ({
      ...manifest,
      run_id: 'b3000000-0000-0000-0000-000000000015',
    }));

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 5, 10, 0)),
      }),
    ).rejects.toThrow(
      /manifest snapshot run_id mismatch: expected 'b3000000-0000-0000-0000-000000000014' but found 'b3000000-0000-0000-0000-000000000015'/,
    );
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when manifest flow_id differs from the bootstrap trace', async () => {
    const runFolder = join(runFolderBase, 'resume-bootstrap-flow-id-mismatch');
    await startPausedBuildCheckpoint({
      runFolder,
      runId: 'b3000000-0000-0000-0000-000000000016',
      goal: 'Reject bootstrap flow id mismatch',
    });
    rewriteTraceEntry(runFolder, 0, (bootstrap) => ({
      ...bootstrap,
      flow_id: 'different-flow-id',
    }));

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 5, 15, 0)),
      }),
    ).rejects.toThrow(
      /manifest snapshot flow_id mismatch: expected 'different-flow-id' but found 'build-checkpoint-exec-test'/,
    );
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when manifest hash differs from the bootstrap trace', async () => {
    const runFolder = join(runFolderBase, 'resume-bootstrap-manifest-hash-mismatch');
    await startPausedBuildCheckpoint({
      runFolder,
      runId: 'b3000000-0000-0000-0000-000000000017',
      goal: 'Reject bootstrap manifest hash mismatch',
    });
    rewriteTraceEntry(runFolder, 0, (bootstrap) => ({
      ...bootstrap,
      manifest_hash: 'b'.repeat(64),
    }));

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 5, 20, 0)),
      }),
    ).rejects.toThrow(/manifest snapshot hash mismatch/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when the waiting Build brief is missing', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'resume-missing-brief');

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000006'),
      goal: 'Reject missing brief on resume',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 40, 0)),
    });
    rmSync(join(runFolder, 'reports/build/brief.json'));

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 3, 45, 0)),
      }),
    ).rejects.toThrow(/brief\.json/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when the waiting Build brief was replaced', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'resume-tampered-brief');

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000009'),
      goal: 'Reject tampered brief on resume',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 10, 0)),
    });
    writeFileSync(
      join(runFolder, 'reports/build/brief.json'),
      `${JSON.stringify(
        {
          objective: 'Tampered objective',
          scope: 'Tampered scope',
          success_criteria: ['Tampered criterion'],
          verification_command_candidates: [
            {
              id: 'tampered',
              cwd: '.',
              argv: [process.execPath, '-e', "process.stdout.write('tampered')"],
              timeout_ms: 1_000,
              max_output_bytes: 20_000,
              env: {},
            },
          ],
          checkpoint: {
            request_path: 'reports/checkpoints/frame-step-request.json',
            allowed_choices: ['continue', 'revise'],
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 4, 15, 0)),
      }),
    ).rejects.toThrow(/brief hash differs/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('rejects checkpoint resume when the request and Build brief were replaced together', async () => {
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'resume-tampered-request-and-brief');

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000012'),
      goal: 'Reject tampered request and brief on resume',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 40, 0)),
    });
    const tamperedBrief = `${JSON.stringify(
      {
        objective: 'Tampered objective',
        scope: 'Tampered scope',
        success_criteria: ['Tampered criterion'],
        verification_command_candidates: [
          {
            id: 'tampered',
            cwd: '.',
            argv: [process.execPath, '-e', "process.stdout.write('tampered')"],
            timeout_ms: 1_000,
            max_output_bytes: 20_000,
            env: {},
          },
        ],
        checkpoint: {
          request_path: 'reports/checkpoints/frame-step-request.json',
          allowed_choices: ['continue', 'revise'],
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(runFolder, 'reports/build/brief.json'), tamperedBrief);
    writeFileSync(
      join(runFolder, 'reports/checkpoints/frame-step-request.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          step_id: 'frame-step',
          prompt: 'Frame',
          allowed_choices: ['continue', 'revise'],
          safe_default_choice: 'continue',
          execution_context: {
            project_root: process.cwd(),
            selection_config_layers: [],
            checkpoint_report_sha256: sha256Hex(tamperedBrief),
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      resumeCompiledFlowCheckpoint({
        runFolder,
        selection: 'continue',
        projectRoot: process.cwd(),
        now: deterministicNow(Date.UTC(2026, 3, 25, 4, 45, 0)),
      }),
    ).rejects.toThrow(/request hash differs/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(false);
  });

  it('resumes post-checkpoint relay with the original selection context', async () => {
    const { flow, bytes } = checkpointToRelayCompiledFlow();
    const runFolder = join(runFolderBase, 'resume-relay-context');
    const captured: RelayInput[] = [];
    const relayer: RelayFn = makeStubRelayer(
      (input) => {
        captured.push(input);
        return '{"verdict":"accept"}';
      },
      { receipt_id: 'resume-relay-context' },
    );

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000007'),
      goal: 'Resume relay with original config',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 50, 0)),
      selectionConfigLayers: [
        {
          layer: 'invocation',
          config: {
            schema_version: 1,
            host: { kind: 'generic-shell' },
            relay: { default: 'auto', roles: {}, circuits: {}, connectors: {} },
            skills: { bindings: {} },
            skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
            circuits: {},
            power_tiers: {},
            defaults: {
              selection: {
                model: { provider: 'anthropic', model: 'claude-resume-original' },
                effort: 'high',
                skills: { mode: 'replace', skills: [SkillId.parse('tdd')] },
                invocation_options: {},
              },
            },
          },
        },
      ],
    });

    const resumed = await resumeCompiledFlowCheckpoint({
      runFolder,
      selection: 'continue',
      projectRoot: process.cwd(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 55, 0)),
      relayer,
      selectionConfigLayers: [
        {
          layer: 'invocation',
          config: {
            schema_version: 1,
            host: { kind: 'generic-shell' },
            relay: { default: 'auto', roles: {}, circuits: {}, connectors: {} },
            skills: { bindings: {} },
            skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
            circuits: {},
            power_tiers: {},
            defaults: {
              selection: {
                model: { provider: 'openai', model: 'wrong-resume-model' },
                effort: 'low',
                skills: { mode: 'replace', skills: [] },
                invocation_options: {},
              },
            },
          },
        },
      ],
    });

    expect(resumed.result.outcome).toBe('complete');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.resolvedSelection).toMatchObject({
      model: { provider: 'anthropic', model: 'claude-resume-original' },
      effort: 'high',
      skills: ['tdd'],
    });
  });

  it('resumes post-checkpoint relay with original empty selection context', async () => {
    const { flow, bytes } = checkpointToRelayCompiledFlow();
    const runFolder = join(runFolderBase, 'resume-empty-relay-context');
    const captured: RelayInput[] = [];
    const relayer: RelayFn = makeStubRelayer(
      (input) => {
        captured.push(input);
        return '{"verdict":"accept"}';
      },
      { receipt_id: 'resume-empty-relay-context' },
    );

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000010'),
      goal: 'Resume relay with original empty config',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 20, 0)),
    });

    const resumed = await resumeCompiledFlowCheckpoint({
      runFolder,
      selection: 'continue',
      projectRoot: process.cwd(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 25, 0)),
      relayer,
      selectionConfigLayers: [
        {
          layer: 'invocation',
          config: {
            schema_version: 1,
            host: { kind: 'generic-shell' },
            relay: { default: 'auto', roles: {}, circuits: {}, connectors: {} },
            skills: { bindings: {} },
            skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
            circuits: {},
            power_tiers: {},
            defaults: {
              selection: {
                model: { provider: 'openai', model: 'wrong-resume-model' },
                effort: 'low',
                skills: { mode: 'replace', skills: [] },
                invocation_options: {},
              },
            },
          },
        },
      ],
    });

    expect(resumed.result.outcome).toBe('complete');
    expect(captured).toHaveLength(1);
    // The resume-time layer must not leak in: no 'wrong-resume-model'. The
    // original empty context materializes the default-on medium dial instead.
    expect(captured[0]?.resolvedSelection?.model).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
    });
    expect(captured[0]?.resolvedSelection?.effort).toBeUndefined();
    expect(captured[0]?.resolvedSelection?.skills).toEqual([]);
  });

  it('resumes post-checkpoint verification with the original project root', async () => {
    const originalProjectRoot = join(runFolderBase, 'original-project');
    const wrongProjectRoot = join(runFolderBase, 'wrong-project');
    mkdirSync(originalProjectRoot, { recursive: true });
    mkdirSync(wrongProjectRoot, { recursive: true });
    writeFileSync(join(originalProjectRoot, 'marker.txt'), 'present\n');
    writeFileSync(
      join(originalProjectRoot, 'package.json'),
      `${JSON.stringify({
        private: true,
        scripts: { verify: `${process.execPath} -e "require('node:fs').accessSync('marker.txt')"` },
      })}\n`,
    );
    const { flow, bytes } = checkpointToVerificationCompiledFlow();
    const runFolder = join(runFolderBase, 'resume-verification-context');

    await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: originalProjectRoot,
      runId: RunId.parse('b3000000-0000-0000-0000-000000000008'),
      goal: 'Resume verification with original project root',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 0, 0)),
    });

    const resumed = await resumeCompiledFlowCheckpoint({
      runFolder,
      selection: 'continue',
      projectRoot: wrongProjectRoot,
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 5, 0)),
    });

    expect(resumed.result.outcome).toBe('complete');
    const verification = BuildVerification.parse(
      readJson(runFolder, 'reports/build/verification.json'),
    );
    expect(verification.overall_status).toBe('passed');
  });

  it('does not borrow a resume-time project root when the original run had none', async () => {
    const resumeProjectRoot = join(runFolderBase, 'resume-project');
    mkdirSync(resumeProjectRoot, { recursive: true });
    writeFileSync(join(resumeProjectRoot, 'marker.txt'), 'present\n');
    const { flow, bytes } = checkpointToVerificationCompiledFlow();
    const runFolder = join(runFolderBase, 'resume-no-project-root');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      runId: RunId.parse('b3000000-0000-0000-0000-000000000011'),
      goal: 'Resume verification without borrowing project root',
      depth: 'high',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 4, 30, 0)),
    });

    if (isGraphCheckpointWaitingResult(outcome.result)) throw new Error('expected run to close');
    expect(outcome.result.outcome).toBe('aborted');
    expect(outcome.result.reason).toMatch(/projectRoot was not provided/);
  });

  it('resolves autonomous depth through a declared default choice', async () => {
    const { flow, bytes } = checkpointCompiledFlow({
      safeDefault: 'continue',
    });
    const runFolder = join(runFolderBase, 'autonomous');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000002'),
      goal: 'Frame an autonomous Build run',
      depth: 'autonomous',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 10, 0)),
    });

    expect(outcome.result.outcome).toBe('complete');
    const resolved = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'checkpoint.resolved',
    );
    expect(resolved).toMatchObject({
      selection: 'continue',
      auto_resolved: true,
      resolution_source: 'declared-default',
    });
  });

  it('fails autonomous depth closed when no declared default choice exists', async () => {
    const { flow, bytes } = checkpointCompiledFlow({});
    const runFolder = join(runFolderBase, 'autonomous-missing');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000003'),
      goal: 'Reject unsafe autonomous checkpoint',
      depth: 'autonomous',
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 3, 15, 0)),
    });

    expect(outcome.result.outcome).toBe('aborted');
    if (outcome.result.outcome !== 'aborted') {
      throw new Error(`expected aborted, got ${outcome.result.outcome}`);
    }
    expect(outcome.result.reason).toMatch(/declared default choice/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(true);
  });

  // Headless-checkpoint policy (M9-A4). An unattended run (a composed/nested
  // child, or a batch/headless host) has no operator to answer a checkpoint and
  // no external resume driver to clear it. At high/tournament depth an attended
  // run parks at checkpoint_waiting for that operator (proven by the paused-open
  // test above) — but an unattended run that parked could never be resumed, so
  // the engine must instead reach a terminal outcome. The locked decision is
  // fail-closed by default: the engine never auto-skips a human gate just
  // because a safe default exists. It auto-continues an unattended checkpoint
  // ONLY when the flow's manifest explicitly opts that checkpoint in via
  // auto_continuable_when_nested; otherwise it stops with a loud "hit a human
  // gate unattended" terminal. The signal rides on the run invocation, never on
  // a flow, so it is latent until M9 wires composed runs; every shipped
  // top-level run today is attended and still parks unchanged.
  it('fails an unattended high-depth checkpoint closed when it is not declared auto-continuable, even with a safe default', async () => {
    // The safety regression guard: a safe default alone must NOT let an
    // unattended run auto-skip a human gate. Only an explicit opt-in may.
    const { flow, bytes } = checkpointCompiledFlow({ safeDefault: 'continue' });
    const runFolder = join(runFolderBase, 'unattended-high-not-optedin');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000020'),
      goal: 'Refuse to auto-skip an unattended human gate',
      depth: 'high',
      unattended: true,
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 6, 0, 0)),
    });

    if (isGraphCheckpointWaitingResult(outcome.result)) {
      throw new Error('unattended run must not park at a checkpoint');
    }
    expect(outcome.result.outcome).toBe('aborted');
    if (outcome.result.outcome !== 'aborted') {
      throw new Error(`expected aborted, got ${outcome.result.outcome}`);
    }
    expect(outcome.result.reason).toMatch(/unattended/);
    expect(outcome.result.reason).toMatch(/auto_continuable_when_nested/);
    // It must not have crossed the gate: no checkpoint.resolved trace entry.
    expect(
      outcome.trace_entries.find((trace_entry) => trace_entry.kind === 'checkpoint.resolved'),
    ).toBeUndefined();
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(true);
  });

  it('auto-continues an unattended high-depth checkpoint through its safe default when declared auto-continuable', async () => {
    const { flow, bytes } = checkpointCompiledFlow({
      safeDefault: 'continue',
      autoContinuableWhenNested: true,
    });
    const runFolder = join(runFolderBase, 'unattended-high-optedin');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000022'),
      goal: 'Resolve an opted-in unattended deep Build run',
      depth: 'high',
      unattended: true,
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 6, 10, 0)),
    });

    if (isGraphCheckpointWaitingResult(outcome.result)) {
      throw new Error('unattended run must reach a terminal outcome, not park at a checkpoint');
    }
    expect(outcome.result.outcome).toBe('complete');
    expect(outcome.snapshot.status).toBe('complete');
    const resolved = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'checkpoint.resolved',
    );
    expect(resolved).toMatchObject({
      selection: 'continue',
      auto_resolved: true,
      resolution_source: 'declared-default',
    });
    expect(readJson(runFolder, 'reports/result.json')).toMatchObject({ outcome: 'complete' });
  });

  it('fails an opted-in unattended checkpoint closed when it has no safe default or auto-resolution to continue with', async () => {
    // Opt-in alone is not enough: there must be something safe to continue with.
    const { flow, bytes } = checkpointCompiledFlow({ autoContinuableWhenNested: true });
    const runFolder = join(runFolderBase, 'unattended-high-optedin-missing');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000023'),
      goal: 'Reject an opted-in unattended checkpoint with nothing to continue with',
      depth: 'high',
      unattended: true,
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 6, 15, 0)),
    });

    if (isGraphCheckpointWaitingResult(outcome.result)) {
      throw new Error('unattended run must not park at a checkpoint');
    }
    expect(outcome.result.outcome).toBe('aborted');
    if (outcome.result.outcome !== 'aborted') {
      throw new Error(`expected aborted, got ${outcome.result.outcome}`);
    }
    expect(outcome.result.reason).toMatch(/safe default|auto-resolution/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(true);
  });

  it('fails an unattended high-depth checkpoint closed when not opted in and no safe default exists', async () => {
    const { flow, bytes } = checkpointCompiledFlow({});
    const runFolder = join(runFolderBase, 'unattended-high-missing');

    const outcome = await runCompiledFlow({
      runFolder,
      flow,
      flowBytes: bytes,
      projectRoot: process.cwd(),
      runId: RunId.parse('b3000000-0000-0000-0000-000000000021'),
      goal: 'Reject an unsafe unattended checkpoint',
      depth: 'high',
      unattended: true,
      change_kind: change_kind(),
      now: deterministicNow(Date.UTC(2026, 3, 25, 6, 5, 0)),
    });

    // Never a silent park (it could not be resumed) and never a guess (no
    // arbitrary route is chosen): a loud, terminal failure instead.
    if (isGraphCheckpointWaitingResult(outcome.result)) {
      throw new Error('unattended run must not park at a checkpoint');
    }
    expect(outcome.result.outcome).toBe('aborted');
    if (outcome.result.outcome !== 'aborted') {
      throw new Error(`expected aborted, got ${outcome.result.outcome}`);
    }
    expect(outcome.result.reason).toMatch(/unattended/);
    expect(existsSync(join(runFolder, 'reports/result.json'))).toBe(true);
  });
});

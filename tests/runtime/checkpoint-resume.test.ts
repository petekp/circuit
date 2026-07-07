import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectRunStatusFromRunFolder } from '../../src/app/run-status/run-folder-projector.js';
import { main } from '../../src/cli/circuit.js';
import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import {
  isCheckpointResumeRejectedResult,
  resumeCompiledFlow,
  resumeCompiledFlowResult,
} from '../../src/runtime/run/checkpoint-resume.js';
import type {
  CompiledFlowRunOptions,
  CompiledFlowRunner,
} from '../../src/runtime/run/child-runner.js';
import { runCompiledFlowWithWaiting } from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import { PolicyLayer } from '../../src/schemas/policy-envelope.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';
import { RunResult } from '../../src/schemas/result.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';
import { runResultPath } from '../../src/shared/result-path.js';
import { captureJson, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

const GOAL = 'prove runtime checkpoint resume';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function writeBuildProofPackage(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
  );
}

function checkpointFixtureFlow(
  overrides: {
    readonly checkpointRoutes?: Record<string, string>;
    readonly checkpointChoices?: readonly { readonly id: string; readonly label?: string }[];
  } = {},
): unknown {
  const checkpointChoices = overrides.checkpointChoices ?? [{ id: 'continue', label: 'Continue' }];
  const checkpointRoutes = overrides.checkpointRoutes ?? {
    continue: 'relay-step',
    pass: 'relay-step',
    stop: '@stop',
  };
  return {
    schema_version: '3',
    id: 'checkpoint-fixture',
    version: '0.1.0',
    purpose: 'Dedicated runtime checkpoint pause/resume fixture.',
    axes: {
      allowed_depths: ['high'],
      supports_tournament: false,
      supports_autonomous: false,
      default: { depth: 'high', tournament: false, tournament_n: 3, autonomous: false },
    },
    starts_at: 'checkpoint-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['checkpoint-step'] },
      { id: 'act-stage', title: 'Act', canonical: 'act', steps: ['relay-step'] },
      { id: 'verify-stage', title: 'Verify', canonical: 'verify', steps: ['verify-step'] },
      { id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'review'],
      rationale: 'The checkpoint fixture keeps only the steps needed for runtime resume parity.',
    },
    steps: [
      {
        id: 'checkpoint-step',
        title: 'Checkpoint - wait for operator',
        protocol: 'checkpoint-fixture-frame@v1',
        reads: [],
        routes: checkpointRoutes,
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Choose whether the runtime fixture should continue.',
          choices: checkpointChoices,
          safe_default_choice: checkpointChoices[0]?.id,
        },
        writes: {
          request: 'reports/checkpoints/checkpoint-step-request.json',
          response: 'reports/checkpoints/checkpoint-step-response.json',
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: checkpointChoices.map((choice) => choice.id),
        },
      },
      {
        id: 'relay-step',
        title: 'Relay - continue after checkpoint',
        protocol: 'checkpoint-fixture-relay@v1',
        reads: ['reports/checkpoints/checkpoint-step-response.json'],
        routes: {
          pass: 'verify-step',
          retry: 'relay-step',
          stop: '@stop',
        },
        executor: 'worker',
        kind: 'relay',
        role: 'reviewer',
        writes: {
          request: 'reports/relay/fixture.request.json',
          receipt: 'reports/relay/fixture.receipt.txt',
          result: 'reports/relay/fixture.result.json',
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: ['accept'],
        },
      },
      {
        id: 'verify-step',
        title: 'Verify - prove resumed context',
        protocol: 'checkpoint-fixture-verify@v1',
        reads: ['reports/relay/fixture.result.json'],
        routes: {
          pass: 'close-step',
          retry: 'relay-step',
          stop: '@stop',
        },
        executor: 'orchestrator',
        kind: 'verification',
        writes: {
          report: {
            path: 'reports/verification.json',
            schema: 'checkpoint.fixture.verification@v1',
          },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['overall_status'],
        },
      },
      {
        id: 'close-step',
        title: 'Close - complete fixture',
        protocol: 'checkpoint-fixture-close@v1',
        reads: ['reports/verification.json'],
        routes: {
          pass: '@complete',
          complete: '@complete',
          stop: '@stop',
        },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: {
            path: 'reports/fixture-result.json',
            schema: 'checkpoint.fixture.result@v1',
          },
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

function completedAttemptFixtureFlow(): unknown {
  const base = checkpointFixtureFlow({
    checkpointRoutes: {
      loop: 'pre-step',
      pass: 'relay-step',
      stop: '@stop',
    },
    checkpointChoices: [{ id: 'loop', label: 'Loop' }],
  }) as {
    readonly stages: readonly Record<string, unknown>[];
    readonly steps: readonly Record<string, unknown>[];
    readonly [key: string]: unknown;
  };
  return {
    ...base,
    id: 'checkpoint-cycle-fixture',
    axes: {
      allowed_depths: ['high'],
      supports_tournament: false,
      supports_autonomous: false,
      default: { depth: 'high', tournament: false, tournament_n: 3, autonomous: false },
    },
    starts_at: 'pre-step',
    stages: base.stages.map((stage) =>
      stage.id === 'frame-stage' ? { ...stage, steps: ['pre-step', 'checkpoint-step'] } : stage,
    ),
    steps: [
      {
        id: 'pre-step',
        title: 'Pre - completed before checkpoint',
        protocol: 'checkpoint-cycle-pre@v1',
        reads: [],
        routes: {
          pass: 'checkpoint-step',
        },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: {
            path: 'reports/pre.json',
            schema: 'checkpoint.fixture.pre@v1',
          },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
      },
      ...base.steps,
    ],
  };
}

// A flow shaped like the explainer: an operator checkpoint that resumes into a
// sub-run "build" step. The sub-run declares a `stop` recovery route, so a child
// that closes non-complete degrades onto `stop -> @stop` (the parent reaches a
// clean `stopped` terminal it can route) rather than crashing. The explainer
// always parks at its PICK checkpoint, so its build step is only ever reached
// via resume — which is exactly the path that used to drop the recovery
// bindings and hard-abort. This fixture reproduces that path.
function checkpointThenSubRunFixtureFlow(): unknown {
  return {
    schema_version: '3',
    id: 'checkpoint-subrun-fixture',
    version: '0.1.0',
    purpose: 'Checkpoint then a sub-run build step — resume recovery-binding parity.',
    axes: {
      allowed_depths: ['high'],
      supports_tournament: false,
      supports_autonomous: false,
      default: { depth: 'high', tournament: false, tournament_n: 3, autonomous: false },
    },
    starts_at: 'checkpoint-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['checkpoint-step'] },
      { id: 'act-stage', title: 'Act', canonical: 'act', steps: ['build-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'Mirrors the explainer: a checkpoint that resumes into a sub-run build step.',
    },
    steps: [
      {
        id: 'checkpoint-step',
        title: 'Checkpoint - wait for operator',
        protocol: 'checkpoint-subrun-frame@v1',
        reads: [],
        routes: { continue: 'build-step', pass: 'build-step', stop: '@stop' },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Choose whether the runtime fixture should continue.',
          choices: [{ id: 'continue', label: 'Continue' }],
          safe_default_choice: 'continue',
        },
        writes: {
          request: 'reports/checkpoints/checkpoint-step-request.json',
          response: 'reports/checkpoints/checkpoint-step-response.json',
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      },
      {
        id: 'build-step',
        title: 'Build - sub-run child (mirrors explainer build-step)',
        protocol: 'checkpoint-subrun-build@v1',
        reads: [],
        routes: { pass: '@complete', stop: '@stop' },
        executor: 'orchestrator',
        kind: 'sub-run',
        flow_ref: { flow_id: 'checkpoint-subrun-child', entry_mode: 'default' },
        goal: 'sub-run child goal',
        depth: 'high',
        writes: { result: 'reports/build-child-result.json' },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: ['accept'],
        },
      },
    ],
  };
}

// PROBE variant: build-step's `stop` recovery route points BACK to the gate
// checkpoint instead of `@stop`. Used to probe whether a failed sub-run child can
// re-open the post-editorial checkpoint (leaving the run resumable / editorial
// preserved) rather than closing the run terminally.
function checkpointRecoverToGateFixtureFlow(): unknown {
  const base = checkpointThenSubRunFixtureFlow() as {
    steps: Array<{ id: string; routes: Record<string, string> }>;
  };
  for (const step of base.steps) {
    if (step.id === 'build-step') {
      step.routes = { pass: '@complete', stop: 'checkpoint-step' };
    }
  }
  return base;
}

// PROBE variant (Arm 3): build-step `stop` -> a FRESH second checkpoint
// (`retry-gate`) that has never been resolved. Probes whether routing a failed
// sub-run child to an UNRESOLVED checkpoint pauses cleanly (checkpoint_waiting /
// resumable) rather than aborting (which Arm 2 showed for an already-resolved gate).
function checkpointThenSubRunThenRetryGateFlow(): unknown {
  return {
    schema_version: '3',
    id: 'checkpoint-subrun-retrygate-fixture',
    version: '0.1.0',
    purpose: 'Gate -> sub-run -> retry gate on failure (probe).',
    axes: {
      allowed_depths: ['high'],
      supports_tournament: false,
      supports_autonomous: false,
      default: { depth: 'high', tournament: false, tournament_n: 3, autonomous: false },
    },
    starts_at: 'checkpoint-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['checkpoint-step'] },
      { id: 'act-stage', title: 'Act', canonical: 'act', steps: ['build-step', 'retry-gate'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'Probe: gate then sub-run then a retry gate on failure.',
    },
    steps: [
      {
        id: 'checkpoint-step',
        title: 'Checkpoint - wait for operator',
        protocol: 'checkpoint-subrun-frame@v1',
        reads: [],
        routes: { continue: 'build-step', pass: 'build-step', stop: '@stop' },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Choose whether the runtime fixture should continue.',
          choices: [{ id: 'continue', label: 'Continue' }],
          safe_default_choice: 'continue',
        },
        writes: {
          request: 'reports/checkpoints/checkpoint-step-request.json',
          response: 'reports/checkpoints/checkpoint-step-response.json',
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      },
      {
        id: 'build-step',
        title: 'Build - sub-run child',
        protocol: 'checkpoint-subrun-build@v1',
        reads: [],
        routes: { pass: '@complete', stop: 'retry-gate' },
        executor: 'orchestrator',
        kind: 'sub-run',
        flow_ref: { flow_id: 'checkpoint-subrun-child', entry_mode: 'default' },
        goal: 'sub-run child goal',
        depth: 'high',
        writes: { result: 'reports/build-child-result.json' },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: ['accept'],
        },
      },
      {
        id: 'retry-gate',
        title: 'Retry gate - operator decides after a build failure',
        protocol: 'checkpoint-subrun-frame@v1',
        reads: [],
        routes: { continue: 'build-step', pass: 'build-step', stop: '@stop' },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Build failed. Retry the build or stop.',
          choices: [
            { id: 'continue', label: 'Retry' },
            { id: 'stop', label: 'Stop' },
          ],
          safe_default_choice: 'stop',
        },
        writes: {
          request: 'reports/checkpoints/retry-gate-request.json',
          response: 'reports/checkpoints/retry-gate-response.json',
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue', 'stop'],
        },
      },
    ],
  };
}

function checkpointSubRunChildFlow(): unknown {
  return {
    schema_version: '3',
    id: 'checkpoint-subrun-child',
    version: '0.1.0',
    purpose: 'Stub child for the checkpoint sub-run resume fixture.',
    axes: {
      allowed_depths: ['high'],
      supports_tournament: false,
      supports_autonomous: false,
      default: { depth: 'high', tournament: false, tournament_n: 3, autonomous: false },
    },
    starts_at: 'child-step',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['child-step'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'Narrow stub child for the resume sub-run fixture.',
    },
    steps: [
      {
        id: 'child-step',
        title: 'Child compose',
        protocol: 'child-compose@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: { report: { path: 'reports/child-compose.json', schema: 'child-compose@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
      },
    ],
  };
}

// A stub child runner that closes the child with a non-complete outcome, so the
// parent's sub-run step takes its `stop` recovery route (sub-run.ts) rather than
// admitting a verdict. This is the "failed build child" the explainer hit.
function makeAbortingChildRunner(): CompiledFlowRunner {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const childResultAbs = runResultPath(options.runDir);
    mkdirSync(dirname(childResultAbs), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: 'checkpoint-subrun-child',
      goal: options.goal,
      outcome: 'aborted',
      summary: 'stub child aborted to exercise parent recovery routing',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'stub-manifest-hash',
    });
    writeFileSync(childResultAbs, `${JSON.stringify(body, null, 2)}\n`);
    return {
      schema_version: body.schema_version,
      run_id: body.run_id,
      flow_id: body.flow_id,
      goal: body.goal,
      outcome: body.outcome,
      summary: body.summary,
      closed_at: body.closed_at,
      trace_entries_observed: body.trace_entries_observed,
      manifest_hash: body.manifest_hash,
      resultPath: childResultAbs,
    };
  };
}

function fixtureBytes(flow: unknown = checkpointFixtureFlow()): Buffer {
  return Buffer.from(JSON.stringify(flow));
}

function fixtureRelayer(): RelayFn {
  return makeStubRelayer(
    JSON.stringify({
      verdict: 'accept',
      summary: 'Resumed relay accepted the checkpoint selection.',
    }),
    { receipt_id: 'checkpoint-fixture-receipt' },
  );
}

// A resumed relay that asks its parent for more context — it carries a
// context_request in its result body. Used to prove the typed-lookup channel is
// re-threaded on resume: the post-step seam must resolve-and-record the request.
function fixtureRelayerWithContextRequest(): RelayFn {
  return makeStubRelayer(
    JSON.stringify({
      verdict: 'accept',
      summary: 'Resumed relay asked its parent for one more named slice.',
      context_request: {
        queries: [{ from_step: 'checkpoint-step', field_path: 'observations' }],
      },
    }),
    { receipt_id: 'checkpoint-fixture-context-receipt' },
  );
}

function fixtureExecutors(
  observed: {
    verificationContexts?: Array<{
      readonly projectRoot?: string;
      readonly selectionConfigLayerCount: number;
      readonly policyLayerCount: number;
    }>;
    composeCalls?: string[];
  } = {},
): Partial<ExecutorRegistry> {
  return {
    compose: async (step, context): Promise<StepOutcome> => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      observed.composeCalls?.push(step.id);
      const report = step.writes?.report;
      if (report === undefined) throw new Error(`compose step '${step.id}' has no report write`);
      await context.files.writeJson(
        { path: report.path },
        {
          summary: `compose ${step.id} completed`,
        },
      );
      return { route: 'pass', details: { writer: step.writer } };
    },
    verification: async (step, context): Promise<StepOutcome> => {
      if (step.kind !== 'verification') throw new Error('expected verification step');
      const report = step.writes?.report;
      if (report === undefined)
        throw new Error(`verification step '${step.id}' has no report write`);
      observed.verificationContexts?.push({
        ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
        selectionConfigLayerCount: context.selectionConfigLayers?.length ?? 0,
        policyLayerCount: context.policyLayers?.length ?? 0,
      });
      await context.files.writeJson(
        { path: report.path },
        {
          overall_status: 'passed',
          ...(context.projectRoot === undefined ? {} : { project_root: context.projectRoot }),
          selection_config_layer_count: context.selectionConfigLayers?.length ?? 0,
          policy_layer_count: context.policyLayers?.length ?? 0,
        },
      );
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        ...(report.schema === undefined ? {} : { report_schema: report.schema }),
      });
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { overall_status: 'passed' } };
    },
  };
}

function selectionLayer() {
  return LayeredConfig.parse({
    layer: 'project',
    config: {
      schema_version: 1,
      host: { kind: 'generic-shell' },
      relay: {
        default: 'auto',
        roles: {},
        flows: {},
        connectors: {},
      },
      flows: {},
      defaults: {},
    },
  });
}

function policyLayer() {
  return PolicyLayer.parse({
    source: 'project',
    envelope: {
      schema_version: 2,
      policy: {
        rules: {
          connectors: {
            allow: ['claude-code'],
          },
        },
      },
    },
  });
}

async function readTrace(runDir: string): Promise<TraceEntry[]> {
  const text = await readFile(join(runDir, 'trace.ndjson'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEntry);
}

async function writeTrace(runDir: string, entries: readonly TraceEntry[]): Promise<void> {
  await writeFile(
    join(runDir, 'trace.ndjson'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

async function rewriteCheckpointRequestTrace(
  runDir: string,
  rewrite: (entry: TraceEntry) => TraceEntry,
): Promise<void> {
  const entries = await readTrace(runDir);
  await writeTrace(
    runDir,
    entries.map((entry) => (entry.kind === 'checkpoint.requested' ? rewrite(entry) : entry)),
  );
}

async function createWaitingFixture(input: {
  readonly runDir: string;
  readonly now?: () => Date;
  readonly progress?: (event: unknown) => void;
  readonly flowBytes?: Buffer;
  readonly policyLayers?: readonly ReturnType<typeof policyLayer>[];
}) {
  const result = await runCompiledFlowWithWaiting({
    flowBytes: input.flowBytes ?? fixtureBytes(),
    runDir: input.runDir,
    runId: RUN_ID,
    goal: GOAL,
    entryModeName: 'high',
    projectRoot: input.runDir,
    selectionConfigLayers: [selectionLayer()],
    ...(input.policyLayers === undefined ? {} : { policyLayers: input.policyLayers }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    executors: fixtureExecutors(),
  });
  expect(isGraphCheckpointWaitingResult(result)).toBe(true);
  if (!isGraphCheckpointWaitingResult(result)) throw new Error('expected waiting checkpoint');
  return result;
}

describe('runtime checkpoint pause/resume fixture', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'circuit-runtime-checkpoint-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('pauses as an open checkpoint instead of closing as an abort', async () => {
    const runDir = join(tempDir, 'pause');
    const progressEvents: unknown[] = [];

    const result = await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 1)),
      progress: (event) => progressEvents.push(ProgressEvent.parse(event)),
    });

    expect(result.outcome).toBe('checkpoint_waiting');
    expect(result.checkpoint).toMatchObject({
      stepId: 'checkpoint-step',
      attempt: 1,
      allowedChoices: ['continue'],
    });
    expect(result.checkpoint.requestPath).toBe(
      join(runDir, 'reports/checkpoints/checkpoint-step-request.json'),
    );
    expect(existsSync(join(runDir, 'reports/result.json'))).toBe(false);

    const trace = await readTrace(runDir);
    expect(trace.map((entry) => entry.kind)).toContain('checkpoint.requested');
    expect(trace.map((entry) => entry.kind)).not.toContain('step.aborted');
    expect(trace.map((entry) => entry.kind)).not.toContain('run.closed');
    const requested = trace.find((entry) => entry.kind === 'checkpoint.requested');
    expect(requested).toMatchObject({
      step_id: 'checkpoint-step',
      attempt: 1,
      request_path: 'reports/checkpoints/checkpoint-step-request.json',
      options: ['continue'],
    });
    expect((requested as Record<string, unknown> | undefined)?.report_path).toBeUndefined();

    expect(projectRunStatusFromRunFolder(runDir)).toMatchObject({
      engine_state: 'waiting_checkpoint',
      reason: 'checkpoint_waiting',
      legal_next_actions: ['inspect', 'resume'],
      checkpoint: {
        checkpoint_id: 'checkpoint-step:1',
        step_id: 'checkpoint-step',
        attempt: 1,
        choices: [{ id: 'continue', label: 'Continue', value: 'continue' }],
        request_path: join(runDir, 'reports/checkpoints/checkpoint-step-request.json'),
      },
    });

    const progressTypes = progressEvents.map((event) => (event as { readonly type: string }).type);
    expect(progressTypes).toContain('checkpoint.waiting');
    expect(progressTypes).toContain('user_input.requested');
  });

  it('resumes into a sub-run whose child fails and degrades onto stop -> @stop instead of hard-aborting', async () => {
    const runDir = join(tempDir, 'resume-subrun-degrade');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      flowBytes: fixtureBytes(checkpointThenSubRunFixtureFlow()),
    });

    const result = await resumeCompiledFlow({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      childCompiledFlowResolver: () => ({ flowBytes: fixtureBytes(checkpointSubRunChildFlow()) }),
      childRunner: makeAbortingChildRunner(),
    });

    // A failed child must degrade onto the parent's stop -> @stop recovery route,
    // reaching a clean `stopped` terminal the parent can route — NOT a hard-abort
    // that forces a full re-run. Before the resume binding fix this closed
    // `aborted` with "...does not declare a matching recovery binding".
    expect(result.outcome).toBe('stopped');
    expect(result.reason ?? '').not.toMatch(/recovery binding/i);

    const trace = await readTrace(runDir);
    const kinds = trace.map((entry) => entry.kind);
    // The sub-run recorded its child's non-success as a failed check (the degrade
    // signal), and the parent did NOT abort the step.
    expect(
      trace.some(
        (entry) =>
          entry.kind === 'check.evaluated' &&
          entry.step_id === ('build-step' as unknown as typeof entry.step_id) &&
          entry.outcome === 'fail',
      ),
    ).toBe(true);
    expect(kinds).not.toContain('step.aborted');
    expect(kinds).toContain('run.closed');
  });

  // ===== Explainer post-editorial checkpoint: preservation across a build failure
  // (the brief's P0). These three lock why one checkpoint is not enough and why a
  // second, fresh retry-gate is the minimum that preserves editorial. The mirrors
  // the explainer exactly: a checkpoint (the post-editorial build-gate), then a
  // sub-run build-step whose child closes non-complete. =====

  // ONE GATE IS NOT ENOUGH. With the build-step's stop route at `@stop`, a build
  // failure closes the run terminally. The editorial upstream of the gate ran
  // once, but the run is no longer resumable — a retry forces a fresh run that
  // re-spends the editorial.
  it('checkpoint-only: a build failure closes the run terminally and cannot be resumed', async () => {
    const runDir = join(tempDir, 'preserve-one-gate');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      flowBytes: fixtureBytes(checkpointThenSubRunFixtureFlow()),
    });
    const first = await resumeCompiledFlow({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      childCompiledFlowResolver: () => ({ flowBytes: fixtureBytes(checkpointSubRunChildFlow()) }),
      childRunner: makeAbortingChildRunner(),
    });
    expect(first.outcome).toBe('stopped');
    const status = projectRunStatusFromRunFolder(runDir);
    expect(status.engine_state).toBe('completed');
    expect(status.legal_next_actions).not.toContain('resume');

    // A second resume to re-attempt the build is refused: the run is closed and
    // there is no unresolved checkpoint to re-enter.
    const second = await resumeCompiledFlowResult({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 4)),
      childCompiledFlowResolver: () => ({ flowBytes: fixtureBytes(checkpointSubRunChildFlow()) }),
      childRunner: makeAbortingChildRunner(),
    });
    expect(isCheckpointResumeRejectedResult(second)).toBe(true);
    if (isCheckpointResumeRejectedResult(second)) {
      expect(second.error.message).toMatch(/already closed|no unresolved checkpoint/i);
    }
  });

  // A FRESH GATE, NOT THE SAME ONE. Routing the failed build back to the already-
  // resolved gate does not re-open it — it aborts. This is why the fix routes to a
  // distinct, never-resolved retry-gate (the next test) rather than the build-gate.
  it('recovery back to the already-resolved gate aborts (must use a fresh gate)', async () => {
    const runDir = join(tempDir, 'preserve-same-gate');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      flowBytes: fixtureBytes(checkpointRecoverToGateFixtureFlow()),
    });
    await resumeCompiledFlowResult({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      childCompiledFlowResolver: () => ({ flowBytes: fixtureBytes(checkpointSubRunChildFlow()) }),
      childRunner: makeAbortingChildRunner(),
    });
    expect(projectRunStatusFromRunFolder(runDir).engine_state).toBe('aborted');
  });

  // TWO GATES PRESERVE EDITORIAL. The build-step's stop route lands on a fresh
  // retry-gate checkpoint, so a build failure parks the run resumably at an
  // unresolved checkpoint. The upstream gate (the editorial boundary) is resolved
  // exactly once and is never re-run across build retries.
  it('retry-gate: a build failure parks resumably and the editorial boundary is not recomputed', async () => {
    const runDir = join(tempDir, 'preserve-retry-gate');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      flowBytes: fixtureBytes(checkpointThenSubRunThenRetryGateFlow()),
    });

    const resolvedFor = (trace: readonly TraceEntry[], stepId: string): number =>
      trace.filter((e) => e.kind === 'checkpoint.resolved' && e.step_id === stepId).length;
    const buildFails = (trace: readonly TraceEntry[]): number =>
      trace.filter(
        (e) =>
          e.kind === 'check.evaluated' &&
          e.step_id === ('build-step' as unknown as typeof e.step_id) &&
          e.outcome === 'fail',
      ).length;
    const unresolved = (trace: readonly TraceEntry[], stepId: string): boolean => {
      const resolved = new Set(
        trace.flatMap((e) =>
          e.kind === 'checkpoint.resolved' && e.step_id === stepId ? [e.attempt] : [],
        ),
      );
      return trace.some(
        (e) =>
          e.kind === 'checkpoint.requested' && e.step_id === stepId && !resolved.has(e.attempt),
      );
    };

    // First resume: cross the build-gate, the build fails, and the run parks at
    // the retry-gate instead of closing.
    await resumeCompiledFlowResult({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      childCompiledFlowResolver: () => ({ flowBytes: fixtureBytes(checkpointSubRunChildFlow()) }),
      childRunner: makeAbortingChildRunner(),
    });
    const status = projectRunStatusFromRunFolder(runDir);
    expect(status.engine_state).toBe('waiting_checkpoint');
    expect(status.legal_next_actions).toContain('resume');
    let trace = await readTrace(runDir);
    expect(unresolved(trace, 'retry-gate')).toBe(true); // resumable at the retry-gate
    expect(resolvedFor(trace, 'checkpoint-step')).toBe(1); // editorial gate crossed once
    expect(buildFails(trace)).toBe(1);

    // Second resume: from the parked retry-gate the operator stops cleanly (the
    // retry-gate's safe_default, and the autonomous behavior). The run closes
    // `stopped` keeping the editorial output — the editorial gate is STILL resolved
    // exactly once, never re-crossed across the whole failure-and-recovery cycle.
    // (The retry choice — retry-gate.continue -> build-step — is structurally locked
    // by tests/contracts/explainer-build-gate. We do not drive it here: this harness
    // pre-writes a sticky checkpoint response, so feeding `continue` to a gate over a
    // deterministically-failing child models "wire continue permanently," which the
    // engine's loop-guard aborts rather than re-spending editorial — itself the
    // no-infinite-loop safety, but not a faithful single-retry.)
    const final = await resumeCompiledFlow({
      runDir,
      selection: 'stop',
      now: deterministicNow(Date.UTC(2026, 0, 4)),
      childCompiledFlowResolver: () => ({ flowBytes: fixtureBytes(checkpointSubRunChildFlow()) }),
      childRunner: makeAbortingChildRunner(),
    });
    expect(final.outcome).toBe('stopped');
    trace = await readTrace(runDir);
    expect(resolvedFor(trace, 'checkpoint-step')).toBe(1); // editorial NOT recomputed
    expect(buildFails(trace)).toBe(1); // build never re-ran on a clean stop
  });

  // THE REAL EXPLAINER, END TO END. The three tests above lock the mechanism on
  // fixtures that mirror the explainer shape. This one drives the REAL compiled
  // explainer (generated/flows/explainer/circuit.json) from intake forward through
  // a failed child build, to close the adversarial-review coverage gap: it proves
  // the real editorial producers (digest, tournament, hardening, spec) run EXACTLY
  // ONCE across the whole build-failure-and-recovery cycle, never re-spent on resume.
  //
  // Stub relayers satisfy the only two model-backed steps — the tournament fanout
  // branches (one researcher relay per concept) and the hardening reviewer relay.
  // The five compose steps (intake, digest, ideas, spec, close) run their real
  // deterministic writers; the three checkpoints (pick, build-gate, retry-gate) are
  // resumed in turn. The build child closes non-complete so build-step degrades onto
  // its `stop` route to the fresh retry-gate, parking the run resumably. No model
  // calls; fixed runId + deterministicNow keep it stable.
  it('REAL explainer: a failed child build preserves the editorial fan-out — digest/tournament/hardening/spec run exactly once across resume', async () => {
    const runDir = join(tempDir, 'real-explainer-preserve');
    const explainerBytes = readFileSync(resolve('generated/flows/explainer/circuit.json'));
    const buildChildBytes = readFileSync(resolve('generated/flows/build/circuit.json'));
    const fixedNow = deterministicNow(Date.UTC(2026, 5, 18, 12, 0, 0));

    // The six per-concept rubric self-judgments every tournament branch reports.
    const passJudgments = {
      fidelity: 'pass',
      memetic_potential: 'pass',
      entertainment: 'pass',
      cross_audience_reach: 'pass',
      build_feasibility: 'pass',
      novelty: 'pass',
    } as const;

    // Satisfies the two model-backed steps. Branch relays self-identify via
    // "Step: tournament-step-<concept-id>"; the hardening relay via "Step: hardening-step".
    const explainerRelayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async (input: RelayInput) => {
        const branch = input.prompt.match(/Step: tournament-step-(concept-\d+)/);
        if (branch !== null) {
          const conceptId = branch[1];
          return {
            request_payload: input.prompt,
            receipt_id: `proposal-${conceptId}`,
            result_body: JSON.stringify({
              verdict: 'accept',
              concept_id: conceptId,
              concept_label: `Label ${conceptId}`,
              case_summary: `The strongest evidence-backed case for ${conceptId}.`,
              fidelity_evidence: ['O:1'],
              risks: ['Tournament risk note.'],
              next_action: 'Build it.',
              rubric_model_judgments: passJudgments,
            }),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        }
        if (input.prompt.includes('Step: hardening-step')) {
          return {
            request_payload: input.prompt,
            receipt_id: 'hardening',
            result_body: JSON.stringify({
              verdict: 'recommend',
              recommended_concept_id: 'concept-1',
              teaches_right_driver: true,
              banned_phrase_findings: [],
              objections: [],
              confidence: 'high',
            }),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        }
        throw new Error(`unexpected explainer relay prompt: ${input.prompt.slice(0, 200)}`);
      },
    };

    // The child build resolves to the REAL build flow (so the engine's
    // resolver-id-vs-flow_ref check passes), but the child runner closes it
    // `aborted` — the failed build. The parent's build-step then degrades onto its
    // `stop` route to the retry-gate (mirrors makeAbortingChildRunner).
    const buildChildResolver = () => ({ flowBytes: buildChildBytes });
    const failingBuildChildRunner: CompiledFlowRunner = async (
      options: CompiledFlowRunOptions,
    ): Promise<GraphRunResult> => {
      const childResultAbs = runResultPath(options.runDir);
      mkdirSync(dirname(childResultAbs), { recursive: true });
      const body = RunResult.parse({
        schema_version: 1,
        run_id: options.runId ?? 'child-build-run',
        flow_id: 'build',
        goal: options.goal,
        outcome: 'aborted',
        summary: 'stub child build aborted to exercise the parent retry-gate',
        closed_at: new Date(0).toISOString(),
        trace_entries_observed: 1,
        manifest_hash: 'stub-manifest-hash',
      });
      writeFileSync(childResultAbs, `${JSON.stringify(body, null, 2)}\n`);
      return {
        schema_version: body.schema_version,
        run_id: body.run_id,
        flow_id: body.flow_id,
        goal: body.goal,
        outcome: body.outcome,
        summary: body.summary,
        closed_at: body.closed_at,
        trace_entries_observed: body.trace_entries_observed,
        manifest_hash: body.manifest_hash,
        resultPath: childResultAbs,
      };
    };

    const enteredCount = (trace: readonly TraceEntry[], stepId: string): number =>
      trace.filter(
        (entry) =>
          entry.kind === 'step.entered' &&
          entry.step_id === (stepId as unknown as typeof entry.step_id),
      ).length;

    // Run from intake forward at tournament depth: the editorial fan-out (intake →
    // digest → ideas → tournament → hardening) all runs, then parks at the PICK
    // checkpoint.
    const waiting = await runCompiledFlowWithWaiting({
      runDir,
      flowBytes: explainerBytes,
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      goal: 'explainer: real preservation across a failed build',
      depth: 'tournament',
      entryModeName: 'tournament',
      now: fixedNow,
      relayer: explainerRelayer,
      projectRoot: runDir,
    });
    expect(isGraphCheckpointWaitingResult(waiting)).toBe(true);
    if (!isGraphCheckpointWaitingResult(waiting)) throw new Error('expected PICK park');
    expect(waiting.checkpoint.stepId).toBe('pick-checkpoint-step');

    // Resume 1 — PICK a concept: spec-step composes, then the run parks at the
    // post-editorial build-gate.
    await resumeCompiledFlowResult({
      runDir,
      selection: 'concept-1',
      now: fixedNow,
      relayer: explainerRelayer,
      childCompiledFlowResolver: buildChildResolver,
      childRunner: failingBuildChildRunner,
    });
    expect(projectRunStatusFromRunFolder(runDir).engine_state).toBe('waiting_checkpoint');

    // Resume 2 — cross the build-gate (`continue`): the child build runs and fails,
    // and the run parks resumably at the FRESH retry-gate instead of closing. (A
    // continuation that re-parks at a new checkpoint surfaces as a rejected resume
    // result — the durable proof is the run-folder state, exactly as the retry-gate
    // fixture test above relies on.)
    const afterBuild = await resumeCompiledFlowResult({
      runDir,
      selection: 'continue',
      now: fixedNow,
      relayer: explainerRelayer,
      childCompiledFlowResolver: buildChildResolver,
      childRunner: failingBuildChildRunner,
    });
    expect(isCheckpointResumeRejectedResult(afterBuild)).toBe(true);
    const parkedAtRetry = projectRunStatusFromRunFolder(runDir);
    expect(parkedAtRetry.engine_state).toBe('waiting_checkpoint'); // resumable, editorial preserved
    expect(parkedAtRetry.legal_next_actions).toContain('resume');

    // Resume 3 (final) — from the parked retry-gate the operator stops cleanly (the
    // retry-gate's safe_default). The run closes `stopped`, keeping the editorial.
    const final = await resumeCompiledFlow({
      runDir,
      selection: 'stop',
      now: fixedNow,
      relayer: explainerRelayer,
      childCompiledFlowResolver: buildChildResolver,
      childRunner: failingBuildChildRunner,
    });
    expect(final.outcome).toBe('stopped');
    expect(projectRunStatusFromRunFolder(runDir).engine_state).toBe('completed');

    // THE PRESERVATION PROOF: across the whole intake → build-failure → retry-gate
    // → stop lifecycle, every expensive editorial producer ran EXACTLY ONCE. None
    // was re-entered on any of the three resumes.
    const trace = await readTrace(runDir);
    expect(enteredCount(trace, 'digest-step')).toBe(1);
    expect(enteredCount(trace, 'tournament-step')).toBe(1);
    expect(enteredCount(trace, 'hardening-step')).toBe(1);
    expect(enteredCount(trace, 'spec-step')).toBe(1);
    // And the build child failed exactly once — it never re-ran on the clean stop.
    expect(enteredCount(trace, 'build-step')).toBe(1);
  }, 20_000);

  it('resumes a runtime checkpoint, restores saved context, continues the graph, and closes', async () => {
    const runDir = join(tempDir, 'resume');
    const before = await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
    });
    const entriesBeforeResume = await readTrace(runDir);
    const observed: {
      verificationContexts: Array<{
        projectRoot?: string;
        selectionConfigLayerCount: number;
        policyLayerCount: number;
      }>;
    } = {
      verificationContexts: [],
    };

    const result = await resumeCompiledFlow({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      relayer: fixtureRelayer(),
      executors: fixtureExecutors(observed),
    });

    expect(result.outcome).toBe('complete');
    expect(RunResult.parse(JSON.parse(readFileSync(result.resultPath, 'utf8')))).toMatchObject({
      run_id: RUN_ID,
      flow_id: 'checkpoint-fixture',
      outcome: 'complete',
      manifest_hash: result.manifest_hash,
    });
    expect(observed.verificationContexts).toEqual([
      {
        projectRoot: runDir,
        selectionConfigLayerCount: 1,
        policyLayerCount: 0,
      },
    ]);

    const trace = await readTrace(runDir);
    const guidance = trace.find(
      (entry) =>
        entry.kind === 'guidance.decision' &&
        entry.subject === 'checkpoint_resolution' &&
        entry.scope?.step_id === 'checkpoint-step',
    );
    expect(guidance).toMatchObject({
      input_refs: [
        expect.objectContaining({
          kind: 'request',
          ref: 'reports/checkpoints/checkpoint-step-request.json',
          step_id: 'checkpoint-step',
        }),
      ],
    });
    const resolved = trace.find((entry) => entry.kind === 'checkpoint.resolved');
    expect(resolved).toMatchObject({
      step_id: 'checkpoint-step',
      attempt: before.checkpoint.attempt,
      selection: 'continue',
      auto_resolved: false,
      resolution_source: 'operator',
      response_path: 'reports/checkpoints/checkpoint-step-response.json',
    });
    expect(trace.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'checkpoint.resolved',
        'relay.completed',
        'step.report_written',
        'run.closed',
      ]),
    );
    expect(trace.map((entry) => entry.sequence)).toEqual(trace.map((_, index) => index));
    expect(trace.length).toBeGreaterThan(entriesBeforeResume.length);
    expect(projectRunStatusFromRunFolder(runDir)).toMatchObject({
      engine_state: 'completed',
      reason: 'run_closed',
      terminal_outcome: 'complete',
    });
  });

  it('re-threads the typed-lookup context channel on resume so a resumed step that asks for context is recorded', async () => {
    // BUILD 3 — the resume re-thread. A run parks at a checkpoint, then resumes
    // into a relay step that emits a context_request. The resume path rebuilds
    // the run from the saved manifest and, before this fix, threaded NO
    // contextPuller into the resumed graph — so the request was silently dropped
    // and no run.context-pull entry was ever written. With the channel
    // re-applied on resume (mirror of the equipment-reshape reseed) the post-step
    // seam resolves and records the request. Here the named parent has no typed
    // report, so the pull PARKS as a finding — but the durable record is exactly
    // the proof the channel is live on the resumed path.
    const runDir = join(tempDir, 'resume-context-pull');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
    });

    const result = await resumeCompiledFlow({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      relayer: fixtureRelayerWithContextRequest(),
      executors: fixtureExecutors(),
    });

    expect(result.outcome).toBe('complete');

    const trace = await readTrace(runDir);
    const pulls = trace.filter((entry) => entry.kind === 'run.context-pull');
    expect(pulls.length).toBeGreaterThan(0);
    expect(pulls[0]).toMatchObject({
      step_id: 'relay-step',
      from_step: 'checkpoint-step',
      field_path: 'observations',
      answered: false,
    });
  });

  it('resumes a parked checkpoint whose trace tail was torn by a crash (Fix 1 / audit Probe C)', async () => {
    // Audit Probe C, end-to-end through the real resume path. A run parks at a
    // checkpoint, then a crash mid-append leaves a torn final trace line. Before
    // Fix 1 this bricked resume with a raw `Unterminated string in JSON`
    // SyntaxError out of TraceStore.load. Now the torn final line is treated as
    // the end of the trace: the clean checkpoint.requested still governs, the
    // appending TraceStore truncates the torn bytes on its first write, and the
    // run resumes to a clean, contiguous trace.
    const runDir = join(tempDir, 'resume-torn-tail');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
    });

    // The crash artifact: a half-written record with no trailing newline,
    // appended after the clean checkpoint.requested line.
    const tracePath = join(runDir, 'trace.ndjson');
    const clean = readFileSync(tracePath, 'utf8');
    writeFileSync(
      tracePath,
      `${clean}{"schema_version":1,"sequence":999,"run_id":"${RUN_ID}","kind":"step.ent`,
      'utf8',
    );

    const result = await resumeCompiledFlow({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      relayer: fixtureRelayer(),
      executors: fixtureExecutors(),
    });

    expect(result.outcome).toBe('complete');

    // The resumed trace is clean: torn bytes gone, sequence numbers contiguous,
    // and the run closed normally. A fresh strict-enough reader sees no garbage.
    const trace = await readTrace(runDir);
    expect(trace.map((entry) => entry.sequence)).toEqual(trace.map((_, index) => index));
    expect(trace.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['checkpoint.resolved', 'run.closed']),
    );
    expect(projectRunStatusFromRunFolder(runDir)).toMatchObject({
      engine_state: 'completed',
      reason: 'run_closed',
      terminal_outcome: 'complete',
    });
  });

  it('rejects checkpoint requests when a static choice has no declared route', async () => {
    const runDir = join(tempDir, 'missing-choice-route');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: fixtureBytes(
        checkpointFixtureFlow({
          checkpointRoutes: {
            pass: 'relay-step',
            stop: '@stop',
          },
        }),
      ),
      runDir,
      runId: RUN_ID,
      goal: GOAL,
      entryModeName: 'high',
      depth: 'medium',
      projectRoot: runDir,
      selectionConfigLayers: [selectionLayer()],
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      relayer: fixtureRelayer(),
      executors: fixtureExecutors(),
    });

    expect(isGraphCheckpointWaitingResult(result)).toBe(false);
    if (isGraphCheckpointWaitingResult(result)) throw new Error('expected aborted result');
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      "checkpoint choice 'continue' on step 'checkpoint-step' has no explicit declared route",
    );
    const trace = await readTrace(runDir);
    expect(trace.some((entry) => entry.kind === 'checkpoint.requested')).toBe(false);
    expect(trace.some((entry) => entry.kind === 'checkpoint.resolved')).toBe(false);
  });

  it('preserves PolicyEnvelope layers across checkpoint resume', async () => {
    const runDir = join(tempDir, 'resume-policy-v2');
    await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      policyLayers: [policyLayer()],
    });
    const observed: {
      verificationContexts: Array<{
        projectRoot?: string;
        selectionConfigLayerCount: number;
        policyLayerCount: number;
      }>;
    } = {
      verificationContexts: [],
    };

    const result = await resumeCompiledFlow({
      runDir,
      selection: 'continue',
      now: deterministicNow(Date.UTC(2026, 0, 3)),
      relayer: fixtureRelayer(),
      executors: fixtureExecutors(observed),
    });

    expect(result.outcome).toBe('complete');
    expect(observed.verificationContexts).toEqual([
      {
        projectRoot: runDir,
        selectionConfigLayerCount: 1,
        policyLayerCount: 1,
      },
    ]);
    const trace = await readTrace(runDir);
    const relayGuidance = trace.find(
      (entry) => entry.kind === 'guidance.decision' && entry.subject === 'relay_execution',
    );
    expect(relayGuidance).toMatchObject({
      policy_refs: expect.arrayContaining([
        expect.objectContaining({ kind: 'policy', ref: 'policy.runtime.policy_v2' }),
      ]),
    });
  });

  it('rejects checkpoint resume when the saved WorkContract ref does not match the flow snapshot', async () => {
    const runDir = join(tempDir, 'resume-contract-ref-drift');
    const waiting = await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      policyLayers: [policyLayer()],
    });
    const requestText = await readFile(waiting.checkpoint.requestPath, 'utf8');
    const request = JSON.parse(requestText) as {
      execution_context: {
        work_contract_ref: {
          sha256?: string;
        };
      };
    };
    request.execution_context.work_contract_ref.sha256 = '0'.repeat(64);
    const rewritten = `${JSON.stringify(request, null, 2)}\n`;
    await writeFile(waiting.checkpoint.requestPath, rewritten);
    await rewriteCheckpointRequestTrace(runDir, (entry) => ({
      ...entry,
      request_report_hash: sha256Hex(rewritten),
    }));

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        now: deterministicNow(Date.UTC(2026, 0, 3)),
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/work_contract_ref does not match saved flow/);
  });

  it('rejects checkpoint resume when the checkpoint boundary hash does not match the saved flow', async () => {
    const runDir = join(tempDir, 'resume-boundary-hash-drift');
    const waiting = await createWaitingFixture({
      runDir,
      now: deterministicNow(Date.UTC(2026, 0, 2)),
      policyLayers: [policyLayer()],
    });
    const replacementHash = '0'.repeat(64);
    const requestText = await readFile(waiting.checkpoint.requestPath, 'utf8');
    const request = JSON.parse(requestText) as {
      execution_context: {
        checkpoint_boundary_ref: {
          sha256?: string;
        };
        checkpoint_boundary_hash?: string;
      };
    };
    request.execution_context.checkpoint_boundary_ref.sha256 = replacementHash;
    request.execution_context.checkpoint_boundary_hash = replacementHash;
    const rewritten = `${JSON.stringify(request, null, 2)}\n`;
    await writeFile(waiting.checkpoint.requestPath, rewritten);
    await rewriteCheckpointRequestTrace(runDir, (entry) => {
      if (entry.kind !== 'checkpoint.requested') return entry;
      if (entry.boundary_ref === undefined) {
        throw new Error('expected checkpoint request trace boundary_ref');
      }
      return {
        ...entry,
        request_report_hash: sha256Hex(rewritten),
        boundary_ref: { ...entry.boundary_ref, sha256: replacementHash },
        boundary_hash: replacementHash,
      } as TraceEntry;
    });

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        now: deterministicNow(Date.UTC(2026, 0, 3)),
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/checkpoint boundary does not match saved flow/);
  });

  it('rejects invalid selections and tampered checkpoint request bytes', async () => {
    const invalidChoiceRun = join(tempDir, 'invalid-choice');
    await createWaitingFixture({ runDir: invalidChoiceRun });

    await expect(
      resumeCompiledFlow({
        runDir: invalidChoiceRun,
        selection: 'stop',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/selection 'stop' is not allowed/);

    const tamperedRun = join(tempDir, 'tampered-request');
    const waiting = await createWaitingFixture({ runDir: tamperedRun });
    await writeFile(waiting.checkpoint.requestPath, '{not json');

    await expect(
      resumeCompiledFlow({
        runDir: tamperedRun,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/checkpoint request hash differs from trace/);
  });

  it('returns checkpoint resume validation failures as typed values while compatibility resume still throws', async () => {
    const resultRun = join(tempDir, 'typed-invalid-choice');
    await createWaitingFixture({ runDir: resultRun });

    const result = await resumeCompiledFlowResult({
      runDir: resultRun,
      selection: 'stop',
      relayer: fixtureRelayer(),
      executors: fixtureExecutors(),
    });

    expect(isCheckpointResumeRejectedResult(result)).toBe(true);
    if (!isCheckpointResumeRejectedResult(result)) {
      throw new Error('expected rejected checkpoint resume result');
    }
    expect(result.reason).toContain("selection 'stop' is not allowed");

    const throwRun = join(tempDir, 'typed-invalid-choice-compat');
    await createWaitingFixture({ runDir: throwRun });
    await expect(
      resumeCompiledFlow({
        runDir: throwRun,
        selection: 'stop',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(result.reason);
  });

  it('rejects and hides checkpoints whose traced request path differs from the saved flow', async () => {
    const runDir = join(tempDir, 'path-mismatch');
    await createWaitingFixture({ runDir });
    const alternatePath = 'reports/checkpoints/alternate-request.json';
    const alternateAbs = join(runDir, alternatePath);
    await mkdir(join(runDir, 'reports/checkpoints'), { recursive: true });
    const alternateRequest = {
      schema_version: 1,
      step_id: 'checkpoint-step',
      prompt: 'alternate request',
      allowed_choices: ['continue'],
      execution_context: {
        project_root: runDir,
        selection_config_layers: [selectionLayer()],
      },
    };
    const alternateText = `${JSON.stringify(alternateRequest, null, 2)}\n`;
    await writeFile(alternateAbs, alternateText);
    await rewriteCheckpointRequestTrace(runDir, (entry) => ({
      ...entry,
      request_path: alternatePath,
      request_report_hash: sha256Hex(alternateText),
    }));

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/does not match saved flow path/);
    expect(projectRunStatusFromRunFolder(runDir)).toMatchObject({
      engine_state: 'invalid',
      reason: 'checkpoint_invalid',
      legal_next_actions: ['none'],
      error: { code: 'checkpoint_request_path_mismatch' },
    });
  });

  it('rejects missing checkpoint request files', async () => {
    const runDir = join(tempDir, 'missing-request');
    const waiting = await createWaitingFixture({ runDir });
    await rm(waiting.checkpoint.requestPath);

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/no such file or directory|ENOENT/);
  });

  it('projects checkpoints with mismatched request choices as invalid', async () => {
    const runDir = join(tempDir, 'request-choice-mismatch');
    const waiting = await createWaitingFixture({ runDir });
    const staleRequest = {
      schema_version: 1,
      step_id: 'checkpoint-step',
      prompt: 'stale choices',
      allowed_choices: ['continue', 'other'],
      execution_context: {
        project_root: runDir,
        selection_config_layers: [selectionLayer()],
      },
    };
    const staleText = `${JSON.stringify(staleRequest, null, 2)}\n`;
    await writeFile(waiting.checkpoint.requestPath, staleText);
    await rewriteCheckpointRequestTrace(runDir, (entry) => ({
      ...entry,
      request_report_hash: sha256Hex(staleText),
    }));

    expect(projectRunStatusFromRunFolder(runDir)).toMatchObject({
      engine_state: 'invalid',
      reason: 'checkpoint_invalid',
      legal_next_actions: ['none'],
      error: { code: 'checkpoint_choice_mismatch' },
    });
    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/request choices for 'checkpoint-step' are stale/);
  });

  it('rejects stale request bodies after the request hash passes', async () => {
    const runDir = join(tempDir, 'stale-request');
    const waiting = await createWaitingFixture({ runDir });
    const staleRequest = {
      schema_version: 2,
      step_id: 'checkpoint-step',
      prompt: 'stale request',
      allowed_choices: ['continue'],
      execution_context: {
        project_root: runDir,
        selection_config_layers: [selectionLayer()],
      },
    };
    const staleText = `${JSON.stringify(staleRequest, null, 2)}\n`;
    await writeFile(waiting.checkpoint.requestPath, staleText);
    const entries = await readTrace(runDir);
    await writeTrace(
      runDir,
      entries.map((entry) =>
        entry.kind === 'checkpoint.requested'
          ? { ...entry, request_report_hash: sha256Hex(staleText) }
          : entry,
      ),
    );

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/request for 'checkpoint-step' is stale/);
  });

  it('rejects stale request step ids after the request hash passes', async () => {
    const runDir = join(tempDir, 'stale-step-id');
    const waiting = await createWaitingFixture({ runDir });
    const staleRequest = {
      schema_version: 1,
      step_id: 'other-step',
      prompt: 'stale request',
      allowed_choices: ['continue'],
      execution_context: {
        project_root: runDir,
        selection_config_layers: [selectionLayer()],
      },
    };
    const staleText = `${JSON.stringify(staleRequest, null, 2)}\n`;
    await writeFile(waiting.checkpoint.requestPath, staleText);
    await rewriteCheckpointRequestTrace(runDir, (entry) => ({
      ...entry,
      request_report_hash: sha256Hex(staleText),
    }));

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/request for 'checkpoint-step' is stale/);
  });

  it('rejects tampered trace choices before writing checkpoint.resolved', async () => {
    const runDir = join(tempDir, 'stale-trace-choices');
    await createWaitingFixture({ runDir });
    await rewriteCheckpointRequestTrace(runDir, (entry) => ({
      ...entry,
      options: ['continue', 'other'],
    }));

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'other',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/checkpoint trace choices for 'checkpoint-step' are stale/);
    const trace = await readTrace(runDir);
    expect(trace.some((entry) => entry.kind === 'checkpoint.resolved')).toBe(false);
  });

  it('rejects already resolved and closed checkpoint runs', async () => {
    const resolvedRun = join(tempDir, 'already-resolved');
    await createWaitingFixture({ runDir: resolvedRun });
    await rewriteCheckpointRequestTrace(resolvedRun, (entry) => ({
      ...entry,
    }));
    const entries = await readTrace(resolvedRun);
    await writeTrace(resolvedRun, [
      ...entries,
      {
        schema_version: 1,
        sequence: entries.length,
        recorded_at: '2026-01-01T00:00:10.000Z',
        run_id: RUN_ID,
        kind: 'checkpoint.resolved',
        step_id: 'checkpoint-step',
        attempt: 1,
        selection: 'continue',
        route_id: 'pass',
        auto_resolved: false,
        resolution_source: 'operator',
        response_path: 'reports/checkpoints/checkpoint-step-response.json',
      } as TraceEntry,
    ]);

    await expect(
      resumeCompiledFlow({
        runDir: resolvedRun,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/run has no unresolved checkpoint request/);

    const closedRun = join(tempDir, 'closed-run');
    await createWaitingFixture({ runDir: closedRun });
    const closedEntries = await readTrace(closedRun);
    await writeTrace(closedRun, [
      ...closedEntries,
      {
        schema_version: 1,
        sequence: closedEntries.length,
        recorded_at: '2026-01-01T00:00:10.000Z',
        run_id: RUN_ID,
        kind: 'run.closed',
        outcome: 'aborted',
        reason: 'closed for rejection coverage',
      } as TraceEntry,
    ]);

    await expect(
      resumeCompiledFlow({
        runDir: closedRun,
        selection: 'continue',
        relayer: fixtureRelayer(),
        executors: fixtureExecutors(),
      }),
    ).rejects.toThrow(/run is already closed/);
  });

  it('validates checkpoint report hashes when the request carries one', async () => {
    const runDir = join(tempDir, 'report-hash');
    writeBuildProofPackage(tempDir);
    const buildBytes = await readFile(join(process.cwd(), 'generated/flows/build/circuit.json'));
    const result = await runCompiledFlowWithWaiting({
      flowBytes: buildBytes,
      runDir,
      runId: randomUUID(),
      goal: 'build checkpoint report hash proof',
      entryModeName: 'high',
      projectRoot: tempDir,
    });
    expect(isGraphCheckpointWaitingResult(result)).toBe(true);
    writeFileSync(join(runDir, 'reports/build/brief.json'), '{"tampered":true}\n');

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
      }),
    ).rejects.toThrow(/waiting Build brief hash differs from request/);
  });

  it('rejects a missing checkpoint report when the request carries its hash', async () => {
    const runDir = join(tempDir, 'missing-report');
    writeBuildProofPackage(tempDir);
    const buildBytes = await readFile(join(process.cwd(), 'generated/flows/build/circuit.json'));
    const result = await runCompiledFlowWithWaiting({
      flowBytes: buildBytes,
      runDir,
      runId: randomUUID(),
      goal: 'build checkpoint missing report proof',
      entryModeName: 'high',
      projectRoot: tempDir,
    });
    expect(isGraphCheckpointWaitingResult(result)).toBe(true);
    await rm(join(runDir, 'reports/build/brief.json'));

    await expect(
      resumeCompiledFlow({
        runDir,
        selection: 'continue',
      }),
    ).rejects.toThrow(/brief\.json|ENOENT|no such file or directory/);
  });

  it('reconstructs completed step state before continuing a resumed graph', async () => {
    const runDir = join(tempDir, 'completed-state');
    const composeCalls: string[] = [];
    await createWaitingFixture({
      runDir,
      flowBytes: fixtureBytes(completedAttemptFixtureFlow()),
    });

    const result = await resumeCompiledFlow({
      runDir,
      selection: 'loop',
      executors: fixtureExecutors({ composeCalls }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("already completed step 'pre-step'");
    expect(composeCalls).toEqual([]);
    const trace = await readTrace(runDir);
    const enteredPreStepCount = trace.filter(
      (entry) => entry.kind === 'step.entered' && entry.step_id === 'pre-step',
    ).length;
    expect(enteredPreStepCount).toBe(1);
  });

  it('routes CLI resume by saved runtime engine marker even when default runtime routing is disabled', async () => {
    const runDir = join(tempDir, 'cli-resume');
    await createWaitingFixture({ runDir });
    await withScopedEnv({ CIRCUIT_SHOW_RUNTIME_DECISION: '1' }, async () => {
      const { result: code, json: output } = await captureJson<Record<string, unknown>>(() =>
        main(['resume', '--run-folder', runDir, '--checkpoint-choice', 'continue'], {
          now: deterministicNow(Date.UTC(2026, 0, 4)),
          relayer: fixtureRelayer(),
          runtimeExecutors: fixtureExecutors(),
        }),
      );

      expect(code).toBe(0);
      expect(output).toMatchObject({
        run_id: RUN_ID,
        flow_id: 'checkpoint-fixture',
        outcome: 'complete',
        runtime_reason: 'checkpoint resume follows the saved run folder engine marker',
      });
      expect(output).not.toHaveProperty('runtime');
      expect(typeof output.result_path).toBe('string');
    });
  });
});

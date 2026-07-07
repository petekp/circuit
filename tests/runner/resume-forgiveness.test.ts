import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseExecutionArgs, runResumeCommand } from '../../src/cli/run.js';
import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlowWithWaiting } from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

// CLI-boundary forgiveness for `circuit resume` (checkpoint UX audit,
// findings 1-3). An operator standing at a parked run types what the page or
// terminal showed them: sometimes the label instead of the id, sometimes the
// id in a different case, sometimes just the run id instead of the folder.
// The engine's allow-list stays strict; the CLI maps forgivable input onto
// the canonical form first, and a real miss answers with the actual choices
// instead of the generic not-resumable shrug.

const GOAL = 'prove resume forgives label and case input';
const RUN_ID = '22222222-2222-4222-8222-222222222202';

function fixtureFlow(): unknown {
  return {
    schema_version: '3',
    id: 'resume-forgiveness-fixture',
    version: '0.1.0',
    purpose: 'Dedicated CLI resume-forgiveness fixture.',
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
      rationale: 'The forgiveness fixture keeps only the steps needed for CLI resume parity.',
    },
    steps: [
      {
        id: 'checkpoint-step',
        title: 'Checkpoint - wait for operator',
        protocol: 'resume-forgiveness-frame@v1',
        reads: [],
        routes: {
          'keep-prototype': 'relay-step',
          'discard-prototype': 'relay-step',
          pass: 'relay-step',
          stop: '@stop',
        },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Choose what happens to the prototype.',
          choices: [
            { id: 'keep-prototype', label: 'Keep the prototype' },
            { id: 'discard-prototype', label: 'Discard the prototype' },
          ],
          safe_default_choice: 'keep-prototype',
        },
        writes: {
          request: 'reports/checkpoints/checkpoint-step-request.json',
          response: 'reports/checkpoints/checkpoint-step-response.json',
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['keep-prototype', 'discard-prototype'],
        },
      },
      {
        id: 'relay-step',
        title: 'Relay - continue after checkpoint',
        protocol: 'resume-forgiveness-relay@v1',
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
        protocol: 'resume-forgiveness-verify@v1',
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
            schema: 'resume.forgiveness.verification@v1',
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
        protocol: 'resume-forgiveness-close@v1',
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
            schema: 'resume.forgiveness.result@v1',
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

function fixtureExecutors(): Partial<ExecutorRegistry> {
  return {
    compose: async (step, context): Promise<StepOutcome> => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const report = step.writes?.report;
      if (report === undefined) throw new Error(`compose step '${step.id}' has no report write`);
      await context.files.writeJson({ path: report.path }, { summary: `compose ${step.id} done` });
      return { route: 'pass', details: {} };
    },
    verification: async (step, context): Promise<StepOutcome> => {
      if (step.kind !== 'verification') throw new Error('expected verification step');
      const report = step.writes?.report;
      if (report === undefined)
        throw new Error(`verification step '${step.id}' has no report write`);
      await context.files.writeJson({ path: report.path }, { overall_status: 'passed' });
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
      return { route: 'pass', details: {} };
    },
  };
}

function fixtureRelayer(): RelayFn {
  return makeStubRelayer(
    JSON.stringify({ verdict: 'accept', summary: 'Resumed relay accepted the selection.' }),
    { receipt_id: 'resume-forgiveness-receipt' },
  );
}

function selectionLayer() {
  return LayeredConfig.parse({
    layer: 'project',
    config: {
      schema_version: 1,
      host: { kind: 'generic-shell' },
      relay: { default: 'auto', roles: {}, flows: {}, connectors: {} },
      flows: {},
      defaults: {},
    },
  });
}

async function createWaitingRun(runDir: string): Promise<void> {
  const result = await runCompiledFlowWithWaiting({
    flowBytes: Buffer.from(JSON.stringify(fixtureFlow())),
    runDir,
    runId: RUN_ID,
    goal: GOAL,
    entryModeName: 'high',
    projectRoot: runDir,
    selectionConfigLayers: [selectionLayer()],
    executors: fixtureExecutors(),
    now: deterministicNow(Date.UTC(2026, 6, 4)),
  });
  expect(isGraphCheckpointWaitingResult(result)).toBe(true);
}

describe('resume forgives operator-shaped checkpoint input', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'circuit-resume-forgiveness-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('maps a choice label (any case) onto the id and completes the run', async () => {
    const runDir = join(tempDir, 'label-resume');
    await createWaitingRun(runDir);

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-choice',
      'keep the prototype',
    ]);
    const { result, stdout, stderr } = await captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
      }),
    );

    expect(stderr).not.toContain('error:');
    expect(result).toBe(0);
    const envelope = JSON.parse(stdout) as { outcome: string };
    expect(envelope.outcome).toBe('complete');
    // The saved decision record carries the canonical id, not the label.
    const trace = await readFile(join(runDir, 'trace.ndjson'), 'utf8');
    expect(trace).toContain('"selection":"keep-prototype"');
  });

  it('answers an unknown choice with the actual choices instead of a generic shrug', async () => {
    const runDir = join(tempDir, 'invalid-choice');
    await createWaitingRun(runDir);

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-choice',
      'keepit',
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain("'keepit'");
    expect(stderr).toContain('keep-prototype (Keep the prototype)');
    expect(stderr).toContain('discard-prototype (Discard the prototype)');
    expect(stderr).toContain(`circuit resume --run-folder ${runDir} --checkpoint-choice`);
    // The old generic answer must not swallow the specific one.
    expect(stderr).not.toContain('could not be resumed even though it is waiting');
  });

  it('points a missing folder at the run-id convention and the inbox', async () => {
    const missing = join(tempDir, 'nope');
    const args = parseExecutionArgs('resume', [
      '--run-folder',
      missing,
      '--checkpoint-choice',
      'anything',
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain(missing);
    expect(stderr).toContain('.circuit/runs/');
    expect(stderr).toContain('circuit inbox');
  });
});

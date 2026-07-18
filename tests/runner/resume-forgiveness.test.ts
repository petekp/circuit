import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  durableCheckpointReviewWasRecorded,
  parseExecutionArgs,
  runResumeCommand,
} from '../../src/cli/run.js';
import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlowWithWaiting } from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import { acquireResumeLock } from '../../src/runtime/run/resume-lock.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CheckpointReviewResponse } from '../../src/schemas/checkpoint-review-response.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import { encodeCheckpointReviewResponse } from '../../src/shared/checkpoint-review-token.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
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

function twoCheckpointFixtureFlow(): unknown {
  const flow = structuredClone(fixtureFlow()) as {
    stages: Array<{ id: string; steps: string[] }>;
    steps: Array<Record<string, unknown> & { id: string }>;
  };
  const first = flow.steps.find((step) => step.id === 'checkpoint-step');
  if (first === undefined) throw new Error('fixture checkpoint is missing');
  first.routes = {
    'keep-prototype': 'second-checkpoint-step',
    'discard-prototype': 'second-checkpoint-step',
    pass: 'second-checkpoint-step',
    stop: '@stop',
  };
  const second = {
    id: 'second-checkpoint-step',
    title: 'Checkpoint - choose the final treatment',
    protocol: 'resume-forgiveness-second-frame@v1',
    reads: ['reports/checkpoints/checkpoint-step-response.json'],
    routes: {
      polish: 'relay-step',
      simplify: 'relay-step',
      pass: 'relay-step',
      stop: '@stop',
    },
    executor: 'orchestrator',
    kind: 'checkpoint',
    policy: {
      prompt: 'Choose the final treatment for the accepted direction.',
      choices: [
        { id: 'polish', label: 'Polish it' },
        { id: 'simplify', label: 'Simplify it' },
      ],
      safe_default_choice: 'polish',
    },
    writes: {
      request: 'reports/checkpoints/second-checkpoint-step-request.json',
      response: 'reports/checkpoints/second-checkpoint-step-response.json',
    },
    check: {
      kind: 'checkpoint_selection',
      source: { kind: 'checkpoint_response', ref: 'response' },
      allow: ['polish', 'simplify'],
    },
  };
  const relayIndex = flow.steps.findIndex((step) => step.id === 'relay-step');
  flow.steps.splice(relayIndex, 0, second);
  const actStage = flow.stages.find((stage) => stage.id === 'act-stage');
  if (actStage === undefined) throw new Error('fixture act stage is missing');
  actStage.steps.unshift(second.id);
  return flow;
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

async function createWaitingRun(runDir: string, flow: unknown = fixtureFlow()): Promise<void> {
  const result = await runCompiledFlowWithWaiting({
    flowBytes: Buffer.from(JSON.stringify(flow)),
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

async function validReviewResponse(
  runDir: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const requestBody = await readFile(
    join(runDir, 'reports/checkpoints/checkpoint-step-request.json'),
    'utf8',
  );
  return {
    schema: 'checkpoint.review-response@v1',
    run_id: RUN_ID,
    step_id: 'checkpoint-step',
    attempt: 1,
    request_sha256: sha256Hex(requestBody),
    selection: 'keep-prototype',
    comments: [],
    ...overrides,
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function dropHttpResponse(input: {
  readonly endpoint: string;
  readonly origin: string;
  readonly authorization: string;
  readonly payload: unknown;
}): Promise<void> {
  const body = JSON.stringify(input.payload);
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      input.endpoint,
      {
        method: 'POST',
        headers: {
          Origin: input.origin,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'X-Circuit-Review-Session': input.authorization,
        },
      },
      (response) => {
        response.destroy();
        resolve();
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function expectCheckpointStillUntouched(input: {
  readonly runDir: string;
  readonly traceBefore: string;
}): Promise<void> {
  expect(await readFile(join(input.runDir, 'trace.ndjson'), 'utf8')).toBe(input.traceBefore);
  await expectMissing(join(input.runDir, 'reports/checkpoints/checkpoint-step-response.json'));
  await expectMissing(
    join(input.runDir, 'reports/checkpoints/checkpoint-step-response.attempt-1.json'),
  );
  await expectMissing(join(input.runDir, 'resume.lock'));
}

describe('resume forgives operator-shaped checkpoint input', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'circuit-resume-forgiveness-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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

  it('keeps a typed response exact instead of normalizing its selection behind the token', async () => {
    const runDir = join(tempDir, 'typed-label-resume');
    await createWaitingRun(runDir);
    const response = encodeCheckpointReviewResponse({
      schema: 'checkpoint.review-response@v1',
      run_id: RUN_ID,
      step_id: 'checkpoint-step',
      attempt: 1,
      request_sha256: 'a'.repeat(64),
      selection: 'Keep the prototype',
      comments: [],
    });
    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response',
      response,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain("'Keep the prototype'");
    expect(stderr).toContain('keep-prototype (Keep the prototype)');
  });

  it('resumes from an exported checkpoint response JSON file', async () => {
    const runDir = join(tempDir, 'response-file-resume');
    await createWaitingRun(runDir);
    const requestPath = join(runDir, 'reports/checkpoints/checkpoint-step-request.json');
    const requestBody = await readFile(requestPath, 'utf8');
    const responsePath = join(runDir, 'exports/checkpoint-review.json');
    await mkdir(dirname(responsePath), { recursive: true });
    await writeFile(
      responsePath,
      `${JSON.stringify(
        {
          schema: 'checkpoint.review-response@v1',
          run_id: RUN_ID,
          step_id: 'checkpoint-step',
          attempt: 1,
          request_sha256: sha256Hex(requestBody),
          selection: 'keep-prototype',
          comments: [
            {
              scope: 'choice',
              choice_id: 'keep-prototype',
              body: 'Keep it, but tighten the copy before launch.',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
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
    const savedResponse = JSON.parse(
      await readFile(join(runDir, 'reports/checkpoints/checkpoint-step-response.json'), 'utf8'),
    ) as { comments?: unknown };
    expect(savedResponse).toMatchObject({
      selection: 'keep-prototype',
      comments: [
        {
          scope: 'choice',
          choice_id: 'keep-prototype',
          body: 'Keep it, but tighten the copy before launch.',
        },
      ],
    });
  });

  it('surfaces a different next checkpoint after a direct resume', async () => {
    const runDir = join(tempDir, 'direct-two-checkpoint-resume');
    await createWaitingRun(runDir, twoCheckpointFixtureFlow());
    const summaryPath = join(runDir, 'reports/operator-summary.html');
    await writeFile(summaryPath, 'STALE_FIRST_CHECKPOINT_PAGE', 'utf8');
    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-choice',
      'keep-prototype',
    ]);

    const { result, stdout, stderr } = await captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
      }),
    );

    expect(result).toBe(0);
    expect(stderr).not.toContain('could not continue');
    expect(stderr).not.toContain('error:');
    const envelope = JSON.parse(stdout) as {
      outcome: string;
      operator_summary_html_path?: string;
      checkpoint: { step_id: string; attempt: number; allowed_choices: string[] };
    };
    expect(envelope).toMatchObject({
      outcome: 'checkpoint_waiting',
      operator_summary_html_path: summaryPath,
      checkpoint: {
        step_id: 'second-checkpoint-step',
        attempt: 1,
        allowed_choices: ['polish', 'simplify'],
      },
    });
    const summary = await readFile(summaryPath, 'utf8');
    expect(summary).not.toContain('STALE_FIRST_CHECKPOINT_PAGE');
    expect(summary).toContain('Choose the final treatment for the accepted direction.');
  });

  it('saves the browser Done payload and continues without copy or paste', async () => {
    const runDir = join(tempDir, 'trusted-done-resume');
    await createWaitingRun(runDir);
    const summaryPath = join(runDir, 'reports/operator-summary.html');
    await writeFile(
      summaryPath,
      '<!doctype html><html><head><title>Worker page</title></head><body>UNTRUSTED_SAVED_HTML</body></html>',
      'utf8',
    );
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [
        {
          scope: 'choice',
          choice_id: 'discard-prototype',
          body: 'The simpler direction is easier to maintain.',
        },
        { scope: 'overall', body: 'Ship the quieter option. ✓' },
      ],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let reviewUrl = '';
    let servedReviewHtml = '';
    let browserSubmission: Promise<Response> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          reviewUrl = url;
          browserSubmission = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            servedReviewHtml = html;
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            const submit = () =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });
            const accepted = await submit();
            if (accepted.ok) await submit();
            return accepted;
          })();
        },
      }),
    );

    const { result, stdout, stderr } = await command;
    const submitted = browserSubmission;
    if (submitted === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    const submissionResponse = await submitted;

    expect(reviewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(servedReviewHtml).not.toContain('UNTRUSTED_SAVED_HTML');
    expect(servedReviewHtml).toContain('Choose what happens to the prototype.');
    expect(submissionResponse.status).toBe(200);
    expect(result).toBe(0);
    expect(stderr).not.toContain('error:');
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'complete', run_folder: runDir });

    const canonicalPath = join(runDir, 'reports/checkpoints/checkpoint-step-response.json');
    const attemptPath = join(runDir, 'reports/checkpoints/checkpoint-step-response.attempt-1.json');
    const canonical = await readFile(canonicalPath, 'utf8');
    const attempt = await readFile(attemptPath, 'utf8');
    expect(canonical).toBe(attempt);
    expect(JSON.parse(canonical)).toEqual({
      schema_version: 1,
      step_id: payload.step_id,
      selection: payload.selection,
      route_id: payload.selection,
      resolution_source: 'operator',
      comments: payload.comments,
    });

    const trace = (await readFile(join(runDir, 'trace.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resolved = trace.filter((entry) => entry.kind === 'checkpoint.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      selection: payload.selection,
      route_id: payload.selection,
      auto_resolved: false,
      resolution_source: 'operator',
      response_path: 'reports/checkpoints/checkpoint-step-response.json',
      response_attempt_path: 'reports/checkpoints/checkpoint-step-response.attempt-1.json',
      response_report_hash: sha256Hex(attempt),
    });
    expect(trace.map((entry) => entry.sequence)).toEqual(trace.map((_, index) => index));
    await expectMissing(join(runDir, 'resume.lock'));
    await expectMissing(summaryPath);
  });

  it('saves browser Done and surfaces a different next checkpoint without a false failure', async () => {
    const runDir = join(tempDir, 'trusted-done-two-checkpoint-resume');
    await createWaitingRun(runDir, twoCheckpointFixtureFlow());
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'Keep this review before the next decision.' }],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let browserSubmission: Promise<Response> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          browserSubmission = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            const submit = () =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });
            const accepted = await submit();
            if (accepted.ok) await submit();
            return accepted;
          })();
        },
      }),
    );

    const { result, stdout, stderr } = await command;
    const submitted = browserSubmission;
    if (submitted === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    const submissionResponse = await submitted;

    expect(submissionResponse.status).toBe(200);
    expect(await submissionResponse.json()).toEqual({
      ok: true,
      message: 'Review saved.',
      terminal: true,
    });
    expect(result).toBe(0);
    expect(stderr).not.toContain('could not finish continuing');
    expect(stderr).not.toContain('could not continue');
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: 'checkpoint_waiting',
      checkpoint: {
        step_id: 'second-checkpoint-step',
        allowed_choices: ['polish', 'simplify'],
      },
    });
    expect(await readFile(join(runDir, 'reports/operator-summary.html'), 'utf8')).toContain(
      'Choose the final treatment for the accepted direction.',
    );
    const savedResponse = JSON.parse(
      await readFile(join(runDir, 'reports/checkpoints/checkpoint-step-response.json'), 'utf8'),
    ) as { comments?: unknown };
    expect(savedResponse).toMatchObject({
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'Keep this review before the next decision.' }],
    });
  });

  it('keeps a bounded listener open when the first accepted reply is lost', async () => {
    const runDir = join(tempDir, 'trusted-done-lost-accepted-reply');
    await createWaitingRun(runDir);
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'Keep this exact review through a lost reply.' }],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let endpoint = '';
    let browserJourney: Promise<void> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          browserJourney = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            endpoint = session.endpoint;
            const origin = new URL(url).origin;
            const submit = (body: unknown) =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(body),
              });

            await dropHttpResponse({
              endpoint: session.endpoint,
              origin,
              authorization: session.authorization,
              payload,
            });
            await waitForFile(join(runDir, 'reports/fixture-result.json'));

            const changed = await submit({
              ...payload,
              comments: [{ scope: 'overall', body: 'A changed replay must stay rejected.' }],
            });
            expect(changed.status).toBe(409);
            expect(await changed.json()).toMatchObject({
              ok: false,
              code: 'already_submitted',
              terminal: true,
            });

            const replay = await submit(payload);
            expect(replay.status).toBe(200);
            expect(await replay.json()).toEqual({
              ok: true,
              message: 'Review saved.',
              terminal: true,
            });
          })();
        },
      }),
    );

    const { result, stderr } = await command;
    const journey = browserJourney;
    if (journey === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    await journey;

    expect(result).toBe(0);
    expect(stderr).not.toContain('error:');
    await expectMissing(join(runDir, 'resume.lock'));
    await expect(fetch(endpoint)).rejects.toThrow();
  });

  it.each([
    {
      label: 'the trace names an undeclared canonical path',
      mutate: (_record: Record<string, unknown>, entry: Record<string, unknown>) => {
        entry.response_path = 'reports/checkpoints/other-response.json';
      },
    },
    {
      label: 'the trace names an undeclared attempt path',
      mutate: (_record: Record<string, unknown>, entry: Record<string, unknown>) => {
        entry.response_attempt_path = 'reports/checkpoints/checkpoint-step-response.attempt-2.json';
      },
    },
    {
      label: 'the trace claims automatic resolution',
      mutate: (_record: Record<string, unknown>, entry: Record<string, unknown>) => {
        entry.auto_resolved = true;
      },
    },
    {
      label: 'the trace does not name the operator as its source',
      mutate: (_record: Record<string, unknown>, entry: Record<string, unknown>) => {
        entry.resolution_source = 'policy';
      },
    },
    {
      label: 'the response record does not name the operator as its source',
      mutate: (record: Record<string, unknown>) => {
        record.resolution_source = 'policy';
      },
    },
    {
      label: 'the response and trace use a route other than the selected route',
      mutate: (record: Record<string, unknown>, entry: Record<string, unknown>) => {
        record.route_id = 'pass';
        entry.route_id = 'pass';
      },
    },
    {
      label: 'the response comments differ from the submitted comments',
      mutate: (record: Record<string, unknown>) => {
        record.comments = [{ scope: 'overall', body: 'Different notes.' }];
      },
    },
    {
      label: 'the response contains an undeclared extra field',
      mutate: (record: Record<string, unknown>) => {
        record.extra = 'must not be accepted';
      },
    },
    {
      label: 'the trace hash differs from the attempt bytes',
      corruptHash: true,
      mutate: () => undefined,
    },
  ])('rejects durable proof when $label', async ({ label, mutate, corruptHash }) => {
    const runDir = join(
      tempDir,
      `durable-proof-${label.replaceAll(/[^a-z]+/gi, '-').toLowerCase()}`,
    );
    await createWaitingRun(runDir);
    const response = CheckpointReviewResponse.parse(
      await validReviewResponse(runDir, {
        selection: 'discard-prototype',
        comments: [{ scope: 'overall', body: 'Keep this exact operator note.' }],
      }),
    );
    const canonicalPath = 'reports/checkpoints/checkpoint-step-response.json';
    const attemptPath = 'reports/checkpoints/checkpoint-step-response.attempt-1.json';
    const record: Record<string, unknown> = {
      schema_version: 1,
      step_id: response.step_id,
      selection: response.selection,
      route_id: response.selection,
      resolution_source: 'operator',
      comments: response.comments,
    };
    const entry: Record<string, unknown> = {
      run_id: response.run_id,
      kind: 'checkpoint.resolved',
      step_id: response.step_id,
      attempt: response.attempt,
      selection: response.selection,
      route_id: response.selection,
      auto_resolved: false,
      resolution_source: 'operator',
      response_path: canonicalPath,
      response_attempt_path: attemptPath,
    };
    mutate(record, entry);
    const recordText = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(join(runDir, canonicalPath), recordText);
    await writeFile(join(runDir, attemptPath), recordText);
    entry.response_report_hash = corruptHash === true ? 'f'.repeat(64) : sha256Hex(recordText);
    const trace = new TraceStore(runDir);
    await trace.load();
    await trace.append(entry as unknown as Parameters<TraceStore['append']>[0]);

    await expect(durableCheckpointReviewWasRecorded(runDir, response)).resolves.toBe(false);
  });

  it('lets the same Done submission retry after another resume releases the lock', async () => {
    const runDir = join(tempDir, 'trusted-done-lock-retry');
    await createWaitingRun(runDir);
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'Save this exact review after the other resume.' }],
    });
    const held = acquireResumeLock(runDir);
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error(held.message);
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let browserJourney: Promise<void> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          browserJourney = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            const submit = () =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });

            const blocked = await submit();
            expect(blocked.status).toBe(409);
            expect(await blocked.json()).toMatchObject({
              ok: false,
              code: 'resume_in_progress',
              terminal: false,
            });
            held.handle.release();

            const accepted = await submit();
            expect(accepted.status).toBe(200);
            const acknowledged = await submit();
            expect(acknowledged.status).toBe(200);
          })();
        },
      }),
    );

    const { result, stderr } = await command;
    const journey = browserJourney;
    if (journey === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    await journey;
    expect(result).toBe(0);
    expect(stderr).not.toContain('error:');
    const saved = JSON.parse(
      await readFile(join(runDir, 'reports/checkpoints/checkpoint-step-response.json'), 'utf8'),
    ) as { readonly comments: unknown };
    expect(saved.comments).toEqual(payload.comments);
    await expectMissing(join(runDir, 'resume.lock'));
  });

  it('does not acknowledge Done unless the exact checkpoint response is durable', async () => {
    const runDir = join(tempDir, 'done-without-durable-response');
    await createWaitingRun(runDir);
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'This must not be reported as saved.' }],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let browserSubmission: Promise<Response> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: {
          ...fixtureExecutors(),
          // Model a checkpoint executor that closes normally without ever
          // writing the response files or checkpoint.resolved trace entry.
          checkpoint: async (): Promise<StepOutcome> => ({
            route: 'stop',
            details: { reason: 'fixture deliberately skipped checkpoint persistence' },
          }),
        },
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          browserSubmission = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            const submit = () =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });
            const accepted = await submit();
            if (accepted.ok) await submit();
            return accepted;
          })();
        },
      }),
    );

    const { result } = await command;
    const submitted = browserSubmission;
    if (submitted === undefined) throw new Error('review browser was not opened');
    const response = await submitted;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'checkpoint_review_not_persisted',
    });
    expect(result).toBe(2);
    await expectMissing(join(runDir, 'reports/checkpoints/checkpoint-step-response.json'));
    await expectMissing(
      join(runDir, 'reports/checkpoints/checkpoint-step-response.attempt-1.json'),
    );
    const trace = await readFile(join(runDir, 'trace.ndjson'), 'utf8');
    expect(trace).not.toContain('checkpoint.resolved');
    await expectMissing(join(runDir, 'resume.lock'));
  });

  it('reports the review as saved through a torn trace tail when continuation fails after checkpoint.resolved', async () => {
    const runDir = join(tempDir, 'done-durable-before-resume-failure');
    await createWaitingRun(runDir);
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'This exact review is already durable.' }],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let browserSubmission: Promise<Response> | undefined;
    let resolutionRecorded = false;
    let tornTailWritten = false;
    const baseTime = Date.UTC(2026, 6, 5);
    let tick = 0;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: {
          ...fixtureExecutors(),
          checkpoint: async (step, context): Promise<StepOutcome> => {
            if (step.kind !== 'checkpoint' || step.writes?.response === undefined) {
              throw new Error('expected checkpoint response write');
            }
            const responseBody = {
              schema_version: 1,
              step_id: step.id,
              selection: payload.selection,
              route_id: payload.selection,
              resolution_source: 'operator',
              comments: payload.comments,
            };
            const attemptPath = 'reports/checkpoints/checkpoint-step-response.attempt-1.json';
            await context.files.writeJson(step.writes.response, responseBody);
            await context.files.writeJson({ path: attemptPath }, responseBody);
            const attemptText = await context.files.readText({ path: attemptPath });
            await context.trace.append({
              run_id: context.runId,
              kind: 'checkpoint.resolved',
              step_id: step.id,
              attempt: context.activeStepAttempt ?? 1,
              selection: payload.selection as string,
              route_id: payload.selection as string,
              auto_resolved: false,
              resolution_source: 'operator',
              response_path: step.writes.response.path,
              response_attempt_path: attemptPath,
              response_report_hash: sha256Hex(attemptText),
            });
            resolutionRecorded = true;
            return { route: payload.selection as string, details: {} };
          },
        },
        relayer: fixtureRelayer(),
        now: () => {
          if (resolutionRecorded) {
            if (!tornTailWritten) {
              appendFileSync(join(runDir, 'trace.ndjson'), '{"schema_version":1');
              tornTailWritten = true;
            }
            throw new Error('fixture continuation failed after durable checkpoint resolution');
          }
          const value = new Date(baseTime + tick * 1_000);
          tick += 1;
          return value;
        },
        openCheckpointReview: (url) => {
          browserSubmission = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            return fetch(session.endpoint, {
              method: 'POST',
              headers: {
                Origin: new URL(url).origin,
                'Content-Type': 'application/json',
                'X-Circuit-Review-Session': session.authorization,
              },
              body: JSON.stringify(payload),
            });
          })();
        },
      }),
    );

    const { result, stderr } = await command;
    const submitted = browserSubmission;
    if (submitted === undefined) throw new Error('review browser was not opened');
    const response = await submitted;

    const responseBody = await response.json();
    expect(response.status).toBe(200);
    expect(responseBody).toEqual({
      ok: true,
      code: 'resume_failed_after_save',
      message: 'Review saved, but Circuit could not finish continuing the run.',
      terminal: true,
    });
    expect(result).toBe(2);
    expect(stderr).toContain('review was saved');
    expect(stderr).toContain('could not finish continuing');
  });

  it('rejects a stale runtime submission and settles the local review command', async () => {
    const runDir = join(tempDir, 'stale-live-review');
    await createWaitingRun(runDir);
    const requestPath = join(runDir, 'reports/checkpoints/checkpoint-step-request.json');
    const originalRequest = await readFile(requestPath, 'utf8');
    const tracePath = join(runDir, 'trace.ndjson');
    const traceBefore = await readFile(tracePath, 'utf8');
    const payload = await validReviewResponse(runDir, {
      selection: 'keep-prototype',
      comments: [{ scope: 'overall', body: 'This stale review must not be written.' }],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    let browserJourney: Promise<void> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          browserJourney = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            const submit = () =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });

            await writeFile(requestPath, `${originalRequest.trim()}\n `);
            const stale = await submit();
            expect(stale.status).toBe(409);
            expect(await stale.json()).toMatchObject({
              ok: false,
              code: 'resume_rejected',
            });
            expect(await readFile(tracePath, 'utf8')).toBe(traceBefore);
            await expectMissing(join(runDir, 'reports/checkpoints/checkpoint-step-response.json'));
            await expectMissing(
              join(runDir, 'reports/checkpoints/checkpoint-step-response.attempt-1.json'),
            );
            await expectMissing(join(runDir, 'resume.lock'));
          })();
        },
      }),
    );

    const { result, stderr } = await command;
    const journey = browserJourney;
    if (journey === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    await journey;
    expect(result).toBe(2);
    expect(stderr).toContain('error:');
    expect(stderr).not.toContain('runtime checkpoint resume rejected');
  });

  it('regenerates a missing page and acknowledges Done before the remaining run finishes', async () => {
    const runDir = join(tempDir, 'missing-page-live-review');
    await createWaitingRun(runDir);
    await rm(join(runDir, 'reports/operator-summary.html'), { force: true });
    const payload = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'The review should save before the relay finishes.' }],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runDir, '--checkpoint-review']);
    const baseRelayer = fixtureRelayer();
    let releaseRelay: (() => void) | undefined;
    const relayGate = new Promise<void>((resolve) => {
      releaseRelay = resolve;
    });
    let markRelayStarted: (() => void) | undefined;
    const relayStarted = new Promise<void>((resolve) => {
      markRelayStarted = resolve;
    });
    const slowRelayer: RelayFn = {
      ...baseRelayer,
      relay: async (relayInput) => {
        markRelayStarted?.();
        await relayGate;
        return baseRelayer.relay(relayInput);
      },
    };
    let browserJourney: Promise<void> | undefined;
    let servedReviewHtml = '';
    let markBrowserOpened: (() => void) | undefined;
    const browserOpened = new Promise<void>((resolve) => {
      markBrowserOpened = resolve;
    });
    let commandFinished = false;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: slowRelayer,
        now: deterministicNow(Date.UTC(2026, 6, 5)),
        openCheckpointReview: (url) => {
          browserJourney = (async () => {
            try {
              const page = await fetch(url);
              const html = await page.text();
              servedReviewHtml = html;
              const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
              if (match?.[1] === undefined) throw new Error('missing review bootstrap');
              const session = JSON.parse(match[1]) as {
                readonly endpoint: string;
                readonly authorization: string;
              };
              const submitted = await fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });
              expect(submitted.status).toBe(200);
              const acknowledged = await fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(payload),
              });
              expect(acknowledged.status).toBe(200);
              await relayStarted;
              expect(commandFinished).toBe(false);
            } finally {
              releaseRelay?.();
            }
          })();
          markBrowserOpened?.();
        },
      }),
    );
    void command.then(() => {
      commandFinished = true;
    });

    await browserOpened;
    const journey = browserJourney;
    if (journey === undefined) throw new Error('review browser journey did not start');
    await journey;
    const { result, stderr } = await command;
    expect(servedReviewHtml).toContain('Choose what happens to the prototype.');
    expect(result).toBe(0);
    expect(stderr).not.toContain('error:');
  });

  it('resolves a relative response file from the caller working directory, not the run folder', async () => {
    const callerDir = join(tempDir, 'caller');
    const runDir = join(tempDir, 'cwd-response-file');
    await mkdir(callerDir, { recursive: true });
    await createWaitingRun(runDir);

    const callerResponse = await validReviewResponse(runDir, {
      selection: 'discard-prototype',
      comments: [{ scope: 'overall', body: 'Use the file selected by the caller.' }],
    });
    const runFolderShadow = await validReviewResponse(runDir, {
      selection: 'keep-prototype',
      comments: [{ scope: 'overall', body: 'This run-folder shadow must be ignored.' }],
    });
    await writeFile(join(callerDir, 'review.json'), `${JSON.stringify(callerResponse)}\n`);
    await writeFile(join(runDir, 'review.json'), `${JSON.stringify(runFolderShadow)}\n`);
    process.chdir(callerDir);

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      'review.json',
    ]);
    const { result, stderr } = await captureStreams(() =>
      runResumeCommand(args, {
        runtimeExecutors: fixtureExecutors(),
        relayer: fixtureRelayer(),
        now: deterministicNow(Date.UTC(2026, 6, 5)),
      }),
    );

    expect(stderr).not.toContain('error:');
    expect(result).toBe(0);
    const savedResponse = JSON.parse(
      await readFile(join(runDir, 'reports/checkpoints/checkpoint-step-response.json'), 'utf8'),
    ) as { selection: string; comments: Array<{ body: string }> };
    expect(savedResponse.selection).toBe('discard-prototype');
    expect(savedResponse.comments.map((comment) => comment.body)).toEqual([
      'Use the file selected by the caller.',
    ]);
  });

  it('does not fall back to a same-named response file inside the run folder', async () => {
    const callerDir = join(tempDir, 'caller-without-response');
    const runDir = join(tempDir, 'run-folder-shadow');
    await mkdir(callerDir, { recursive: true });
    await createWaitingRun(runDir);
    await writeFile(
      join(runDir, 'review.json'),
      `${JSON.stringify(await validReviewResponse(runDir))}\n`,
    );
    const traceBefore = await readFile(join(runDir, 'trace.ndjson'), 'utf8');
    process.chdir(callerDir);

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      'review.json',
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain(join(callerDir, 'review.json'));
    expect(stderr).not.toContain(join(runDir, 'review.json'));
    await expectCheckpointStillUntouched({ runDir, traceBefore });
  });

  it('rejects a raw response file larger than 64 KiB before accepting its JSON payload', async () => {
    const runDir = join(tempDir, 'oversized-response-file');
    await createWaitingRun(runDir);
    const responsePath = join(tempDir, 'oversized-review.json');
    const validJson = JSON.stringify(await validReviewResponse(runDir));
    const padded = `${validJson}${' '.repeat(65_537 - Buffer.byteLength(validJson, 'utf8'))}`;
    expect(Buffer.byteLength(padded, 'utf8')).toBe(65_537);
    await writeFile(responsePath, padded);
    const traceBefore = await readFile(join(runDir, 'trace.ndjson'), 'utf8');

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toMatch(/(?:64 KiB|65,?536).*bytes|too large/i);
    await expectCheckpointStillUntouched({ runDir, traceBefore });
  });

  it('rejects a response path that is not a regular file', async () => {
    const runDir = join(tempDir, 'non-regular-response-file');
    const responseDirectory = join(tempDir, 'review-directory');
    await createWaitingRun(runDir);
    await mkdir(responseDirectory);
    const traceBefore = await readFile(join(runDir, 'trace.ndjson'), 'utf8');

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responseDirectory,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toMatch(/not a regular file|must be a regular file/i);
    await expectCheckpointStillUntouched({ runDir, traceBefore });
  });

  it('reports safe line and column details for malformed JSON', async () => {
    const runDir = join(tempDir, 'malformed-json-location');
    const responsePath = join(tempDir, 'malformed-location.json');
    await createWaitingRun(runDir);
    await writeFile(responsePath, '{\n  "schema": "checkpoint.review-response@v1",\n}\n');

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain(responsePath);
    expect(stderr).toMatch(/line 3,? column 1/i);
  });

  it('never echoes review content from an invalid JSON parse error', async () => {
    const runDir = join(tempDir, 'malformed-json-secret');
    const responsePath = join(tempDir, 'malformed-secret.json');
    await createWaitingRun(runDir);
    await writeFile(
      responsePath,
      '{\n  "comments": [\n    SECRET_REVIEW_CONTENT_DO_NOT_ECHO\n  ]\n}\n',
    );

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain(responsePath);
    expect(stderr).not.toContain('SECRET');
    expect(stderr).not.toContain('SECRET_REVIEW_CONTENT_DO_NOT_ECHO');
    expect(stderr).not.toContain('SECRET_REVIEW_');
  });

  it('names invalid schema field paths without echoing their values', async () => {
    const runDir = join(tempDir, 'invalid-schema-values');
    const responsePath = join(tempDir, 'invalid-schema.json');
    await createWaitingRun(runDir);
    const invalidResponse = await validReviewResponse(runDir, {
      run_id: 'SECRET_RUN_ID_DO_NOT_ECHO',
      comments: [
        {
          scope: 'choice',
          choice_id: 'keep-prototype',
          body: '',
        },
      ],
    });
    await writeFile(responsePath, `${JSON.stringify(invalidResponse)}\n`);

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain('run_id');
    expect(stderr).toMatch(/comments(?:\[0\]|\.0)\.body/);
    expect(stderr).not.toContain('SECRET_RUN_ID_DO_NOT_ECHO');
    expect(stderr).not.toContain('SECRET_RUN_ID_');
  });

  it.each([
    {
      label: 'another run id',
      override: { run_id: '33333333-3333-4333-8333-333333333303' },
      actionable: /belongs to a different run|run id does not match/i,
    },
    {
      label: 'another checkpoint step',
      override: { step_id: 'another-checkpoint-step' },
      actionable: /different checkpoint step|checkpoint step does not match/i,
    },
    {
      label: 'a stale attempt',
      override: { attempt: 2 },
      actionable: /stale checkpoint attempt|checkpoint attempt does not match/i,
    },
    {
      label: 'a stale request hash',
      override: { request_sha256: 'b'.repeat(64) },
      actionable:
        /stale checkpoint request|checkpoint request (?:has changed|hash does not match)/i,
    },
  ])('explains $label and leaves the parked run untouched', async ({ override, actionable }) => {
    const runDir = join(tempDir, `typed-identity-${Object.keys(override)[0]}`);
    const responsePath = join(tempDir, `typed-identity-${Object.keys(override)[0]}.json`);
    await createWaitingRun(runDir);
    await writeFile(
      responsePath,
      `${JSON.stringify(await validReviewResponse(runDir, override))}\n`,
    );
    const traceBefore = await readFile(join(runDir, 'trace.ndjson'), 'utf8');

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toMatch(actionable);
    expect(stderr).not.toContain('Something about the saved checkpoint prevented it');
    await expectCheckpointStillUntouched({ runDir, traceBefore });
  });

  it('explains a comment for an unavailable choice and leaves the parked run untouched', async () => {
    const runDir = join(tempDir, 'typed-unavailable-comment');
    const responsePath = join(tempDir, 'typed-unavailable-comment.json');
    await createWaitingRun(runDir);
    await writeFile(
      responsePath,
      `${JSON.stringify(
        await validReviewResponse(runDir, {
          comments: [
            {
              scope: 'choice',
              choice_id: 'removed-choice',
              body: 'This note must not be written.',
            },
          ],
        }),
      )}\n`,
    );
    const traceBefore = await readFile(join(runDir, 'trace.ndjson'), 'utf8');

    const args = parseExecutionArgs('resume', [
      '--run-folder',
      runDir,
      '--checkpoint-response-file',
      responsePath,
    ]);
    const { result, stderr } = await captureStreams(() => runResumeCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain('choice that is no longer available');
    expect(stderr).not.toContain('runtime checkpoint');
    expect(stderr).not.toContain('This note must not be written.');
    await expectCheckpointStillUntouched({ runDir, traceBefore });
  });

  it('points a missing folder at the run-id convention and the checkpoints list', async () => {
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
    expect(stderr).toContain('circuit checkpoints');
  });
});

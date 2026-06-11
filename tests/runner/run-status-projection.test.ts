import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectRunStatusFromRunFolder } from '../../src/app/run-status/run-folder-projector.js';
import { main } from '../../src/cli/circuit.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const RECORDED_AT = '2026-04-30T12:00:00.000Z';
const FIX_FLOW_BYTES = readFileSync(resolve('generated/flows/fix/circuit.json'));
const BUILD_FLOW_BYTES = readFileSync(resolve('generated/flows/build/circuit.json'));
const FIX_CHECKPOINT_REQUEST_PATH = 'reports/checkpoints/fix-no-repro-decision-request.json';

const change_kind = {
  change_kind: 'discovery' as const,
  failure_mode: 'status projection test fixture',
  acceptance_evidence: 'semantic projection assertions pass',
  alternate_framing: 'hand-authored run folder fixture',
};

function tempRunFolder(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  const runFolder = join(root, 'run');
  mkdirSync(runFolder, { recursive: true });
  return runFolder;
}

function writeManifest(input: {
  readonly runFolder: string;
  readonly runId?: string;
  readonly flowId?: string;
  readonly bytes?: Buffer;
}): string {
  const manifest = writeManifestSnapshot(input.runFolder, {
    run_id: RunId.parse(input.runId ?? RUN_ID),
    flow_id: CompiledFlowId.parse(input.flowId ?? 'fix'),
    captured_at: RECORDED_AT,
    bytes: input.bytes ?? FIX_FLOW_BYTES,
  });
  return manifest.hash;
}

function bootstrap(input: {
  readonly runId?: string;
  readonly flowId?: string;
  readonly manifestHash: string;
  readonly goal?: string;
}): unknown {
  return {
    schema_version: 1,
    sequence: 0,
    recorded_at: RECORDED_AT,
    run_id: input.runId ?? RUN_ID,
    kind: 'run.bootstrapped',
    flow_id: input.flowId ?? 'fix',
    depth: 'medium',
    goal: input.goal ?? 'Fix the checkout bug',
    change_kind,
    manifest_hash: input.manifestHash,
  };
}

function writeRawTrace(runFolder: string, entries: readonly unknown[]): void {
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function unrecognizedBootstrap(input: {
  readonly runId?: string;
  readonly flowId?: string;
  readonly manifestHash: string;
  readonly goal?: string;
  readonly engine?: string;
}): Record<string, unknown> {
  return {
    sequence: 0,
    recorded_at: RECORDED_AT,
    run_id: input.runId ?? RUN_ID,
    kind: 'run.bootstrapped',
    engine: input.engine ?? 'runtime',
    flow_id: input.flowId ?? 'fix',
    depth: 'medium',
    goal: input.goal ?? 'Fix the checkout bug',
    manifest_hash: input.manifestHash,
  };
}

function stepEntered(sequence: number, stepId: string, attempt = 1): unknown {
  return {
    schema_version: 1,
    sequence,
    recorded_at: RECORDED_AT,
    run_id: RUN_ID,
    kind: 'step.entered',
    step_id: stepId,
    attempt,
  };
}

function unrecognizedStepEntered(
  sequence: number,
  stepId: string,
  attempt = 1,
): Record<string, unknown> {
  return {
    sequence,
    recorded_at: RECORDED_AT,
    run_id: RUN_ID,
    kind: 'step.entered',
    step_id: stepId,
    attempt,
  };
}

function unrecognizedRunClosed(sequence: number, outcome: string): Record<string, unknown> {
  return {
    sequence,
    recorded_at: RECORDED_AT,
    run_id: RUN_ID,
    kind: 'run.closed',
    outcome,
  };
}

function runClosed(sequence: number, outcome: string): unknown {
  return {
    schema_version: 1,
    sequence,
    recorded_at: RECORDED_AT,
    run_id: RUN_ID,
    kind: 'run.closed',
    outcome,
  };
}

function writeResultPlaceholder(runFolder: string): void {
  const path = join(runFolder, 'reports', 'result.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{}\n');
}

function writeCheckpointRequest(input: {
  readonly runFolder: string;
  readonly allowedChoices?: readonly string[];
  readonly stepId?: string;
  readonly corruptJson?: boolean;
}): string {
  const requestPath = join(input.runFolder, FIX_CHECKPOINT_REQUEST_PATH);
  mkdirSync(dirname(requestPath), { recursive: true });
  const text =
    input.corruptJson === true
      ? '{not-json'
      : `${JSON.stringify(
          {
            schema_version: 1,
            step_id: input.stepId ?? 'fix-no-repro-decision',
            prompt: 'Diagnosis did not cleanly reproduce the bug. Choose how to proceed.',
            allowed_choices: input.allowedChoices ?? ['continue'],
            execution_context: {
              selection_config_layers: [],
            },
          },
          null,
          2,
        )}\n`;
  writeFileSync(requestPath, text);
  return sha256Hex(text);
}

function expectInvalidTraceProjection(projection: unknown): void {
  expect(projection).toMatchObject({
    api_version: 'run-status-v1',
    engine_state: 'invalid',
    reason: 'trace_invalid',
    legal_next_actions: ['none'],
    error: {
      code: 'trace_bootstrap_invalid',
      message: 'trace is missing or invalid for this run folder',
    },
  });
}

function expectInvalidManifestProjection(projection: unknown): void {
  expect(projection).toMatchObject({
    api_version: 'run-status-v1',
    engine_state: 'invalid',
    reason: 'manifest_invalid',
    legal_next_actions: ['none'],
    error: {
      code: 'manifest_invalid',
    },
  });
}

async function captureMain(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const { result, stdout, stderr } = await captureStreams(() => main(argv));
  return { code: result, stdout, stderr };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('run folder status projection', () => {
  it('fails closed for completed unrecognized run folders', () => {
    const runFolder = tempRunFolder('circuit-run-status-complete-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'fix-close'),
      unrecognizedRunClosed(2, 'complete'),
    ]);
    writeResultPlaceholder(runFolder);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
    expect(projection).not.toHaveProperty('current_step');
  });

  it('fails closed for aborted unrecognized run folders', () => {
    const runFolder = tempRunFolder('circuit-run-status-aborted-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'fix-act'),
      unrecognizedRunClosed(2, 'aborted'),
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
    expect(projection).not.toHaveProperty('current_step');
  });

  it.each(['handoff', 'stopped', 'escalated'] as const)(
    'fails closed for %s unrecognized run folders',
    (outcome) => {
      const runFolder = tempRunFolder(`circuit-run-status-${outcome}-`);
      const manifestHash = writeManifest({ runFolder });
      writeRawTrace(runFolder, [
        unrecognizedBootstrap({ manifestHash }),
        unrecognizedRunClosed(1, outcome),
      ]);

      const projection = projectRunStatusFromRunFolder(runFolder);

      expectInvalidTraceProjection(projection);
    },
  );

  it('fails closed for waiting invalid checkpoints instead of adapting them', () => {
    const runFolder = tempRunFolder('circuit-run-status-checkpoint-');
    const manifestHash = writeManifest({ runFolder });
    const requestHash = writeCheckpointRequest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'fix-no-repro-decision'),
      {
        sequence: 2,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'checkpoint.requested',
        step_id: 'fix-no-repro-decision',
        attempt: 1,
        allowed_choices: ['continue'],
        request_path: FIX_CHECKPOINT_REQUEST_PATH,
        request_report_hash: requestHash,
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
    expect(projection).not.toHaveProperty('checkpoint');
  });

  it('fails closed before validating invalid checkpoint request files', () => {
    const runFolder = tempRunFolder('circuit-run-status-bad-checkpoint-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'fix-no-repro-decision'),
      {
        sequence: 2,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'checkpoint.requested',
        step_id: 'fix-no-repro-decision',
        attempt: 1,
        allowed_choices: ['continue'],
        request_path: FIX_CHECKPOINT_REQUEST_PATH,
        request_report_hash: '0'.repeat(64),
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('fails closed for open unrecognized run folders', () => {
    const runFolder = tempRunFolder('circuit-run-status-open-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'fix-gather-context'),
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
    expect(projection).not.toHaveProperty('current_step');
  });

  it('fails closed before reading saved current-step labels', () => {
    const runFolder = tempRunFolder('circuit-run-status-flow-mismatch-open-');
    const manifestHash = writeManifest({ runFolder, bytes: BUILD_FLOW_BYTES });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'frame-step'),
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('fails closed before adapting invalid checkpoint identity mismatches', () => {
    const runFolder = tempRunFolder('circuit-run-status-flow-mismatch-checkpoint-');
    const manifestHash = writeManifest({ runFolder, bytes: BUILD_FLOW_BYTES });
    const requestHash = writeCheckpointRequest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedStepEntered(1, 'fix-no-repro-decision'),
      {
        sequence: 2,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'checkpoint.requested',
        step_id: 'fix-no-repro-decision',
        attempt: 1,
        allowed_choices: ['continue'],
        request_path: FIX_CHECKPOINT_REQUEST_PATH,
        request_report_hash: requestHash,
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('fails closed for invalid folders with corrupt traces', () => {
    const runFolder = tempRunFolder('circuit-run-status-corrupt-trace-');
    writeManifest({ runFolder });
    writeFileSync(join(runFolder, 'trace.ndjson'), '{not-json\n');

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
    expect(projection).not.toHaveProperty('goal');
  });

  it('returns invalid manifest projections without requiring trace metadata', () => {
    const runFolder = tempRunFolder('circuit-run-status-missing-manifest-');

    const projection = projectRunStatusFromRunFolder(runFolder);

    expect(projection).toMatchObject({
      engine_state: 'invalid',
      reason: 'manifest_invalid',
      legal_next_actions: ['none'],
    });
    expect(projection).not.toHaveProperty('goal');
    expect(projection).not.toHaveProperty('run_id');
  });

  it('fails closed for trace-only folders before manifest validation', () => {
    const runFolder = tempRunFolder('circuit-run-status-trace-only-');
    writeRawTrace(runFolder, [
      {
        schema_version: 1,
        sequence: 0,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'run.bootstrapped',
        flow_id: 'fix',
        depth: 'medium',
        goal: 'Resume a invalid trace-only folder',
        change_kind,
        manifest_hash: 'invalid-manifest-hash',
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidManifestProjection(projection);
  });

  it('fails closed for run.started trace-only folders before manifest validation', () => {
    const runFolder = tempRunFolder('circuit-run-status-started-trace-only-');
    writeRawTrace(runFolder, [
      {
        schema_version: 1,
        kind: 'run.started',
        flow_id: 'build',
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidManifestProjection(projection);
  });

  it('fails closed before adapting saved identity mismatches', () => {
    const runFolder = tempRunFolder('circuit-run-status-identity-mismatch-');
    const manifestHash = writeManifest({ runFolder, runId: RUN_ID });
    writeRawTrace(runFolder, [unrecognizedBootstrap({ runId: OTHER_RUN_ID, manifestHash })]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('projects marked runtime open runs with retry-aware current step attempts', () => {
    const runFolder = tempRunFolder('circuit-run-status-runtime-retry-open-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      bootstrap({ manifestHash }),
      stepEntered(1, 'fix-act', 1),
      {
        schema_version: 1,
        sequence: 2,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'step.completed',
        step_id: 'fix-act',
        attempt: 1,
        route_taken: 'retry',
      },
      stepEntered(3, 'fix-act', 2),
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expect(projection).toMatchObject({
      engine_state: 'open',
      reason: 'active_or_unknown',
      current_step: {
        step_id: 'fix-act',
        attempt: 2,
      },
    });
    expect(projection.engine_state === 'open' && projection.current_step?.label).toContain(
      'apply focused fix',
    );
  });

  it('fails closed when a current runtime trace has a sequence gap', () => {
    const runFolder = tempRunFolder('circuit-run-status-sequence-gap-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [bootstrap({ manifestHash }), stepEntered(2, 'fix-act')]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('fails closed when a current runtime trace has entries after run.closed', () => {
    const runFolder = tempRunFolder('circuit-run-status-after-close-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      bootstrap({ manifestHash }),
      runClosed(1, 'complete'),
      stepEntered(2, 'fix-act'),
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('fails closed when a current runtime terminal entry is malformed', () => {
    const runFolder = tempRunFolder('circuit-run-status-malformed-terminal-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      bootstrap({ manifestHash }),
      {
        schema_version: 1,
        sequence: 1,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'run.closed',
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });

  it('fails closed for malformed unrecognized traces without treating them as runtime', () => {
    const runFolder = tempRunFolder('circuit-run-status-v1-missing-schema-version-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      {
        sequence: 0,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'run.bootstrapped',
        flow_id: 'fix',
        depth: 'medium',
        goal: 'Fix the checkout bug',
        change_kind,
        manifest_hash: manifestHash,
      },
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
    expect(projection).not.toHaveProperty('goal');
  });

  it('returns identity mismatch when a marked runtime trace disagrees with its manifest', () => {
    const runFolder = tempRunFolder('circuit-run-status-runtime-identity-mismatch-');
    writeManifest({ runFolder, runId: RUN_ID });
    writeRawTrace(runFolder, [bootstrap({ manifestHash: '0'.repeat(64) })]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expect(projection).toMatchObject({
      engine_state: 'invalid',
      reason: 'identity_mismatch',
      legal_next_actions: ['none'],
      run_id: RUN_ID,
      flow_id: 'fix',
    });
  });

  it('fails closed for unrecognized runs even when compiled-flow bytes cannot be parsed', () => {
    const runFolder = tempRunFolder('circuit-run-status-bad-flow-bytes-');
    const badBytes = Buffer.from('not json');
    const manifestHash = writeManifest({ runFolder, bytes: badBytes });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedRunClosed(1, 'complete'),
    ]);

    const projection = projectRunStatusFromRunFolder(runFolder);

    expectInvalidTraceProjection(projection);
  });
});

describe('runs show CLI', () => {
  it('prints a unsupported runtime projection for unrecognized run folders', async () => {
    const runFolder = tempRunFolder('circuit-runs-show-valid-');
    const manifestHash = writeManifest({ runFolder });
    writeRawTrace(runFolder, [
      unrecognizedBootstrap({ manifestHash }),
      unrecognizedRunClosed(1, 'complete'),
    ]);

    const result = await captureMain(['runs', 'show', '--run-folder', runFolder, '--json']);

    expect(result.code, result.stderr).toBe(0);
    expectInvalidTraceProjection(JSON.parse(result.stdout));
  });

  it('prints invalid projections with exit 0 for existing broken run folders', async () => {
    const runFolder = tempRunFolder('circuit-runs-show-invalid-');

    const result = await captureMain(['runs', 'show', '--run-folder', runFolder, '--json']);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      api_version: 'run-status-v1',
      engine_state: 'invalid',
      reason: 'manifest_invalid',
    });
  });

  it('prints the unsupported runtime projection for run.started trace-only folders', async () => {
    const runFolder = tempRunFolder('circuit-runs-show-started-trace-only-');
    writeRawTrace(runFolder, [
      {
        schema_version: 1,
        kind: 'run.started',
        flow_id: 'build',
      },
    ]);

    const result = await captureMain(['runs', 'show', '--run-folder', runFolder, '--json']);

    expect(result.code, result.stderr).toBe(0);
    expectInvalidManifestProjection(JSON.parse(result.stdout));
  });

  it('prints engine errors with exit 1 for missing folders', async () => {
    const runFolder = join(tempRunFolder('circuit-runs-show-missing-'), 'missing');

    const result = await captureMain(['runs', 'show', '--run-folder', runFolder, '--json']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      api_version: 'engine-error-v1',
      error: { code: 'folder_not_found' },
    });
  });

  it('requires --json and bypasses the normal flow parser', async () => {
    const runFolder = tempRunFolder('circuit-runs-show-no-json-');

    const result = await captureMain(['runs', 'show', '--run-folder', runFolder]);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      api_version: 'engine-error-v1',
      error: { code: 'invalid_invocation' },
    });
  });

  it('accepts equals-form option syntax through Commander', async () => {
    const runFolder = tempRunFolder('circuit-runs-show-equals-');

    const result = await captureMain(['runs', 'show', `--run-folder=${runFolder}`, '--json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      api_version: 'run-status-v1',
      engine_state: 'invalid',
    });
  });
});

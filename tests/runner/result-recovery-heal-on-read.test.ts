import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { healClosedRunResult } from '../../src/app/run-status/projection-common.js';
import { projectRunStatusFromRunFolder } from '../../src/app/run-status/run-folder-projector.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import { runResultPath } from '../../src/shared/result-path.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

// M13 (heal-on-read): a crash between the run.closed trace append and the
// result.json write leaves a durably-closed run with no result.json.
// regenerateMissingRunResult can rebuild it from the trace, but nothing called
// it, so the status projection just silently omitted result_path and the
// designed remedy never ran. healClosedRunResult wires that healer into the
// read path so a status read self-repairs the crash window. These tests prove
// the heal fires on the crash window and stays a no-op on healthy runs.

const RUNTIME_FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');
const FIX_FIXTURE_PATH = resolve('generated/flows/fix/circuit.json');

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"heal-on-read fixture"}\n', 'utf8');
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          ...attempt,
          report_path: report.path,
          report_schema: report.schema ?? 'runtime.compose',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        ...attempt,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

// Drive a real flow to a durable close: writes a manifest snapshot, a trace
// ending in run.closed, and result.json — the exact on-disk shape a genuine
// closed run has.
async function driveClosedRun(runFolder: string): Promise<void> {
  await runCompiledFlow({
    runDir: runFolder,
    flowBytes: readFileSync(RUNTIME_FIXTURE_PATH),
    runId: '22222222-2222-2222-2222-222222222222',
    goal: 'prove heal-on-read rebuilds a crash-window result',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 5, 15, 12, 0, 0)),
    relayer: makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt-heal' }),
    executors: composeExecutor(),
  });
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-heal-on-read-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('heal-on-read: status projection self-repairs a crash-window missing result', () => {
  it('rebuilds result.json from the trace and projects result_path (was silently omitted)', async () => {
    const runFolder = join(base, 'run');
    await driveClosedRun(runFolder);

    // Simulate the crash-after-close window: durably closed in the trace, but
    // result.json never landed.
    rmSync(runResultPath(runFolder));
    expect(existsSync(runResultPath(runFolder))).toBe(false);

    // The current (unhealed) read is honest about being closed but silently
    // omits result_path — exactly the operator-visible gap the finding names.
    const before = projectRunStatusFromRunFolder(runFolder);
    expect(before.engine_state).toBe('completed');
    expect(before).not.toHaveProperty('result_path');

    // Heal-on-read rebuilds the result from the durable trace...
    const outcome = await healClosedRunResult(runFolder);
    expect(outcome?.regenerated).toBe(true);
    expect(existsSync(runResultPath(runFolder))).toBe(true);

    // ...and the very next projection now surfaces result_path.
    const after = projectRunStatusFromRunFolder(runFolder);
    expect(after.engine_state).toBe('completed');
    expect(after).toHaveProperty('result_path', runResultPath(runFolder));
  });

  it('is a no-op when result.json already exists (no spurious regeneration)', async () => {
    const runFolder = join(base, 'run-present');
    await driveClosedRun(runFolder);
    expect(existsSync(runResultPath(runFolder))).toBe(true);
    const originalBytes = readFileSync(runResultPath(runFolder));

    const outcome = await healClosedRunResult(runFolder);
    expect(outcome).toEqual({ regenerated: false, reason: 'result-present' });
    // The existing result is left byte-for-byte untouched.
    expect(readFileSync(runResultPath(runFolder)).equals(originalBytes)).toBe(true);

    const projection = projectRunStatusFromRunFolder(runFolder);
    expect(projection).toHaveProperty('result_path', runResultPath(runFolder));
  });

  it('does not heal (forward-recover) an open, not-closed run', async () => {
    // A run that bootstrapped but never closed. A valid manifest snapshot and a
    // recognized runtime bootstrap make it projectable as an open run; heal must
    // not invent a result for it.
    const runFolder = join(base, 'run-open');
    mkdirSync(runFolder, { recursive: true });
    const RUN_ID = '11111111-1111-4111-8111-111111111111';
    const RECORDED_AT = '2026-04-30T12:00:00.000Z';
    const manifest = writeManifestSnapshot(runFolder, {
      run_id: RunId.parse(RUN_ID),
      flow_id: CompiledFlowId.parse('fix'),
      captured_at: RECORDED_AT,
      bytes: readFileSync(FIX_FIXTURE_PATH),
    });
    const entries: readonly unknown[] = [
      {
        schema_version: 1,
        sequence: 0,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'run.bootstrapped',
        flow_id: 'fix',
        depth: 'medium',
        goal: 'an open run that never closed',
        change_kind: {
          change_kind: 'discovery',
          failure_mode: 'heal-on-read open fixture',
          acceptance_evidence: 'no run.closed present',
          alternate_framing: 'use a closed fixture',
        },
        manifest_hash: manifest.hash,
      },
      {
        schema_version: 1,
        sequence: 1,
        recorded_at: RECORDED_AT,
        run_id: RUN_ID,
        kind: 'step.entered',
        step_id: 'fix-act',
        attempt: 1,
      },
    ];
    writeFileSync(
      join(runFolder, 'trace.ndjson'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );

    const outcome = await healClosedRunResult(runFolder);
    expect(outcome).toEqual({ regenerated: false, reason: 'not-closed' });
    expect(existsSync(runResultPath(runFolder))).toBe(false);

    const projection = projectRunStatusFromRunFolder(runFolder);
    expect(projection.engine_state).toBe('open');
    expect(projection).not.toHaveProperty('result_path');
  });
});

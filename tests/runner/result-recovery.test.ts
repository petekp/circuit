import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { regenerateMissingRunResult } from '../../src/runtime/run/result-recovery.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';
import { runResultPath } from '../../src/shared/result-path.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

// Durability Tier-1, Fix 3 (audit finding 4): a crash between the run.closed
// trace append and the result.json write leaves a closed run with no result.
// regenerateMissingRunResult rebuilds result.json from the durable trace. The
// gold-standard proof: a real run's result, deleted, regenerates to the same
// load-bearing values closeRun originally wrote.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"result-recovery fixture"}\n', 'utf8');
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

async function driveClosedRun(runFolder: string): Promise<void> {
  await runCompiledFlow({
    runDir: runFolder,
    flowBytes: readFileSync(FIXTURE_PATH),
    runId: '22222222-2222-2222-2222-222222222222',
    goal: 'prove result.json regenerates from a closed trace',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 5, 15, 12, 0, 0)),
    relayer: makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt-recovery' }),
    executors: composeExecutor(),
  });
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-result-recovery-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('result.json regeneration from a closed trace (Fix 3)', () => {
  it('regenerates a deleted result.json to the same load-bearing values', async () => {
    const runFolder = join(base, 'run');
    await driveClosedRun(runFolder);

    const original = JSON.parse(readFileSync(runResultPath(runFolder), 'utf8'));
    expect(original.outcome).toBe('complete');

    // Simulate the crash-after-close window: the run is closed in the trace,
    // but result.json never landed.
    rmSync(runResultPath(runFolder));
    expect(existsSync(runResultPath(runFolder))).toBe(false);

    const outcome = await regenerateMissingRunResult(runFolder);
    expect(outcome.regenerated).toBe(true);

    const regen = JSON.parse(readFileSync(runResultPath(runFolder), 'utf8'));
    // A regenerated result is a valid result.json.
    expect(() => RunResult.parse(regen)).not.toThrow();

    // The durable close timestamp is the run.closed trace entry's recorded_at.
    const entries = await new TraceStore(runFolder).load();
    const closed = entries.find((e) => e.kind === 'run.closed');
    expect(regen.closed_at).toBe(closed?.recorded_at);
    expect(regen.trace_entries_observed).toBe(entries.length);

    // Every identity / outcome field matches what closeRun originally wrote.
    for (const field of [
      'schema_version',
      'run_id',
      'flow_id',
      'goal',
      'outcome',
      'manifest_hash',
      'verdict',
    ] as const) {
      expect(regen[field]).toEqual(original[field]);
    }
    // Summary uses the outcome-only form (terminal target is not durable).
    expect(regen.summary).toBe(`Run closed with outcome ${original.outcome}.`);
  });

  it('is a no-op when result.json is already present', async () => {
    const runFolder = join(base, 'run-present');
    await driveClosedRun(runFolder);
    expect(existsSync(runResultPath(runFolder))).toBe(true);

    const outcome = await regenerateMissingRunResult(runFolder);
    expect(outcome).toEqual({ regenerated: false, reason: 'result-present' });
  });

  it('is a no-op (does not forward-recover) when the run is not closed', async () => {
    // A run that bootstrapped but never closed: regeneration must not invent a
    // result. Hand-build a minimal open trace (no run.closed).
    const runFolder = join(base, 'run-open');
    mkdirSync(runFolder, { recursive: true });
    const open = new TraceStore(runFolder, { now: deterministicNow(Date.UTC(2026, 5, 15, 12)) });
    await open.append({
      run_id: '33333333-3333-3333-3333-333333333333',
      kind: 'run.bootstrapped',
      flow_id: 'runtime-proof',
      goal: 'an open run',
      depth: 'medium',
      change_kind: {
        change_kind: 'ratchet-advance',
        failure_mode: 'open-run fixture failed',
        acceptance_evidence: 'bootstrap without close',
        alternate_framing: 'use a smaller fixture',
      },
      manifest_hash: 'deadbeef',
    });
    await open.append({
      run_id: '33333333-3333-3333-3333-333333333333',
      kind: 'step.entered',
      step_id: 'frame',
      attempt: 1,
    });

    const outcome = await regenerateMissingRunResult(runFolder);
    expect(outcome).toEqual({ regenerated: false, reason: 'not-closed' });
    expect(existsSync(runResultPath(runFolder))).toBe(false);
  });
});

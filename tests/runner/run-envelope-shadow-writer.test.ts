import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RUN_ENVELOPE_SHADOW_RELATIVE_PATH,
  writeRunEnvelopeShadowRecord,
} from '../../src/app/run-envelope/shadow-record.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { RunEnvelopeShadowRecord } from '../../src/schemas/run-envelope.js';

let tempDir: string;

const runId = '00000000-0000-4000-8000-00000000f001';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-run-envelope-shadow-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('Run envelope shadow writer', () => {
  it('writes an observation-only shadow record for a closed child run', () => {
    const runFolder = join(tempDir, 'closed');
    const resultPath = join(runFolder, 'reports/result.json');
    writeJson(resultPath, {
      schema_version: 1,
      run_id: runId,
      flow_id: 'build',
      goal: 'Build the thing.',
      outcome: 'complete',
      summary: 'Run closed complete.',
      closed_at: '2026-05-28T05:00:00.000Z',
      trace_entries_observed: 8,
      manifest_hash: 'runtime:build@0.1.0',
    });

    const written = writeRunEnvelopeShadowRecord({
      runFolder,
      operatorIntent: 'Build the thing.',
      selectedProcess: {
        process_id: 'build',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      child: {
        kind: 'closed',
        runResult: {
          schema_version: 1,
          run_id: RunId.parse(runId),
          flow_id: CompiledFlowId.parse('build'),
          goal: 'Build the thing.',
          outcome: 'complete',
          summary: 'Run closed complete.',
          closed_at: '2026-05-28T05:00:00.000Z',
          trace_entries_observed: 8,
          manifest_hash: 'runtime:build@0.1.0',
        },
        resultPath,
      },
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    expect(written.path).toBe(join(runFolder, RUN_ENVELOPE_SHADOW_RELATIVE_PATH));
    const record = RunEnvelopeShadowRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record).toMatchObject({
      schema: 'run.envelope-shadow@v0',
      mode: 'shadow',
      shadow_reason: 'source-owned-run-not-active',
      child_run: {
        outcome: 'complete',
        result_ref: {
          source: 'child_result',
          ref: { kind: 'report', ref: 'reports/result.json' },
        },
      },
    });
    expect(record).not.toHaveProperty('completion_gate');
  });

  it('writes a checkpoint-waiting shadow record without a result ref', () => {
    const runFolder = join(tempDir, 'waiting');
    const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');
    writeJson(requestPath, {
      schema: 'checkpoint.request@v1',
      prompt: 'Continue?',
    });

    const written = writeRunEnvelopeShadowRecord({
      runFolder,
      operatorIntent: 'Build the thing.',
      selectedProcess: {
        process_id: 'build',
        routed_by: 'explicit',
        router_reason: 'matched build signal',
        entry_mode: 'default',
      },
      child: {
        kind: 'checkpoint_waiting',
        run_id: runId,
        flow_id: 'build',
        trace_entries_observed: 5,
        manifest_hash: 'runtime:build@0.1.0',
        checkpoint: {
          step_id: 'frame-step',
          request_path: requestPath,
          allowed_choices: ['continue', 'stop'],
        },
      },
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeShadowRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.child_run.outcome).toBe('checkpoint_waiting');
    expect(record.child_run.result_ref).toBeUndefined();
    expect(record.child_run.checkpoint).toMatchObject({
      step_id: 'frame-step',
      allowed_choices: ['continue', 'stop'],
    });
  });
});

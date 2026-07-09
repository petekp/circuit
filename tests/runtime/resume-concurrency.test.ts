import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCheckpointResumeRejectedResult,
  resumeCompiledFlowResult,
} from '../../src/runtime/run/checkpoint-resume.js';
import { resumeLockPath } from '../../src/runtime/run/resume-lock.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { computeManifestHash } from '../../src/schemas/manifest.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

// H5 — resume had no cross-process guard. Two concurrent resumes both loaded the
// same trace, computed the same nextSequence, and both appended entries stamped
// with it; the duplicate sequence bricks every later load() forever. This test
// pins the guard at the real resume entrypoint: with a live lock present a second
// resume must refuse in plain English and leave the trace untouched.

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const FLOW_ID = 'runtime-proof';
const MANIFEST_HASH = computeManifestHash(Buffer.from('resume concurrency manifest bytes'));

let runDir: string;
const tracePath = () => join(runDir, 'trace.ndjson');

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'circuit-resume-concurrency-'));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

async function seedValidTrace(): Promise<void> {
  const trace = new TraceStore(runDir, { now: deterministicNow(Date.UTC(2026, 6, 9, 12, 0, 0)) });
  await trace.append({
    run_id: RUN_ID,
    kind: 'run.bootstrapped',
    flow_id: FLOW_ID,
    goal: 'resume concurrency guard',
    depth: 'medium',
    change_kind: {
      change_kind: 'ratchet-advance',
      failure_mode: 'concurrent resume bricked the trace',
      acceptance_evidence: 'second resume refuses and the trace is unchanged',
      alternate_framing: 'lock at the CLI instead of the entrypoint',
    },
    manifest_hash: MANIFEST_HASH,
  });
  await trace.append({ run_id: RUN_ID, kind: 'step.entered', step_id: 'frame', attempt: 1 });
}

function holdLiveLock(): void {
  // Simulate a first resume already in progress in THIS (live) process.
  writeFileSync(
    resumeLockPath(runDir),
    JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      acquired_at: '2026-07-09T00:00:00.000Z',
    }),
    'utf8',
  );
}

describe('concurrent resume guard (H5)', () => {
  it('refuses a second resume while one is in progress and leaves the trace intact', async () => {
    await seedValidTrace();
    const before = readFileSync(tracePath(), 'utf8');
    holdLiveLock();

    const result = await resumeCompiledFlowResult({ runDir, selection: 'continue' });

    // Refused in plain English (no jargon, tells the operator another resume runs).
    expect(isCheckpointResumeRejectedResult(result)).toBe(true);
    if (!isCheckpointResumeRejectedResult(result)) throw new Error('unreachable');
    expect(result.reason.toLowerCase()).toContain('another resume is already running');

    // No duplicate-sequence entry was appended: the trace bytes are unchanged.
    expect(readFileSync(tracePath(), 'utf8')).toBe(before);

    // Integrity preserved: the durable trace still loads (not bricked).
    const reloaded = await new TraceStore(runDir).load();
    expect(reloaded.map((e) => e.sequence)).toEqual([0, 1]);
  });
});

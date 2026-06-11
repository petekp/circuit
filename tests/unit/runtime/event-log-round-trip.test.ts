import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../../helpers/runtime-fixtures.js';

import {
  readRuntimeCompiledFlowManifestSnapshot,
  readRuntimeManifestSnapshot,
  runtimeManifestSnapshotPath,
  writeRuntimeManifestSnapshot,
} from '../../../src/runtime/run/manifest-snapshot.js';
import { TraceStore } from '../../../src/runtime/trace/trace-store.js';
import { ManifestSnapshot, computeManifestHash } from '../../../src/schemas/manifest.js';

// runtime trace.ndjson append/load and manifest.snapshot.json byte-match tests.
// The unsupported runtime's reducer-derived state.json is intentionally not part
// of this contract.

const MANIFEST_BODY = readFileSync(resolve('generated/flows/runtime-proof/circuit.json'));
const RUN_ID = '11111111-2222-3333-4444-555555555555';
const FLOW_ID = 'runtime-proof';
const change_kind = {
  change_kind: 'ratchet-advance' as const,
  failure_mode: 'trace store test fixture failed',
  acceptance_evidence: 'trace entries append and reload with contiguous sequence numbers',
  alternate_framing: 'use a smaller direct trace-store fixture',
};

function baseRecordedAt(step: number): string {
  const base = Date.UTC(2026, 3, 20, 12, 0, 0);
  return new Date(base + step * 1000).toISOString();
}

async function writeBootstrap(trace: TraceStore) {
  return await trace.append({
    run_id: RUN_ID,
    kind: 'run.bootstrapped',
    flow_id: FLOW_ID,
    goal: 'prove circuit can close one run',
    depth: 'medium',
    change_kind,
    manifest_hash: computeManifestHash(MANIFEST_BODY),
  });
}

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-runtime-event-log-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

describe('runtime trace.ndjson and manifest snapshot round-trip', () => {
  it('appends trace.ndjson with contiguous sequences and reloads the same entries', async () => {
    const trace = new TraceStore(runFolder, {
      now: deterministicNow(Date.UTC(2026, 3, 20, 12, 0, 0)),
    });
    const boot = await writeBootstrap(trace);
    const step = await trace.append({
      run_id: RUN_ID,
      kind: 'step.entered',
      step_id: 'frame',
      attempt: 1,
    });

    expect(boot.sequence).toBe(0);
    expect(step.sequence).toBe(1);
    expect(boot.recorded_at).toBe(baseRecordedAt(0));
    expect(step.recorded_at).toBe(baseRecordedAt(1));

    const logText = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8');
    expect(logText.endsWith('\n')).toBe(true);
    expect(logText.split('\n').filter(Boolean)).toHaveLength(2);

    const reloaded = await new TraceStore(runFolder).load();
    expect(reloaded.map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(reloaded[0]).toMatchObject({
      run_id: RUN_ID,
      kind: 'run.bootstrapped',
      flow_id: FLOW_ID,
    });
    expect(reloaded[1]).toMatchObject({
      run_id: RUN_ID,
      kind: 'step.entered',
      step_id: 'frame',
    });
  });

  it('serializes concurrent appends through one sequence authority', async () => {
    const trace = new TraceStore(runFolder);
    const entries = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        trace.append({
          run_id: RUN_ID,
          kind: 'step.entered',
          step_id: `parallel-${index}`,
          attempt: 1,
        }),
      ),
    );

    expect(entries.map((entry) => entry.sequence).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    const reloaded = await new TraceStore(runFolder).load();
    expect(reloaded.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('rejects appending after run.closed, including after reload', async () => {
    const trace = new TraceStore(runFolder);
    await writeBootstrap(trace);
    await trace.append({
      run_id: RUN_ID,
      kind: 'run.closed',
      outcome: 'complete',
    });

    await expect(
      trace.append({ run_id: RUN_ID, kind: 'step.completed', step_id: 'frame', attempt: 1 }),
    ).rejects.toThrow('cannot append trace entry after run close');

    const reloaded = new TraceStore(runFolder);
    await reloaded.load();
    await expect(
      reloaded.append({ run_id: RUN_ID, kind: 'step.completed', step_id: 'frame', attempt: 1 }),
    ).rejects.toThrow('cannot append trace entry after run close');
  });

  it('rejects a tampered trace log with a sequence gap', async () => {
    const trace = new TraceStore(runFolder);
    await writeBootstrap(trace);
    await trace.append({ run_id: RUN_ID, kind: 'step.entered', step_id: 'frame', attempt: 1 });
    await trace.append({ run_id: RUN_ID, kind: 'run.closed', outcome: 'complete' });

    const lines = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8').split('\n').filter(Boolean);
    const first = lines[0];
    const closed = lines[2];
    if (first === undefined || closed === undefined) {
      throw new Error('expected bootstrap and closed trace entries');
    }
    writeFileSync(join(runFolder, 'trace.ndjson'), `${[first, closed].join('\n')}\n`);

    await expect(new TraceStore(runFolder).load()).rejects.toThrow(/trace sequence mismatch/);
  });

  it('rejects trace entries after run.closed', async () => {
    const closed = {
      schema_version: 1,
      sequence: 0,
      recorded_at: baseRecordedAt(0),
      run_id: RUN_ID,
      kind: 'run.closed',
      outcome: 'complete',
    };
    const late = {
      schema_version: 1,
      sequence: 1,
      recorded_at: baseRecordedAt(1),
      run_id: RUN_ID,
      kind: 'step.entered',
      step_id: 'late',
      attempt: 1,
    };
    writeFileSync(
      join(runFolder, 'trace.ndjson'),
      `${JSON.stringify(closed)}\n${JSON.stringify(late)}\n`,
    );

    await expect(new TraceStore(runFolder).load()).rejects.toThrow(/after run\.closed/);
  });

  it('writes a runtime manifest snapshot whose bytes hash matches the fixture bytes', async () => {
    const manifestHash = computeManifestHash(MANIFEST_BODY);
    const snapshot = await writeRuntimeManifestSnapshot({
      runDir: runFolder,
      runId: RUN_ID,
      flowId: FLOW_ID,
      capturedAt: baseRecordedAt(0),
      bytes: MANIFEST_BODY,
    });

    expect(existsSync(runtimeManifestSnapshotPath(runFolder))).toBe(true);
    expect(snapshot.algorithm).toBe('sha256-raw');
    expect(snapshot.hash).toBe(manifestHash);

    const parsed = ManifestSnapshot.parse(
      JSON.parse(readFileSync(runtimeManifestSnapshotPath(runFolder), 'utf8')),
    );
    expect(parsed).toEqual(snapshot);
    expect(await readRuntimeManifestSnapshot(runFolder)).toEqual(snapshot);
  });

  it('round-trips manifest bytes through the compiled-flow manifest reader', async () => {
    const manifestHash = computeManifestHash(MANIFEST_BODY);
    await writeRuntimeManifestSnapshot({
      runDir: runFolder,
      runId: RUN_ID,
      flowId: FLOW_ID,
      capturedAt: baseRecordedAt(0),
      bytes: MANIFEST_BODY,
    });

    const { snapshot, flowBytes, flow } = await readRuntimeCompiledFlowManifestSnapshot({
      runDir: runFolder,
      expectedRunId: RUN_ID,
      expectedFlowId: FLOW_ID,
      expectedHash: manifestHash,
    });
    expect(snapshot.hash).toBe(manifestHash);
    expect(flowBytes.equals(MANIFEST_BODY)).toBe(true);
    expect(flow.id).toBe(FLOW_ID);
  });

  it('corrupt manifest snapshot bytes fail loudly', async () => {
    await writeRuntimeManifestSnapshot({
      runDir: runFolder,
      runId: RUN_ID,
      flowId: FLOW_ID,
      capturedAt: baseRecordedAt(0),
      bytes: MANIFEST_BODY,
    });
    const parsed: { bytes_base64: string } = JSON.parse(
      readFileSync(runtimeManifestSnapshotPath(runFolder), 'utf8'),
    );
    const tampered = {
      ...parsed,
      bytes_base64: Buffer.from('not the real manifest bytes', 'utf8').toString('base64'),
    };
    writeFileSync(runtimeManifestSnapshotPath(runFolder), JSON.stringify(tampered));

    await expect(readRuntimeManifestSnapshot(runFolder)).rejects.toThrow(/manifest hash mismatch/);
  });

  it('does not overwrite an existing manifest snapshot', async () => {
    const input = {
      runDir: runFolder,
      runId: RUN_ID,
      flowId: FLOW_ID,
      capturedAt: baseRecordedAt(0),
      bytes: MANIFEST_BODY,
    };
    await writeRuntimeManifestSnapshot(input);

    await expect(writeRuntimeManifestSnapshot(input)).rejects.toThrow(/EEXIST|file already exists/);
  });

  it('manifest snapshot path and trace path are distinct and stable', () => {
    const tracePath = join(runFolder, 'trace.ndjson');
    expect(tracePath).toContain('trace.ndjson');
    expect(runtimeManifestSnapshotPath(runFolder)).toContain('manifest.snapshot.json');
    expect(tracePath).not.toBe(runtimeManifestSnapshotPath(runFolder));
  });
});

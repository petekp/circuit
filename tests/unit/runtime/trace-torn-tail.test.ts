import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceStore } from '../../../src/runtime/trace/trace-store.js';
import { computeManifestHash } from '../../../src/schemas/manifest.js';
import { deterministicNow } from '../../helpers/runtime-fixtures.js';

// Durability Tier-1, Fix 1 (audit Probe C): the trace reader must tolerate a
// torn/unparseable FINAL line — the expected artifact of a crash mid-append —
// by treating the trace as ending at the last complete line. It must stay
// STRICT on interior corruption: a torn line in the MIDDLE is real corruption
// and must fail loud.

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const FLOW_ID = 'runtime-proof';
const MANIFEST_HASH = computeManifestHash(Buffer.from('durability probe manifest bytes'));
const change_kind = {
  change_kind: 'ratchet-advance' as const,
  failure_mode: 'torn-tail fixture failed',
  acceptance_evidence: 'trace entries append and reload across a torn trailing line',
  alternate_framing: 'use a smaller direct trace-store fixture',
};

let runFolder: string;
const tracePath = () => join(runFolder, 'trace.ndjson');

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-trace-torn-'));
});
afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

// Write valid, schema-correct, contiguous trace lines by appending for real,
// then return the raw file text so a test can tear the tail.
async function seedValidTrace(kinds: 'open' | 'closed'): Promise<string> {
  const trace = new TraceStore(runFolder, {
    now: deterministicNow(Date.UTC(2026, 5, 15, 12, 0, 0)),
  });
  await trace.append({
    run_id: RUN_ID,
    kind: 'run.bootstrapped',
    flow_id: FLOW_ID,
    goal: 'durability probe: torn-tail tolerance',
    depth: 'medium',
    change_kind,
    manifest_hash: MANIFEST_HASH,
  });
  await trace.append({ run_id: RUN_ID, kind: 'step.entered', step_id: 'frame', attempt: 1 });
  if (kinds === 'closed') {
    await trace.append({ run_id: RUN_ID, kind: 'run.closed', outcome: 'complete' });
  }
  return readFileSync(tracePath(), 'utf8');
}

describe('trace reader torn-tail tolerance (Fix 1 / audit Probe C)', () => {
  it('treats a torn FINAL line as the end of the trace (does not brick)', async () => {
    const raw = await seedValidTrace('open');
    // Append a torn final line: an interrupted append leaves incomplete JSON
    // with no trailing newline (the exact crash artifact).
    const torn = `${raw}{"schema_version":1,"sequence":2,"run_id":"${RUN_ID}","kind":"step.comple`;
    writeFileSync(tracePath(), torn, 'utf8');

    const reloaded = await new TraceStore(runFolder).load();
    expect(reloaded.map((e) => e.sequence)).toEqual([0, 1]);
    expect(reloaded.at(-1)).toMatchObject({ kind: 'step.entered', step_id: 'frame' });
  });

  it('a closed run with a torn trailing line still reads as closed', async () => {
    const raw = await seedValidTrace('closed');
    const torn = `${raw}{"schema_version":1,"sequence":3,"run_id":"${RUN_ID}","kind":"step.ent`;
    writeFileSync(tracePath(), torn, 'utf8');

    const store = new TraceStore(runFolder);
    const reloaded = await store.load();
    expect(reloaded.map((e) => e.kind)).toEqual(['run.bootstrapped', 'step.entered', 'run.closed']);
    // Closed state is recovered, so further appends are rejected.
    await expect(
      store.append({ run_id: RUN_ID, kind: 'step.completed', step_id: 'frame', attempt: 1 }),
    ).rejects.toThrow(/after run close/);
  });

  it('after a torn-tail load, the next append continues at the right sequence', async () => {
    const raw = await seedValidTrace('open');
    writeFileSync(
      tracePath(),
      `${raw}{"schema_version":1,"sequence":2,"kind":"step.comple`,
      'utf8',
    );

    const store = new TraceStore(runFolder);
    await store.load();
    const appended = await store.append({
      run_id: RUN_ID,
      kind: 'step.entered',
      step_id: 'verify',
      attempt: 1,
    });
    expect(appended.sequence).toBe(2);

    // And it persists: a fresh reader sees three contiguous, complete entries.
    const reloaded = await new TraceStore(runFolder).load();
    expect(reloaded.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(reloaded.at(-1)).toMatchObject({ kind: 'step.entered', step_id: 'verify' });
  });

  it('heals from the raw byte offset when a blank line precedes the torn tail', async () => {
    // A damaged-but-recoverable on-disk shape: a blank line sits between two
    // complete records, then a torn tail. The heal must truncate ONLY the torn
    // bytes — the clean-prefix length has to be measured from the raw bytes, not
    // from a re-joined blank-filtered line set (which is short by the blank
    // line's newline and would chop the last complete record's terminator,
    // gluing the next append onto it and losing a durable record).
    const raw = await seedValidTrace('open');
    const [line0, line1] = raw.split('\n').filter((l) => l.trim().length > 0);
    writeFileSync(
      tracePath(),
      `${line0}\n\n${line1}\n{"schema_version":1,"sequence":2,"kind":"step.comple`,
      'utf8',
    );

    const store = new TraceStore(runFolder);
    // The torn tail is dropped; both complete records survive across the blank.
    expect((await store.load()).map((e) => e.sequence)).toEqual([0, 1]);

    // The next append truncates only the torn bytes — the last complete record
    // is preserved, not concatenated onto.
    const appended = await store.append({
      run_id: RUN_ID,
      kind: 'step.entered',
      step_id: 'verify',
      attempt: 1,
    });
    expect(appended.sequence).toBe(2);

    // A fresh reader recovers all three contiguous records (not just [0]).
    const fresh = await new TraceStore(runFolder).load();
    expect(fresh.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(fresh.at(-1)).toMatchObject({ kind: 'step.entered', step_id: 'verify' });
  });

  it('stays STRICT on interior corruption: a torn MIDDLE line fails loud', async () => {
    const raw = await seedValidTrace('open');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    // Corrupt the FIRST line (interior, since a valid line follows it).
    const corruptedFirst = '{"schema_version":1,"sequence":0,"kind":"run.boot';
    const tampered = `${[corruptedFirst, lines[1]].join('\n')}\n`;
    writeFileSync(tracePath(), tampered, 'utf8');

    await expect(new TraceStore(runFolder).load()).rejects.toThrow();
  });
});

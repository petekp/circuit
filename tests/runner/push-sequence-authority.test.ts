import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';

import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// TraceStore is the single sequence assignment authority in runtime.
// Every appended trace entry gets the next zero-based sequence number,
// including relay transcript entries.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadFixture(): { bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  return { bytes };
}

function stubRelayer(): RelayFn {
  return makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt-push-authority' });
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-push-authority-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('TraceStore is the single sequence-assignment authority', () => {
  it('on-disk trace_entries have sequence === array index across compose + relay + close', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'run');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '99999999-aaaa-bbbb-cccc-000000000001',
      goal: 'pin TraceStore as the single sequence-assignment authority',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 26, 12, 0, 0)),
      relayer: stubRelayer(),
      executors: {
        compose: async (step, context) => {
          if (step.kind !== 'compose') throw new Error('expected compose step');
          const report = step.writes?.report;
          if (report !== undefined) {
            const reportPath = context.files.resolve(report);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, '{"summary":"runtime-proof relay setup"}\n', 'utf8');
          }
          return { route: 'pass', details: { report: report?.path } };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');

    // The on-disk log: parse via the schema-aware reader and assert
    // every trace_entry's sequence equals its zero-based index.
    const log = await new TraceStore(runFolder).load();
    expect(log.length).toBeGreaterThan(0);
    log.forEach((trace_entry, index) => {
      expect(trace_entry.sequence).toBe(index);
    });

    // The relay transcript must thread through TraceStore in the correct
    // order: started, request, receipt, result, completed, each strictly
    // increasing in sequence.
    const relayTraceEntries = log.filter((e) => e.kind.startsWith('relay.'));
    expect(relayTraceEntries.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < relayTraceEntries.length; i += 1) {
      const prev = relayTraceEntries[i - 1];
      const curr = relayTraceEntries[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      expect(curr.sequence).toBeGreaterThan(prev.sequence);
    }
  });
});

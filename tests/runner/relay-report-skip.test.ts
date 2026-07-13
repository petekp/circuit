// Pass-without-report legibility.
//
// A relay step that passes its check normally materializes its schema-tied
// report from the result body. There is a narrow degradation seam: the body
// parsed at check time, the schema accepted it, but the re-parse that feeds
// the report writer fails (relay.ts backfills `parsedBody` with a guarded
// JSON.parse whose catch used to swallow the error). The step still passes —
// correctly, the check already ruled — but `writes.report.path` silently never
// appears, and every downstream reader (operator-summary projection, CI
// tooling, the close path) sees "no report" with no explanation.
//
// These tests pin the fix: the pass verdict is UNCHANGED, but the skipped
// report becomes a durable `step.report_skipped` trace entry naming the
// report path, the raw-result fallback, and the remedy.
//
// Reproducing the seam: on the default path the same string parses at check
// time and at backfill time, so the divergence cannot be reached with input
// alone. The test spies on JSON.parse and fails only the 3rd and 4th parses
// of the exact sentinel body — occurrence 1 is the check evaluation,
// occurrence 2 is the schema parseReport, occurrence 3 is the validator's
// parsedBody extraction, occurrence 4 is the executor's backfill. Everything
// else (trace validation, file IO, other bodies) parses normally.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');
const SENTINEL_BODY = '{"verdict":"ok","probe":"report-skip"}';

// The runtime-proof relay step declares no writes.report; add the canonical
// schema so the report-materialization path is in play (same mutation as
// tests/runner/materializer-schema-parse.test.ts).
function flowBytesWithCanonicalReport(): Buffer {
  const raw: {
    steps: Array<{ id: string; writes: { report?: { path: string; schema: string } } }>;
  } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const step = raw.steps.find((s) => s.id === 'relay-step');
  if (step === undefined) throw new Error('relay-step not found in fixture');
  step.writes.report = {
    path: 'reports/relay-canonical.json',
    schema: 'runtime-proof-canonical@v1',
  };
  CompiledFlow.parse(raw);
  return Buffer.from(JSON.stringify(raw));
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-relay-report-skip-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('a passed relay whose report cannot be materialized is legible', () => {
  it('keeps the pass verdict but records step.report_skipped naming the path, the raw result, and the remedy', async () => {
    const realParse = JSON.parse.bind(JSON);
    let sentinelParses = 0;
    vi.spyOn(JSON, 'parse').mockImplementation((text: string, ...rest: unknown[]) => {
      if (text === SENTINEL_BODY) {
        sentinelParses += 1;
        // 1 = check evaluation, 2 = schema parseReport: both succeed, so the
        // step passes. 3 = validator parsedBody, 4 = executor backfill: both
        // fail, so nothing feeds the report writer. Later parses (if any)
        // behave normally so the close path is untouched.
        if (sentinelParses === 3 || sentinelParses === 4) {
          throw new SyntaxError('simulated backfill parse divergence');
        }
      }
      return realParse(
        text,
        ...(rest as [((this: unknown, key: string, value: unknown) => unknown)?]),
      );
    });

    const runFolder = join(runFolderBase, 'report-skip');
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytesWithCanonicalReport(),
      runId: '4e904e90-4e90-44e9-84e9-04e904e904b1',
      goal: 'pass-without-report legibility',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 12, 15, 0, 0)),
      relayer: makeStubRelayer(SENTINEL_BODY, { receipt_id: 'stub-receipt-report-skip' }),
      executors: {
        compose: async (step, context) => {
          if (step.kind !== 'compose') throw new Error('expected compose step');
          const report = step.writes?.report;
          if (report !== undefined) {
            const reportPath = context.files.resolve(report);
            await mkdir(dirname(reportPath), { recursive: true });
            await writeFile(reportPath, '{"summary":"runtime-proof relay setup"}\n', 'utf8');
          }
          return { route: 'pass', details: { report: report?.path } };
        },
      },
    });

    // The divergence actually happened (guards against the seam moving).
    expect(sentinelParses).toBeGreaterThanOrEqual(4);

    // The pass verdict is untouched: the check ruled, the run completes.
    expect(result.outcome).toBe('complete');

    const trace = await new TraceStore(runFolder).load();
    const checkEvaluated = trace.find(
      (e) => e.kind === 'check.evaluated' && e.check_kind === 'result_verdict',
    );
    if (checkEvaluated?.kind !== 'check.evaluated') throw new Error('expected check.evaluated');
    expect(checkEvaluated.outcome).toBe('pass');

    // The report was never written...
    expect(existsSync(join(runFolder, 'reports', 'relay-canonical.json'))).toBe(false);
    expect(
      trace.find((e) => e.kind === 'step.report_written' && e.step_id === 'relay-step'),
    ).toBeUndefined();

    // ...and that is now a durable, legible record instead of a silent gap.
    const skipped = trace.find((e) => e.kind === 'step.report_skipped');
    expect(skipped).toBeDefined();
    expect(skipped).toMatchObject({
      step_id: 'relay-step',
      report_path: 'reports/relay-canonical.json',
    });
    const reason = (skipped as { reason?: string }).reason ?? '';
    // Names the condition, the surviving raw evidence, and the remedy.
    expect(reason).toContain('passed its check');
    expect(reason).toContain('reports/relay.result.json');
    expect(reason).toMatch(/rerun/i);
  });

  it('writes the report and records no skip marker when the body parses cleanly', async () => {
    const runFolder = join(runFolderBase, 'clean');
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytesWithCanonicalReport(),
      runId: '4e904e90-4e90-44e9-84e9-04e904e904b2',
      goal: 'clean pass writes the report',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 12, 15, 30, 0)),
      relayer: makeStubRelayer(SENTINEL_BODY, { receipt_id: 'stub-receipt-report-skip' }),
      executors: {
        compose: async (step, context) => {
          if (step.kind !== 'compose') throw new Error('expected compose step');
          const report = step.writes?.report;
          if (report !== undefined) {
            const reportPath = context.files.resolve(report);
            await mkdir(dirname(reportPath), { recursive: true });
            await writeFile(reportPath, '{"summary":"runtime-proof relay setup"}\n', 'utf8');
          }
          return { route: 'pass', details: { report: report?.path } };
        },
      },
    });

    expect(result.outcome).toBe('complete');
    expect(existsSync(join(runFolder, 'reports', 'relay-canonical.json'))).toBe(true);
    const trace = await new TraceStore(runFolder).load();
    expect(trace.find((e) => e.kind === 'step.report_skipped')).toBeUndefined();
  });
});

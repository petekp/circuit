// Pass-without-report legibility.
//
// A relay step that passes its check materializes its schema-tied report from
// the result body. There used to be a degradation seam here: the body was
// parsed once for the check, again for schema validation, and then a THIRD and
// FOURTH time to feed the report writer. If one of those later parses diverged,
// the step still passed — correctly, the check had ruled — but
// `writes.report.path` silently never appeared, and every downstream reader
// (operator-summary projection, CI tooling, the close path) saw "no report"
// with no explanation. The `step.report_skipped` trace entry was added to make
// that gap legible.
//
// The seam is now closed at the source: schema validation returns the validated
// body and the writer persists THAT, so on a schema-tied report there is no
// later parse left to diverge from the one the check ruled on. The first test
// pins the closed seam — the body is parsed for the check and for validation,
// and the report is written from the validated output. `step.report_skipped`
// stays in the executor as defense for a relay whose validator returns no
// parsed body; its rendering is covered in operator-summary-writer.test.ts.
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

describe('a passed relay materializes its report from the body the check ruled on', () => {
  it('parses the result body only for the check and for schema validation, then writes that validated body', async () => {
    const realParse = JSON.parse.bind(JSON);
    let sentinelParses = 0;
    vi.spyOn(JSON, 'parse').mockImplementation((text: string, ...rest: unknown[]) => {
      if (text === SENTINEL_BODY) sentinelParses += 1;
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

    // Two parses, not four: the check evaluation and the schema validation. A
    // third would mean the writer re-derived a body the check never saw, which
    // is exactly the divergence this seam used to admit.
    expect(sentinelParses).toBe(2);

    expect(result.outcome).toBe('complete');

    const trace = await new TraceStore(runFolder).load();
    const checkEvaluated = trace.find(
      (e) => e.kind === 'check.evaluated' && e.check_kind === 'result_verdict',
    );
    if (checkEvaluated?.kind !== 'check.evaluated') throw new Error('expected check.evaluated');
    expect(checkEvaluated.outcome).toBe('pass');

    // The report exists, matches the validated body, and no skip marker was
    // recorded — there is no gap left to explain.
    const reportPath = join(runFolder, 'reports', 'relay-canonical.json');
    expect(existsSync(reportPath)).toBe(true);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ verdict: 'ok' });
    expect(trace.find((e) => e.kind === 'step.report_skipped')).toBeUndefined();
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

// End-to-end: the engine identity reaches a real run record.
//
// The unit tests in tests/unit/engine-provenance.test.ts pin the schema and the
// probe. This drives an actual flow through the runtime and reads the files it
// leaves behind, because the point of the stamp is that run history on disk can
// be cohorted by engine build — and a schema that permits the field proves
// nothing about whether anything writes it.
//
// The third test is the one that matters most. A crash-healed result is a
// projection of a run that already happened, possibly on a different engine
// build than the one doing the healing. Stamping the healer there would be a
// quiet lie in exactly the record that exists to tell the truth about what ran.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { regenerateMissingRunResult } from '../../src/runtime/run/result-recovery.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';
import { resolveEngineProvenance } from '../../src/shared/engine-provenance.js';
import { runResultPath } from '../../src/shared/result-path.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

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
        writeFileSync(reportPath, '{"summary":"engine provenance fixture"}\n', 'utf8');
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
    goal: 'prove the engine stamp reaches the run record',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 5, 15, 12, 0, 0)),
    relayer: makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt-provenance' }),
    executors: composeExecutor(),
  });
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-engine-provenance-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('The engine stamp on a real run', () => {
  it('lands on result.json, identifying the checkout that ran', async () => {
    const runFolder = join(base, 'run');
    await driveClosedRun(runFolder);

    const result = RunResult.parse(JSON.parse(readFileSync(runResultPath(runFolder), 'utf8')));
    expect(result.engine).toBeDefined();
    // The suite runs from the circuit checkout, so the probe reaches git.
    expect(result.engine?.source).toBe('git');
    expect(result.engine?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof result.engine?.dirty).toBe('boolean');
    expect(result.engine).toEqual(resolveEngineProvenance());
  });

  it('lands on the run.bootstrapped trace entry, so a crashed run is still attributable', async () => {
    const runFolder = join(base, 'run-trace');
    await driveClosedRun(runFolder);

    const entries = await new TraceStore(runFolder).load();
    const bootstrap = entries.find((entry) => entry.kind === 'run.bootstrapped');
    expect(bootstrap).toBeDefined();
    expect((bootstrap as { engine?: unknown }).engine).toEqual(resolveEngineProvenance());
  });

  it('carries the engine that RAN into a crash-healed result, not the one that healed it', async () => {
    const runFolder = join(base, 'run-healed');
    await driveClosedRun(runFolder);

    // Rewrite the bootstrap stamp to a sha that is provably not this checkout.
    // If recovery re-probed git instead of reading the trace, the regenerated
    // result would carry the live sha and this sentinel would vanish.
    const sentinelSha = 'b'.repeat(40);
    const tracePath = join(runFolder, 'trace.ndjson');
    const rewritten = readFileSync(tracePath, 'utf8')
      .split('\n')
      .map((line) => {
        if (line.length === 0) return line;
        const entry = JSON.parse(line) as { kind: string; engine?: unknown };
        if (entry.kind !== 'run.bootstrapped') return line;
        entry.engine = { version: '9.9.9-sentinel', source: 'git', sha: sentinelSha, dirty: true };
        return JSON.stringify(entry);
      })
      .join('\n');
    writeFileSync(tracePath, rewritten, 'utf8');

    rmSync(runResultPath(runFolder));
    const outcome = await regenerateMissingRunResult(runFolder);
    expect(outcome.regenerated).toBe(true);

    const regen = RunResult.parse(JSON.parse(readFileSync(runResultPath(runFolder), 'utf8')));
    expect(regen.engine?.sha).toBe(sentinelSha);
    expect(regen.engine?.version).toBe('9.9.9-sentinel');
    expect(regen.engine?.sha).not.toBe(resolveEngineProvenance().sha);
  });

  it('heals a run bootstrapped before the stamp existed without inventing one', async () => {
    // The 54 runs already on disk have no stamp. Recovery must leave the field
    // absent rather than backfilling the healing engine, which never ran them.
    const runFolder = join(base, 'run-legacy');
    await driveClosedRun(runFolder);

    const tracePath = join(runFolder, 'trace.ndjson');
    const stripped = readFileSync(tracePath, 'utf8')
      .split('\n')
      .map((line) => {
        if (line.length === 0) return line;
        const entry = JSON.parse(line) as { kind: string; engine?: unknown };
        if (entry.kind !== 'run.bootstrapped') return line;
        // JSON.stringify drops undefined-valued keys, so this really removes it.
        entry.engine = undefined;
        return JSON.stringify(entry);
      })
      .join('\n');
    writeFileSync(tracePath, stripped, 'utf8');

    rmSync(runResultPath(runFolder));
    expect((await regenerateMissingRunResult(runFolder)).regenerated).toBe(true);

    const regen = RunResult.parse(JSON.parse(readFileSync(runResultPath(runFolder), 'utf8')));
    expect(regen.engine).toBeUndefined();
  });
});

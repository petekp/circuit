import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/circuit.js';
import { MemoryInputV0 } from '../../src/index.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const RECORDED_AT = '2026-05-26T12:00:00.000Z';

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function captureMain(argv: readonly string[]) {
  const { result, stdout, stderr } = await captureStreams(() => main(argv));
  return { code: result, stdout, stderr };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFixture(root: string) {
  const runsBase = join(root, '.circuit', 'runs');
  const indexDir = join(root, '.circuit', 'history');
  const runFolder = join(runsBase, RUN_ID);
  mkdirSync(runFolder, { recursive: true });
  writeJson(join(runFolder, 'manifest.snapshot.json'), {
    schema_version: 1,
    run_id: RUN_ID,
    flow_id: 'explore',
    captured_at: RECORDED_AT,
  });
  writeJson(join(runFolder, 'reports', 'result.json'), {
    flow_id: 'explore',
    outcome: 'complete',
    goal: 'Explore history recall',
    summary: 'Run closed with outcome complete.',
  });
  writeJson(join(runFolder, 'reports', 'decision.json'), {
    decision: 'Use explicit local history querying before memory injection.',
    rationale: 'Recall must be cited and hint-only.',
  });
  const trace = [
    {
      schema_version: 1,
      sequence: 0,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'run.bootstrapped',
      flow_id: 'explore',
      depth: 'medium',
      goal: 'Explore history recall',
      change_kind: {
        change_kind: 'discovery',
        failure_mode: 'history is missing',
        acceptance_evidence: 'query results cite reports',
        alternate_framing: 'manual search',
      },
      manifest_hash: 'a'.repeat(64),
    },
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'step.report_written',
      step_id: 'decision-step',
      attempt: 1,
      report_path: 'reports/decision.json',
      report_schema: 'explore.decision@v1',
    },
    {
      schema_version: 1,
      sequence: 2,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'run.closed',
      outcome: 'complete',
    },
  ];
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  return { runsBase, indexDir };
}

describe('history CLI', () => {
  it('rebuilds, reports status, queries, and previews memory inputs', async () => {
    const root = tempRoot('circuit-history-cli-');
    const { runsBase, indexDir } = writeFixture(root);

    const rebuild = await captureMain([
      'history',
      'rebuild',
      '--json',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(rebuild.code, rebuild.stderr).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toMatchObject({
      api_version: 'history-index-v1',
      run_count: 1,
    });

    const status = await captureMain([
      'history',
      'status',
      '--json',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      api_version: 'history-status-v1',
      index_exists: true,
      index_state: 'fresh',
    });

    const query = await captureMain([
      'history',
      'query',
      'local history memory injection',
      '--json',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(query.code, query.stderr).toBe(0);
    const queryBody = JSON.parse(query.stdout);
    expect(queryBody).toMatchObject({
      api_version: 'history-query-result-v1',
      authority_notice:
        'History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.',
    });
    expect(queryBody.results[0].doc.source_path).toBe('reports/decision.json');

    const preview = await captureMain([
      'history',
      'query',
      'local history memory injection',
      '--json',
      '--format',
      'memory-input',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    const previewBody = JSON.parse(preview.stdout);
    expect(previewBody.api_version).toBe('history-memory-input-preview-v1');
    expect(previewBody.memory_inputs.length).toBeGreaterThan(0);
    expect(MemoryInputV0.parse(previewBody.memory_inputs[0]).authority).toBe('hint_only');
  });

  it('requires --json and can rebuild a missing index from query', async () => {
    const root = tempRoot('circuit-history-cli-missing-');
    const { runsBase, indexDir } = writeFixture(root);

    const missingJson = await captureMain([
      'history',
      'query',
      'history',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(missingJson.code).toBe(2);
    // Plain text on stderr, because this caller did not ask for JSON. Saying
    // "pass --json" in JSON would demonstrate that the flag was not needed.
    expect(missingJson.stdout).toBe('');
    expect(missingJson.stderr).toContain('history commands require --json');
    // And the line to retype, so the remedy is not left as an exercise.
    expect(missingJson.stderr).toContain('circuit history query --json');

    const rebuilt = await captureMain([
      'history',
      'query',
      'history',
      '--json',
      '--rebuild-if-stale',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect(JSON.parse(rebuilt.stdout)).toMatchObject({
      api_version: 'history-query-result-v1',
      rebuilt: true,
    });
  });

  it('reports unsupported index schemas', async () => {
    const root = tempRoot('circuit-history-cli-unsupported-');
    const { runsBase, indexDir } = writeFixture(root);
    mkdirSync(indexDir, { recursive: true });
    writeJson(join(indexDir, 'manifest.v1.json'), {
      api_version: 'history-index-v1',
      schema_version: 99,
    });
    writeFileSync(join(indexDir, 'documents.v1.jsonl'), '');

    const result = await captureMain([
      'history',
      'query',
      'history',
      '--json',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      api_version: 'history-error-v1',
      error: { code: 'index_unsupported' },
    });
  });
});

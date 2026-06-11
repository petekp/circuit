import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_PULL_LOG_RELATIVE_PATH } from '../../src/app/history/pull-log.js';
import { runHistoryCommand } from '../../src/cli/history.js';
import { HistoryErrorV1, HistoryMemoryInputPreviewV1, HistoryPullLogV1 } from '../../src/index.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const HISTORY_AUTHORITY_NOTICE =
  'History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const RECORDED_AT = '2026-05-26T12:00:00.000Z';
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'history-pull-cli-'));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// A small queryable corpus: one explore run whose decision report is indexable, so
// `pull "history memory"` returns at least one hint after rebuild-if-stale.
function writeCorpus(): { runsBase: string; indexDir: string; root: string } {
  const root = tempRoot();
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
  return { runsBase, indexDir, root };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(argv: readonly string[]) {
  const { result, stdout } = await captureStreams(() => runHistoryCommand(argv));
  return { code: result, stdout };
}

describe('history pull CLI', () => {
  it('returns a valid preview and writes a re-parseable pull-log over a temp corpus', async () => {
    const { runsBase, indexDir, root } = writeCorpus();
    const runFolder = join(root, '.circuit', 'runs', RUN_ID);

    const { code, stdout } = await run([
      'pull',
      'history memory injection',
      '--json',
      '--flow',
      'explore',
      '--decision-point',
      'before-editing-auth-guard',
      '--run-folder',
      runFolder,
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
      '--rebuild-if-stale',
    ]);
    expect(code).toBe(0);
    const preview = HistoryMemoryInputPreviewV1.parse(JSON.parse(stdout));
    expect(preview.api_version).toBe('history-memory-input-preview-v1');
    // Boundary: the preview carries the authority notice; every input is hint-only.
    expect(preview.authority_notice).toBe(HISTORY_AUTHORITY_NOTICE);
    expect(preview.memory_inputs.every((m) => m.authority === 'hint_only')).toBe(true);

    // The pull-log is written and re-parses; its entry carries flow_id,
    // decision_point, and effect_report_available=false (no effect report present).
    const logPath = join(runFolder, HISTORY_PULL_LOG_RELATIVE_PATH);
    expect(existsSync(logPath)).toBe(true);
    const log = HistoryPullLogV1.parse(JSON.parse(readFileSync(logPath, 'utf8')));
    expect(log.entries).toHaveLength(1);
    const entry = log.entries[0];
    expect(entry?.flow_id).toBe('explore');
    expect(entry?.decision_point).toBe('before-editing-auth-guard');
    expect(entry?.effect_report_available).toBe(false);
    expect(entry?.authority).toBe('hint_only');
    // The logged result_count equals the surfaced inputs count.
    expect(entry?.result_count).toBe(preview.memory_inputs.length);
  });

  it('appends a second entry on a second pull (the log accrues across pulls)', async () => {
    const { runsBase, indexDir, root } = writeCorpus();
    const runFolder = join(root, '.circuit', 'runs', RUN_ID);
    const base = [
      'pull',
      'history memory',
      '--json',
      '--flow',
      'explore',
      '--decision-point',
      'first',
      '--run-folder',
      runFolder,
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
      '--rebuild-if-stale',
    ];
    expect((await run(base)).code).toBe(0);
    expect((await run([...base.slice(0, 6), 'second', ...base.slice(7)])).code).toBe(0);
    const log = HistoryPullLogV1.parse(
      JSON.parse(readFileSync(join(runFolder, HISTORY_PULL_LOG_RELATIVE_PATH), 'utf8')),
    );
    expect(log.entries.map((e) => e.decision_point)).toEqual(['first', 'second']);
  });

  it('still returns results (and warns) when --run-folder is unwritable: the pull is never blocked', async () => {
    const { runsBase, indexDir, root } = writeCorpus();
    // A run folder nested under a regular file, so the log write must fail.
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const runFolder = join(blocker, 'nested');

    const { code, stdout } = await run([
      'pull',
      'history memory',
      '--json',
      '--flow',
      'explore',
      '--decision-point',
      'before-edit',
      '--run-folder',
      runFolder,
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
      '--rebuild-if-stale',
    ]);
    expect(code).toBe(0);
    const preview = HistoryMemoryInputPreviewV1.parse(JSON.parse(stdout));
    // The preview is returned with a pull_log_unavailable warning surfaced.
    expect(preview.warnings.some((w) => w.code === 'pull_log_unavailable')).toBe(true);
  });

  it('rejects a missing --flow (exit 2)', async () => {
    const { runsBase, indexDir, root } = writeCorpus();
    const runFolder = join(root, '.circuit', 'runs', RUN_ID);
    const { code, stdout } = await run([
      'pull',
      'history memory',
      '--json',
      '--decision-point',
      'x',
      '--run-folder',
      runFolder,
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(code).toBe(2);
    expect(HistoryErrorV1.parse(JSON.parse(stdout)).error.code).toBe('invalid_invocation');
  });

  it('rejects a missing --decision-point (exit 2)', async () => {
    const { runsBase, indexDir } = writeCorpus();
    const { code, stdout } = await run([
      'pull',
      'history memory',
      '--json',
      '--flow',
      'explore',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(code).toBe(2);
    expect(HistoryErrorV1.parse(JSON.parse(stdout)).error.code).toBe('invalid_invocation');
  });

  it('rejects invocation without --json (exit 2)', async () => {
    const { runsBase, indexDir } = writeCorpus();
    const { code, stdout } = await run([
      'pull',
      'history memory',
      '--flow',
      'explore',
      '--decision-point',
      'x',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
    ]);
    expect(code).toBe(2);
    expect(HistoryErrorV1.parse(JSON.parse(stdout)).error.code).toBe('invalid_invocation');
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_MEMORY_MERGE_FILE } from '../../src/app/history/indexer.js';
import { runHistoryCommand } from '../../src/cli/history.js';
import { HistoryErrorV1, HistoryMemoryMergeV1 } from '../../src/index.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];

function tempRunsBase(): { runsBase: string; indexDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'memory-merge-cli-'));
  tempRoots.push(root);
  const runsBase = join(root, '.circuit', 'runs');
  const indexDir = join(root, '.circuit', 'history');
  mkdirSync(runsBase, { recursive: true });
  return { runsBase, indexDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(argv: readonly string[]) {
  const { result, stdout, stderr } = await captureStreams(() => runHistoryCommand(argv));
  return { code: result, stdout, stderr };
}

describe('history memory-merge CLI', () => {
  it('prints a schema-valid report and exits 0 over an empty corpus', async () => {
    const { runsBase } = tempRunsBase();
    const { code, stdout } = await run(['memory-merge', '--json', '--runs-base', runsBase]);
    expect(code).toBe(0);
    const report = HistoryMemoryMergeV1.parse(JSON.parse(stdout));
    expect(report.api_version).toBe('history-memory-merge-v1');
    expect(report.run_count).toBe(0);
    expect(report.linkages).toEqual([]);
  });

  it('persists the report with --write and the file re-parses', async () => {
    const { runsBase, indexDir } = tempRunsBase();
    const { code } = await run([
      'memory-merge',
      '--json',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
      '--write',
    ]);
    expect(code).toBe(0);
    const outPath = join(indexDir, HISTORY_MEMORY_MERGE_FILE);
    expect(existsSync(outPath)).toBe(true);
    expect(() =>
      HistoryMemoryMergeV1.parse(JSON.parse(readFileSync(outPath, 'utf8'))),
    ).not.toThrow();
  });

  // A caller who did not ask for JSON is not answered in JSON: the message
  // that says to pass --json would otherwise arrive as the very format it is
  // asking for, on the stream a pipe swallows.
  it('rejects invocation without --json (exit 2) in plain text on stderr', async () => {
    const { runsBase } = tempRunsBase();
    const { code, stdout, stderr } = await run(['memory-merge', '--runs-base', runsBase]);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('history commands require --json');
  });

  it('returns an error envelope when the runs base is missing (exit 1)', async () => {
    const { code, stdout } = await run([
      'memory-merge',
      '--json',
      '--runs-base',
      join(tmpdir(), 'memory-merge-does-not-exist-zzz'),
    ]);
    expect(code).toBe(1);
    const error = HistoryErrorV1.parse(JSON.parse(stdout));
    expect(error.error.code).toBe('runs_base_not_found');
  });
});

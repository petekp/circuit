import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { runtimeManifestSnapshotPath } from '../../src/runtime/run/manifest-snapshot.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { runResultPath as resultPath } from '../../src/shared/result-path.js';

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadFixture(): { bytes: Buffer } {
  return { bytes: readFileSync(FIXTURE_PATH) };
}

function stubRelayer(): RelayFn {
  return makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt-fresh-run-folder' });
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"fresh run guard fixture"}\n', 'utf8');
      }
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

async function closeFixtureRun(input: {
  runFolder: string;
  runId: string;
  goal: string;
  startMs: number;
}): Promise<void> {
  const { bytes } = loadFixture();
  await runCompiledFlow({
    runDir: input.runFolder,
    flowBytes: bytes,
    runId: input.runId,
    goal: input.goal,
    depth: 'medium',
    now: deterministicNow(input.startMs),
    relayer: stubRelayer(),
    executors: composeExecutor(),
  });
}

function tracePath(runFolder: string): string {
  return join(runFolder, 'trace.ndjson');
}

function persistentRunBytes(runFolder: string): ReadonlyMap<string, string> {
  return new Map(
    [tracePath(runFolder), runtimeManifestSnapshotPath(runFolder), resultPath(runFolder)].map(
      (path) => [path, readFileSync(path, 'utf8')] as const,
    ),
  );
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-fresh-root-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('runtime fresh run directory guard', () => {
  it('rejects run-folder reuse before trace, manifest, or result bytes change', async () => {
    const runFolder = join(runFolderBase, 'reused-root');
    await closeFixtureRun({
      runFolder,
      runId: '69000000-0000-0000-0000-000000000201',
      goal: 'first run owns this root',
      startMs: Date.UTC(2026, 3, 24, 14, 0, 0),
    });
    const before = persistentRunBytes(runFolder);

    await expect(
      closeFixtureRun({
        runFolder,
        runId: '69000000-0000-0000-0000-000000000202',
        goal: 'second run must not mutate this root',
        startMs: Date.UTC(2026, 3, 24, 15, 0, 0),
      }),
    ).rejects.toThrow(/fresh run directory/i);

    for (const [path, contents] of before) {
      expect(readFileSync(path, 'utf8')).toBe(contents);
    }
  });

  it('permits an existing empty run-folder directory', async () => {
    const runFolder = join(runFolderBase, 'precreated-empty-root');
    mkdirSync(runFolder, { recursive: true });

    await closeFixtureRun({
      runFolder,
      runId: '69000000-0000-0000-0000-000000000203',
      goal: 'precreated empty root is still a fresh run',
      startMs: Date.UTC(2026, 3, 24, 16, 0, 0),
    });

    expect(existsSync(tracePath(runFolder))).toBe(true);
    expect(existsSync(runtimeManifestSnapshotPath(runFolder))).toBe(true);
    expect(existsSync(resultPath(runFolder))).toBe(true);
  });

  it('rejects an existing file or symlink run-folder before writing run files', async () => {
    const fileRoot = join(runFolderBase, 'file-root');
    writeFileSync(fileRoot, 'not a directory');
    await expect(
      closeFixtureRun({
        runFolder: fileRoot,
        runId: '69000000-0000-0000-0000-000000000204',
        goal: 'file root must not be reused',
        startMs: Date.UTC(2026, 3, 24, 16, 30, 0),
      }),
    ).rejects.toThrow(/fresh run directory/i);
    expect(readFileSync(fileRoot, 'utf8')).toBe('not a directory');

    const symlinkTarget = join(runFolderBase, 'symlink-target');
    const symlinkRoot = join(runFolderBase, 'symlink-root');
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, symlinkRoot);
    await expect(
      closeFixtureRun({
        runFolder: symlinkRoot,
        runId: '69000000-0000-0000-0000-000000000205',
        goal: 'symlink root must not be followed',
        startMs: Date.UTC(2026, 3, 24, 16, 45, 0),
      }),
    ).rejects.toThrow(/fresh run directory/i);
    expect(existsSync(tracePath(symlinkTarget))).toBe(false);
  });

  it('rejects each runtime run file marker before writing new bytes', async () => {
    const cases = [
      ['trace', tracePath],
      ['manifest', runtimeManifestSnapshotPath],
      ['result', resultPath],
    ] as const;

    for (const [index, [label, pathFor]] of cases.entries()) {
      const runFolder = join(runFolderBase, `marker-${label}`);
      const markerPath = pathFor(runFolder);
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, `sentinel-${label}`);

      await expect(
        closeFixtureRun({
          runFolder,
          runId: `69000000-0000-0000-0000-00000000030${index}`,
          goal: `marker ${label} must reject reuse`,
          startMs: Date.UTC(2026, 3, 24, 17, 0, 0),
        }),
      ).rejects.toThrow(/fresh run directory/i);

      expect(readFileSync(markerPath, 'utf8')).toBe(`sentinel-${label}`);
    }
  });
});

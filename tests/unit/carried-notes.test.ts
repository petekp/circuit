import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { appendCarriedNote } from '../../src/runtime/run/carried-notes.js';

// The carried-notes module runs against a REAL RunFileStore over a tmpdir, so the
// test exercises the same read-existing / atomic-write path the engine uses, not
// a stubbed one.
let runDir: string;
let files: RunFileStore;
const REPORT = 'reports/converge/notes.json';

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'circuit-carried-notes-'));
  files = new RunFileStore(runDir);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function onDisk(): unknown {
  return JSON.parse(readFileSync(files.resolve(REPORT), 'utf8'));
}

describe('appendCarriedNote', () => {
  it('creates the file with the first note when none exists yet', async () => {
    const result = await appendCarriedNote({
      files,
      report: REPORT,
      note: { iteration: 0, lesson: 'the export button does nothing on empty lists' },
    });
    expect(result).toEqual([
      { iteration: 0, lesson: 'the export button does nothing on empty lists' },
    ]);
    expect(onDisk()).toEqual(result);
  });

  it('appends subsequent notes in order, so the next pass reads the whole history', async () => {
    await appendCarriedNote({ files, report: REPORT, note: { iteration: 0, lesson: 'first' } });
    await appendCarriedNote({ files, report: REPORT, note: { iteration: 1, lesson: 'second' } });
    expect(onDisk()).toEqual([
      { iteration: 0, lesson: 'first' },
      { iteration: 1, lesson: 'second' },
    ]);
  });

  it('carries an engine steer alongside the lesson when one is present', async () => {
    await appendCarriedNote({
      files,
      report: REPORT,
      note: { iteration: 2, lesson: 'still failing', steer: 'try a different approach' },
    });
    expect(onDisk()).toEqual([
      { iteration: 2, lesson: 'still failing', steer: 'try a different approach' },
    ]);
  });

  it('keeps only the most recent maxEntries notes (bounded prompt growth)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendCarriedNote({
        files,
        report: REPORT,
        note: { iteration: i, lesson: `lesson ${i}` },
        maxEntries: 3,
      });
    }
    expect(onDisk()).toEqual([
      { iteration: 2, lesson: 'lesson 2' },
      { iteration: 3, lesson: 'lesson 3' },
      { iteration: 4, lesson: 'lesson 4' },
    ]);
  });

  it('truncates an over-long lesson so one verbose pass cannot blow the budget', async () => {
    const huge = 'x'.repeat(2000);
    await appendCarriedNote({ files, report: REPORT, note: { iteration: 0, lesson: huge } });
    const written = onDisk() as { lesson: string }[];
    const first = written[0];
    expect(first).toBeDefined();
    expect(first?.lesson.length).toBeLessThanOrEqual(600);
    expect(first?.lesson.endsWith('…')).toBe(true);
  });

  it('starts fresh when the existing file is not a JSON array (never throws)', async () => {
    await files.writeJson(REPORT, { not: 'an array' });
    const result = await appendCarriedNote({
      files,
      report: REPORT,
      note: { iteration: 0, lesson: 'recovered' },
    });
    expect(result).toEqual([{ iteration: 0, lesson: 'recovered' }]);
  });
});

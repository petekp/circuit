import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunFileStore } from '../../../src/runtime/run-files/run-file-store.js';
import * as atomicIo from '../../../src/shared/atomic-io.js';

// Durability Tier-1, Fix 2: whole-file run artifacts (result.json, reports/*.json)
// must be written through atomic-io (stage to a temp sibling, then rename) so a
// crash mid-write cannot leave a half-written file. The append-only trace is out
// of scope (it relies on Fix 1's torn-tail tolerance instead).

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-run-file-atomic-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(runFolder, { recursive: true, force: true });
});

describe('RunFileStore routes whole-file writes through atomic-io (Fix 2)', () => {
  it('writeJson delegates to writeJsonAtomic with byte-identical content', async () => {
    const spy = vi.spyOn(atomicIo, 'writeJsonAtomic');
    const store = new RunFileStore(runFolder);
    const value = { summary: 'durability', nested: { a: 1, b: [2, 3] } };

    const path = await store.writeJson('reports/result.json', value);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(path);
    expect(spy.mock.calls[0]?.[1]).toEqual(value);
    // Content is unchanged from the prior bare-writeFile behavior.
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it('writeText delegates to writeTextAtomic with byte-identical content', async () => {
    const spy = vi.spyOn(atomicIo, 'writeTextAtomic');
    const store = new RunFileStore(runFolder);

    const path = await store.writeText('reports/run-surface.md', '# surface\nbody\n');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('# surface\nbody\n');
  });

  it('leaves no staging .tmp files behind after a successful write', async () => {
    const store = new RunFileStore(runFolder);
    await store.writeJson('reports/result.json', { ok: true });
    await store.writeText('reports/notes.txt', 'hello');

    const reportsDir = join(runFolder, 'reports');
    const leftovers = readdirSync(reportsDir).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

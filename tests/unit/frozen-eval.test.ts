import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FrozenEvalGuard } from '../../src/runtime/run/frozen-eval.js';

// The guard fingerprints a declared set of read-only eval-surface paths at loop
// entry and, asked again later, reports which of those declared paths have
// drifted. A drift covers three shapes — a modified file, a file created after
// the baseline, and a file deleted after the baseline — because any of them is a
// tampered eval surface. The path STRING the flow declared is the key, so latch
// reasons read in the operator's own terms.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-frozen-eval-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('FrozenEvalGuard', () => {
  it('reports no change when a frozen path is untouched after the baseline', () => {
    writeFileSync(join(root, 'eval.txt'), 'check x === 1');
    const guard = new FrozenEvalGuard(root, ['eval.txt']);
    expect(guard.changedFrozenPaths()).toEqual([]);
  });

  it('reports a frozen path whose bytes changed after the baseline', () => {
    writeFileSync(join(root, 'eval.txt'), 'check x === 1');
    const guard = new FrozenEvalGuard(root, ['eval.txt']);
    writeFileSync(join(root, 'eval.txt'), 'check x === 0'); // weaken the check
    expect(guard.changedFrozenPaths()).toEqual(['eval.txt']);
  });

  it('reports a frozen path that was absent at baseline and created after', () => {
    // Absent at baseline -> sentinel; created after -> a real hash -> drift.
    const guard = new FrozenEvalGuard(root, ['eval.txt']);
    writeFileSync(join(root, 'eval.txt'), 'a new eval file the loop should not add');
    expect(guard.changedFrozenPaths()).toEqual(['eval.txt']);
  });

  it('reports a frozen path that was present at baseline and deleted after', () => {
    writeFileSync(join(root, 'eval.txt'), 'check x === 1');
    const guard = new FrozenEvalGuard(root, ['eval.txt']);
    unlinkSync(join(root, 'eval.txt'));
    expect(guard.changedFrozenPaths()).toEqual(['eval.txt']);
  });

  it('returns only the changed declared paths, sorted, when several are frozen', () => {
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'b.txt'), 'b');
    writeFileSync(join(root, 'c.txt'), 'c');
    // Declared out of sorted order on purpose, to prove the result is sorted.
    const guard = new FrozenEvalGuard(root, ['c.txt', 'b.txt', 'a.txt']);
    writeFileSync(join(root, 'c.txt'), 'c-changed');
    writeFileSync(join(root, 'a.txt'), 'a-changed');
    // b.txt is untouched, so it must not appear; a and c come back sorted.
    expect(guard.changedFrozenPaths()).toEqual(['a.txt', 'c.txt']);
  });
});

// Schema-level tests for fix.change-set@v1 and fix.baseline-snapshot@v1.
// Focuses on the verdict rules (status ↔ overall_status, derived sets,
// HEAD-divergence and hidden-index-flag invariants) and the entry-level
// shape of baseline snapshots. Writer-level behavior (subtracting pre-fix
// dirt, mutation detection, helper plumbing) is covered in
// tests/runner/fix-change-set-writer.test.ts.

import { describe, expect, it } from 'vitest';
import { FixBaselineSnapshot, FixChangeSet } from '../../src/flows/fix/reports.js';

const ZERO_SHA = '0000000000000000000000000000000000000000';
const ONE_SHA = '1111111111111111111111111111111111111111';
const BLOB_A = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BLOB_B = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

describe('FixBaselineSnapshot schema', () => {
  it('accepts an empty working tree', () => {
    const snapshot = FixBaselineSnapshot.parse({
      overall_status: 'passed',
      head_sha: ZERO_SHA,
      entries: [],
      hidden_index_flags: [],
    });
    expect(snapshot.head_sha).toBe(ZERO_SHA);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.hidden_index_flags).toEqual([]);
  });

  it('accepts a dirty working tree with porcelain entries and fingerprints', () => {
    const snapshot = FixBaselineSnapshot.parse({
      overall_status: 'passed',
      head_sha: ZERO_SHA,
      entries: [
        { status_code: ' M', path: 'src/example.ts', fingerprint: BLOB_A },
        { status_code: '??', path: 'notes.txt', fingerprint: BLOB_B },
      ],
      hidden_index_flags: [],
    });
    expect(snapshot.entries).toHaveLength(2);
  });

  it('accepts hidden index flags surfaced from ls-files -v', () => {
    const snapshot = FixBaselineSnapshot.parse({
      overall_status: 'passed',
      head_sha: ZERO_SHA,
      entries: [],
      hidden_index_flags: [
        { tag: 'h', path: 'src/locked.ts' },
        { tag: 'S', path: 'sparse.ts' },
      ],
    });
    expect(snapshot.hidden_index_flags).toHaveLength(2);
  });

  it('rejects a non-passed overall_status', () => {
    expect(
      FixBaselineSnapshot.safeParse({
        overall_status: 'failed',
        head_sha: ZERO_SHA,
        entries: [],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty head_sha', () => {
    expect(
      FixBaselineSnapshot.safeParse({
        overall_status: 'passed',
        head_sha: '',
        entries: [],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an entry with a malformed status_code length', () => {
    expect(
      FixBaselineSnapshot.safeParse({
        overall_status: 'passed',
        head_sha: ZERO_SHA,
        entries: [{ status_code: 'M', path: 'src/example.ts', fingerprint: BLOB_A }],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });
});

describe('FixChangeSet schema', () => {
  function passing(overrides: Partial<{ declared: string[]; observed: string[] }> = {}) {
    const declared = overrides.declared ?? ['src/example.ts'];
    const observed = overrides.observed ?? ['src/example.ts'];
    const observedSet = new Set(observed);
    const declaredSet = new Set(declared);
    return {
      status: 'pass' as const,
      overall_status: 'passed' as const,
      baseline_head_sha: ZERO_SHA,
      head_sha: ZERO_SHA,
      declared,
      observed,
      undeclared_extras: observed.filter((p) => !declaredSet.has(p)),
      missing_declared: declared.filter((p) => !observedSet.has(p)),
      baseline_dirty_mutated: [],
      hidden_index_flags: [],
    };
  }

  it('accepts a clean pass when declared matches observed exactly', () => {
    expect(FixChangeSet.parse(passing()).status).toBe('pass');
  });

  it('accepts a fail with undeclared extras and a reason', () => {
    const changeSet = FixChangeSet.parse({
      status: 'fail',
      overall_status: 'failed',
      reason: 'Touched files outside the declared scope.',
      baseline_head_sha: ZERO_SHA,
      head_sha: ZERO_SHA,
      declared: ['src/example.ts'],
      observed: ['src/example.ts', 'src/extra.ts'],
      undeclared_extras: ['src/extra.ts'],
      missing_declared: [],
      baseline_dirty_mutated: [],
      hidden_index_flags: [],
    });
    expect(changeSet.undeclared_extras).toEqual(['src/extra.ts']);
  });

  it('rejects status pass when there are undeclared extras', () => {
    expect(
      FixChangeSet.safeParse({
        ...passing(),
        observed: ['src/example.ts', 'src/extra.ts'],
        undeclared_extras: ['src/extra.ts'],
      }).success,
    ).toBe(false);
  });

  it('rejects status pass when a declared file is missing from observed', () => {
    expect(
      FixChangeSet.safeParse({
        ...passing(),
        declared: ['src/a.ts', 'src/b.ts'],
        observed: ['src/a.ts'],
        missing_declared: ['src/b.ts'],
      }).success,
    ).toBe(false);
  });

  it('rejects status fail when the sets are clean and HEAD did not move', () => {
    expect(
      FixChangeSet.safeParse({
        ...passing(),
        status: 'fail',
        overall_status: 'failed',
        reason: 'should not happen',
      }).success,
    ).toBe(false);
  });

  it('rejects overall_status that contradicts status', () => {
    expect(
      FixChangeSet.safeParse({
        ...passing(),
        overall_status: 'failed',
      }).success,
    ).toBe(false);
    expect(
      FixChangeSet.safeParse({
        ...passing(),
        status: 'fail',
        reason: 'mismatch',
        observed: [],
        missing_declared: ['src/example.ts'],
      }).success,
    ).toBe(false);
  });

  it('requires undeclared_extras to equal observed minus declared', () => {
    expect(
      FixChangeSet.safeParse({
        status: 'fail',
        overall_status: 'failed',
        reason: 'extras computed wrong',
        baseline_head_sha: ZERO_SHA,
        head_sha: ZERO_SHA,
        declared: ['src/a.ts'],
        observed: ['src/a.ts', 'src/b.ts'],
        // src/b.ts is the undeclared extra; this test omits it incorrectly.
        undeclared_extras: [],
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });

  it('requires missing_declared to equal declared minus observed', () => {
    expect(
      FixChangeSet.safeParse({
        status: 'fail',
        overall_status: 'failed',
        reason: 'missing computed wrong',
        baseline_head_sha: ZERO_SHA,
        head_sha: ZERO_SHA,
        declared: ['src/a.ts', 'src/b.ts'],
        observed: ['src/a.ts'],
        undeclared_extras: [],
        // src/b.ts is missing; this test omits it incorrectly.
        missing_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });

  it('requires a reason when status is fail', () => {
    expect(
      FixChangeSet.safeParse({
        status: 'fail',
        overall_status: 'failed',
        baseline_head_sha: ZERO_SHA,
        head_sha: ZERO_SHA,
        declared: ['src/a.ts'],
        observed: [],
        undeclared_extras: [],
        missing_declared: ['src/a.ts'],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });

  it("rejects status 'pass' when baseline_head_sha differs from head_sha", () => {
    // The HEAD-divergence invariant: status='pass' must imply HEAD did not
    // move. The schema enforces this even when path-set differences are
    // clean — defense against a writer (or future stub) that emits 'pass'
    // with a moved HEAD.
    const result = FixChangeSet.safeParse({
      ...passing(),
      head_sha: ONE_SHA,
    });
    expect(result.success).toBe(false);
  });

  it("requires status 'fail' when HEAD diverged, even with clean path sets", () => {
    // Symmetric to the above: HEAD divergence with empty undeclared_extras
    // and missing_declared is still a fail; the schema must accept the fail
    // verdict.
    const result = FixChangeSet.parse({
      status: 'fail',
      overall_status: 'failed',
      reason: 'HEAD moved during the fix run.',
      baseline_head_sha: ZERO_SHA,
      head_sha: ONE_SHA,
      declared: [],
      observed: [],
      undeclared_extras: [],
      missing_declared: [],
      baseline_dirty_mutated: [],
      hidden_index_flags: [],
    });
    expect(result.head_sha).toBe(ONE_SHA);
  });

  it("rejects status 'pass' when hidden_index_flags is non-empty", () => {
    const result = FixChangeSet.safeParse({
      ...passing(),
      hidden_index_flags: [{ tag: 'h', path: 'src/locked.ts' }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts status 'fail' when only hidden_index_flags is non-empty", () => {
    const result = FixChangeSet.parse({
      status: 'fail',
      overall_status: 'failed',
      reason: 'Hidden index flags present.',
      baseline_head_sha: ZERO_SHA,
      head_sha: ZERO_SHA,
      declared: [],
      observed: [],
      undeclared_extras: [],
      missing_declared: [],
      baseline_dirty_mutated: [],
      hidden_index_flags: [{ tag: 'h', path: 'src/locked.ts' }],
    });
    expect(result.hidden_index_flags).toHaveLength(1);
  });

  it('rejects baseline_dirty_mutated paths that are not also in observed', () => {
    const result = FixChangeSet.safeParse({
      ...passing(),
      // src/a.ts is mutated but not in observed — the writer would never emit
      // this shape, but the schema rejects it as a defense-in-depth.
      baseline_dirty_mutated: ['src/a.ts'],
    });
    expect(result.success).toBe(false);
  });
  // Contamination forgiveness: a declared path that was already dirty at run
  // start and untouched since is reported separately from a real overclaim.
  // The schema cannot verify the fingerprint comparison that classifies it —
  // it has no fingerprints — so it enforces the structural invariants instead.
  it('accepts a pass when a declared path is recorded as pre-existing dirt', () => {
    const result = FixChangeSet.parse({
      ...passing({ declared: ['src/example.ts', 'src/stale.ts'] }),
      missing_declared: [],
      declared_pre_existing_dirt: ['src/stale.ts'],
    });
    expect(result.status).toBe('pass');
    expect(result.declared_pre_existing_dirt).toEqual(['src/stale.ts']);
  });

  it('rejects declared_pre_existing_dirt paths that were not declared', () => {
    const result = FixChangeSet.safeParse({
      ...passing(),
      declared_pre_existing_dirt: ['src/never-declared.ts'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a path claimed as both observed and pre-existing dirt', () => {
    const result = FixChangeSet.safeParse({
      ...passing(),
      declared_pre_existing_dirt: ['src/example.ts'],
    });
    expect(result.success).toBe(false);
  });

  // The empty-work guard. Without it, a run that changed nothing could excuse
  // its whole declared list as pre-existing dirt and close clean.
  it('rejects pre-existing dirt when nothing at all was observed', () => {
    const result = FixChangeSet.safeParse({
      status: 'pass',
      overall_status: 'passed',
      baseline_head_sha: ZERO_SHA,
      head_sha: ZERO_SHA,
      declared: ['src/stale.ts'],
      observed: [],
      undeclared_extras: [],
      missing_declared: [],
      declared_pre_existing_dirt: ['src/stale.ts'],
      baseline_dirty_mutated: [],
      hidden_index_flags: [],
    });
    expect(result.success).toBe(false);
  });
});

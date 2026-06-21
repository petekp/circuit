// Parse-arg contract for the shape-sensitivity sweep flags (--composed-shape and
// --composed-only) added to the dynamic-vs-reference harness for Phase D. These
// are pure-function checks ($0): they lock the flag semantics before any live
// spend, so a typo in the sweep command fails loud rather than silently running
// the wrong shape or both arms.

import { describe, expect, it } from 'vitest';
import {
  type DynManifest,
  parseDynArgs,
} from '../../evals/dynamic-vs-reference/run-dynamic-comparison.js';

const MANIFEST: DynManifest = {
  benchmark_id: 'dynamic-vs-reference',
  default_provider: 'claude-code',
  default_model: 'claude-haiku-4-5-20251001',
  default_effort: 'medium',
  default_timeout_ms: 900000,
  reps_per_task: 1,
  families: { fix: ['fix-null-guard'], build: ['build-add-helper'] },
  expected_grain: {},
  fold_cost_tasks: [],
};

describe('parseDynArgs — shape-sensitivity sweep flags', () => {
  it('defaults: no composed shape, not composed-only', () => {
    const args = parseDynArgs([], MANIFEST);
    expect(args.composedShape).toBeUndefined();
    expect(args.composedOnly).toBe(false);
    expect(args.withComposed).toBe(false);
  });

  it('--composed-shape selects a known shape and implies --with-composed', () => {
    const args = parseDynArgs(['--composed-shape', 'fix-linear-lean'], MANIFEST);
    expect(args.composedShape).toBe('fix-linear-lean');
    expect(args.withComposed).toBe(true);
  });

  it('--composed-only skips ref/gen and implies --with-composed', () => {
    const args = parseDynArgs(['--composed-only'], MANIFEST);
    expect(args.composedOnly).toBe(true);
    expect(args.withComposed).toBe(true);
  });

  it('accepts every registered fix shape id', () => {
    for (const shape of ['fix-linear-lean', 'fix-linear-full', 'fix-linear-loop']) {
      const args = parseDynArgs(['--composed-shape', shape], MANIFEST);
      expect(args.composedShape).toBe(shape);
    }
  });

  it('rejects an unknown composed shape (fails loud, no silent wrong-shape run)', () => {
    expect(() => parseDynArgs(['--composed-shape', 'fix-linear-bogus'], MANIFEST)).toThrow(
      /--composed-shape must be one of/,
    );
  });

  it('rejects --composed-shape on the build family (build runs BUILD_LINEAR_FULL)', () => {
    expect(() =>
      parseDynArgs(['--composed-shape', 'fix-linear-lean', '--family', 'build'], MANIFEST),
    ).toThrow(/applies to the fix family/);
  });

  it('full sweep invocation parses (lean, fix-only, composed-only, pinned)', () => {
    const args = parseDynArgs(
      [
        '--family',
        'fix',
        '--composed-only',
        '--composed-shape',
        'fix-linear-lean',
        '--pin-model',
        'claude-haiku-4-5-20251001',
        '--reps',
        '3',
      ],
      MANIFEST,
    );
    expect(args.family).toBe('fix');
    expect(args.composedOnly).toBe(true);
    expect(args.composedShape).toBe('fix-linear-lean');
    expect(args.withComposed).toBe(true);
    expect(args.pinModel).toBe(true);
    expect(args.model).toBe('claude-haiku-4-5-20251001');
    expect(args.reps).toBe(3);
  });
});

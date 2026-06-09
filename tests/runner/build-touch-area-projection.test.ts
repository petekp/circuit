// Unit tests for the build.touch-area@v1 containment projection.
//
// This is the load-bearing security logic of the hard touch-area gate: given
// the git-proven set of files the implementer changed and the plan's declared
// allowed area, decide whether the change stayed in bounds. The match is a
// segment-safe path-prefix test (no glob metacharacters, so no injection
// surface), fail-closed when containment cannot be proven.

import { describe, expect, it } from 'vitest';
import { projectBuildTouchArea } from '../../src/flows/build/writers/touch-area-projection.js';
import type { RuntimeTouchedFilesProjection } from '../../src/shared/runtime-touched-files.js';

function touched(
  overrides: Partial<RuntimeTouchedFilesProjection> & {
    readonly paths?: readonly string[];
  } = {},
): RuntimeTouchedFilesProjection {
  const { paths, ...rest } = overrides;
  return {
    baseline_head_sha: 'aaaa',
    head_sha: 'aaaa',
    head_diverged: false,
    files: (paths ?? []).map((path) => ({
      path,
      status: 'modified' as const,
      source: 'runtime_diff' as const,
      generated_surface: false,
      protected: false,
    })),
    worker_declared: [],
    worker_claim_matches_runtime: true,
    undeclared_worker_extras: [],
    missing_worker_declared: [],
    baseline_dirty_mutated: [],
    hidden_index_flags: [],
    ...rest,
  };
}

describe('projectBuildTouchArea', () => {
  it('is not_enforced and inert when no area is declared', () => {
    const result = projectBuildTouchArea({
      allowedArea: [],
      touched: touched({ paths: ['src/anywhere.ts', 'wild/west.ts'] }),
    });
    expect(result.enforcement).toBe('not_enforced');
    expect(result.containment).toBe('within');
    expect(result.out_of_bounds_paths).toEqual([]);
    // It still records what git observed, for transparency.
    expect(result.observed_paths).toEqual(['src/anywhere.ts', 'wild/west.ts']);
  });

  it('is within when every changed path is inside a declared subtree', () => {
    const result = projectBuildTouchArea({
      allowedArea: ['src/flows/build/', 'tests/'],
      touched: touched({ paths: ['src/flows/build/x.ts', 'tests/contracts/y.test.ts'] }),
    });
    expect(result.enforcement).toBe('enforced');
    expect(result.containment).toBe('within');
    expect(result.out_of_bounds_paths).toEqual([]);
  });

  it('flags a path outside the area as out_of_bounds', () => {
    const result = projectBuildTouchArea({
      allowedArea: ['src/flows/build/'],
      touched: touched({ paths: ['src/flows/build/x.ts', 'src/runtime/engine.ts'] }),
    });
    expect(result.containment).toBe('out_of_bounds');
    expect(result.out_of_bounds_paths).toEqual(['src/runtime/engine.ts']);
  });

  it('flags a rename whose source is outside the area, even when the destination is inside', () => {
    // git mv out-of-area into the allowed area emits ONE porcelain entry whose
    // path is the in-bounds destination and whose `from` is the out-of-bounds
    // source. Without checking `from`, the move would launder an out-of-area
    // file deletion past the gate. The source must be flagged out_of_bounds.
    const result = projectBuildTouchArea({
      allowedArea: ['src/area/'],
      touched: touched({
        files: [
          {
            path: 'src/area/moved.ts',
            from: 'src/elsewhere/original.ts',
            status: 'renamed',
            source: 'runtime_diff',
            generated_surface: false,
            protected: false,
          },
        ],
      }),
    });
    expect(result.containment).toBe('out_of_bounds');
    expect(result.out_of_bounds_paths).toEqual(['src/elsewhere/original.ts']);
    // Both endpoints are surfaced as observed, for operator transparency.
    expect(result.observed_paths).toEqual(['src/area/moved.ts', 'src/elsewhere/original.ts']);
  });

  it('is within when a rename keeps both source and destination inside the area', () => {
    const result = projectBuildTouchArea({
      allowedArea: ['src/area/'],
      touched: touched({
        files: [
          {
            path: 'src/area/new.ts',
            from: 'src/area/old.ts',
            status: 'renamed',
            source: 'runtime_diff',
            generated_surface: false,
            protected: false,
          },
        ],
      }),
    });
    expect(result.containment).toBe('within');
    expect(result.out_of_bounds_paths).toEqual([]);
  });

  it('matches subtree entries on segment boundaries, not raw string prefix', () => {
    // "src/flows/build/" must NOT contain "src/flows/build-other/...".
    const result = projectBuildTouchArea({
      allowedArea: ['src/flows/build/'],
      touched: touched({ paths: ['src/flows/build-other/x.ts'] }),
    });
    expect(result.containment).toBe('out_of_bounds');
    expect(result.out_of_bounds_paths).toEqual(['src/flows/build-other/x.ts']);
  });

  it('treats a trailing slash as optional on a subtree entry', () => {
    const withSlash = projectBuildTouchArea({
      allowedArea: ['src/flows/build/'],
      touched: touched({ paths: ['src/flows/build/x.ts'] }),
    });
    const withoutSlash = projectBuildTouchArea({
      allowedArea: ['src/flows/build'],
      touched: touched({ paths: ['src/flows/build/x.ts'] }),
    });
    expect(withSlash.containment).toBe('within');
    expect(withoutSlash.containment).toBe('within');
  });

  it('allows an exact file-path entry', () => {
    const result = projectBuildTouchArea({
      allowedArea: ['src/flows/build/data.ts'],
      touched: touched({ paths: ['src/flows/build/data.ts'] }),
    });
    expect(result.containment).toBe('within');
  });

  it('is undetermined (fail-closed) when HEAD moved mid-run, even if paths look in-bounds', () => {
    const result = projectBuildTouchArea({
      allowedArea: ['src/flows/build/'],
      touched: touched({
        paths: ['src/flows/build/x.ts'],
        head_diverged: true,
        head_sha: 'bbbb',
      }),
    });
    expect(result.containment).toBe('undetermined');
    expect(result.out_of_bounds_paths).toEqual([]);
    expect(result.reason).toMatch(/HEAD/i);
  });

  it('is undetermined (fail-closed) when a path is hidden from git status', () => {
    const result = projectBuildTouchArea({
      allowedArea: ['src/flows/build/'],
      touched: touched({
        paths: ['src/flows/build/x.ts'],
        hidden_index_flags: [{ tag: 'h', path: 'src/secret.ts' }],
      }),
    });
    expect(result.containment).toBe('undetermined');
    expect(result.reason).toMatch(/hidden|assume-unchanged|skip-worktree/i);
  });

  it('does not fail-close a not_enforced gate when HEAD moved', () => {
    // No area declared = the operator opted out; a mid-run commit must not block.
    const result = projectBuildTouchArea({
      allowedArea: [],
      touched: touched({ paths: ['anything.ts'], head_diverged: true, head_sha: 'bbbb' }),
    });
    expect(result.enforcement).toBe('not_enforced');
    expect(result.containment).toBe('within');
  });
});

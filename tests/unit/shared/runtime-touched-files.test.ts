import { describe, expect, it } from 'vitest';

import {
  type RuntimeGitStateSnapshot,
  projectRuntimeTouchedFiles,
} from '../../../src/shared/runtime-touched-files.js';

function snapshot(options: Partial<RuntimeGitStateSnapshot> = {}): RuntimeGitStateSnapshot {
  return {
    head_sha: 'a'.repeat(40),
    entries: [],
    hidden_index_flags: [],
    ...options,
  };
}

describe('projectRuntimeTouchedFiles', () => {
  it('projects runtime-observed added, deleted, renamed, and modified files', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot({
        entries: [
          { status_code: ' M', path: 'src/changed.ts', fingerprint: 'before' },
          { status_code: ' M', path: 'src/deleted.ts', fingerprint: 'before' },
        ],
      }),
      post: snapshot({
        entries: [
          { status_code: ' M', path: 'src/changed.ts', fingerprint: 'after' },
          { status_code: ' D', path: 'src/deleted.ts', fingerprint: '<deleted>' },
          { status_code: '??', path: 'src/new.ts', fingerprint: 'new' },
          { status_code: ' M', path: 'src/tracked.ts', fingerprint: 'tracked' },
          {
            status_code: 'R ',
            path: 'src/new-name.ts',
            from: 'src/old-name.ts',
            fingerprint: 'renamed',
          },
        ],
      }),
      workerDeclaredPaths: [
        'src/changed.ts',
        'src/deleted.ts',
        'src/new-name.ts',
        'src/new.ts',
        'src/tracked.ts',
      ],
    });

    expect(projection.files).toEqual([
      {
        path: 'src/changed.ts',
        status: 'modified',
        source: 'runtime_diff',
        generated_surface: false,
        protected: false,
      },
      {
        path: 'src/deleted.ts',
        status: 'deleted',
        source: 'runtime_diff',
        generated_surface: false,
        protected: false,
      },
      {
        path: 'src/new-name.ts',
        status: 'renamed',
        source: 'runtime_diff',
        generated_surface: false,
        protected: false,
        // The rename source is carried so a containment consumer sees both
        // endpoints; it does not enter `observed` / the worker-claim sets.
        from: 'src/old-name.ts',
      },
      {
        path: 'src/new.ts',
        status: 'added',
        source: 'runtime_diff',
        generated_surface: false,
        protected: false,
      },
      {
        path: 'src/tracked.ts',
        status: 'modified',
        source: 'runtime_diff',
        generated_surface: false,
        protected: false,
      },
    ]);
    expect(projection.worker_claim_matches_runtime).toBe(true);
  });

  it('detects worker declarations that differ from runtime-observed files', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot(),
      post: snapshot({
        entries: [{ status_code: '??', path: 'src/actual.ts', fingerprint: 'actual' }],
      }),
      workerDeclaredPaths: ['src/claimed.ts'],
    });

    expect(projection.worker_claim_matches_runtime).toBe(false);
    expect(projection.undeclared_worker_extras).toEqual(['src/actual.ts']);
    expect(projection.missing_worker_declared).toEqual(['src/claimed.ts']);
  });

  // A declared path that was already dirty at run start and still carries the
  // same fingerprint was not touched by this run. That is a different fact
  // from "declared a file that was never dirty at all", which is a genuine
  // overclaim, so the two get separate fields and only the second one fails.
  it('separates declared pre-existing dirt from a genuine overclaim', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot({
        entries: [{ status_code: ' M', path: 'src/stale.ts', fingerprint: 'same' }],
      }),
      post: snapshot({
        entries: [
          { status_code: ' M', path: 'src/stale.ts', fingerprint: 'same' },
          { status_code: '??', path: 'src/actual.ts', fingerprint: 'actual' },
        ],
      }),
      workerDeclaredPaths: ['src/actual.ts', 'src/never-touched.ts', 'src/stale.ts'],
    });

    expect(projection.files.map((file) => file.path)).toEqual(['src/actual.ts']);
    expect(projection.declared_pre_existing_dirt).toEqual(['src/stale.ts']);
    expect(projection.missing_worker_declared).toEqual(['src/never-touched.ts']);
    expect(projection.worker_claim_matches_runtime).toBe(false);
  });

  it('does not forgive pre-existing dirt when the run observed no changes at all', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot({
        entries: [{ status_code: ' M', path: 'src/stale.ts', fingerprint: 'same' }],
      }),
      post: snapshot({
        entries: [{ status_code: ' M', path: 'src/stale.ts', fingerprint: 'same' }],
      }),
      workerDeclaredPaths: ['src/stale.ts'],
    });

    expect(projection.files).toEqual([]);
    expect(projection.declared_pre_existing_dirt).toEqual([]);
    expect(projection.missing_worker_declared).toEqual(['src/stale.ts']);
    expect(projection.worker_claim_matches_runtime).toBe(false);
  });

  it('treats baseline-dirty paths that become clean as runtime-touched files', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot({
        entries: [{ status_code: ' M', path: 'src/preexisting.ts', fingerprint: 'dirty' }],
      }),
      post: snapshot(),
      workerDeclaredPaths: ['src/preexisting.ts'],
    });

    expect(projection.files).toEqual([
      {
        path: 'src/preexisting.ts',
        status: 'modified',
        source: 'runtime_diff',
        generated_surface: false,
        protected: false,
      },
    ]);
    expect(projection.baseline_dirty_mutated).toEqual(['src/preexisting.ts']);
  });

  it('carries hidden index flags and head divergence as close-blocking facts', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot({
        head_sha: 'a'.repeat(40),
        hidden_index_flags: [{ tag: 'h', path: 'src/hidden.ts' }],
      }),
      post: snapshot({
        head_sha: 'b'.repeat(40),
        hidden_index_flags: [{ tag: 's', path: 'src/skip.ts' }],
      }),
    });

    expect(projection.head_diverged).toBe(true);
    expect(projection.hidden_index_flags).toEqual([
      { tag: 'h', path: 'src/hidden.ts' },
      { tag: 's', path: 'src/skip.ts' },
    ]);
  });

  it('marks generated and protected paths using explicit prefixes', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot(),
      post: snapshot({
        entries: [
          {
            status_code: '??',
            path: 'generated/flows/fix/circuit.work-contract.v0.json',
            fingerprint: 'generated',
          },
          { status_code: '??', path: 'src/runtime/run/guidance.ts', fingerprint: 'runtime' },
        ],
      }),
      generatedSurfacePathPrefixes: ['generated', 'plugins/claude/skills'],
      protectedPathPrefixes: ['src/runtime'],
    });

    expect(projection.files).toEqual([
      {
        path: 'generated/flows/fix/circuit.work-contract.v0.json',
        status: 'added',
        source: 'runtime_diff',
        generated_surface: true,
        protected: false,
      },
      {
        path: 'src/runtime/run/guidance.ts',
        status: 'added',
        source: 'runtime_diff',
        generated_surface: false,
        protected: true,
      },
    ]);
  });

  it('ignores configured path prefixes before comparing worker claims', () => {
    const projection = projectRuntimeTouchedFiles({
      baseline: snapshot(),
      post: snapshot({
        entries: [
          { status_code: '??', path: 'reports/run.json', fingerprint: 'report' },
          { status_code: '??', path: 'src/actual.ts', fingerprint: 'actual' },
        ],
      }),
      workerDeclaredPaths: ['reports/run.json', 'src/actual.ts'],
      ignoredPathPrefixes: ['reports'],
    });

    expect(projection.files.map((file) => file.path)).toEqual(['src/actual.ts']);
    expect(projection.worker_declared).toEqual(['src/actual.ts']);
    expect(projection.worker_claim_matches_runtime).toBe(true);
  });
});

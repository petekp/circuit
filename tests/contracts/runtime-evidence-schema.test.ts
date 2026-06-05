import { describe, expect, it } from 'vitest';

import {
  RuntimeGitStateSnapshotReport,
  RuntimeTouchedFilesReport,
} from '../../src/schemas/runtime-evidence.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('runtime evidence schemas', () => {
  it('accepts a runtime git state snapshot report', () => {
    const snapshot = RuntimeGitStateSnapshotReport.parse({
      overall_status: 'passed',
      head_sha: HEAD,
      entries: [
        {
          status_code: ' M',
          path: 'src/example.ts',
          fingerprint: 'before',
        },
      ],
      hidden_index_flags: [{ tag: 'h', path: 'src/hidden.ts' }],
    });

    expect(snapshot.entries[0]?.path).toBe('src/example.ts');
  });

  it('accepts touched-file evidence without deciding safe-apply authority', () => {
    const report = RuntimeTouchedFilesReport.parse({
      overall_status: 'failed',
      baseline_head_sha: HEAD,
      head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      head_diverged: true,
      files: [
        {
          path: 'src/runtime/run/graph-runner.ts',
          status: 'modified',
          source: 'runtime_diff',
          generated_surface: false,
          protected: true,
        },
        {
          path: 'generated/flows/build/circuit.json',
          status: 'modified',
          source: 'runtime_diff',
          generated_surface: true,
          protected: false,
        },
      ],
      worker_declared: ['src/runtime/run/graph-runner.ts'],
      worker_claim_matches_runtime: false,
      undeclared_worker_extras: ['generated/flows/build/circuit.json'],
      missing_worker_declared: [],
      baseline_dirty_mutated: [],
      hidden_index_flags: [],
    });

    expect(report.files.map((file) => [file.path, file.protected, file.generated_surface])).toEqual(
      [
        ['src/runtime/run/graph-runner.ts', true, false],
        ['generated/flows/build/circuit.json', false, true],
      ],
    );
  });

  it('rejects a passing touched-file report with mismatch facts', () => {
    expect(
      RuntimeTouchedFilesReport.safeParse({
        overall_status: 'passed',
        baseline_head_sha: HEAD,
        head_sha: HEAD,
        head_diverged: false,
        files: [
          {
            path: 'src/extra.ts',
            status: 'added',
            source: 'runtime_diff',
            generated_surface: false,
            protected: false,
          },
        ],
        worker_declared: [],
        worker_claim_matches_runtime: false,
        undeclared_worker_extras: ['src/extra.ts'],
        missing_worker_declared: [],
        baseline_dirty_mutated: [],
        hidden_index_flags: [],
      }).success,
    ).toBe(false);
  });
});

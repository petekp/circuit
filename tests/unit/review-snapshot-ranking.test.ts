// The classifier behind a snapshot's read order.
//
// The integration proof lives in tests/runner/review-snapshot-priority.test.ts,
// which shows a whole-codebase review reaching source instead of prose. This
// file covers the classification itself, including the cases where getting it
// wrong would hide real code rather than merely reorder it.

import { describe, expect, it } from 'vitest';

import {
  rankSnapshotPaths,
  snapshotRank,
} from '../../src/flows/review/writers/snapshot-ranking.js';

describe('snapshotRank', () => {
  it.each([
    'src/runtime/graph-runner.ts',
    'app/models/user.rb',
    'cmd/server/main.go',
    'scripts/release/publish.sh',
    'src/components/Panel.tsx',
  ])('reads %s as production source', (path) => {
    expect(snapshotRank(path)).toBe('source');
  });

  it.each([
    'tests/runner/review-e2e.test.ts',
    'src/flows/__tests__/build.ts',
    'evals/fix-vs-vanilla/task.mjs',
    'spec/models/user_spec.rb',
    'tests/fixtures/sweep-fixture/scan.mjs',
    'examples/basic/index.ts',
  ])('reads %s as supporting source', (path) => {
    expect(snapshotRank(path)).toBe('test');
  });

  it.each(['package.json', 'tsconfig.json', '.github/workflows/ci.yml', 'Dockerfile', '.nvmrc'])(
    'reads %s as config',
    (path) => {
      expect(snapshotRank(path)).toBe('config');
    },
  );

  it.each(['README.md', 'docs/flows/authoring-model.md', 'NOTES.txt'])(
    'reads %s as prose',
    (path) => {
      expect(snapshotRank(path)).toBe('prose');
    },
  );

  it.each([
    'package-lock.json',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'dist/index.js',
    'node_modules/left-pad/index.js',
    'vendor/github.com/pkg/errors/errors.go',
    'src/app.min.js',
    'src/api.pb.go',
    'tests/__snapshots__/render.snap',
    'dist/index.js.map',
  ])('reads %s as generated', (path) => {
    expect(snapshotRank(path)).toBe('generated');
  });

  it('lets a generated location outrank what the extension says', () => {
    // Compiler output carries the same extension as its source. Reviewing
    // `dist/runtime.ts` instead of `src/runtime.ts` is worse than reviewing
    // neither, because the finding would be about a build artifact.
    expect(snapshotRank('src/runtime.ts')).toBe('source');
    expect(snapshotRank('dist/runtime.ts')).toBe('generated');
  });

  it('does not read a plain file with an unknown extension as generated', () => {
    // Guessing "artifact" for anything unrecognized would hide real code behind
    // whichever extensions this list happens not to know yet.
    expect(snapshotRank('src/query.hcl')).toBe('other');
  });
});

describe('rankSnapshotPaths', () => {
  it('keeps every matched path and only changes the order', () => {
    const matched = [
      'docs/guide.md',
      'package-lock.json',
      'src/a.ts',
      'tests/a.test.ts',
      'tsconfig.json',
    ];
    const ranked = rankSnapshotPaths(matched);

    expect([...ranked].sort()).toEqual([...matched].sort());
    expect(ranked).toEqual([
      'src/a.ts',
      'tests/a.test.ts',
      'tsconfig.json',
      'docs/guide.md',
      'package-lock.json',
    ]);
  });

  it('keeps Git order within one rank so the result is deterministic', () => {
    const ranked = rankSnapshotPaths(['src/b.ts', 'src/a.ts', 'src/c.ts']);
    expect(ranked).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts']);
  });
});

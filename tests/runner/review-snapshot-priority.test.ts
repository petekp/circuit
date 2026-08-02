// What a whole-codebase review actually reads.
//
// A snapshot lists tracked files with `git ls-files` and spends its budget in
// the order Git returns them, which is alphabetical by path. That order has
// nothing to do with what a code review needs. On this repository it means the
// 288-file budget is exhausted inside `docs/` and `apps/` and the reviewer
// never sees one line of `src/`, yet the run still returns a verdict on "this
// codebase". The count in the coverage note was honest; the selection was not
// review of a codebase in any sense the operator meant.
//
// So the budget has to be spent on the files a review is for. Ranking, not
// exclusion: nothing is removed from the matched set, the order in which the
// budget is spent changes, and whatever the budget does not reach is still
// reported as unread.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ComposeBuildContext } from '../../src/flows/registries/compose-writers/types.js';
import { ReviewIntake } from '../../src/flows/review/reports.js';
import { reviewIntakeComposeBuilder } from '../../src/flows/review/writers/intake.js';
import { reviewRunFolderBase, useReviewRunFolders } from './review-wiring-harness.js';

// More prose files than the snapshot budget holds, so alphabetical order alone
// guarantees the source files are never reached.
const PROSE_FILE_COUNT = 320;

function codebaseWithMoreProseThanBudget(label: string): string {
  const projectRoot = join(reviewRunFolderBase(), label);
  mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });

  const write = (path: string, body: string): void => {
    const absolute = join(projectRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  };

  for (let index = 0; index < PROSE_FILE_COUNT; index += 1) {
    write(`docs/note-${String(index).padStart(4, '0')}.md`, `# Note ${index}\n\nProse.\n`);
  }
  // Alphabetically last, and the only thing a code review is for.
  write('src/auth/login.ts', "export const login = () => 'MARKER-SOURCE-LOGIN';\n");
  write('src/auth/session.ts', "export const session = () => 'MARKER-SOURCE-SESSION';\n");
  // Tracked, generated, and enormous relative to its worth to a reviewer.
  write('generated/bundle.json', `${JSON.stringify({ blob: 'x'.repeat(50_000) })}\n`);
  write('package-lock.json', `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`);

  execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
  return projectRoot;
}

async function snapshotIntake(projectRoot: string): Promise<ReviewIntake> {
  const context = {
    goal: 'review this codebase',
    projectRoot,
    inputs: {},
  } as unknown as ComposeBuildContext;
  return ReviewIntake.parse(await reviewIntakeComposeBuilder.build(context));
}

function snapshotPaths(intake: ReviewIntake): readonly string[] {
  const evidence = intake.evidence;
  if (evidence.kind !== 'git-snapshot') {
    throw new Error(`expected a snapshot, got ${evidence.kind}`);
  }
  return evidence.files.map((file) => file.path);
}

describe('a whole-codebase review spends its budget on source first', () => {
  useReviewRunFolders();

  it('reads the source files even when prose fills the budget alphabetically', async () => {
    const projectRoot = codebaseWithMoreProseThanBudget('snapshot-priority-source');
    const paths = snapshotPaths(await snapshotIntake(projectRoot));

    expect(paths).toContain('src/auth/login.ts');
    expect(paths).toContain('src/auth/session.ts');
  });

  it('puts source ahead of prose in the order the budget is spent', async () => {
    const projectRoot = codebaseWithMoreProseThanBudget('snapshot-priority-order');
    const paths = snapshotPaths(await snapshotIntake(projectRoot));

    const firstProse = paths.findIndex((path) => path.startsWith('docs/'));
    const lastSource = paths.reduce(
      (last, path, index) => (path.startsWith('src/') ? index : last),
      -1,
    );
    expect(lastSource).toBeGreaterThanOrEqual(0);
    expect(firstProse).toBeGreaterThan(lastSource);
  });

  it('spends the budget on hand-written files before generated ones', async () => {
    const projectRoot = codebaseWithMoreProseThanBudget('snapshot-priority-generated');
    const paths = snapshotPaths(await snapshotIntake(projectRoot));

    // Both are tracked, so neither is excluded outright. They rank below every
    // hand-written file, and with prose alone overflowing the budget they never
    // come up.
    expect(paths).not.toContain('generated/bundle.json');
    expect(paths).not.toContain('package-lock.json');
  });

  it('still says how much of the tree it did not read', async () => {
    const projectRoot = codebaseWithMoreProseThanBudget('snapshot-priority-coverage');
    const intake = await snapshotIntake(projectRoot);

    const truncated = intake.evidence_warnings.find(
      (warning) => warning.kind === 'snapshot_truncated',
    );
    expect(truncated?.message).toContain(String(PROSE_FILE_COUNT + 4));
    // A reader who sees `src/` in the evidence and `docs/` missing must be able
    // to tell that the selection was ranked, not that the tree lacks docs.
    expect(truncated?.message).toMatch(/most\s+review|review value|ranked|priority/i);
  });

  it('does not reorder anything when the operator named the paths', async () => {
    const projectRoot = codebaseWithMoreProseThanBudget('snapshot-priority-scoped');
    const context = {
      goal: 'review docs/ as it stands',
      projectRoot,
      inputs: {},
    } as unknown as ComposeBuildContext;
    const intake = ReviewIntake.parse(await reviewIntakeComposeBuilder.build(context));

    // Ranking is relative within the matched set. An operator who asked for
    // docs gets docs, not an empty review because prose ranks low.
    expect(snapshotPaths(intake).every((path) => path.startsWith('docs/'))).toBe(true);
    expect(snapshotPaths(intake).length).toBeGreaterThan(0);
  });
});

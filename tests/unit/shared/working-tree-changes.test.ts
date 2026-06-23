import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureWorkingTreeChangedPaths } from '../../../src/shared/working-tree-changes.js';

/**
 * Hermetic tests for `captureWorkingTreeChangedPaths` (src/shared/working-tree-changes.ts).
 *
 * This helper shells out to real `git status` to answer one question for the
 * relay accept gate: "which repo-relative paths actually differ in the working
 * tree right now?" It is the ground truth a worker's self-reported `changed_files`
 * is checked against, so a worker can no longer claim a file it never touched.
 *
 * Hermeticity contract mirrors git-worktree-runner.test.ts: every repo is a
 * fresh `git init` in an OS temp dir with local-only identity; we never read or
 * mutate the surrounding circuit repo's git state. The helper resolves git from
 * the projectRoot argument (NOT process.cwd), so no chdir is required.
 */

function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function gitOk(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(`setup git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'circuit-wtc-'));
  gitOk(repoDir, '-c', 'init.defaultBranch=trunk', 'init');
  gitOk(repoDir, 'config', '--local', 'user.email', 'circuit-test@example.com');
  gitOk(repoDir, 'config', '--local', 'user.name', 'Circuit Test');
  gitOk(repoDir, 'config', '--local', 'commit.gpgsign', 'false');
  // Two committed, clean files. src/foo.ts will be mutated by individual tests;
  // src/clean.ts is the untouched control that must never appear as changed.
  await writeFile(join(repoDir, 'README.md'), 'base\n', 'utf8');
  gitOk(repoDir, 'add', 'README.md');
  // Nested path to prove paths come back repo-relative with forward slashes.
  await write(join(repoDir, 'src', 'foo.ts'), 'export const foo = 1;\n');
  await write(join(repoDir, 'src', 'clean.ts'), 'export const clean = 1;\n');
  gitOk(repoDir, 'add', 'src/foo.ts', 'src/clean.ts');
  gitOk(repoDir, 'commit', '-m', 'initial commit');
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

/** Write a file, creating parent directories as needed. */
async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

describe('captureWorkingTreeChangedPaths', () => {
  it('returns an empty set for a clean working tree', () => {
    const changed = captureWorkingTreeChangedPaths(repoDir);
    expect([...changed]).toEqual([]);
  });

  it('reports a modified tracked file as a repo-relative forward-slash path', async () => {
    await writeFile(join(repoDir, 'src', 'foo.ts'), 'export const foo = 2;\n', 'utf8');
    const changed = captureWorkingTreeChangedPaths(repoDir);
    expect(changed.has('src/foo.ts')).toBe(true);
    // The untouched committed control is never reported.
    expect(changed.has('src/clean.ts')).toBe(false);
  });

  it('reports an untracked new file', async () => {
    await writeFile(join(repoDir, 'src', 'bar.ts'), 'export const bar = 1;\n', 'utf8');
    const changed = captureWorkingTreeChangedPaths(repoDir);
    expect(changed.has('src/bar.ts')).toBe(true);
  });

  it('reports a deleted tracked file', async () => {
    await rm(join(repoDir, 'src', 'foo.ts'));
    const changed = captureWorkingTreeChangedPaths(repoDir);
    expect(changed.has('src/foo.ts')).toBe(true);
  });

  it('reports BOTH endpoints of a rename so a worker may claim either', () => {
    gitOk(repoDir, 'mv', 'src/foo.ts', 'src/foo2.ts');
    const changed = captureWorkingTreeChangedPaths(repoDir);
    expect(changed.has('src/foo2.ts')).toBe(true);
    expect(changed.has('src/foo.ts')).toBe(true);
  });

  it('discovers the repo when projectRoot is a SUBDIRECTORY of it (walks up, gate stays active)', async () => {
    // Circuit always passes the repo root as projectRoot, but the probe must
    // mirror git's own upward repo discovery: a nested projectRoot is still
    // inside the repo, so the gate must run rather than fail-open. This guards
    // against narrowing the no-subprocess fast path to a single-level .git check.
    await writeFile(join(repoDir, 'src', 'foo.ts'), 'export const foo = 3;\n', 'utf8');
    const nested = join(repoDir, 'src');
    expect(() => captureWorkingTreeChangedPaths(nested)).not.toThrow();
  });

  it('throws when the path is not a git repository (fail-closed at the call site)', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'circuit-notrepo-'));
    try {
      expect(() => captureWorkingTreeChangedPaths(notARepo)).toThrow();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

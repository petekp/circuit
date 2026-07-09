import { spawnSync } from 'node:child_process';
import type { WorktreeRunner } from '../run/child-runner.js';

export const gitWorktreeRunner: WorktreeRunner = {
  add({ worktreePath, baseRef, branchName, repoRoot }) {
    // Anchor git at the owning repo (repoRoot) so provisioning targets it and
    // not the caller's process cwd; fall back to process.cwd() when the caller
    // supplies no root, matching the changedFiles cwd threading below.
    const result = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
      encoding: 'utf8',
      ...(repoRoot === undefined ? {} : { cwd: repoRoot }),
    });
    if (result.status !== 0) {
      throw new Error(
        `git worktree add failed (exit ${result.status ?? 'null'}): ${result.stderr ?? ''}`.trim(),
      );
    }
  },
  remove(worktreePath, repoRoot) {
    const result = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
      ...(repoRoot === undefined ? {} : { cwd: repoRoot }),
    });
    if (result.status !== 0) {
      throw new Error(
        `git worktree remove failed (exit ${result.status ?? 'null'}): ${
          result.stderr ?? ''
        }`.trim(),
      );
    }
  },
  changedFiles(worktreePath, baseRef) {
    const result = spawnSync('git', ['diff', '--name-only', `${baseRef}..HEAD`], {
      cwd: worktreePath,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `git diff --name-only failed (exit ${result.status ?? 'null'}): ${
          result.stderr ?? ''
        }`.trim(),
      );
    }
    return (result.stdout ?? '').split('\n').filter((line) => line.length > 0);
  },
};

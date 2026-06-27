import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitCommitContainmentRunner } from '../../src/runtime/run/commit-containment.js';

// The git-backed runner runs against a REAL throwaway repo in a tmpdir, so the
// test exercises the same checkout / add / commit path the engine drives, not a
// stub. The repo is isolated, so nothing here touches the working tree.
let repo: string;

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

function writeAndStageNothing(name: string, body: string): void {
  writeFileSync(join(repo, name), body, 'utf8');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'circuit-commit-containment-'));
  // Force a known base branch name so the assertions do not depend on the host's
  // init.defaultBranch config.
  git(['init', '-b', 'base']);
  git(['config', 'user.email', 'test@circuit.local']);
  git(['config', 'user.name', 'Circuit Test']);
  writeAndStageNothing('seed.txt', 'seed\n');
  git(['add', '-A']);
  git(['commit', '-m', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('createGitCommitContainmentRunner', () => {
  it('contains each iteration as a commit on a throwaway branch, leaving the base branch untouched', () => {
    const baseHead = git(['rev-parse', 'base']);
    const runner = createGitCommitContainmentRunner(repo);

    runner.begin({ branchName: 'circuit/converge-run1' });
    // Iteration 0 mutates a file, iteration 1 mutates another.
    writeAndStageNothing('iter0.txt', 'work 0\n');
    runner.commitIteration({ iterationIndex: 0, message: 'route reenter' });
    writeAndStageNothing('iter1.txt', 'work 1\n');
    runner.commitIteration({ iterationIndex: 1, message: 'route pass' });

    // The run ended on the throwaway branch, not the operator's base branch.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('circuit/converge-run1');
    // The base branch ref never moved: the operator owns whether this merges.
    expect(git(['rev-parse', 'base'])).toBe(baseHead);

    // Two iteration commits on top of the seed, in order, tagged by iteration.
    const log = git(['log', '--format=%s', 'circuit/converge-run1']).split('\n');
    expect(log).toEqual([
      'circuit until-loop iteration 1: route pass',
      'circuit until-loop iteration 0: route reenter',
      'seed',
    ]);
  });

  it('records a commit even for an iteration that changed nothing (--allow-empty keeps one commit per pass)', () => {
    const runner = createGitCommitContainmentRunner(repo);
    runner.begin({ branchName: 'circuit/converge-run2' });
    // No file change before the commit: without --allow-empty this would be a
    // no-op and the branch history would drift from the iteration count.
    runner.commitIteration({ iterationIndex: 0, message: 'route pass' });

    const log = git(['log', '--format=%s', 'circuit/converge-run2']).split('\n');
    expect(log).toEqual(['circuit until-loop iteration 0: route pass', 'seed']);
  });

  it('throws when git fails (a branch name that already exists)', () => {
    const runner = createGitCommitContainmentRunner(repo);
    git(['branch', 'circuit/taken']);
    expect(() => runner.begin({ branchName: 'circuit/taken' })).toThrow(/git checkout failed/);
  });
});

// Per-iteration commit containment for the until loop (slice 7).
//
// An autonomous until loop re-enters its body many times, each pass mutating the
// project's working tree in place. That is the highest-blast-radius part of the
// whole feature: a bad pass leaves the operator's tree in a half-changed state
// with no clean boundary between iterations. Containment moves the loop onto a
// throwaway branch — each iteration becomes one commit, the operator's original
// branch ref never moves, and the operator owns the merge at the end. Nothing is
// ever merged or pushed by the engine.
//
// This is OPT-IN and DEFAULT OFF. The engine makes zero git calls unless a flow
// declares `iterationCommitContainment` AND the host injects a runner. The git
// runner is a factory closed over an explicit project root (never process.cwd(),
// per the host-identity rule), so the engine never reaches for ambient cwd.

import { spawnSync } from 'node:child_process';

export interface CommitContainmentRunner {
  // Called once, before the first iteration commit: move onto the throwaway
  // branch so every subsequent commit lands there, not on the operator's branch.
  begin(input: { branchName: string }): void | Promise<void>;
  // Called once per completed iteration: snapshot the working tree as one commit
  // on the throwaway branch.
  commitIteration(input: { iterationIndex: number; message: string }): void | Promise<void>;
}

// A git-backed runner operating in an explicit working directory. Throws on any
// git failure (the seam treats a containment failure as fatal: a loop asked to
// contain its commits must not silently run uncontained).
export function createGitCommitContainmentRunner(cwd: string): CommitContainmentRunner {
  function git(args: readonly string[]): void {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(
        `git ${args[0]} failed (exit ${result.status ?? 'null'}): ${(result.stderr ?? '').trim()}`,
      );
    }
  }
  return {
    begin({ branchName }) {
      // Switch onto a fresh throwaway branch rooted at the current HEAD, carrying
      // the working tree along. The operator's original branch ref stays put, so
      // they keep ownership of whether and how this work merges back.
      git(['checkout', '-b', branchName]);
    },
    commitIteration({ iterationIndex, message }) {
      git(['add', '-A']);
      // --allow-empty keeps one commit per iteration even when a pass changed
      // nothing on disk, so the branch history maps one-to-one to iterations.
      git([
        'commit',
        '--allow-empty',
        '-m',
        `circuit until-loop iteration ${iterationIndex}: ${message}`,
      ]);
    },
  };
}

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSealedGitRead } from './sealed-git-read.js';

/**
 * Walk from `start` up to the filesystem root looking for a `.git` entry (a
 * directory in a normal clone, a file in a linked worktree). This mirrors how
 * git itself discovers a repository, so we only shell out to `git status` when
 * there is actually a repo to query. A projectRoot outside any repo is answered
 * with cheap stat walks instead of a git subprocess that could only error.
 */
function isInsideGitRepo(start: string): boolean {
  let dir = start;
  // dirname('/') === '/' on POSIX, so the parent === dir test terminates at root.
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Capture the set of repo-relative paths that currently differ in the working
 * tree at `projectRoot`. This is the ground truth a relay worker's
 * self-reported `changed_files` is checked against, so a worker can no longer
 * claim a file it never touched.
 *
 * The set includes modified, added, untracked, and deleted paths, plus BOTH
 * endpoints of a rename (so a worker may legitimately claim either the old or
 * the new path). Paths come back repo-relative with forward slashes.
 *
 * Resolves git from the `projectRoot` argument (NOT process.cwd) so it is safe
 * to call from anywhere, including fanout worktrees whose path IS their
 * projectRoot. Throws on a missing project root or any git failure (including
 * "not a git repository"); the changed_on_disk evaluator catches that and
 * treats the claim as inapplicable (fail-open).
 */
export function captureWorkingTreeChangedPaths(projectRoot: string): Set<string> {
  // The relay accept gate runs this on every act pass, including each retry. A
  // projectRoot outside a git repo has an unobservable working tree, so the
  // caller fail-opens — detect that with stat walks rather than spawning a
  // git subprocess that can only error. Keeps the gate free off-git and out of
  // subprocess-heavy retry loops.
  if (!isInsideGitRepo(projectRoot)) {
    throw new Error(`not a git repository at or above '${projectRoot}'`);
  }
  // `--porcelain=v1 -z` is a stable, machine-parseable format: NUL-delimited
  // records with verbatim (unquoted) pathnames, so paths with spaces or unusual
  // characters need no unescaping. `--untracked-files=all` surfaces brand-new
  // files a worker may have created.
  const result = runSealedGitRead(projectRoot, 'working-tree-status');
  if (result.error !== undefined) {
    throw new Error(`git status failed to spawn in '${projectRoot}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(
      `git status exited ${result.status ?? 'null'} in '${projectRoot}': ${stderr || 'no stderr'}`,
    );
  }
  return parsePorcelainZ(result.stdout ?? '');
}

/**
 * Parse `git status --porcelain=v1 -z` output into a path set.
 *
 * Each record is `XY PATH` — exactly two status characters, a space, then the
 * pathname (which starts at offset 3 and runs to the NUL). A rename or copy
 * record (`R`/`C` in either status column) is immediately followed by a bare
 * original-path token with no status prefix; we consume it so both endpoints
 * are captured and the original path is not mis-read as its own status line.
 */
function parsePorcelainZ(stdout: string): Set<string> {
  const paths = new Set<string>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.length === 0) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path.length > 0) paths.add(path);
    if (status.includes('R') || status.includes('C')) {
      const original = tokens[i + 1];
      i += 1;
      if (original !== undefined && original.length > 0) paths.add(original);
    }
  }
  return paths;
}

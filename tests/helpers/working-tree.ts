import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Test helpers for the `changed_on_disk` acceptance check.
 *
 * The Build/Fix `act` steps now gate on a worker's self-reported `changed_files`
 * actually differing in the working tree. A faithful stub worker must therefore
 * reflect its claims onto disk — exactly what a real worker does. These helpers
 * let a stub relayer make its `changed_files` true, so end-to-end runtime tests
 * exercise the gate in the accept direction instead of tripping it.
 */

/**
 * Create an isolated git repository at `dir` with a committed baseline, using
 * local-only identity so commits succeed on any machine. Returns `dir`.
 */
export function initGitProjectRoot(dir: string): string {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture' }, null, 2)}\n`);
  const git = (...argv: string[]): void => {
    execFileSync('git', argv, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@circuit.local');
  git('config', 'user.name', 'circuit-fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return dir;
}

/**
 * Make each claimed path actually differ in the working tree at `projectRoot`.
 * A new path is created (untracked → dirty); an existing tracked path gets a
 * short marker appended (modified → dirty). Idempotent across repeated relay
 * calls — the file simply stays dirty.
 */
export function reflectChangedFiles(projectRoot: string, paths: readonly string[]): void {
  for (const rel of paths) {
    if (typeof rel !== 'string' || rel.length === 0) continue;
    const abs = join(projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (existsSync(abs)) {
      appendFileSync(abs, '\n// touched by stub worker\n');
    } else {
      writeFileSync(abs, '// created by stub worker\n');
    }
  }
}

/**
 * Pull `changed_files` out of a relay result body (best-effort) and reflect them
 * onto disk. Safe to call on any body; a non-JSON body or absent/empty
 * `changed_files` is a no-op.
 */
export function reflectClaimedChangedFiles(projectRoot: string, resultBody: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultBody);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;
  const claimed = (parsed as { readonly changed_files?: unknown }).changed_files;
  if (!Array.isArray(claimed)) return;
  reflectChangedFiles(
    projectRoot,
    claimed.filter((entry): entry is string => typeof entry === 'string'),
  );
}

// `--target <path>`: naming a place in the repository, not a Git selector.
//
// `--target` exists so the caller can say what to review outright instead of
// having a phrase grammar recover it from the goal. It accepted only Git
// selectors — working-tree, staged, unstaged, commit:<ref>, a range — while
// the prose grammar it was built to replace already understood places:
// "review src/auth" scopes to that path. So the dedicated flag was strictly
// less capable than the sentence, and `--target src/flows/review/writers` was
// refused outright. The flag now takes a path that exists in the project.
//
// A bare token is never a ref here (refs are spelled `commit:<ref>`), so an
// existing path is unambiguous. Anything that is not an existing path is still
// refused by name: a caller who stated an intent and got it wrong is better
// served by a rejection than by a review of something adjacent.

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseExplicitReviewTarget } from '../../src/flows/review/writers/intake.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'circuit-target-path-'));
  mkdirSync(join(projectRoot, 'src', 'auth'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'auth', 'login.ts'), 'export const login = () => {};\n');
  writeFileSync(join(projectRoot, 'README.md'), '# project\n');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function parse(value: string) {
  return parseExplicitReviewTarget(value, { projectRoot });
}

describe('parseExplicitReviewTarget with a path', () => {
  it('accepts a directory that exists in the project', () => {
    const parsed = parse('src/auth');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.target).toMatchObject({
      kind: 'working_tree',
      paths: { include: ['src/auth'], exclude: [] },
    });
  });

  it('accepts a single file', () => {
    const parsed = parse('src/auth/login.ts');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.target).toMatchObject({ paths: { include: ['src/auth/login.ts'] } });
  });

  // The prose grammar reads "review src/auth" as: review the changes there,
  // and if there are none, review the code as it stands. A named path means
  // the same thing, so it carries the same fallback rather than coming back
  // empty on a clean tree.
  it('falls back to a snapshot of the path when nothing changed there', () => {
    const parsed = parse('src/auth');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshotFallback).toEqual({ include: ['src/auth'], exclude: [] });
  });

  it('normalizes a leading ./ and a trailing slash to the stored path', () => {
    for (const written of ['./src/auth', 'src/auth/', './src/auth/']) {
      const parsed = parse(written);
      expect(parsed.ok, written).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.target).toMatchObject({ paths: { include: ['src/auth'] } });
    }
  });

  it('takes the repository root itself', () => {
    const parsed = parse('.');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.target).toMatchObject({ paths: { include: ['.'] } });
  });

  it('still refuses a value that names nothing in the project', () => {
    const parsed = parse('src/does-not-exist');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('src/does-not-exist');
    expect(parsed.reason).toContain('working-tree');
  });

  // "Review does not know the target" is true of a word Circuit never heard
  // of. Said of a path, it is the wrong diagnosis: the form was understood
  // and the path is simply not there. An operator reading the vocabulary list
  // for a typo in their own path is being sent to the wrong place.
  it('tells a path that is not there apart from a word it never knew', () => {
    const missing = parse('src/does-not-exist');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toContain('no "src/does-not-exist" in this repository');
    expect(missing.reason).toContain('Check the path');

    const unknown = parse('yesterday');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.reason).toContain('does not know the target "yesterday"');
  });

  // A path-shaped value that leaves the project is not "not there": saying so
  // would confirm what does and does not exist outside the repository. It
  // keeps the vocabulary refusal.
  it('does not report on existence outside the project', () => {
    const parsed = parse('/etc/passwd');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('does not know the target');
    expect(parsed.reason).not.toContain('in this repository.');
  });

  // A path walking out of the project used to be read as a range with a
  // missing end, because it contains "..". That diagnosis sends the operator
  // to fix Git syntax they never wrote.
  it('reads a leading ../ as a path leaving the project, not a half-written range', () => {
    const parsed = parse('../../etc/passwd');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('points outside this repository');
    expect(parsed.reason).not.toContain('missing one of its ends');
  });

  it('refuses a path that escapes the project root', () => {
    const parsed = parse('../..');
    expect(parsed.ok).toBe(false);
  });

  it('refuses an absolute path outside the project root', () => {
    const parsed = parse('/etc');
    expect(parsed.ok).toBe(false);
  });

  it('refuses a symbolic link rather than following it out of the project', () => {
    symlinkSync(tmpdir(), join(projectRoot, 'escape'));
    const parsed = parse('escape');
    expect(parsed.ok).toBe(false);
  });

  // Found by running Review on this change. Checking only the final component
  // leaves an intermediate symlinked directory free to carry the path out of
  // the project: resolve() is lexical, so the containment check passes on a
  // path the filesystem then traverses somewhere else entirely.
  it('refuses a path that leaves the project through a symlinked parent', () => {
    const outside = mkdtempSync(join(tmpdir(), 'circuit-target-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'not ours\n');
      symlinkSync(outside, join(projectRoot, 'linked'));
      expect(parse('linked/secret.txt').ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // The containment check has to compare canonical paths on both sides, or a
  // project root that is itself reached through a symlink (macOS /tmp is
  // /private/tmp) refuses every path in its own project.
  it('accepts a path when the project root itself is reached through a symlink', () => {
    const parsed = parseExplicitReviewTarget('src/auth', {
      projectRoot: realpathSync(projectRoot),
    });
    expect(parsed.ok).toBe(true);
  });

  // Git selectors keep winning: a repository that happens to contain a
  // directory named `staged` must not change what `--target staged` means.
  it('keeps the Git vocabulary ahead of a same-named directory', () => {
    mkdirSync(join(projectRoot, 'staged'));
    const parsed = parse('staged');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.target).toMatchObject({ kind: 'working_tree', mode: 'staged' });
  });

  // Without a project root there is nothing to check a path against, so the
  // closed Git vocabulary is all that is left. Callers that can supply a root
  // do; this is the honest behavior when one is absent, not a fallback worth
  // guessing through.
  it('refuses a path when no project root was supplied', () => {
    expect(parseExplicitReviewTarget('src/auth').ok).toBe(false);
  });
});

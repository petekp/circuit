import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, classify, globToRegExp } from '../../scripts/docs/doc-classes.ts';
import {
  committedGeneratedCodeOutputs,
  committedGeneratedOutputs,
  committedRuntimeBundleOutputs,
  generatedMarkdownOutputs,
} from '../../scripts/generated/committed-generated-outputs.ts';

// The generated-surface guard. Its set is the generated runtime code artifacts
// plus the generated markdown (see committed-generated-outputs.ts for why
// generated JSON is out of scope — check-flow-drift re-emits and compares that).
// Every member of this set must be protected from a hand-edit that the next
// emit would silently overwrite — either by the Edit-deny list in
// .claude/settings.json (the only option for non-markdown artifacts) or by a
// `generated` class in docs/doc-classes.json (which routes the doc-rot gates at
// the generator). The set is derived from the generators, so adding a registered
// runtime artifact or generated-markdown destination without protecting it fails
// here instead of shipping editable.

function denyGlobs(): string[] {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, '.claude/settings.json'), 'utf8')) as {
    permissions?: { deny?: unknown };
  };
  const deny = raw.permissions?.deny;
  if (!Array.isArray(deny)) return [];
  return deny
    .filter((rule): rule is string => typeof rule === 'string' && rule.startsWith('Edit('))
    .map((rule) => rule.slice('Edit('.length, -1).replace(/^\//, ''));
}

function isDenied(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function isGeneratedClass(path: string): boolean {
  return classify(path)?.class === 'generated';
}

function trackedFiles(): Set<string> {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return new Set(out.split('\n').filter((line) => line !== ''));
}

describe('generated-surface guard', () => {
  it('derives a non-empty set of committed generated outputs (loud on empty)', () => {
    // 2 runtime bundles + 2 git-state + 2 launcher-core sidecars.
    expect(committedRuntimeBundleOutputs()).toEqual(
      expect.arrayContaining([
        'plugins/claude/runtime/circuit.js',
        'plugins/codex/runtime/circuit.js',
        'plugins/claude/runtime/git-state.js',
        'plugins/codex/runtime/git-state.js',
        'plugins/claude/scripts/launcher-core.ts',
        'plugins/codex/scripts/launcher-core.ts',
      ]),
    );
    expect(committedGeneratedCodeOutputs()).toEqual(
      expect.arrayContaining([
        'plugins/codex/.mcp.json',
        'plugins/codex/mcp/server.cjs',
        'plugins/codex/mcp/server.mjs',
        'src/shared/html/checkpoint-review-runtime.generated.ts',
      ]),
    );
    expect(committedGeneratedCodeOutputs().length).toBeGreaterThanOrEqual(10);
    // The generated code plus generated markdown (generated-surfaces.md, the
    // two release docs, and the host command/skill mirrors).
    expect(committedGeneratedOutputs().length).toBeGreaterThanOrEqual(8);
    expect(generatedMarkdownOutputs().length).toBeGreaterThanOrEqual(2);
  });

  it('lists only files that are actually tracked', () => {
    const tracked = trackedFiles();
    const missing = committedGeneratedOutputs().filter((path) => !tracked.has(path));
    expect(missing, 'committed generated outputs that are not tracked').toEqual([]);
  });

  it('covers every committed generated output by deny list or doc-classes', () => {
    const globs = denyGlobs();
    const unprotected = committedGeneratedOutputs().filter(
      (path) => !isDenied(path, globs) && !isGeneratedClass(path),
    );
    expect(
      unprotected,
      'generated outputs covered by neither the Edit-deny list nor a doc-classes `generated` entry',
    ).toEqual([]);
  });

  it('protects every non-markdown generated artifact with the Edit-deny list', () => {
    // doc-classes only governs markdown, so the .js/.ts runtime artifacts have
    // no fallback: the deny list is the only thing standing between them and a
    // hand-edit the next emit would clobber.
    const globs = denyGlobs();
    const undenied = committedGeneratedCodeOutputs().filter((path) => !isDenied(path, globs));
    expect(undenied, 'generated code artifacts missing from the Edit-deny list').toEqual([]);
  });
});

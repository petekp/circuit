import { describe, expect, it } from 'vitest';
import { rankDiffText, splitDiffSections } from '../../src/flows/review/writers/diff-ranking.js';
import { declaredGeneratedMatcher } from '../../src/flows/review/writers/snapshot-ranking.js';

function section(path: string, body: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    body,
    '',
  ].join('\n');
}

function paddedSection(path: string, chars: number): string {
  return section(path, `+${'x'.repeat(chars)}`);
}

describe('splitDiffSections', () => {
  it('names each section by the path it changes', () => {
    const diff = `${section('src/a.ts', '+one')}${section('docs/b.md', '+two')}`;
    expect(splitDiffSections(diff).map((entry) => entry.path)).toEqual(['src/a.ts', 'docs/b.md']);
  });

  it('reads a path containing a space from the marker lines, not the header', () => {
    const diff = section('src/two words.ts', '+one');
    expect(splitDiffSections(diff)[0]?.path).toBe('src/two words.ts');
  });

  it('keeps anything before the first file section as unnamed preamble', () => {
    const diff = `commit abc123\nAuthor: someone\n\n${section('src/a.ts', '+one')}`;
    const sections = splitDiffSections(diff);
    expect(sections[0]?.path).toBe('');
    expect(sections[0]?.text).toContain('commit abc123');
    expect(sections[1]?.path).toBe('src/a.ts');
  });
});

describe('rankDiffText', () => {
  it('returns a diff that fits verbatim, with no coverage footer', () => {
    const diff = `${section('src/a.ts', '+one')}${section('docs/b.md', '+two')}`;
    const ranked = rankDiffText(diff, 10_000);
    expect(ranked.text).toBe(diff);
    expect(ranked.truncated).toBe(false);
    expect(ranked.matchedFileCount).toBe(2);
    expect(ranked.includedFileCount).toBe(2);
  });

  // The failure this whole module exists for. Git emits sections in path
  // order, so a head slice of this diff keeps `docs/` and reaches no source.
  it('keeps source when an alphabetically earlier prose file would fill the budget', () => {
    const diff = `${paddedSection('docs/aaa.md', 6_000)}${paddedSection('src/zzz.ts', 1_000)}`;
    const ranked = rankDiffText(diff, 4_000);
    expect(ranked.text).toContain('src/zzz.ts');
    expect(ranked.text).not.toContain('docs/aaa.md\n+xxx');
    expect(ranked.truncated).toBe(true);
    expect(ranked.matchedFileCount).toBe(2);
    expect(ranked.includedFileCount).toBe(1);
  });

  it('passes over a section too large for the budget instead of stopping there', () => {
    const diff = [
      paddedSection('src/huge.ts', 20_000),
      paddedSection('src/small.ts', 100),
      paddedSection('src/also-small.ts', 100),
    ].join('');
    const ranked = rankDiffText(diff, 4_000);
    expect(ranked.text).toContain('src/small.ts');
    expect(ranked.text).toContain('src/also-small.ts');
    expect(ranked.includedFileCount).toBe(2);
  });

  it('reassembles the kept sections in the diff order, not the rank order', () => {
    const diff = [
      paddedSection('docs/a.md', 200),
      paddedSection('src/b.ts', 200),
      paddedSection('docs/c.md', 200),
      paddedSection('src/d.ts', 4_000),
    ].join('');
    const ranked = rankDiffText(diff, 2_000);
    const text = ranked.text;
    expect(text.indexOf('docs/a.md')).toBeLessThan(text.indexOf('src/b.ts'));
    expect(text.indexOf('src/b.ts')).toBeLessThan(text.indexOf('docs/c.md'));
  });

  it('names what it did not inspect', () => {
    const diff = `${paddedSection('docs/aaa.md', 6_000)}${paddedSection('src/zzz.ts', 1_000)}`;
    const ranked = rankDiffText(diff, 4_000);
    expect(ranked.text).toContain('this diff changes 2 files. Review read 1 of them');
    expect(ranked.text).toContain('Not inspected: docs/aaa.md');
  });

  it('never returns an empty diff, even when no section fits', () => {
    const diff = paddedSection('src/huge.ts', 50_000);
    const ranked = rankDiffText(diff, 1_000);
    expect(ranked.text.length).toBeGreaterThan(0);
    expect(ranked.text).toContain('src/huge.ts');
    expect(ranked.truncated).toBe(true);
  });

  // The concrete case: this repository's compiled host bundles are plain `.js`
  // at a path with no generated-looking segment, so name-based ranking reads
  // them as source. `.gitattributes` has said otherwise since July.
  it('demotes a file the project declared generated in .gitattributes', () => {
    const diff = [
      paddedSection('plugins/claude/runtime/circuit.js', 3_000),
      paddedSection('src/cli/doctor.ts', 3_000),
    ].join('');
    const isDeclaredGenerated = declaredGeneratedMatcher(
      'plugins/claude/runtime/circuit.js linguist-generated=true\n',
    );
    const ranked = rankDiffText(diff, 5_000, { isDeclaredGenerated });
    expect(ranked.text).toContain('src/cli/doctor.ts');
    expect(ranked.text).toContain('Not inspected: plugins/claude/runtime/circuit.js');
  });
});

describe('declaredGeneratedMatcher', () => {
  it('is false for everything when there is no .gitattributes', () => {
    const matcher = declaredGeneratedMatcher(undefined);
    expect(matcher('plugins/claude/runtime/circuit.js')).toBe(false);
  });

  it('ignores comments, macro definitions, and unrelated attributes', () => {
    const matcher = declaredGeneratedMatcher(
      ['# a comment', '[attr]binary -diff -merge -text', '* text=auto eol=lf', ''].join('\n'),
    );
    expect(matcher('src/a.ts')).toBe(false);
  });

  it('matches an exact rooted path', () => {
    const matcher = declaredGeneratedMatcher('plugins/codex/runtime/circuit.js linguist-generated');
    expect(matcher('plugins/codex/runtime/circuit.js')).toBe(true);
    expect(matcher('src/runtime/circuit.js')).toBe(false);
  });

  it('matches a double-star pattern across directories, including zero of them', () => {
    const matcher = declaredGeneratedMatcher('generated/flows/**/*.json linguist-generated=true');
    expect(matcher('generated/flows/review/a.json')).toBe(true);
    expect(matcher('generated/flows/a.json')).toBe(true);
    expect(matcher('generated/other/a.json')).toBe(false);
  });

  it('matches a slash-free pattern against the file name at any depth', () => {
    const matcher = declaredGeneratedMatcher('*.pb.go linguist-generated=true');
    expect(matcher('api/v1/service.pb.go')).toBe(true);
    expect(matcher('api/v1/service.go')).toBe(false);
  });

  it('treats a trailing slash as the directory contents', () => {
    const matcher = declaredGeneratedMatcher('docs/release/proofs/runs/ linguist-generated=true');
    expect(matcher('docs/release/proofs/runs/a/b.json')).toBe(true);
    expect(matcher('docs/release/proofs/runs')).toBe(false);
  });

  it('lets a later line unset an earlier one', () => {
    const matcher = declaredGeneratedMatcher(
      ['dist/** linguist-generated=true', 'dist/keep.ts -linguist-generated'].join('\n'),
    );
    expect(matcher('dist/bundle.js')).toBe(true);
    expect(matcher('dist/keep.ts')).toBe(false);
  });

  // Read from the real file rather than a fixture: the point of the rule is
  // that this repository's own bundles are covered, and a fixture copy would
  // keep passing after someone edited the real one.
  it("covers this repository's own compiled host bundles", async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const matcher = declaredGeneratedMatcher(readFileSync(`${root}.gitattributes`, 'utf8'));
    expect(matcher('plugins/claude/runtime/circuit.js')).toBe(true);
    expect(matcher('plugins/codex/runtime/circuit.js')).toBe(true);
    expect(matcher('src/cli/doctor.ts')).toBe(false);
  });
});

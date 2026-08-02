// The order a snapshot spends its budget in.
//
// A snapshot lists tracked files with `git ls-files`, which returns them
// alphabetically by path. Spending a bounded budget in that order makes the
// review's subject an accident of naming. On this repository it filled the
// entire 288-file budget inside `docs/` and `apps/` and reached no source at
// all, while the run still answered a question about "this codebase".
//
// This ranks the matched set instead. Nothing is dropped: every matched file
// stays in the list, the coverage note still reports how many were read against
// how many matched, and a scope the operator named is unaffected because ranking
// is relative within whatever matched. What changes is which files the budget
// reaches first.
//
// Ranking by path rather than by content is deliberate. Reading a header from
// every tracked file to look for a generated marker would cost a syscall per
// file on a tree of thousands, and the paths already carry the signal: the
// directories that hold generated and vendored output are named for it, and
// lockfiles are named exactly.

import { basename, extname } from 'node:path';

// Read first. Files whose contents are the thing a code review is about.
const SOURCE_EXTENSIONS = new Set([
  'astro',
  'bash',
  'c',
  'cc',
  'cjs',
  'clj',
  'cpp',
  'cs',
  'css',
  'cts',
  'cxx',
  'dart',
  'elm',
  'erl',
  'ex',
  'exs',
  'fish',
  'fs',
  'go',
  'h',
  'hh',
  'hpp',
  'hs',
  'java',
  'jl',
  'js',
  'jsx',
  'kt',
  'kts',
  'lua',
  'm',
  'mjs',
  'ml',
  'mm',
  'mts',
  'php',
  'pl',
  'ps1',
  'py',
  'r',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'zsh',
]);

// Source, but supporting rather than shipped. Read after production code for
// the same reason a reviewer opens the implementation before its test: a
// finding in the code is a finding, a finding in a fixture is usually a note
// about the fixture. Ranking these apart is what stops a large fixture corpus
// from consuming the whole budget — on this repository the eval fixtures alone
// are 257 source files, more than the budget holds.
const TEST_PATH_SEGMENTS = new Set([
  '__mocks__',
  '__tests__',
  'benchmark',
  'benchmarks',
  'demo',
  'demos',
  'e2e',
  'eval',
  'evals',
  'example',
  'examples',
  'fixture',
  'fixtures',
  'mocks',
  'sample',
  'samples',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);

const TEST_FILENAME_PATTERN = /[._-](?:test|spec|bench)\.[A-Za-z0-9]+$/u;

// Read after test source. Not the subject of a review, but often the reason a
// finding is real: what gets built, what runs in CI, what the entrypoint is.
const CONFIG_EXTENSIONS = new Set([
  'cfg',
  'conf',
  'graphql',
  'ini',
  'json',
  'json5',
  'jsonc',
  'properties',
  'proto',
  'toml',
  'yaml',
  'yml',
]);

const CONFIG_FILENAMES = new Set([
  'dockerfile',
  'justfile',
  'makefile',
  'procfile',
  'rakefile',
  'taskfile',
]);

// Read after config. Prose about the code is not the code.
const PROSE_EXTENSIONS = new Set(['adoc', 'markdown', 'md', 'mdx', 'org', 'rst', 'text', 'txt']);

// Read last. Tracked, but written by a tool rather than by a person, so a
// finding in one of them is a finding about its generator.
const GENERATED_PATH_SEGMENTS = new Set([
  '__generated__',
  '__snapshots__',
  '.next',
  '.nuxt',
  '.turbo',
  'bower_components',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'third_party',
  'thirdparty',
  'vendor',
]);

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'flake.lock',
  'gemfile.lock',
  'go.sum',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
]);

const GENERATED_EXTENSIONS = new Set(['map', 'snap']);

const GENERATED_FILENAME_PATTERN = /\.(?:min|bundle|generated|gen|pb)\.[A-Za-z0-9]+$/u;

export const SNAPSHOT_RANKS = ['source', 'test', 'config', 'prose', 'generated', 'other'] as const;
export type SnapshotRank = (typeof SNAPSHOT_RANKS)[number];

const RANK_ORDER: Readonly<Record<SnapshotRank, number>> = {
  source: 0,
  test: 1,
  config: 2,
  prose: 3,
  // Below prose but above nothing: a file with no recognized extension is more
  // likely a script or a fixture than a build artifact, and guessing it is an
  // artifact would hide real code behind a naming convention this list happens
  // not to know.
  other: 4,
  generated: 5,
};

function fileExtension(path: string): string {
  return extname(path).replace(/^\./u, '').toLowerCase();
}

/**
 * What kind of file this path is, for the purpose of deciding read order.
 *
 * A generated or vendored location outranks everything else the name says: a
 * `.ts` file under `dist/` is compiler output, and reviewing it instead of its
 * source is worse than not reviewing it at all.
 */
export function snapshotRank(path: string): SnapshotRank {
  const segments = path.split('/');
  const name = basename(path).toLowerCase();
  if (segments.slice(0, -1).some((segment) => GENERATED_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    return 'generated';
  }
  if (LOCKFILE_NAMES.has(name)) return 'generated';
  if (GENERATED_FILENAME_PATTERN.test(name)) return 'generated';

  const extension = fileExtension(path);
  if (GENERATED_EXTENSIONS.has(extension)) return 'generated';
  if (SOURCE_EXTENSIONS.has(extension)) {
    const supporting =
      segments.slice(0, -1).some((segment) => TEST_PATH_SEGMENTS.has(segment.toLowerCase())) ||
      TEST_FILENAME_PATTERN.test(name);
    return supporting ? 'test' : 'source';
  }
  if (PROSE_EXTENSIONS.has(extension)) return 'prose';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  if (CONFIG_FILENAMES.has(name)) return 'config';
  // A dotfile with no extension (`.gitignore`, `.nvmrc`) is configuration.
  if (extension.length === 0 && name.startsWith('.')) return 'config';
  return 'other';
}

// A project that generates files usually says so, and there is one portable
// place it says it: `linguist-generated` in `.gitattributes`. GitHub reads it
// to collapse those files in a diff, so it is already maintained for exactly
// the audience a review is. Reading it means Circuit stops guessing on the
// cases a path cannot reveal.
//
// This repository is one of them. Its compiled host bundles live at
// `plugins/claude/runtime/circuit.js` — no `dist/`, no `.min.`, a plain `.js`
// extension — so every name-based rule above reads them as source, and at
// seven megabytes each they outranked the entire `src/` tree they were
// compiled from. `.gitattributes` has declared them generated since July.
//
// Supported subset, stated plainly because a silent partial match would be
// worse than none: `#` comments and `[macro]` definitions are skipped, a
// pattern may be double-quoted, `*` matches inside one path segment, `**`
// matches across segments, `?` matches one character that is not a slash, a
// pattern containing no slash matches the file name at any depth, a trailing
// slash means the directory's contents, and the last matching line wins.
// Character classes (`[a-z]`) are matched literally. Only the repository
// root's `.gitattributes` is read; a nested one is not.
const GENERATED_ATTRIBUTE = 'linguist-generated';

function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const directoryOnly = anchored.endsWith('/');
  const body = directoryOnly ? anchored.slice(0, -1) : anchored;
  // A pattern with no slash is a file-name match at any depth. One with a
  // slash is anchored to the file that declared it, which is the repo root.
  const rooted = body.includes('/') ? body : `**/${body}`;
  let source = '';
  for (let index = 0; index < rooted.length; index += 1) {
    const char = rooted[index] as string;
    if (char === '*') {
      if (rooted[index + 1] === '*') {
        // `**/` may also match zero directories, so `**/x` matches `x`.
        if (rooted[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}${directoryOnly ? '/.*' : ''}$`, 'u');
}

function attributeVerdict(attributes: readonly string[]): boolean | undefined {
  let verdict: boolean | undefined;
  for (const attribute of attributes) {
    if (attribute === GENERATED_ATTRIBUTE || attribute === `${GENERATED_ATTRIBUTE}=true`) {
      verdict = true;
    } else if (
      attribute === `-${GENERATED_ATTRIBUTE}` ||
      attribute === `${GENERATED_ATTRIBUTE}=false`
    ) {
      verdict = false;
    }
  }
  return verdict;
}

/**
 * Read a `.gitattributes` file into a predicate for "the project calls this
 * generated". A file with no such declaration yields a predicate that is false
 * for everything, so a caller never has to branch on whether one existed.
 */
export function declaredGeneratedMatcher(
  gitattributes: string | undefined,
): (path: string) => boolean {
  const rules: { readonly match: RegExp; readonly generated: boolean }[] = [];
  for (const rawLine of (gitattributes ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('[')) continue;
    const quoted = line.startsWith('"') ? /^"((?:[^"\\]|\\.)*)"\s*(.*)$/u.exec(line) : null;
    const pattern = quoted === null ? (line.split(/\s+/u)[0] as string) : (quoted[1] as string);
    const rest = quoted === null ? line.slice(pattern.length) : (quoted[2] as string);
    const generated = attributeVerdict(rest.split(/\s+/u).filter((part) => part.length > 0));
    if (generated === undefined) continue;
    try {
      rules.push({ match: globToRegExp(pattern), generated });
    } catch {
      // An unparseable pattern is one rule Circuit does not get to use, not a
      // reason to fail a review that was going to run either way.
    }
  }
  if (rules.length === 0) return () => false;
  return (path: string) => {
    let verdict = false;
    for (const rule of rules) {
      if (rule.match.test(path)) verdict = rule.generated;
    }
    return verdict;
  };
}

/**
 * The matched set, reordered so a bounded read reaches the files a review is
 * for. Stable within a rank, so the result is deterministic and still reads
 * like the tree it came from.
 */
export function rankSnapshotPaths(
  paths: readonly string[],
  options?: { readonly isDeclaredGenerated?: (path: string) => boolean },
): readonly string[] {
  const declared = options?.isDeclaredGenerated;
  return paths
    .map((path, index) => ({
      path,
      index,
      order: declared?.(path) === true ? RANK_ORDER.generated : RANK_ORDER[snapshotRank(path)],
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((entry) => entry.path);
}

#!/usr/bin/env node
// Doc-class manifest loader. docs/doc-classes.json assigns every tracked
// markdown file to exactly one class (first matching glob wins):
//
//   living     — current guidance; doc-rot gates scan these
//   historical — point-in-time records; kept as written, never scanned
//   generated  — emitted by a script; fix the generator, not the file
//   evidence   — captured run output; the recorded bytes are the point
//
// The manifest is deliberately catch-all-free. A tracked .md that matches
// no entry is an error (every new doc family must be classified on
// purpose), and an entry matching zero tracked files is an error (an
// empty glob silently hides rot — the alpha.6 lesson).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MANIFEST_PATH = join(REPO_ROOT, 'docs/doc-classes.json');

export const DOC_CLASS_VALUES = ['living', 'historical', 'generated', 'evidence'] as const;
export type DocClass = (typeof DOC_CLASS_VALUES)[number];

export type DocClassEntry = {
  glob: string;
  class: DocClass;
  generator?: string;
};

export type DocClassManifest = {
  schema_version: number;
  entries: DocClassEntry[];
};

export type ClassifiedDoc = {
  path: string;
  class: DocClass;
  entry: DocClassEntry;
};

export type DocClassification = {
  docs: ClassifiedDoc[];
  errors: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isDocClass(value: unknown): value is DocClass {
  return typeof value === 'string' && (DOC_CLASS_VALUES as readonly string[]).includes(value);
}

export function loadDocClasses(): DocClassManifest {
  const raw: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    fail('docs/doc-classes.json must be a JSON object');
  }
  const manifest = raw as { schema_version?: unknown; entries?: unknown };
  if (manifest.schema_version !== 1) {
    fail('docs/doc-classes.json schema_version must be 1');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail('docs/doc-classes.json entries must be a non-empty array');
  }

  const entries = manifest.entries.map((value: unknown, index: number): DocClassEntry => {
    const label = `entries[${index}]`;
    if (typeof value !== 'object' || value === null) {
      fail(`${label} must be an object`);
    }
    const entry = value as { glob?: unknown; class?: unknown; generator?: unknown };
    if (typeof entry.glob !== 'string' || entry.glob.trim() === '') {
      fail(`${label}.glob must be a non-empty string`);
    }
    if (!isDocClass(entry.class)) {
      fail(`${label}.class must be one of ${DOC_CLASS_VALUES.join('|')}`);
    }
    if (
      entry.class === 'generated' &&
      (typeof entry.generator !== 'string' || entry.generator.trim() === '')
    ) {
      fail(`${label} (${entry.glob}) is generated and must name its generator`);
    }
    if (entry.class !== 'generated' && entry.generator !== undefined) {
      fail(`${label} (${entry.glob}) must not name a generator unless class is generated`);
    }
    if (entry.glob === '**' || entry.glob === '**/*.md' || entry.glob === '**/*') {
      fail(`${label} is a catch-all glob; classify each doc family explicitly`);
    }
    return typeof entry.generator === 'string'
      ? { glob: entry.glob, class: entry.class, generator: entry.generator }
      : { glob: entry.glob, class: entry.class };
  });

  return { schema_version: 1, entries };
}

// Manifest globs: `**/` spans zero or more directories, `**` spans
// anything including `/`, `*` spans within one path segment.
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      source += '.*';
      i += 2;
      continue;
    }
    const char = glob.charAt(i);
    source += char === '*' ? '[^/]*' : char.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

// The classification universe: every tracked markdown file, which includes
// the tracked .claude/skills/**/*.md skill docs.
export function trackedMarkdownFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.md'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((line) => line !== '');
}

export function classifyAll(): DocClassification {
  const manifest = loadDocClasses();
  const matchers = manifest.entries.map((entry) => ({
    entry,
    regex: globToRegExp(entry.glob),
    hits: 0,
  }));

  const docs: ClassifiedDoc[] = [];
  const errors: string[] = [];

  for (const path of trackedMarkdownFiles()) {
    const matcher = matchers.find((candidate) => candidate.regex.test(path));
    if (!matcher) {
      errors.push(`${path} is unclassified — add a glob to docs/doc-classes.json`);
      continue;
    }
    matcher.hits += 1;
    docs.push({ path, class: matcher.entry.class, entry: matcher.entry });
  }

  for (const matcher of matchers) {
    if (matcher.hits === 0) {
      errors.push(
        `docs/doc-classes.json glob "${matcher.entry.glob}" matches zero tracked files — an empty glob hides rot; remove or fix it`,
      );
    }
  }

  return { docs, errors };
}

// First-match-wins classification for a single repo-relative path.
export function classify(path: string): DocClassEntry | undefined {
  return loadDocClasses().entries.find((entry) => globToRegExp(entry.glob).test(path));
}

// Tracked living-class markdown paths. Throws when the manifest fails the
// completeness check, so every consumer (gate script or contract test)
// surfaces manifest rot instead of silently scanning a partial corpus.
export function livingDocs(): string[] {
  const { docs, errors } = classifyAll();
  if (errors.length > 0) {
    throw new Error(
      `doc-classes manifest check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  return docs.filter((doc) => doc.class === 'living').map((doc) => doc.path);
}

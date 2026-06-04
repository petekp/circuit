#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const IDEAS_DIR = join(REPO_ROOT, 'docs/ideas');
const CATALOG_PATH = join(IDEAS_DIR, 'catalog.json');
const README_PATH = join(IDEAS_DIR, 'README.md');

type IdeaCatalog = {
  schema_version: number;
  last_swept: string;
  status_values: string[];
  categories: string[];
  entries: IdeaEntry[];
};

type IdeaEntry = {
  path: string;
  title: string;
  status: string;
  category: string;
  tags: string[];
  current_reading: string;
  related?: string[];
  last_checked: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function readCatalog(): IdeaCatalog {
  const raw = readFileSync(CATALOG_PATH, 'utf8');
  return JSON.parse(raw) as IdeaCatalog;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
  }
}

function main() {
  const catalog = readCatalog();
  const readme = readFileSync(README_PATH, 'utf8');
  const errors: string[] = [];

  if (catalog.schema_version !== 1) {
    errors.push('catalog.schema_version must be 1');
  }

  if (!Array.isArray(catalog.status_values) || catalog.status_values.length === 0) {
    errors.push('catalog.status_values must be a non-empty array');
  }

  if (!Array.isArray(catalog.categories) || catalog.categories.length === 0) {
    errors.push('catalog.categories must be a non-empty array');
  }

  if (!Array.isArray(catalog.entries)) {
    errors.push('catalog.entries must be an array');
  }

  const allowedStatuses = new Set(catalog.status_values);
  const allowedCategories = new Set(catalog.categories);
  const seenPaths = new Set<string>();

  const ideaDocs = new Set(
    readdirSync(IDEAS_DIR)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .map((name) => `docs/ideas/${name}`),
  );

  for (const [index, entry] of catalog.entries.entries()) {
    const label = `entries[${index}]`;

    try {
      assertNonEmptyString(entry.path, `${label}.path`);
      assertNonEmptyString(entry.title, `${label}.title`);
      assertNonEmptyString(entry.status, `${label}.status`);
      assertNonEmptyString(entry.category, `${label}.category`);
      assertNonEmptyString(entry.current_reading, `${label}.current_reading`);
      assertNonEmptyString(entry.last_checked, `${label}.last_checked`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (seenPaths.has(entry.path)) {
      errors.push(`${entry.path} appears more than once`);
    }
    seenPaths.add(entry.path);

    if (!entry.path.startsWith('docs/ideas/') || !entry.path.endsWith('.md')) {
      errors.push(`${entry.path} must be a docs/ideas markdown path`);
    }

    if (basename(entry.path) === 'README.md') {
      errors.push('README.md must not be a catalog entry');
    }

    if (!existsSync(join(REPO_ROOT, entry.path))) {
      errors.push(`${entry.path} does not exist`);
    }

    if (!allowedStatuses.has(entry.status)) {
      errors.push(`${entry.path} has unknown status ${entry.status}`);
    }

    if (!allowedCategories.has(entry.category)) {
      errors.push(`${entry.path} has unknown category ${entry.category}`);
    }

    if (!Array.isArray(entry.tags) || entry.tags.length === 0) {
      errors.push(`${entry.path} must have at least one tag`);
    }

    for (const tag of entry.tags ?? []) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        errors.push(`${entry.path} has an empty tag`);
      }
    }

    for (const relatedPath of entry.related ?? []) {
      if (typeof relatedPath !== 'string' || relatedPath.trim() === '') {
        errors.push(`${entry.path} has an empty related path`);
        continue;
      }
      if (!existsSync(join(REPO_ROOT, relatedPath))) {
        errors.push(`${entry.path} related path does not exist: ${relatedPath}`);
      }
    }

    const readmeRowPrefix = `| [\`${basename(entry.path)}\`](${basename(entry.path)}) | \`${entry.status}\` |`;
    if (!readme.includes(readmeRowPrefix)) {
      errors.push(`${entry.path} is missing a matching docs/ideas/README.md row`);
    }
  }

  for (const ideaDoc of ideaDocs) {
    if (!seenPaths.has(ideaDoc)) {
      errors.push(`${ideaDoc} is missing from docs/ideas/catalog.json`);
    }
  }

  for (const catalogPath of seenPaths) {
    if (!ideaDocs.has(catalogPath)) {
      errors.push(`${catalogPath} is in catalog.json but is not a live top-level idea doc`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.stderr.write(`\ncheck-ideas-catalog failed with ${errors.length} issue(s)\n`);
    process.exit(1);
  }

  process.stdout.write(
    `Idea catalog OK: ${catalog.entries.length} entries cover ${ideaDocs.size} docs (${relative(
      REPO_ROOT,
      CATALOG_PATH,
    )})\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`check-ideas-catalog failed: ${message}\n`);
  process.exit(1);
}

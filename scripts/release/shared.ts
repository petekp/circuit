import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
// Type-only imports of the source modules whose compiled output is loaded
// dynamically from `dist/` below. The runtime `import()` still targets the
// built `.js`; these `import type` lines are erased by tsc and only supply the
// module shape so the dist-import seam is typed instead of `any`. This mirrors
// the pattern already used by emit-current-capabilities.ts and
// yaml-schema-registry.ts.
import type * as ReleaseChecksModule from '../../src/release/checks.js';
import type * as ReleaseSchemasModule from '../../src/release/schemas.js';
import { formatWithBiome as formatWithBiomeShared, stableJson } from '../shared/format.ts';

export const projectRoot = resolve(new URL('../..', import.meta.url).pathname);

export function readText(relPath: string): string {
  return readFileSync(resolve(projectRoot, relPath), 'utf8');
}

// biome-ignore lint/suspicious/noExplicitAny: caller can provide a schema-specific generic.
export function readJson<T = any>(relPath: string): T {
  return JSON.parse(readText(relPath)) as T;
}

function readYaml(relPath: string): unknown {
  return YAML.parse(readText(relPath));
}

export function loadYamlWithSchema<T extends z.ZodTypeAny>(relPath: string, schema: T): z.infer<T> {
  return schema.parse(readYaml(relPath));
}

export function loadJsonWithSchema<T extends z.ZodTypeAny>(relPath: string, schema: T): z.infer<T> {
  return schema.parse(readJson(relPath));
}

export function pathExists(relPath: string): boolean {
  return existsSync(resolve(projectRoot, relPath));
}

export function listFiles(
  relDir: string,
  predicate: (entry: string) => boolean = () => true,
): string[] {
  const abs = resolve(projectRoot, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((entry) => predicate(entry))
    .sort()
    .map((entry) => `${relDir}/${entry}`);
}

export function listMarkdownBasenames(relDir: string): string[] {
  return listFiles(relDir, (entry) => entry.endsWith('.md')).map((file) =>
    file.slice(file.lastIndexOf('/') + 1, -'.md'.length),
  );
}

export function fileIsPresent(relPath: string): boolean {
  try {
    return statSync(resolve(projectRoot, relPath)).isFile();
  } catch {
    return false;
  }
}

// Re-exported from scripts/shared/format.ts (the single source of truth shared
// with the YAML-schema emitter). Kept exported here so the release scripts that
// already import them from './shared.ts' need no change.
export { stableJson };

export function formatWithBiome(relPath: string, content: string): string {
  return formatWithBiomeShared(relPath, content, projectRoot);
}

export function writeOrCheck(relPath: string, content: string, check: boolean): void {
  const abs = resolve(projectRoot, relPath);
  if (check) {
    if (!existsSync(abs)) {
      throw new Error(`${relPath} is missing; run the matching emit command`);
    }
    const current = readFileSync(abs, 'utf8');
    if (current !== content) {
      throw new Error(`${relPath} drifted; run the matching emit command`);
    }
    console.log(`✓ ${relPath} is in sync`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  console.log(`emitted ${relPath}`);
}

export function formatMarkdown(content: string): string {
  return `${content.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export async function loadReleaseSchemas(): Promise<typeof ReleaseSchemasModule> {
  return import(resolve(projectRoot, 'dist/release/schemas.js')) as Promise<
    typeof ReleaseSchemasModule
  >;
}

export async function loadReleaseChecks(): Promise<typeof ReleaseChecksModule> {
  return import(resolve(projectRoot, 'dist/release/checks.js')) as Promise<
    typeof ReleaseChecksModule
  >;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamically imports built catalog module.
export async function loadCurrentCatalog(): Promise<any> {
  return import(resolve(projectRoot, 'dist/flows/catalog.js'));
}

// biome-ignore lint/suspicious/noExplicitAny: dynamically imports built connector schemas module.
export async function loadConnectorSchemas(): Promise<any> {
  return import(resolve(projectRoot, 'dist/schemas/connector.js'));
}

export function runBiomeFormat(relPath: string): void {
  execFileSync('npx', ['biome', 'format', '--write', resolve(projectRoot, relPath)], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

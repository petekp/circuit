import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const STATIC_IMPORT_PATTERN = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
const REEXPORT_PATTERN =
  /\bexport\s+(?:type\s+)?(?:\*\s+|\{[\s\S]*?\}\s+)?from\s+['"]([^'"\n]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;

export function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

export function walkTsFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

export function importPathsFrom(file: string): readonly string[] {
  const text = readSource(file);
  const out: string[] = [];
  for (const pattern of [STATIC_IMPORT_PATTERN, REEXPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const importPath = match[1];
      if (importPath !== undefined) out.push(importPath);
    }
  }
  return out;
}

export function topLevelSourceModuleFor(file: string): string | undefined {
  const normalized = normalize(file).split(sep);
  const srcIndex = normalized.lastIndexOf('src');
  if (srcIndex === -1) return undefined;
  return normalized[srcIndex + 1];
}

export function relativeImportTarget(file: string, importPath: string): string | undefined {
  if (!importPath.startsWith('.')) return undefined;

  const rawTarget = resolve(dirname(file), importPath);
  const candidates = [
    rawTarget,
    rawTarget.replace(/\.js$/, '.ts'),
    `${rawTarget}.ts`,
    join(rawTarget, 'index.ts'),
  ];

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

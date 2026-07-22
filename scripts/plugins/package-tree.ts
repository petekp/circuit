import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OWNED_ROOTS = new Set([
  '.claude-plugin',
  '.codex-plugin',
  'commands',
  'flows',
  'hooks',
  'mcp',
  'runtime',
  'scripts',
  'skills',
]);

export type PackageTreeStatusKind = 'ok' | 'missing' | 'stale' | 'extra-owned-files';

export type PackageTreeComparison = {
  status: PackageTreeStatusKind;
  source: string;
  target: string;
  missing: string[];
  stale: string[];
  extra_owned_files: string[];
  source_file_count: number;
  target_owned_file_count: number;
};

function normalizeRelativePath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
}

export function isPackageOwnedFile(path: string): boolean {
  const normalized = normalizeRelativePath(path);
  if (normalized === 'README.md' || normalized === '.mcp.json') return true;
  const [head] = normalized.split('/');
  return head !== undefined && OWNED_ROOTS.has(head);
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [];
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    const absDir = resolve(root, relDir);
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = join(relDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(relPath);
      } else if (entry.isFile()) {
        files.push(normalizeRelativePath(relPath));
      }
    }
  }
  return files.sort();
}

export function walkPackageFiles(root: string): string[] {
  return walkFiles(root).filter(isPackageOwnedFile);
}

export function packageTreeDigest(root: string): string {
  const hash = createHash('sha256');
  for (const file of walkPackageFiles(resolve(root))) {
    const bytes = readFileSync(resolve(root, file));
    hash.update(file, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(bytes.byteLength), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(bytes);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileMap(root: string): Map<string, string> {
  return new Map(walkPackageFiles(root).map((file) => [file, digestFile(resolve(root, file))]));
}

export function packageTreeStatus(source: string, target: string): PackageTreeComparison {
  const sourceRoot = resolve(source);
  const targetRoot = resolve(target);
  const sourceFiles = fileMap(sourceRoot);

  if (!existsSync(targetRoot)) {
    return {
      status: 'missing',
      source: sourceRoot,
      target: targetRoot,
      missing: [...sourceFiles.keys()],
      stale: [],
      extra_owned_files: [],
      source_file_count: sourceFiles.size,
      target_owned_file_count: 0,
    };
  }

  if (!statSync(targetRoot).isDirectory()) {
    return {
      status: 'stale',
      source: sourceRoot,
      target: targetRoot,
      missing: [...sourceFiles.keys()],
      stale: [],
      extra_owned_files: [],
      source_file_count: sourceFiles.size,
      target_owned_file_count: 0,
    };
  }

  const targetFiles = fileMap(targetRoot);
  const missing: string[] = [];
  const stale: string[] = [];
  const extraOwnedFiles: string[] = [];

  for (const [file, digest] of sourceFiles) {
    const targetDigest = targetFiles.get(file);
    if (targetDigest === undefined) {
      missing.push(file);
    } else if (targetDigest !== digest) {
      stale.push(file);
    }
  }

  for (const file of targetFiles.keys()) {
    if (!sourceFiles.has(file)) extraOwnedFiles.push(file);
  }

  const status =
    missing.length > 0 || stale.length > 0
      ? 'stale'
      : extraOwnedFiles.length > 0
        ? 'extra-owned-files'
        : 'ok';

  return {
    status,
    source: sourceRoot,
    target: targetRoot,
    missing,
    stale,
    extra_owned_files: extraOwnedFiles,
    source_file_count: sourceFiles.size,
    target_owned_file_count: targetFiles.size,
  };
}

export function listPackageDirs(root: string, dir: string): string[] {
  const target = resolve(root, dir);
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function listCommandIds(root: string): string[] {
  const commandsRoot = resolve(root, 'commands');
  if (!existsSync(commandsRoot)) return [];
  return walkFiles(commandsRoot)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''))
    .sort();
}

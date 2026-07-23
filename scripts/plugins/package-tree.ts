import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
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

type TreeEntry = { readonly path: string; readonly type: 'file' | 'symlink' };
type MaterializedTreeEntry = TreeEntry & { readonly contents: Buffer };

function walkAllTreeEntries(root: string): TreeEntry[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const entries: TreeEntry[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    const absDir = resolve(root, relDir);
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = normalizeRelativePath(join(relDir, entry.name));
      if (entry.isDirectory()) {
        stack.push(relPath);
      } else if (entry.isFile()) {
        entries.push({ path: relPath, type: 'file' });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relPath, type: 'symlink' });
      } else {
        throw new Error(`unsupported package-tree entry: ${relPath}`);
      }
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function digestTreeEntries(entries: readonly MaterializedTreeEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(entry.type);
    hash.update('\0');
    hash.update(String(pathBytes.byteLength));
    hash.update('\0');
    hash.update(pathBytes);
    hash.update('\0');
    hash.update(String(entry.contents.byteLength));
    hash.update('\0');
    hash.update(entry.contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Stable digest of every file and symlink in a plugin package. */
export function packageTreeSha256(root: string): string {
  const canonicalRoot = resolve(root);
  return digestTreeEntries(
    walkAllTreeEntries(canonicalRoot).map((entry) => ({
      ...entry,
      contents:
        entry.type === 'file'
          ? readFileSync(resolve(canonicalRoot, entry.path))
          : Buffer.from(readlinkSync(resolve(canonicalRoot, entry.path)), 'utf8'),
    })),
  );
}

function gitOutput(repoRoot: string, args: readonly string[]): Buffer {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'buffer',
    maxBuffer: 64 * 1_048_576,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = Buffer.concat([
      result.stderr ?? Buffer.alloc(0),
      result.stdout ?? Buffer.alloc(0),
    ])
      .toString('utf8')
      .trim();
    throw new Error(detail || `git ${args[0] ?? ''} failed`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

/** Recomputes the package digest from immutable blobs at one full Git commit. */
export function packageGitTreeSha256(
  repoRoot: string,
  commit: string,
  packagePath: string,
): string {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('commit must be a full Git SHA');
  const normalizedRoot = normalizeRelativePath(packagePath);
  if (
    normalizedRoot.length === 0 ||
    packagePath.startsWith('/') ||
    packagePath.includes('\\') ||
    normalizedRoot.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('package path must be a safe repository-relative path');
  }
  const prefix = `${normalizedRoot}/`;
  const listing = gitOutput(repoRoot, [
    'ls-tree',
    '-rz',
    '--full-tree',
    commit,
    '--',
    normalizedRoot,
  ]).toString('utf8');
  const entries: MaterializedTreeEntry[] = [];
  for (const line of listing.split('\0').filter(Boolean)) {
    const match = line.match(/^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t(.+)$/u);
    if (match === null) throw new Error('Git returned a malformed package-tree entry');
    const [, mode, objectType, objectId, fullPath] = match;
    if (objectType !== 'blob' || objectId === undefined || fullPath === undefined) {
      throw new Error(`unsupported Git package-tree entry: ${fullPath ?? '<unknown>'}`);
    }
    if (!fullPath.startsWith(prefix)) {
      throw new Error('Git returned a package-tree entry outside the requested path');
    }
    const path = fullPath.slice(prefix.length);
    if (path.length === 0) throw new Error('Git returned an empty package-tree path');
    entries.push({
      path,
      type: mode === '120000' ? 'symlink' : 'file',
      contents: gitOutput(repoRoot, ['cat-file', 'blob', objectId]),
    });
  }
  if (entries.length === 0) throw new Error('Git commit has no plugin package tree');
  return digestTreeEntries(entries);
}

export function walkPackageFiles(root: string): string[] {
  return walkFiles(root).filter(isPackageOwnedFile);
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

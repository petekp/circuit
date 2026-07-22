import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FLOW_ASSETS = 64;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MACOS_DIRECT_GIT_CANDIDATES = [
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
] as const;

interface CodexNpmTarget {
  readonly packageName: string;
  readonly triple: string;
  readonly executableName: 'codex' | 'codex.exe';
}

const CODEX_NPM_TARGETS: Readonly<Record<string, CodexNpmTarget>> = Object.freeze({
  'darwin:arm64': {
    packageName: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    executableName: 'codex',
  },
  'darwin:x64': {
    packageName: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
    executableName: 'codex',
  },
  'linux:arm64': {
    packageName: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    executableName: 'codex',
  },
  'linux:x64': {
    packageName: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    executableName: 'codex',
  },
  'win32:arm64': {
    packageName: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    executableName: 'codex.exe',
  },
  'win32:x64': {
    packageName: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    executableName: 'codex.exe',
  },
});

export class McpProductionPathError extends Error {
  readonly code = 'mcp_runtime_unavailable' as const;
  readonly nextAction = 'Reinstall Circuit and Codex, then retry.';

  constructor(message: string) {
    super(message);
    this.name = 'McpProductionPathError';
  }
}

export function findExecutableOnPath(name: string, pathValue: string | undefined): string {
  if (!EXECUTABLE_NAME.test(name)) {
    throw new McpProductionPathError('Circuit was given an invalid executable name.');
  }
  if (pathValue === undefined || pathValue.trim().length === 0) {
    throw new McpProductionPathError(`Circuit could not find ${name} because PATH is empty.`);
  }
  const directories = pathValue.split(delimiter);
  if (directories.some((directory) => !isAbsolute(directory))) {
    throw new McpProductionPathError('Circuit refused a PATH containing relative directories.');
  }
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      const info = statSync(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) return candidate;
    } catch {
      // Continue through the bounded explicit PATH supplied by the host.
    }
  }
  throw new McpProductionPathError(`Circuit could not find an executable ${name} on PATH.`);
}

function isExecutableFile(candidate: string): boolean {
  try {
    const info = statSync(candidate);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveGitExecutableOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
  macosDirectGitCandidates: readonly string[] = MACOS_DIRECT_GIT_CANDIDATES,
): string {
  if (platform === 'darwin') {
    for (const candidate of macosDirectGitCandidates) {
      if (!isAbsolute(candidate) || candidate.includes('\0')) continue;
      if (!isExecutableFile(candidate)) continue;
      return realpathSync.native(candidate);
    }
  }
  return findExecutableOnPath('git', pathValue);
}

function pathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function isNativeExecutable(path: string): boolean {
  const descriptor = openSync(path, 'r');
  const bytes = Buffer.alloc(4);
  try {
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) return false;
  } finally {
    closeSync(descriptor);
  }
  const hex = bytes.toString('hex');
  return (
    hex === '7f454c46' ||
    hex.startsWith('4d5a') ||
    new Set([
      'feedface',
      'cefaedfe',
      'feedfacf',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca',
    ]).has(hex)
  );
}

function readPackageJson(path: string): Record<string, unknown> {
  const info = statSync(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PACKAGE_JSON_BYTES) {
    throw new McpProductionPathError('Circuit refused an invalid Codex package manifest.');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new McpProductionPathError('Circuit could not parse the Codex package manifest.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpProductionPathError('Circuit refused an invalid Codex package manifest.');
  }
  return value as Record<string, unknown>;
}

function optionalDependencyNames(manifest: Record<string, unknown>): ReadonlySet<string> {
  const value = manifest.optionalDependencies;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value));
}

function officialCodexPackageRoot(launcher: string): string {
  let directory = dirname(launcher);
  for (let depth = 0; depth < 4; depth += 1) {
    const manifestPath = join(directory, 'package.json');
    try {
      const manifest = readPackageJson(manifestPath);
      const bin = manifest.bin;
      const binPath =
        typeof bin === 'object' && bin !== null && !Array.isArray(bin)
          ? (bin as Record<string, unknown>).codex
          : undefined;
      if (
        manifest.name === '@openai/codex' &&
        binPath === 'bin/codex.js' &&
        realpathSync.native(join(directory, binPath)) === launcher
      ) {
        return directory;
      }
    } catch (error) {
      if (error instanceof McpProductionPathError) throw error;
      // This ancestor is not the package root. Continue through the bounded walk.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new McpProductionPathError(
    'Circuit refused an opaque Codex launcher because its native executable could not be sealed.',
  );
}

function nativeCodexFromNpmLauncher(
  launcher: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const target = CODEX_NPM_TARGETS[`${platform}:${arch}`];
  if (target === undefined) {
    throw new McpProductionPathError(
      `Circuit cannot seal the Codex npm launcher on ${platform}/${arch}.`,
    );
  }
  const packageRoot = officialCodexPackageRoot(launcher);
  const packageManifest = readPackageJson(join(packageRoot, 'package.json'));
  if (!optionalDependencyNames(packageManifest).has(target.packageName)) {
    throw new McpProductionPathError(
      'Circuit refused a Codex npm launcher without its declared native package.',
    );
  }

  let platformPackageRoot: string | undefined;
  try {
    const require = createRequire(join(packageRoot, 'package.json'));
    const manifestPath = realpathSync.native(require.resolve(`${target.packageName}/package.json`));
    platformPackageRoot = dirname(manifestPath);
  } catch {
    // Official tarball installs may carry the native payload directly in vendor/.
  }
  const candidate =
    platformPackageRoot === undefined
      ? join(packageRoot, 'vendor', target.triple, 'bin', target.executableName)
      : join(platformPackageRoot, 'vendor', target.triple, 'bin', target.executableName);
  let native: string;
  try {
    native = realpathSync.native(candidate);
    const root = realpathSync.native(platformPackageRoot ?? packageRoot);
    const info = statSync(native);
    if (!pathInside(root, native) || !info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error('invalid native executable');
    }
  } catch {
    throw new McpProductionPathError(
      'Circuit could not seal the native executable behind the Codex npm launcher.',
    );
  }
  if (!isNativeExecutable(native)) {
    throw new McpProductionPathError(
      'Circuit refused a Codex npm payload that is not a native executable.',
    );
  }
  return native;
}

function nativeCodexFromVitePlusLauncher(
  discovered: string,
  wrapper: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const binRoot = dirname(discovered);
  const vitePlusRoot = dirname(binRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(vitePlusRoot);
  } catch {
    throw new McpProductionPathError('Circuit could not seal the Vite+ Codex package root.');
  }
  if (
    basename(binRoot) !== 'bin' ||
    basename(wrapper) !== 'vp' ||
    !pathInside(canonicalRoot, wrapper)
  ) {
    throw new McpProductionPathError(
      'Circuit refused an opaque native Codex launcher because its downstream executable could not be sealed.',
    );
  }
  const npmLauncher = join(
    canonicalRoot,
    'packages',
    '@openai',
    'codex',
    'lib',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  let canonicalLauncher: string;
  try {
    canonicalLauncher = realpathSync.native(npmLauncher);
    if (!pathInside(canonicalRoot, canonicalLauncher)) throw new Error('launcher escaped root');
  } catch {
    throw new McpProductionPathError(
      'Circuit could not seal the native executable selected by the Vite+ Codex launcher.',
    );
  }
  return nativeCodexFromNpmLauncher(canonicalLauncher, platform, arch);
}

/**
 * Returns the native Codex file Circuit will spawn directly. The official npm
 * JavaScript launcher and Vite+ wrapper are never executed.
 */
export function resolveCodexExecutableOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const discovered = findExecutableOnPath('codex', pathValue);
  let resolved: string;
  try {
    resolved = realpathSync.native(discovered);
    const info = statSync(resolved);
    if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error('not executable');
  } catch {
    throw new McpProductionPathError('Circuit could not resolve the Codex executable.');
  }
  if (isNativeExecutable(resolved)) {
    const nativeName = basename(resolved).toLowerCase();
    if (nativeName === 'codex' || nativeName === 'codex.exe') return discovered;
    return nativeCodexFromVitePlusLauncher(discovered, resolved, platform, arch);
  }
  return nativeCodexFromNpmLauncher(resolved, platform, arch);
}

export interface PinnedNodeInstallation {
  readonly executable: string;
  readonly bin: string;
  readonly root: string;
}

/**
 * Derives the smallest conventional Node installation root from an already
 * pinned real executable. The named Codex sandbox reads this root so Node can
 * load its own libraries, while the shell PATH receives only its bin folder.
 */
export function derivePinnedNodeInstallation(executable: string): PinnedNodeInstallation {
  if (!isAbsolute(executable) || executable.includes('\0') || resolve(executable) !== executable) {
    throw new McpProductionPathError('The pinned Node executable path is invalid.');
  }
  const bin = dirname(executable);
  const root = dirname(bin);
  if (basename(bin) !== 'bin' || root === dirname(root)) {
    throw new McpProductionPathError(
      'Circuit refused an unreviewed Node installation layout for the Codex sandbox.',
    );
  }
  return Object.freeze({ executable, bin, root });
}

export function codexMcpStateRoot(codexHome: string): string {
  if (!isAbsolute(codexHome) || codexHome.includes('\0')) {
    throw new McpProductionPathError('CODEX_HOME must be an absolute local directory.');
  }
  return resolve(codexHome, 'circuit', 'mcp', 'v1');
}

function flowAssetId(flowsRoot: string, path: string): string {
  const rel = relative(flowsRoot, path)
    .split(sep)
    .join('/')
    .replace(/\.json$/, '');
  const id = rel.replaceAll('/', '-');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new McpProductionPathError(`Circuit found an invalid packaged flow path: ${rel}`);
  }
  return id;
}

export function collectPackagedFlowAssets(
  flowsRoot: string,
): readonly { readonly id: string; readonly path: string }[] {
  if (!isAbsolute(flowsRoot)) {
    throw new McpProductionPathError('The packaged flow root must be absolute.');
  }
  const rootInfo = lstatSync(flowsRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new McpProductionPathError('The packaged flow root is not a real directory.');
  }

  const found: { id: string; path: string }[] = [];
  const pending = [flowsRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new McpProductionPathError('Circuit refused a linked packaged flow asset.');
      }
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        throw new McpProductionPathError('Circuit found an unexpected packaged flow asset.');
      }
      found.push({ id: flowAssetId(flowsRoot, path), path });
      if (found.length > MAX_FLOW_ASSETS) {
        throw new McpProductionPathError('Circuit found too many packaged flow assets.');
      }
    }
  }
  found.sort((left, right) => left.id.localeCompare(right.id));
  if (!found.some((asset) => asset.id === 'catalog')) {
    throw new McpProductionPathError('The packaged public flow catalog is missing.');
  }
  if (new Set(found.map((entry) => entry.id)).size !== found.length) {
    throw new McpProductionPathError('Packaged flow asset IDs are not unique.');
  }
  return Object.freeze(found);
}

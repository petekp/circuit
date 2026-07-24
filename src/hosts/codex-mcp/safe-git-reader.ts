import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  RUNTIME_GIT_HARDENED_CONFIG,
  type RuntimeGitPinnedTarget,
  type RuntimeGitTarget,
  runtimeGitTextIsValidUtf8,
} from '../../shared/runtime-git-reader.js';
import type {
  GitReadSandboxRequest,
  MacosProofSandbox,
  ProofSandboxResult,
} from './proof-sandbox.js';

const MAX_GIT_POINTER_BYTES = 8 * 1024;
const GIT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const REQUEST_FIELDS = new Set(['operation', 'target']);

export type SafeGitOperation =
  | 'status'
  | 'staged_diff'
  | 'unstaged_diff'
  | 'staged_diff_stat'
  | 'unstaged_diff_stat'
  | 'resolve_target'
  | 'target_diff'
  | 'target_diff_stat'
  | 'hidden_index_flags'
  | 'staged_changed_gitlinks'
  | 'unstaged_changed_gitlinks'
  | 'untracked_files';

type StaticSafeGitOperation = Exclude<
  SafeGitOperation,
  'resolve_target' | 'target_diff' | 'target_diff_stat'
>;

type ParsedSafeGitRequest =
  | {
      readonly operation: 'resolve_target';
      readonly target: RuntimeGitTarget;
    }
  | {
      readonly operation: 'target_diff' | 'target_diff_stat';
      readonly target: RuntimeGitPinnedTarget;
    }
  | {
      readonly operation: StaticSafeGitOperation;
      readonly target?: never;
    };

type SafeGitCommandRequest =
  | ParsedSafeGitRequest
  | {
      readonly operation: 'commit_object';
      readonly commit: string;
    };

export interface SafeGitRepository {
  readonly workspace: string;
  readonly git_dir: string;
  readonly common_dir: string;
  readonly read_roots: readonly string[];
}

export interface SafeGitReadResult {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly operation: SafeGitOperation;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number | null;
  readonly truncated: boolean;
  readonly limit_bytes: number;
  readonly submodule_policy: 'reported_without_recursive_execution';
  readonly attribute_policy: 'external_commands_disabled';
  readonly cleanup_confirmed: boolean;
  readonly resolved_target?: RuntimeGitPinnedTarget;
}

export interface SafeGitSandbox {
  readonly executeGitRead: MacosProofSandbox['executeGitRead'];
}

export interface SafeGitReader {
  readonly read: (request: unknown) => Promise<SafeGitReadResult>;
}

interface CreateSafeGitReaderOptions {
  readonly workspace: string;
  readonly gitExecutable: string;
  readonly sandbox: SafeGitSandbox;
}

export class SafeGitReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SafeGitReadError';
    this.code = code;
  }
}

export const SAFE_GIT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
});

const OPERATION_ARGS: Readonly<Record<StaticSafeGitOperation, readonly string[]>> = {
  status: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
  staged_diff: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--cached',
    '--',
  ],
  unstaged_diff: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--',
  ],
  staged_diff_stat: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--stat',
    '--cached',
    '--',
  ],
  unstaged_diff_stat: [
    'diff',
    '--stat',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--',
  ],
  hidden_index_flags: ['ls-files', '-v', '-z', '--'],
  staged_changed_gitlinks: [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--ignore-submodules=none',
    '--cached',
    '--',
  ],
  unstaged_changed_gitlinks: [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--ignore-submodules=none',
    '--',
  ],
  untracked_files: ['ls-files', '--others', '--exclude-standard', '-z', '--'],
};
const CONFIG_AUDIT_ARGS = ['config', '--null', '--list', '--no-includes'] as const;
const METADATA_PATHS = [
  'HEAD',
  'config',
  'config.worktree',
  'index',
  'packed-refs',
  'shallow',
  'objects',
  'objects/info',
  'objects/pack',
  'refs',
  'info',
  'info/attributes',
  'info/exclude',
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

async function readSmallRegularFile(candidate: string, label: string): Promise<string> {
  const metadata = await lstat(candidate).catch((error: unknown) => {
    throw new SafeGitReadError('unsafe_git_directory', `${label}: ${errorMessage(error)}`);
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_GIT_POINTER_BYTES) {
    throw new SafeGitReadError('unsafe_git_directory', `${label} must be a small regular file.`);
  }
  return await readFile(candidate, 'utf8');
}

async function directoryRealpath(candidate: string, label: string): Promise<string> {
  const canonical = await realpath(candidate).catch((error: unknown) => {
    throw new SafeGitReadError('unsafe_git_directory', `${label}: ${errorMessage(error)}`);
  });
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new SafeGitReadError('unsafe_git_directory', `${label} must be a directory.`);
  }
  return canonical;
}

async function rejectObjectAlternates(gitDirectories: readonly string[]): Promise<void> {
  for (const directory of gitDirectories) {
    const alternates = join(directory, 'objects', 'info', 'alternates');
    try {
      await lstat(alternates);
      throw new SafeGitReadError(
        'unsafe_git_directory',
        'Git object alternates can escape the trusted Git directory and are not supported.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function rejectLegacyGrafts(gitDirectories: readonly string[]): Promise<void> {
  for (const directory of gitDirectories) {
    const grafts = join(directory, 'info', 'grafts');
    try {
      await lstat(grafts);
      throw new SafeGitReadError(
        'unsafe_git_directory',
        'Legacy Git graft metadata can change commit ancestry and is not supported.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function rejectMetadataSymlinks(gitDirectories: readonly string[]): Promise<void> {
  for (const directory of gitDirectories) {
    for (const relativePath of METADATA_PATHS) {
      try {
        const metadata = await lstat(join(directory, relativePath));
        if (metadata.isSymbolicLink()) {
          throw new SafeGitReadError(
            'unsafe_git_directory',
            `Git metadata path ${JSON.stringify(relativePath)} must not be a symbolic link.`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
  }
}

export async function resolveSafeGitRepository(workspaceInput: string): Promise<SafeGitRepository> {
  if (!isAbsolute(workspaceInput)) {
    throw new SafeGitReadError('unsafe_git_directory', 'Git workspace must be absolute.');
  }
  const workspace = await directoryRealpath(resolve(workspaceInput), 'Git workspace');
  if (workspace !== resolve(workspaceInput)) {
    throw new SafeGitReadError('unsafe_git_directory', 'Git workspace must already be canonical.');
  }
  const dotGit = join(workspace, '.git');
  const dotGitMetadata = await lstat(dotGit).catch((error: unknown) => {
    throw new SafeGitReadError(
      'unsafe_git_directory',
      `Git metadata could not be inspected: ${errorMessage(error)}`,
    );
  });
  if (dotGitMetadata.isSymbolicLink()) {
    throw new SafeGitReadError('unsafe_git_directory', 'The workspace .git entry is a symlink.');
  }

  if (dotGitMetadata.isDirectory()) {
    const gitDirectory = await directoryRealpath(dotGit, 'Git directory');
    if (!isInside(workspace, gitDirectory)) {
      throw new SafeGitReadError(
        'unsafe_git_directory',
        'The Git directory escapes the workspace.',
      );
    }
    try {
      await lstat(join(gitDirectory, 'commondir'));
      throw new SafeGitReadError(
        'unsafe_git_directory',
        'An in-workspace Git directory must not redirect through commondir.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rejectMetadataSymlinks([gitDirectory]);
    await rejectObjectAlternates([gitDirectory]);
    await rejectLegacyGrafts([gitDirectory]);
    return Object.freeze({
      workspace,
      git_dir: gitDirectory,
      common_dir: gitDirectory,
      read_roots: Object.freeze([workspace, gitDirectory]),
    });
  }

  if (!dotGitMetadata.isFile()) {
    throw new SafeGitReadError(
      'unsafe_git_directory',
      'The workspace .git entry must be a directory or linked-worktree pointer.',
    );
  }
  const pointer = (await readSmallRegularFile(dotGit, 'Git pointer')).trim();
  const match = /^gitdir: (.+)$/u.exec(pointer);
  if (match?.[1] === undefined || match[1].includes('\0')) {
    throw new SafeGitReadError('unsafe_git_directory', 'The Git pointer is invalid.');
  }
  const gitDirectory = await directoryRealpath(
    resolve(workspace, match[1]),
    'Linked-worktree Git directory',
  );
  if (basename(resolve(gitDirectory, '..')) !== 'worktrees') {
    throw new SafeGitReadError(
      'unsafe_git_directory',
      'The Git pointer does not use the fixed linked worktree shape.',
    );
  }
  const commonPointer = (
    await readSmallRegularFile(join(gitDirectory, 'commondir'), 'Git commondir pointer')
  ).trim();
  if (commonPointer.length === 0 || commonPointer.includes('\0')) {
    throw new SafeGitReadError('unsafe_git_directory', 'The Git commondir pointer is invalid.');
  }
  const commonDirectory = await directoryRealpath(
    resolve(gitDirectory, commonPointer),
    'Git common directory',
  );
  const expectedCommonDirectory = await directoryRealpath(
    resolve(gitDirectory, '..', '..'),
    'Expected Git common directory',
  );
  if (commonDirectory !== expectedCommonDirectory) {
    throw new SafeGitReadError(
      'unsafe_git_directory',
      'The Git pointer does not use the fixed linked worktree shape.',
    );
  }
  const backlinkText = (
    await readSmallRegularFile(join(gitDirectory, 'gitdir'), 'Git worktree backlink')
  ).trim();
  if (backlinkText.length === 0 || backlinkText.includes('\0')) {
    throw new SafeGitReadError('unsafe_git_directory', 'The Git worktree backlink is invalid.');
  }
  const backlink = await realpath(
    isAbsolute(backlinkText) ? backlinkText : resolve(gitDirectory, backlinkText),
  );
  const workspaceDotGit = await realpath(dotGit);
  if (backlink !== workspaceDotGit) {
    throw new SafeGitReadError(
      'unsafe_git_directory',
      'The Git worktree backlink does not match this workspace.',
    );
  }
  await rejectMetadataSymlinks([gitDirectory, commonDirectory]);
  await rejectObjectAlternates([gitDirectory, commonDirectory]);
  await rejectLegacyGrafts([gitDirectory, commonDirectory]);
  return Object.freeze({
    workspace,
    git_dir: gitDirectory,
    common_dir: commonDirectory,
    read_roots: Object.freeze([...new Set([workspace, gitDirectory, commonDirectory])]),
  });
}

function validateRefToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SafeGitReadError('invalid_git_read', `${label} must be a non-empty Git ref.`);
  }
  if (
    value.length > 120 ||
    value.startsWith('-') ||
    value.includes('\0') ||
    value.includes('..') ||
    value.includes('@{') ||
    !/^[A-Za-z0-9._/@+~^-]+$/u.test(value)
  ) {
    throw new SafeGitReadError('invalid_git_read', `${label} is an unsafe Git ref.`);
  }
  return value;
}

function parseSymbolicTarget(value: unknown): RuntimeGitTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafeGitReadError('invalid_git_read', 'Git target must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'commit') {
    for (const key of Object.keys(record)) {
      if (key !== 'kind' && key !== 'ref') {
        throw new SafeGitReadError('invalid_git_read', `Unknown Git commit target field ${key}.`);
      }
    }
    return { kind: 'commit', ref: validateRefToken(record.ref, 'Git target ref') };
  }
  if (record.kind === 'range') {
    for (const key of Object.keys(record)) {
      if (key !== 'kind' && key !== 'base' && key !== 'head' && key !== 'dots') {
        throw new SafeGitReadError('invalid_git_read', `Unknown Git range target field ${key}.`);
      }
    }
    if (record.dots !== '..' && record.dots !== '...') {
      throw new SafeGitReadError('invalid_git_read', 'Git target range dots must be .. or ....');
    }
    return {
      kind: 'range',
      base: validateRefToken(record.base, 'Git target base ref'),
      head: validateRefToken(record.head, 'Git target head ref'),
      dots: record.dots,
    };
  }
  throw new SafeGitReadError('invalid_git_read', 'Git target kind is not supported.');
}

function validateObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new SafeGitReadError(
      'invalid_git_read',
      `${label} must be a full immutable Git object id.`,
    );
  }
  return value;
}

function parsePinnedTarget(value: unknown): RuntimeGitPinnedTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafeGitReadError('invalid_git_read', 'Pinned Git target must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'commit') {
    for (const key of Object.keys(record)) {
      if (key !== 'kind' && key !== 'commit') {
        throw new SafeGitReadError(
          'invalid_git_read',
          `Unknown pinned Git commit target field ${key}.`,
        );
      }
    }
    return {
      kind: 'commit',
      commit: validateObjectId(record.commit, 'Pinned Git commit id'),
    };
  }
  if (record.kind === 'range') {
    for (const key of Object.keys(record)) {
      if (key !== 'kind' && key !== 'base_commit' && key !== 'head_commit' && key !== 'dots') {
        throw new SafeGitReadError(
          'invalid_git_read',
          `Unknown pinned Git range target field ${key}.`,
        );
      }
    }
    if (record.dots !== '..' && record.dots !== '...') {
      throw new SafeGitReadError('invalid_git_read', 'Pinned Git range dots must be .. or ....');
    }
    return {
      kind: 'range',
      base_commit: validateObjectId(record.base_commit, 'Pinned Git base commit id'),
      head_commit: validateObjectId(record.head_commit, 'Pinned Git head commit id'),
      dots: record.dots,
    };
  }
  throw new SafeGitReadError('invalid_git_read', 'Pinned Git target kind is not supported.');
}

function parseRequest(value: unknown): ParsedSafeGitRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SafeGitReadError('invalid_git_read', 'Git read request must be an object.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REQUEST_FIELDS.has(key)) {
      throw new SafeGitReadError('invalid_git_read', `Unknown field ${JSON.stringify(key)}.`);
    }
  }
  if (
    record.operation !== 'status' &&
    record.operation !== 'staged_diff' &&
    record.operation !== 'unstaged_diff' &&
    record.operation !== 'staged_diff_stat' &&
    record.operation !== 'unstaged_diff_stat' &&
    record.operation !== 'resolve_target' &&
    record.operation !== 'target_diff' &&
    record.operation !== 'target_diff_stat' &&
    record.operation !== 'hidden_index_flags' &&
    record.operation !== 'staged_changed_gitlinks' &&
    record.operation !== 'unstaged_changed_gitlinks' &&
    record.operation !== 'untracked_files'
  ) {
    throw new SafeGitReadError('invalid_git_read', 'Git read operation is not supported.');
  }
  const operation = record.operation;
  if (operation === 'resolve_target') {
    return { operation, target: parseSymbolicTarget(record.target) };
  }
  if (operation === 'target_diff' || operation === 'target_diff_stat') {
    return { operation, target: parsePinnedTarget(record.target) };
  }
  if (record.target !== undefined) {
    throw new SafeGitReadError(
      'invalid_git_read',
      'Git target is only allowed for target resolution and diff operations.',
    );
  }
  return { operation };
}

async function resolveGitExecutable(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new SafeGitReadError('invalid_git_executable', 'Git executable must be absolute.');
  }
  const executable = await realpath(candidate).catch((error: unknown) => {
    throw new SafeGitReadError(
      'invalid_git_executable',
      `Git executable could not be resolved: ${errorMessage(error)}`,
    );
  });
  const metadata = await stat(executable);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new SafeGitReadError(
      'invalid_git_executable',
      'Git executable must be an executable regular file.',
    );
  }
  return executable;
}

function targetArgs(
  operation: 'target_diff' | 'target_diff_stat',
  target: RuntimeGitPinnedTarget,
  commitParent: string | null | undefined,
): readonly string[] {
  const stat = operation === 'target_diff_stat' ? ['--stat'] : [];
  if (target.kind === 'commit') {
    if (commitParent === undefined) {
      throw new SafeGitReadError(
        'invalid_git_read',
        'Pinned commit ancestry must be inspected before reading its diff.',
      );
    }
    if (commitParent !== null) {
      return Object.freeze([
        'diff',
        ...stat,
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
        '--ignore-submodules=none',
        `${commitParent}^{commit}`,
        `${target.commit}^{commit}`,
        '--',
      ]);
    }
    return Object.freeze([
      'show',
      '--format=',
      ...stat,
      '--no-ext-diff',
      '--no-textconv',
      '--submodule=short',
      '--ignore-submodules=none',
      '--root',
      `${target.commit}^{commit}`,
      '--',
    ]);
  }
  return Object.freeze([
    'diff',
    ...stat,
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    `${target.base_commit}^{commit}${target.dots}${target.head_commit}^{commit}`,
    '--',
  ]);
}

function resolveTargetArgs(target: RuntimeGitTarget): readonly string[] {
  if (target.kind === 'commit') {
    return Object.freeze(['rev-parse', '--verify', '--end-of-options', `${target.ref}^{commit}`]);
  }
  return Object.freeze([
    'rev-parse',
    '--revs-only',
    '--end-of-options',
    `${target.base}^{commit}..${target.head}^{commit}`,
  ]);
}

function operationArgs(
  request: SafeGitCommandRequest,
  commitParent?: string | null,
): readonly string[] {
  if (request.operation === 'commit_object') {
    return Object.freeze(['cat-file', 'commit', `${request.commit}^{commit}`]);
  }
  if (request.operation === 'resolve_target') {
    return resolveTargetArgs(request.target);
  }
  if (request.operation === 'target_diff' || request.operation === 'target_diff_stat') {
    return targetArgs(request.operation, request.target, commitParent);
  }
  return OPERATION_ARGS[request.operation];
}

function resolvedObjectId(value: string | undefined, label: string): string {
  if (value === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new SafeGitReadError(
      'invalid_git_output',
      `Git returned an invalid ${label} while resolving the Review target.`,
    );
  }
  return value;
}

function parseResolvedTarget(target: RuntimeGitTarget, output: string): RuntimeGitPinnedTarget {
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (target.kind === 'commit') {
    if (lines.length !== 1) {
      throw new SafeGitReadError(
        'invalid_git_output',
        'Git returned an unexpected commit target resolution shape.',
      );
    }
    return {
      kind: 'commit',
      commit: resolvedObjectId(lines[0], 'commit id'),
    };
  }
  if (lines.length !== 2 || !lines[1]?.startsWith('^')) {
    throw new SafeGitReadError(
      'invalid_git_output',
      'Git returned an unexpected range target resolution shape.',
    );
  }
  return {
    kind: 'range',
    base_commit: resolvedObjectId(lines[1].slice(1), 'range base commit id'),
    head_commit: resolvedObjectId(lines[0], 'range head commit id'),
    dots: target.dots,
  };
}

function parseRawCommitParent(commit: string, output: string): string | null {
  const header = output.split('\n\n', 1)[0] ?? '';
  const lines = header.split('\n');
  if (!/^(?:tree) (?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(lines[0] ?? '')) {
    throw new SafeGitReadError(
      'invalid_git_output',
      `Git returned malformed raw commit data for ${commit}.`,
    );
  }
  const parentLines = lines.filter((line) => line.startsWith('parent '));
  for (const line of parentLines) {
    if (!/^parent (?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(line)) {
      throw new SafeGitReadError(
        'invalid_git_output',
        `Git returned an invalid parent id for ${commit}.`,
      );
    }
  }
  return parentLines[0]?.slice('parent '.length) ?? null;
}

function gitArgv(
  executable: string,
  repository: SafeGitRepository,
  request: SafeGitCommandRequest | { readonly operation: 'config_audit' },
  dynamicConfig: readonly string[] = [],
  commitParent?: string | null,
): readonly string[] {
  return Object.freeze([
    executable,
    '--no-pager',
    '--no-optional-locks',
    `--git-dir=${repository.git_dir}`,
    `--work-tree=${repository.workspace}`,
    ...[...RUNTIME_GIT_HARDENED_CONFIG, ...dynamicConfig].flatMap((value) => ['-c', value]),
    ...(request.operation === 'config_audit'
      ? CONFIG_AUDIT_ARGS
      : operationArgs(request, commitParent)),
  ]);
}

function gitRequest(
  executable: string,
  repository: SafeGitRepository,
  request: SafeGitCommandRequest | { readonly operation: 'config_audit' },
  dynamicConfig: readonly string[] = [],
  commitParent?: string | null,
): GitReadSandboxRequest {
  const operation = request.operation;
  return Object.freeze({
    id: `safe-git-${operation.replaceAll('_', '-')}`,
    cwd: '.',
    argv: gitArgv(executable, repository, request, dynamicConfig, commitParent),
    env: Object.freeze({}),
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: GIT_OUTPUT_LIMIT_BYTES,
    access: 'git-read-only',
    readRoots: repository.read_roots,
    git_environment: SAFE_GIT_ENVIRONMENT,
  });
}

function auditGitConfiguration(output: string): readonly string[] {
  const dynamicConfig = new Set<string>();
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf('\n');
    const key = (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase();
    const value = separator === -1 ? '' : entry.slice(separator + 1);
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
      throw new SafeGitReadError(
        'unsafe_git_config',
        'Git config include paths are not allowed for MCP reads.',
      );
    }
    if (key === 'core.worktree') {
      throw new SafeGitReadError(
        'unsafe_git_config',
        'Git config must not redirect the trusted worktree.',
      );
    }
    if (key === 'core.bare' && value.toLowerCase() === 'true') {
      throw new SafeGitReadError(
        'unsafe_git_config',
        'A bare Git repository has no safe worktree.',
      );
    }
    if (/^filter\..+\.(clean|smudge|process)$/u.test(key)) dynamicConfig.add(`${key}=`);
    if (/^filter\..+\.required$/u.test(key)) dynamicConfig.add(`${key}=false`);
    if (/^diff\..+\.(command|textconv)$/u.test(key)) dynamicConfig.add(`${key}=`);
  }
  return Object.freeze([...dynamicConfig].sort());
}

function failedResult(operation: SafeGitOperation, result: ProofSandboxResult): SafeGitReadResult {
  return Object.freeze({
    schema_version: 1,
    ok: false,
    operation,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    truncated: result.truncated,
    limit_bytes: GIT_OUTPUT_LIMIT_BYTES,
    submodule_policy: 'reported_without_recursive_execution',
    attribute_policy: 'external_commands_disabled',
    cleanup_confirmed: result.cleanup.confirmed,
  });
}

function failedAuxiliaryResult(
  operation: SafeGitOperation,
  result: ProofSandboxResult,
  message: string,
): SafeGitReadResult {
  return Object.freeze({
    ...failedResult(operation, result),
    stdout: '',
    stderr: message,
  });
}

function failedCommitInspectionResult(
  operation: SafeGitOperation,
  result: ProofSandboxResult,
): SafeGitReadResult {
  return Object.freeze({
    ...failedResult(operation, result),
    stdout: '',
    stderr: 'Git commit ancestry inspection failed before the requested read could be trusted.',
  });
}

function successfulResult(input: {
  readonly operation: SafeGitOperation;
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly truncated?: boolean;
  readonly resolvedTarget?: RuntimeGitPinnedTarget;
}): SafeGitReadResult {
  return Object.freeze({
    schema_version: 1,
    ok: true,
    operation: input.operation,
    stdout: input.stdout,
    stderr: input.stderr ?? '',
    exit_code: input.exitCode === undefined ? 0 : input.exitCode,
    truncated: input.truncated ?? false,
    limit_bytes: GIT_OUTPUT_LIMIT_BYTES,
    submodule_policy: 'reported_without_recursive_execution',
    attribute_policy: 'external_commands_disabled',
    cleanup_confirmed: true,
    ...(input.resolvedTarget === undefined ? {} : { resolved_target: input.resolvedTarget }),
  });
}

function assertValidGitOutputEncoding(output: string, label: string): void {
  if (!runtimeGitTextIsValidUtf8(output)) {
    throw new SafeGitReadError(
      'invalid_git_output',
      `${label} is not valid UTF-8 and cannot be used as trusted Review evidence.`,
    );
  }
}

export function createSafeGitReader(options: CreateSafeGitReaderOptions): SafeGitReader {
  return Object.freeze({
    async read(request: unknown): Promise<SafeGitReadResult> {
      const parsed = parseRequest(request);
      const operation = parsed.operation;
      const repository = await resolveSafeGitRepository(options.workspace);
      const executable = await resolveGitExecutable(options.gitExecutable);
      const configAudit = await options.sandbox.executeGitRead(
        gitRequest(executable, repository, { operation: 'config_audit' }),
      );
      if (configAudit.status !== 'passed' || !configAudit.cleanup.confirmed) {
        return failedAuxiliaryResult(
          operation,
          configAudit,
          'Git configuration audit failed before the requested read could be trusted.',
        );
      }
      assertValidGitOutputEncoding(configAudit.stdout, 'Git configuration output');
      const dynamicConfig = auditGitConfiguration(configAudit.stdout);
      let commitParent: string | null | undefined;
      if (
        (parsed.operation === 'target_diff' || parsed.operation === 'target_diff_stat') &&
        parsed.target.kind === 'commit'
      ) {
        const commitInspection = await options.sandbox.executeGitRead(
          gitRequest(
            executable,
            repository,
            { operation: 'commit_object', commit: parsed.target.commit },
            dynamicConfig,
          ),
        );
        if (commitInspection.status !== 'passed' || !commitInspection.cleanup.confirmed) {
          return failedCommitInspectionResult(operation, commitInspection);
        }
        assertValidGitOutputEncoding(commitInspection.stdout, 'Git commit inspection output');
        commitParent = parseRawCommitParent(parsed.target.commit, commitInspection.stdout);
      }
      const primary = await options.sandbox.executeGitRead(
        gitRequest(executable, repository, parsed, dynamicConfig, commitParent),
      );
      if (primary.status !== 'passed' || !primary.cleanup.confirmed) {
        const boundedPartialDiff =
          primary.status === 'output_limit' &&
          primary.cleanup.confirmed &&
          primary.stdout.length > 0 &&
          (operation === 'staged_diff' ||
            operation === 'unstaged_diff' ||
            operation === 'target_diff');
        if (boundedPartialDiff) {
          assertValidGitOutputEncoding(primary.stdout, `Git ${operation} output`);
          return successfulResult({
            operation,
            stdout: primary.stdout,
            stderr: primary.stderr,
            exitCode: primary.exit_code,
            truncated: true,
          });
        }
        return failedResult(operation, primary);
      }
      assertValidGitOutputEncoding(primary.stdout, `Git ${operation} output`);
      if (parsed.operation === 'resolve_target') {
        return successfulResult({
          operation,
          stdout: primary.stdout,
          stderr: primary.stderr,
          exitCode: primary.exit_code,
          resolvedTarget: parseResolvedTarget(parsed.target, primary.stdout),
        });
      }

      return successfulResult({
        operation,
        stdout: primary.stdout,
        stderr: primary.stderr,
        exitCode: primary.exit_code,
      });
    },
  });
}

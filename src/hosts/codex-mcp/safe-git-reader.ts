import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  GitReadSandboxRequest,
  MacosProofSandbox,
  ProofSandboxResult,
} from './proof-sandbox.js';

const MAX_GIT_POINTER_BYTES = 8 * 1024;
const GIT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const REQUEST_FIELDS = new Set(['operation']);

export type SafeGitOperation =
  | 'status'
  | 'staged_diff'
  | 'unstaged_diff'
  | 'staged_diff_stat'
  | 'untracked_files'
  | 'submodules';

export interface SafeGitRepository {
  readonly workspace: string;
  readonly git_dir: string;
  readonly common_dir: string;
  readonly read_roots: readonly string[];
}

export interface SafeGitSubmodule {
  readonly path: string;
  readonly index_oid: string;
  readonly inspection: 'gitlink_only';
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
  readonly submodules: readonly SafeGitSubmodule[];
  readonly submodule_policy: 'reported_without_recursive_execution';
  readonly attribute_policy: 'external_commands_disabled';
  readonly cleanup_confirmed: boolean;
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

const HARDENED_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'diff.external=',
  'interactive.diffFilter=',
  'credential.helper=',
  'core.sshCommand=false',
  'protocol.allow=never',
  'protocol.file.allow=never',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
] as const;

const OPERATION_ARGS: Readonly<Record<SafeGitOperation, readonly string[]>> = {
  status: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
  staged_diff: ['diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--cached', '--'],
  unstaged_diff: ['diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--'],
  staged_diff_stat: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--stat',
    '--cached',
    '--',
  ],
  untracked_files: ['ls-files', '--others', '--exclude-standard', '-z', '--'],
  submodules: ['ls-files', '--stage', '-z', '--'],
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
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
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
  return Object.freeze({
    workspace,
    git_dir: gitDirectory,
    common_dir: commonDirectory,
    read_roots: Object.freeze([...new Set([workspace, gitDirectory, commonDirectory])]),
  });
}

function parseRequest(value: unknown): SafeGitOperation {
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
    record.operation !== 'untracked_files' &&
    record.operation !== 'submodules'
  ) {
    throw new SafeGitReadError('invalid_git_read', 'Git read operation is not supported.');
  }
  return record.operation;
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

function gitArgv(
  executable: string,
  repository: SafeGitRepository,
  operation: SafeGitOperation | 'config_audit',
  dynamicConfig: readonly string[] = [],
): readonly string[] {
  return Object.freeze([
    executable,
    '--no-pager',
    '--no-optional-locks',
    `--git-dir=${repository.git_dir}`,
    `--work-tree=${repository.workspace}`,
    ...[...HARDENED_CONFIG, ...dynamicConfig].flatMap((value) => ['-c', value]),
    ...(operation === 'config_audit' ? CONFIG_AUDIT_ARGS : OPERATION_ARGS[operation]),
  ]);
}

function gitRequest(
  executable: string,
  repository: SafeGitRepository,
  operation: SafeGitOperation | 'config_audit',
  dynamicConfig: readonly string[] = [],
): GitReadSandboxRequest {
  return Object.freeze({
    id: `safe-git-${operation.replaceAll('_', '-')}`,
    cwd: '.',
    argv: gitArgv(executable, repository, operation, dynamicConfig),
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

function parseSubmodules(output: string, workspace: string): readonly SafeGitSubmodule[] {
  const submodules: SafeGitSubmodule[] = [];
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue;
    const match = /^160000 ([a-f0-9]{7,64}) (\d+)\t([\s\S]+)$/u.exec(entry);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    if (match[2] !== '0') {
      throw new SafeGitReadError(
        'unsafe_submodule_state',
        'Unmerged submodule index entries require manual inspection.',
      );
    }
    const submodulePath = match[3];
    if (isAbsolute(submodulePath) || !isInside(workspace, resolve(workspace, submodulePath))) {
      throw new SafeGitReadError(
        'unsafe_submodule_path',
        'A submodule path escapes the workspace.',
      );
    }
    submodules.push({
      path: submodulePath,
      index_oid: match[1],
      inspection: 'gitlink_only',
    });
  }
  return Object.freeze(submodules);
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
    submodules: Object.freeze([]),
    submodule_policy: 'reported_without_recursive_execution',
    attribute_policy: 'external_commands_disabled',
    cleanup_confirmed: result.cleanup.confirmed,
  });
}

export function createSafeGitReader(options: CreateSafeGitReaderOptions): SafeGitReader {
  return Object.freeze({
    async read(request: unknown): Promise<SafeGitReadResult> {
      const operation = parseRequest(request);
      const repository = await resolveSafeGitRepository(options.workspace);
      const executable = await resolveGitExecutable(options.gitExecutable);
      const configAudit = await options.sandbox.executeGitRead(
        gitRequest(executable, repository, 'config_audit'),
      );
      if (configAudit.status !== 'passed' || !configAudit.cleanup.confirmed) {
        return failedResult(operation, configAudit);
      }
      const dynamicConfig = auditGitConfiguration(configAudit.stdout);
      const primary = await options.sandbox.executeGitRead(
        gitRequest(executable, repository, operation, dynamicConfig),
      );
      if (primary.status !== 'passed' || !primary.cleanup.confirmed) {
        return failedResult(operation, primary);
      }

      const submoduleObservation =
        operation === 'submodules'
          ? primary
          : await options.sandbox.executeGitRead(
              gitRequest(executable, repository, 'submodules', dynamicConfig),
            );
      if (submoduleObservation.status !== 'passed' || !submoduleObservation.cleanup.confirmed) {
        return failedResult(operation, submoduleObservation);
      }
      const submodules = parseSubmodules(submoduleObservation.stdout, repository.workspace);

      return Object.freeze({
        schema_version: 1,
        ok: true,
        operation,
        stdout: primary.stdout,
        stderr: primary.stderr,
        exit_code: primary.exit_code,
        truncated: false,
        limit_bytes: GIT_OUTPUT_LIMIT_BYTES,
        submodules,
        submodule_policy: 'reported_without_recursive_execution',
        attribute_policy: 'external_commands_disabled',
        cleanup_confirmed: true,
      });
    },
  });
}

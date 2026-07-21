import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type ProofPlanCommand, runExternalMcpSandboxCommand } from './proof-plan.js';

export type SealedGitReadOperation =
  | 'review-status'
  | 'review-staged-diff'
  | 'review-unstaged-diff'
  | 'review-staged-stat'
  | 'review-untracked'
  | 'working-tree-status';

export interface SealedGitReadResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
  readonly truncated: boolean;
}

const SYSTEM_GIT = '/usr/bin/git';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MCP_PROOF_RUNNER_ENV = 'CIRCUIT_MCP_PROOF_RUNNER';

const GLOBAL_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'interactive.diffFilter=',
  '-c',
  'submodule.recurse=false',
] as const;

const OPERATION_ARGS: Readonly<Record<SealedGitReadOperation, readonly string[]>> = {
  'review-status': ['status', '--short', '--ignore-submodules=all'],
  'review-staged-diff': [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    '--cached',
    '--',
  ],
  'review-unstaged-diff': [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    '--',
  ],
  'review-staged-stat': [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    '--stat',
    '--cached',
    '--',
  ],
  'review-untracked': ['ls-files', '--others', '--exclude-standard', '-z'],
  'working-tree-status': [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=all',
  ],
};

const OPERATION_IDS: Readonly<Record<SealedGitReadOperation, string>> = {
  'review-status': 'git-review-status',
  'review-staged-diff': 'git-review-staged-diff',
  'review-unstaged-diff': 'git-review-unstaged-diff',
  'review-staged-stat': 'git-review-staged-stat',
  'review-untracked': 'git-review-untracked',
  'working-tree-status': 'git-working-tree-status',
};

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function projectRoot(projectRootInput: string): string {
  const root = realpathSync.native(resolve(projectRootInput));
  if (!lstatSync(root).isDirectory()) throw new Error('Git project root must be a directory.');
  return root;
}

export function sealedGitReadArgv(operation: SealedGitReadOperation): readonly string[] {
  return [SYSTEM_GIT, ...GLOBAL_ARGS, ...OPERATION_ARGS[operation]];
}

function normalGitRead(
  root: string,
  operation: SealedGitReadOperation,
  maxOutputBytes: number,
): SealedGitReadResult {
  const result = spawnSync('git', [...GLOBAL_ARGS, ...OPERATION_ARGS[operation]], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: maxOutputBytes,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
    truncated: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS',
  };
}

export function runSealedGitRead(
  projectRootInput: string,
  operation: SealedGitReadOperation,
  options: { readonly maxOutputBytes?: number } = {},
): SealedGitReadResult {
  const maxOutputBytes = Math.min(
    MAX_OUTPUT_BYTES,
    Math.max(1, options.maxOutputBytes ?? MAX_OUTPUT_BYTES),
  );
  if (process.env.CIRCUIT_MCP_SEALED !== '1') {
    // Ordinary CLI runs historically treat a missing or non-Git cwd as
    // unavailable evidence. Let Git/spawn report that condition instead of
    // applying the sealed MCP path contract to non-MCP callers.
    return normalGitRead(resolve(projectRootInput), operation, maxOutputBytes);
  }

  const root = projectRoot(projectRootInput);
  const runner = process.env[MCP_PROOF_RUNNER_ENV];
  if (runner === undefined || !isAbsolute(runner) || !existsSync(runner)) {
    throw new Error(`Sealed Git reads require an absolute ${MCP_PROOF_RUNNER_ENV}.`);
  }
  const command: ProofPlanCommand = {
    id: OPERATION_IDS[operation],
    cwd: '.',
    argv: sealedGitReadArgv(operation),
    timeout_ms: 30_000,
    max_output_bytes: maxOutputBytes,
    env: {},
  };
  const observed = runExternalMcpSandboxCommand(command, root, root, 'git-read-only');
  if (observed === undefined || observed.mcp_execution === undefined) {
    throw new Error('The sealed Git read broker did not return an MCP sandbox record.');
  }
  const execution = observed.mcp_execution;
  if (
    execution.access !== 'git-read-only' ||
    execution.network !== 'denied' ||
    execution.cleanup_confirmed !== true ||
    execution.writable_roots.length !== 1 ||
    execution.writable_roots.some(
      (candidate) =>
        !isAbsolute(candidate) ||
        isInside(root, resolve(candidate)) ||
        !resolve(candidate).split('/').at(-1)?.startsWith('circuit-mcp-proof-'),
    )
  ) {
    throw new Error('The sealed Git read broker did not prove its read-only boundary.');
  }
  const truncated = execution.status === 'output_limit';
  const error =
    observed.status === 'failed' && !truncated
      ? new Error(
          observed.stderr_summary.length > 0
            ? observed.stderr_summary
            : `The sealed Git read failed (${execution.status}; exit ${observed.exit_code}).`,
        )
      : undefined;
  return {
    status: observed.exit_code,
    signal: null,
    stdout: observed.stdout_summary,
    stderr: observed.stderr_summary,
    ...(error === undefined ? {} : { error }),
    truncated,
  };
}

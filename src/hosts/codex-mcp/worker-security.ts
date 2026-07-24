import { access, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { RuntimeExecutionCapabilities } from '../../runtime/run/capabilities.js';
import {
  ProofPlanBlockedError,
  preflightProofPlanCommand,
  resolveProjectRelativeProofCwd,
} from '../../shared/proof-plan.js';
import type { RuntimeGitReader } from '../../shared/runtime-git-reader.js';
import { createMacosProofSandbox } from './proof-sandbox.js';
import type { MacosProofSandbox } from './proof-sandbox.js';
import {
  type SafeGitReader,
  createSafeGitReader,
  resolveSafeGitRepository,
} from './safe-git-reader.js';

export interface McpWorkerSecurity {
  readonly proofCommandRunner: NonNullable<RuntimeExecutionCapabilities['proofCommandRunner']>;
  readonly gitReader: RuntimeGitReader;
}

export interface CreateMcpWorkerSecurityInput {
  readonly workspace: string;
  readonly privateRoot: string;
  readonly gitExecutable: string;
  readonly runtimeReadRoots?: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export interface CreateMcpWorkerSecurityDependencies {
  readonly createSandbox?: typeof createMacosProofSandbox;
  readonly createGitReader?: (input: {
    readonly workspace: string;
    readonly gitExecutable: string;
    readonly sandbox: MacosProofSandbox;
  }) => SafeGitReader;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function developerToolchainReadRoots(executable: string): readonly string[] {
  const resolved = resolve(executable);
  const xcode = /^\/Applications\/[^/]*Xcode[^/]*\.app\/Contents\/Developer(?:\/|$)/u.exec(
    resolved,
  );
  if (xcode !== null) return Object.freeze([xcode[0].replace(/\/$/u, '')]);
  if (isInside('/Library/Developer/CommandLineTools', resolved)) {
    return Object.freeze(['/Library/Developer/CommandLineTools']);
  }
  return Object.freeze([]);
}

function proofPathEntries(
  environment: NodeJS.ProcessEnv,
  preferredExecutables: readonly string[] = [],
): readonly string[] {
  const configured = (environment.PATH ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry) && !entry.includes('\0'));
  return Object.freeze([
    ...new Set([
      dirname(process.execPath),
      ...preferredExecutables
        .filter((entry) => isAbsolute(entry) && !entry.includes('\0'))
        .map((entry) => dirname(resolve(entry))),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      ...configured,
    ]),
  ]);
}

function isGitStateHelperCommand(command: {
  readonly id: string;
  readonly argv: readonly string[];
}): boolean {
  return (
    command.id.endsWith('-git-state') &&
    command.argv.some((entry) => /^git-state\.(?:js|ts)$/u.test(basename(entry)))
  );
}

function vitePlusInstallationRoot(candidate: string): string | undefined {
  return /^(.*\/\.vite-plus)\/[^/]+\/bin\/vp$/u.exec(candidate)?.[1];
}

function vitePlusNodeInstallationRoot(candidate: string): string | undefined {
  return /^(.*\/\.vite-plus)\/js_runtime\/node\/[^/]+\/bin\/node$/u.exec(candidate)?.[1];
}

async function reviewedVitePlusShimTarget(
  requestedName: string,
  candidate: string,
): Promise<string | undefined> {
  const canonicalCandidate = await realpath(candidate);
  const viteRoot = vitePlusInstallationRoot(canonicalCandidate);
  if (viteRoot === undefined) return candidate;
  const hostNode = await realpath(process.execPath);
  if (vitePlusNodeInstallationRoot(hostNode) !== viteRoot) return undefined;
  if (requestedName === 'node') return hostNode;
  const script =
    requestedName === 'npm' ? 'npm-cli.js' : requestedName === 'npx' ? 'npx-cli.js' : undefined;
  if (script === undefined) return undefined;
  const target = join(dirname(dirname(hostNode)), 'lib', 'node_modules', 'npm', 'bin', script);
  try {
    await access(target, 1);
    return await realpath(target);
  } catch {
    return undefined;
  }
}

async function resolveProofExecutable(
  argv0: string,
  pathEntries: readonly string[],
): Promise<string> {
  const normalizedPathEntries = pathEntries.map((entry) => resolve(entry));
  const candidates = isAbsolute(argv0)
    ? normalizedPathEntries.includes(dirname(resolve(argv0)))
      ? [resolve(argv0)]
      : []
    : basename(argv0) === argv0
      ? normalizedPathEntries.map((entry) => join(entry, argv0))
      : [];
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      const reviewed = await reviewedVitePlusShimTarget(basename(argv0), candidate);
      if (reviewed !== undefined) return reviewed;
    } catch {
      // Keep looking through the fixed PATH roster.
    }
  }
  throw new ProofPlanBlockedError(
    `Proof plan blocked: verification executable ${JSON.stringify(argv0)} is outside the fixed proof toolchain or unavailable.`,
  );
}

export function createMcpWorkerSecurity(
  input: CreateMcpWorkerSecurityInput,
  dependencies: CreateMcpWorkerSecurityDependencies = {},
): McpWorkerSecurity {
  const workspace = resolve(input.workspace);
  const gitExecutable = resolve(input.gitExecutable);
  const pathEntries = proofPathEntries(input.environment, [gitExecutable]);
  const readRoots = [
    ...new Set([...(input.runtimeReadRoots ?? []), ...developerToolchainReadRoots(gitExecutable)]),
  ];
  const sandbox = (dependencies.createSandbox ?? createMacosProofSandbox)({
    workspace,
    privateRoot: input.privateRoot,
    pathEntries,
    ...(readRoots.length === 0 ? {} : { readRoots }),
    // The supervisor launches each worker as the leader of its own process
    // group. Proof and Git children stay in that durable cleanup boundary.
    ownerProcessGroupId: process.pid,
  });
  const safeGit = (dependencies.createGitReader ?? createSafeGitReader)({
    workspace,
    gitExecutable: input.gitExecutable,
    sandbox,
  });
  let gitMetadataReadRoots: Promise<readonly string[]> | undefined;
  const resolveGitMetadataReadRoots = async (): Promise<readonly string[]> => {
    gitMetadataReadRoots ??= resolveSafeGitRepository(workspace).then(
      (repository) => repository.read_roots,
    );
    return await gitMetadataReadRoots;
  };

  const proofCommandRunner: McpWorkerSecurity['proofCommandRunner'] = async (
    command,
    projectRoot,
  ) => {
    const canonicalProjectRoot = resolve(projectRoot);
    if (!isInside(workspace, canonicalProjectRoot)) {
      throw new ProofPlanBlockedError(
        'Proof plan blocked: the project root escapes the trusted workspace.',
      );
    }
    const cwd = resolveProjectRelativeProofCwd(canonicalProjectRoot, command.cwd);
    preflightProofPlanCommand(command, cwd);
    const executable = await resolveProofExecutable(command.argv[0] ?? '', pathEntries);
    const sandboxCwd = relative(workspace, cwd) || '.';
    const request = {
      id: command.id,
      cwd: sandboxCwd,
      argv: [executable, ...command.argv.slice(1)],
      env: command.env,
      timeout_ms: command.timeout_ms,
      max_output_bytes: command.max_output_bytes,
    };
    const gitStateReadRoots = isGitStateHelperCommand(command)
      ? await resolveGitMetadataReadRoots()
      : undefined;
    const result =
      gitStateReadRoots === undefined
        ? await sandbox.execute(request)
        : await sandbox.execute(request, { readRoots: gitStateReadRoots });
    if (!result.cleanup.confirmed || result.status === 'cleanup_unconfirmed') {
      throw new ProofPlanBlockedError(
        `Proof plan blocked: cleanup could not be confirmed for command '${command.id}'.`,
      );
    }
    const passed = result.status === 'passed';
    const exitCode = passed
      ? 0
      : result.exit_code === null || result.exit_code === 0
        ? 1
        : result.exit_code;
    return {
      command,
      exit_code: exitCode,
      status: passed ? 'passed' : 'failed',
      duration_ms: result.duration_ms,
      stdout_summary: result.stdout,
      stderr_summary: result.stderr,
      timed_out: result.status === 'timed_out',
    };
  };
  const gitReader: RuntimeGitReader = {
    read: async ({ operation, projectRoot, target }) => {
      if (resolve(projectRoot) !== workspace) {
        throw new Error('The bounded Git reader is sealed to the trusted workspace.');
      }
      return await safeGit.read({ operation, ...(target === undefined ? {} : { target }) });
    },
  };
  return Object.freeze({ proofCommandRunner, gitReader });
}

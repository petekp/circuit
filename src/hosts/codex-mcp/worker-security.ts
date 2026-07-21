import { access } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { RuntimeExecutionCapabilities } from '../../runtime/run/capabilities.js';
import {
  ProofPlanBlockedError,
  preflightProofPlanCommand,
  resolveProjectRelativeProofCwd,
} from '../../shared/proof-plan.js';
import type { RuntimeGitReader } from '../../shared/runtime-git-reader.js';
import { createMacosProofSandbox } from './proof-sandbox.js';
import type { MacosProofSandbox } from './proof-sandbox.js';
import { type SafeGitReader, createSafeGitReader } from './safe-git-reader.js';

export interface McpWorkerSecurity {
  readonly proofCommandRunner: NonNullable<RuntimeExecutionCapabilities['proofCommandRunner']>;
  readonly gitReader: RuntimeGitReader;
}

export interface CreateMcpWorkerSecurityInput {
  readonly workspace: string;
  readonly privateRoot: string;
  readonly gitExecutable: string;
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

function proofPathEntries(environment: NodeJS.ProcessEnv): readonly string[] {
  const entries = (environment.PATH ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry) && !entry.includes('\0'));
  entries.push(dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return Object.freeze([...new Set(entries)]);
}

async function resolveProofExecutable(
  argv0: string,
  pathEntries: readonly string[],
): Promise<string> {
  const candidates = isAbsolute(argv0) ? [argv0] : pathEntries.map((entry) => join(entry, argv0));
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      // Keep looking through the fixed PATH roster.
    }
  }
  throw new ProofPlanBlockedError(
    `Proof plan blocked: verification executable ${JSON.stringify(argv0)} is unavailable.`,
  );
}

export function createMcpWorkerSecurity(
  input: CreateMcpWorkerSecurityInput,
  dependencies: CreateMcpWorkerSecurityDependencies = {},
): McpWorkerSecurity {
  const workspace = resolve(input.workspace);
  const pathEntries = proofPathEntries(input.environment);
  const sandbox = (dependencies.createSandbox ?? createMacosProofSandbox)({
    workspace,
    privateRoot: input.privateRoot,
    pathEntries,
  });
  const safeGit = (dependencies.createGitReader ?? createSafeGitReader)({
    workspace,
    gitExecutable: input.gitExecutable,
    sandbox,
  });

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
    const result = await sandbox.execute({
      id: command.id,
      cwd: sandboxCwd,
      argv: [executable, ...command.argv.slice(1)],
      env: command.env,
      timeout_ms: command.timeout_ms,
      max_output_bytes: command.max_output_bytes,
    });
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
    read: async ({ operation, projectRoot }) => {
      if (resolve(projectRoot) !== workspace) {
        throw new Error('The bounded Git reader is sealed to the trusted workspace.');
      }
      return await safeGit.read({ operation });
    },
  };
  return Object.freeze({ proofCommandRunner, gitReader });
}

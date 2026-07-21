import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isGitStateCommandId } from './git-state-command.js';
import { readWorkspaceRegularFile } from './safe-workspace-file.js';

const PROOF_PLAN_ENV_INHERIT_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
] as const;

export class ProofPlanBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofPlanBlockedError';
  }
}

export function isProofPlanBlockedError(error: unknown): error is ProofPlanBlockedError {
  return (
    error instanceof ProofPlanBlockedError ||
    (error instanceof Error && error.name === 'ProofPlanBlockedError')
  );
}

export interface ProofPlanCommandObservation {
  readonly command: ProofPlanCommand;
  readonly exit_code: number;
  readonly status: 'passed' | 'failed';
  readonly duration_ms: number;
  readonly stdout_summary: string;
  readonly stderr_summary: string;
  // True when the command was killed for hitting its verification budget
  // rather than exiting on its own. Lets downstream reasoning (the
  // executor's failure reason, recovery routing) distinguish an honest
  // timeout from a red command instead of folding both into 'failed'.
  readonly timed_out: boolean;
  readonly mcp_execution?: {
    readonly access: 'workspace-write' | 'git-read-only';
    readonly status: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'output_limit';
    readonly cleanup_confirmed: boolean;
    readonly network: 'denied';
    readonly writable_roots: readonly string[];
  };
}

export interface ProofPlanCommand {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly env: Readonly<Record<string, string>>;
}

function isInsideOrSame(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function resolveProjectRelativeProofCwd(projectRoot: string, cwd: string): string {
  const rootAbs = resolve(projectRoot);
  const targetAbs = resolve(rootAbs, cwd);
  if (!isInsideOrSame(rootAbs, targetAbs)) {
    throw new ProofPlanBlockedError(
      `verification cwd rejected: ${JSON.stringify(cwd)} escapes project root`,
    );
  }
  if (!existsSync(rootAbs)) {
    throw new ProofPlanBlockedError(
      `verification project root rejected: ${rootAbs} does not exist`,
    );
  }
  const rootReal = realpathSync.native(rootAbs);
  let cursor = rootAbs;
  for (const segment of cwd.split('/')) {
    if (segment === '.') continue;
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) {
      throw new ProofPlanBlockedError(
        `verification cwd rejected: ${JSON.stringify(cwd)} does not exist`,
      );
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new ProofPlanBlockedError(
        `verification cwd rejected: ${JSON.stringify(cwd)} crosses symlink ${JSON.stringify(cursor)}`,
      );
    }
    const cursorReal = realpathSync.native(cursor);
    if (!isInsideOrSame(rootReal, cursorReal)) {
      throw new ProofPlanBlockedError(
        `verification cwd rejected: ${JSON.stringify(cwd)} escapes real project root through ${JSON.stringify(cursor)}`,
      );
    }
  }
  const targetReal = realpathSync.native(targetAbs);
  if (!isInsideOrSame(rootReal, targetReal)) {
    throw new ProofPlanBlockedError(
      `verification cwd rejected: ${JSON.stringify(cwd)} escapes real project root`,
    );
  }
  return targetReal;
}

function proofPlanEnvironment(commandEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROOF_PLAN_ENV_INHERIT_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...commandEnv };
}

function summarizeOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8');
}

function commandBinaryName(argv0: string): string {
  const normalized = argv0.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

export function packageScriptInvocation(command: ProofPlanCommand): string | undefined {
  const argv0 = command.argv[0];
  if (argv0 === undefined) return undefined;
  const binary = commandBinaryName(argv0);
  if (binary !== 'npm' && binary !== 'pnpm' && binary !== 'yarn') return undefined;
  if (command.argv[1] !== 'run') return undefined;
  const script = command.argv[2];
  if (script === undefined) {
    throw new ProofPlanBlockedError(
      `Proof plan blocked: verification command '${command.id}' invokes ${binary} run without a script name.`,
    );
  }
  return script;
}

export function preflightProofPlanCommand(command: ProofPlanCommand, cwdAbs: string): void {
  const script = packageScriptInvocation(command);
  if (script === undefined) return;

  let parsed: unknown;
  try {
    const source = readWorkspaceRegularFile(cwdAbs, 'package.json', 1024 * 1024);
    if (source === undefined) {
      throw new ProofPlanBlockedError(
        `Proof plan blocked: verification command '${command.id}' requires package.json at cwd ${JSON.stringify(command.cwd)}.`,
      );
    }
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof ProofPlanBlockedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProofPlanBlockedError(
      `Proof plan blocked: verification command '${command.id}' could not parse package.json at cwd ${JSON.stringify(command.cwd)}: ${message}.`,
    );
  }

  const scripts =
    parsed && typeof parsed === 'object' ? (parsed as { scripts?: unknown }).scripts : undefined;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new ProofPlanBlockedError(
      `Proof plan blocked: verification command '${command.id}' requires package.json scripts at cwd ${JSON.stringify(command.cwd)}.`,
    );
  }
  if (typeof (scripts as Record<string, unknown>)[script] !== 'string') {
    throw new ProofPlanBlockedError(
      `Proof plan blocked: verification command '${command.id}' references missing package script "${script}" at cwd ${JSON.stringify(command.cwd)}.`,
    );
  }
}

function isLaunchError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR';
}

function commandTimedOut(input: {
  readonly error: Error | undefined;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timeoutMs: number;
}): boolean {
  if (input.error !== undefined && (input.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return true;
  }
  return input.signal !== null && input.durationMs >= input.timeoutMs;
}

const MCP_PROOF_REQUEST_SCHEMA = 'circuit.mcp-proof-request@v1';
const MCP_PROOF_RESPONSE_SCHEMA = 'circuit.mcp-proof-response@v1';
const MCP_PROOF_RUNNER_ENV = 'CIRCUIT_MCP_PROOF_RUNNER';
const MCP_CANCEL_FILE_ENV = 'CIRCUIT_MCP_CANCEL_FILE';
const MCP_GIT_STATE_HELPER_ENV = 'CIRCUIT_MCP_GIT_STATE_HELPER';

export function runExternalMcpSandboxCommand(
  command: ProofPlanCommand,
  projectRoot: string,
  cwd: string,
  access: 'workspace-write' | 'git-read-only' = 'workspace-write',
): ProofPlanCommandObservation | undefined {
  const configuredRunner = process.env[MCP_PROOF_RUNNER_ENV];
  if (configuredRunner === undefined) return undefined;
  if (!isAbsolute(configuredRunner)) {
    throw new ProofPlanBlockedError(`${MCP_PROOF_RUNNER_ENV} must be an absolute path.`);
  }
  if (!existsSync(configuredRunner)) {
    throw new ProofPlanBlockedError(`${MCP_PROOF_RUNNER_ENV} does not exist.`);
  }
  const runnerStat = lstatSync(configuredRunner);
  if (runnerStat.isSymbolicLink() || !runnerStat.isFile()) {
    throw new ProofPlanBlockedError(`${MCP_PROOF_RUNNER_ENV} must be a regular file.`);
  }
  const runner = realpathSync.native(configuredRunner);
  const cancelFile = process.env[MCP_CANCEL_FILE_ENV];
  if (cancelFile === undefined || !isAbsolute(cancelFile)) {
    throw new ProofPlanBlockedError(`${MCP_CANCEL_FILE_ENV} must be an absolute path.`);
  }
  const canonicalProjectRoot = realpathSync.native(resolve(projectRoot));
  const request = {
    schema: MCP_PROOF_REQUEST_SCHEMA,
    access,
    projectRoot: canonicalProjectRoot,
    cwd,
    command,
    cancelFile,
  };
  const gitStateHelper = process.env[MCP_GIT_STATE_HELPER_ENV];
  const result = spawnSync(process.execPath, [runner], {
    cwd: canonicalProjectRoot,
    env: proofPlanEnvironment(
      gitStateHelper === undefined ? {} : { [MCP_GIT_STATE_HELPER_ENV]: gitStateHelper },
    ),
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: Math.max(command.max_output_bytes * 2 + 64 * 1024, 256 * 1024),
    shell: false,
    timeout: command.timeout_ms + 10_000,
  });
  if (result.error !== undefined) {
    throw new ProofPlanBlockedError(
      `Proof sandbox runner failed for '${command.id}': ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(-2_000) : '';
    throw new ProofPlanBlockedError(
      `Proof sandbox runner failed for '${command.id}' (exit ${String(result.status)})${detail.length === 0 ? '.' : `: ${detail}`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof result.stdout === 'string' ? result.stdout : '');
  } catch (error) {
    throw new ProofPlanBlockedError(
      `Proof sandbox runner returned invalid JSON for '${command.id}': ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProofPlanBlockedError('Proof sandbox runner returned an invalid response.');
  }
  const response = parsed as Record<string, unknown>;
  const observation = response.observation;
  const execution = response.execution;
  if (
    response.schema !== MCP_PROOF_RESPONSE_SCHEMA ||
    observation === null ||
    typeof observation !== 'object' ||
    Array.isArray(observation) ||
    execution === null ||
    typeof execution !== 'object' ||
    Array.isArray(execution)
  ) {
    throw new ProofPlanBlockedError('Proof sandbox runner returned an invalid response.');
  }
  const observed = observation as Record<string, unknown>;
  const executionRecord = execution as Record<string, unknown>;
  const cleanup = executionRecord.cleanup;
  const sandbox = executionRecord.sandbox;
  const executionStatus = executionRecord.status;
  if (
    cleanup === null ||
    typeof cleanup !== 'object' ||
    Array.isArray(cleanup) ||
    (cleanup as Record<string, unknown>).confirmed !== true
  ) {
    const detail = JSON.stringify(cleanup);
    throw new ProofPlanBlockedError(
      `Proof sandbox runner could not confirm cleanup for '${command.id}': ${detail}.`,
    );
  }
  if (
    sandbox === null ||
    typeof sandbox !== 'object' ||
    Array.isArray(sandbox) ||
    (sandbox as Record<string, unknown>).network !== 'denied' ||
    (sandbox as Record<string, unknown>).access !== access ||
    !Array.isArray((sandbox as Record<string, unknown>).writable_roots)
  ) {
    throw new ProofPlanBlockedError(
      `Proof sandbox runner did not prove network denial for '${command.id}'.`,
    );
  }
  const exitCode = observed.exit_code;
  const status = observed.status;
  const durationMs = observed.duration_ms;
  const stdoutSummary = observed.stdout_summary;
  const stderrSummary = observed.stderr_summary;
  const timedOut = observed.timed_out;
  if (
    executionStatus !== 'passed' &&
    executionStatus !== 'failed' &&
    executionStatus !== 'timed_out' &&
    executionStatus !== 'cancelled' &&
    executionStatus !== 'output_limit'
  ) {
    throw new ProofPlanBlockedError('Proof sandbox runner returned an invalid execution status.');
  }
  if (
    !Number.isInteger(exitCode) ||
    (status !== 'passed' && status !== 'failed') ||
    typeof durationMs !== 'number' ||
    durationMs < 0 ||
    typeof stdoutSummary !== 'string' ||
    typeof stderrSummary !== 'string' ||
    typeof timedOut !== 'boolean' ||
    (status === 'passed') !== (exitCode === 0)
  ) {
    throw new ProofPlanBlockedError('Proof sandbox runner returned an invalid observation.');
  }
  return {
    command,
    exit_code: exitCode as number,
    status,
    duration_ms: durationMs,
    stdout_summary: summarizeOutput(stdoutSummary, command.max_output_bytes),
    stderr_summary: summarizeOutput(stderrSummary, command.max_output_bytes),
    timed_out: timedOut,
    mcp_execution: {
      access,
      status: executionStatus,
      cleanup_confirmed: true,
      network: 'denied',
      writable_roots: (sandbox as Record<string, unknown>).writable_roots as string[],
    },
  };
}

export function runProofPlanCommand(
  command: ProofPlanCommand,
  projectRoot: string,
): ProofPlanCommandObservation {
  const started = Date.now();
  const cwd = resolveProjectRelativeProofCwd(projectRoot, command.cwd);
  preflightProofPlanCommand(command, cwd);
  const access = isGitStateCommandId(command.id) ? 'git-read-only' : 'workspace-write';
  const externalObservation = runExternalMcpSandboxCommand(command, projectRoot, cwd, access);
  if (externalObservation !== undefined) return externalObservation;
  const result = spawnSync(command.argv[0] as string, command.argv.slice(1), {
    cwd,
    env: proofPlanEnvironment(command.env),
    encoding: 'utf8',
    maxBuffer: command.max_output_bytes,
    shell: false,
    timeout: command.timeout_ms,
  });
  if (result.error !== undefined && isLaunchError(result.error)) {
    throw new ProofPlanBlockedError(
      `Proof plan blocked: verification command '${command.id}' could not launch ${JSON.stringify(command.argv[0])}: ${result.error.message}`,
    );
  }
  const exitCode =
    typeof result.status === 'number' && result.error === undefined ? result.status : 1;
  const durationMs = Math.max(0, Date.now() - started);
  const stderrParts = [
    typeof result.stderr === 'string' ? result.stderr : '',
    result.error === undefined ? '' : result.error.message,
    result.signal === null ? '' : `signal: ${result.signal}`,
  ].filter((part) => part.length > 0);
  return {
    command,
    exit_code: exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    duration_ms: durationMs,
    stdout_summary: summarizeOutput(
      typeof result.stdout === 'string' ? result.stdout : '',
      command.max_output_bytes,
    ),
    stderr_summary: summarizeOutput(stderrParts.join('\n'), command.max_output_bytes),
    timed_out: commandTimedOut({
      error: result.error,
      signal: result.signal,
      durationMs,
      timeoutMs: command.timeout_ms,
    }),
  };
}

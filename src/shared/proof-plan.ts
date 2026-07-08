import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

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

  const packageJsonPath = join(cwdAbs, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new ProofPlanBlockedError(
      `Proof plan blocked: verification command '${command.id}' requires package.json at cwd ${JSON.stringify(command.cwd)}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
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

export function runProofPlanCommand(
  command: ProofPlanCommand,
  projectRoot: string,
): ProofPlanCommandObservation {
  const started = Date.now();
  const cwd = resolveProjectRelativeProofCwd(projectRoot, command.cwd);
  preflightProofPlanCommand(command, cwd);
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
  const stderrParts = [
    typeof result.stderr === 'string' ? result.stderr : '',
    result.error === undefined ? '' : result.error.message,
    result.signal === null ? '' : `signal: ${result.signal}`,
  ].filter((part) => part.length > 0);
  return {
    command,
    exit_code: exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    duration_ms: Math.max(0, Date.now() - started),
    stdout_summary: summarizeOutput(
      typeof result.stdout === 'string' ? result.stdout : '',
      command.max_output_bytes,
    ),
    stderr_summary: summarizeOutput(stderrParts.join('\n'), command.max_output_bytes),
  };
}

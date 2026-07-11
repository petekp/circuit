import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationCommand } from '../schemas/verification.js';
import { ProofPlanBlockedError } from './proof-plan.js';

export type VerificationNeed = 'build' | 'lint' | 'general';

// One shared verification budget across every caller. 600s aligns Build,
// Fix, and Pursue with Fix's original allowance instead of the accidental
// 120s split (docs/release/agent-friction-remediation.md, F1).
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 600_000;

export interface ResolveVerificationCommandsInput {
  readonly projectRoot?: string;
  readonly goal: string;
  readonly requestedNeeds?: readonly VerificationNeed[];
  readonly commandIdPrefix: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export type VerificationResolverResult =
  | { readonly status: 'ready'; readonly commands: readonly VerificationCommand[] }
  | { readonly status: 'blocked'; readonly reason: string };

type PackageManager = 'npm' | 'pnpm' | 'yarn';

interface PackageInfo {
  readonly scripts: Readonly<Record<string, string>>;
  readonly packageManager?: string;
}

function readPackageInfo(projectRoot: string): PackageInfo | string {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return `Cannot choose verification commands because ${packageJsonPath} does not exist.`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Cannot choose verification commands because package.json could not be parsed: ${message}.`;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Cannot choose verification commands because package.json is not a JSON object.';
  }

  const scriptsRaw = (parsed as { scripts?: unknown }).scripts;
  if (scriptsRaw === null || typeof scriptsRaw !== 'object' || Array.isArray(scriptsRaw)) {
    return 'Cannot choose verification commands because package.json scripts must be an object.';
  }

  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(scriptsRaw ?? {})) {
    if (typeof value === 'string') scripts[name] = value;
  }

  if (Object.keys(scripts).length === 0) {
    return 'Cannot choose verification commands because package.json does not define any scripts.';
  }

  const packageManagerRaw = (parsed as { packageManager?: unknown }).packageManager;
  return {
    scripts,
    ...(typeof packageManagerRaw === 'string' ? { packageManager: packageManagerRaw } : {}),
  };
}

function packageManagerFromPackageJson(value: string): PackageManager | string {
  if (value === 'npm' || value.startsWith('npm@')) return 'npm';
  if (value === 'pnpm' || value.startsWith('pnpm@')) return 'pnpm';
  if (value === 'yarn' || value.startsWith('yarn@')) return 'yarn';
  return `Cannot choose verification commands because packageManager ${JSON.stringify(value)} is not supported by the Node-script resolver.`;
}

function resolvePackageManager(projectRoot: string, info: PackageInfo): PackageManager | string {
  if (info.packageManager !== undefined) return packageManagerFromPackageJson(info.packageManager);
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectRoot, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function uniqueNeeds(needs: readonly VerificationNeed[] | undefined): VerificationNeed[] {
  const source = needs === undefined || needs.length === 0 ? ['general' as const] : needs;
  return [...new Set(source)];
}

function firstGeneralScript(scripts: Readonly<Record<string, string>>): string | undefined {
  for (const name of ['verify', 'test', 'check'] as const) {
    if (typeof scripts[name] === 'string') return name;
  }
  return undefined;
}

function commandForScript(input: {
  readonly manager: PackageManager;
  readonly script: string;
  readonly commandIdPrefix: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}): VerificationCommand {
  return {
    id: `${input.commandIdPrefix}-${input.script}`,
    cwd: '.',
    argv: [input.manager, 'run', input.script],
    timeout_ms: input.timeoutMs,
    max_output_bytes: input.maxOutputBytes,
    env: { ...input.env },
  };
}

export function resolveVerificationCommands(
  input: ResolveVerificationCommandsInput,
): VerificationResolverResult {
  if (input.projectRoot === undefined) {
    return {
      status: 'blocked',
      reason: 'Cannot choose verification commands because projectRoot was not provided.',
    };
  }

  const packageInfo = readPackageInfo(input.projectRoot);
  if (typeof packageInfo === 'string') return { status: 'blocked', reason: packageInfo };

  const manager = resolvePackageManager(input.projectRoot, packageInfo);
  if (typeof manager === 'string' && !['npm', 'pnpm', 'yarn'].includes(manager)) {
    return { status: 'blocked', reason: manager };
  }

  const needs = uniqueNeeds(input.requestedNeeds);
  const missing: string[] = [];
  const selectedScripts: string[] = [];

  for (const need of needs) {
    if (need === 'general') {
      const generalScript = firstGeneralScript(packageInfo.scripts);
      if (generalScript === undefined) {
        missing.push('one of verify, test, or check');
      } else {
        selectedScripts.push(generalScript);
      }
      continue;
    }
    if (typeof packageInfo.scripts[need] === 'string') {
      selectedScripts.push(need);
    } else {
      missing.push(need);
    }
  }

  if (missing.length > 0) {
    return {
      status: 'blocked',
      reason: `Cannot choose verification commands because package.json is missing required script ${missing.join(', ')}.`,
    };
  }

  const commands = [...new Set(selectedScripts)].map((script) =>
    commandForScript({
      manager: manager as PackageManager,
      script,
      commandIdPrefix: input.commandIdPrefix,
      timeoutMs: input.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes ?? 200_000,
      env: input.env ?? {},
    }),
  );

  if (commands.length === 0) {
    return {
      status: 'blocked',
      reason: 'Cannot choose verification commands because no verification scripts were selected.',
    };
  }

  return { status: 'ready', commands };
}

export function requireResolvedVerificationCommands(
  input: ResolveVerificationCommandsInput,
): readonly VerificationCommand[] {
  const result = resolveVerificationCommands(input);
  if (result.status === 'blocked') throw new ProofPlanBlockedError(result.reason);
  return result.commands;
}

function goalAsksForNeed(goal: string, need: 'build' | 'lint'): boolean {
  const escaped = need.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const proofWords = String.raw`(?:run|runs|pass|passes|passing|green|clean|keep|stays?|must|should|ensure|verify|verification|proof)`;
  return (
    new RegExp(String.raw`\b${escaped}\b\s*(?:\+|&|and|,)\s*\b(?:build|lint)\b`, 'i').test(goal) ||
    new RegExp(String.raw`\b(?:build|lint)\b\s*(?:\+|&|and|,)\s*\b${escaped}\b`, 'i').test(goal) ||
    new RegExp(String.raw`\b${proofWords}\b[\s\S]{0,40}\b${escaped}\b`, 'i').test(goal) ||
    new RegExp(String.raw`\b${escaped}\b[\s\S]{0,40}\b${proofWords}\b`, 'i').test(goal)
  );
}

export function inferBuildVerificationNeeds(goal: string): readonly VerificationNeed[] {
  const needs: VerificationNeed[] = [];
  if (goalAsksForNeed(goal, 'build')) needs.push('build');
  if (goalAsksForNeed(goal, 'lint')) needs.push('lint');
  return needs.length > 0 ? needs : ['general'];
}

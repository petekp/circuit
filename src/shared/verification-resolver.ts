import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type DeclaredVerificationCommand,
  VerificationCommand,
  VerificationConfig,
} from '../schemas/verification.js';
import { PROJECT_CONFIG_RELATIVE_SEGMENTS } from './control-plane-paths.js';
import { ProofPlanBlockedError } from './proof-plan.js';

// `scan` and `audit` are Sweep's two oracles. They resolve through the same
// precedence as the rest, and their package.json fallback is a script of the
// same name, which is what the generic per-need branch below already does.
export type VerificationNeed = 'build' | 'lint' | 'general' | 'scan' | 'audit';

// Needs that census a set rather than prove a change. They carry an output
// contract of their own, so the inline "verify with `cmd`" shortcut does not
// answer them. See resolveVerificationCommands.
const CENSUS_ORACLE_NEEDS: ReadonlySet<VerificationNeed> = new Set(['scan', 'audit']);

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
  // Parsed, not constructed: this is the resolver's own mint, and the brand on
  // VerificationCommand only comes from the schema.
  return VerificationCommand.parse({
    id: `${input.commandIdPrefix}-${input.script}`,
    cwd: '.',
    argv: [input.manager, 'run', input.script],
    timeout_ms: input.timeoutMs,
    max_output_bytes: input.maxOutputBytes,
    env: { ...input.env },
  });
}

function parseSimpleArgv(command: string): string[] | undefined {
  const argv: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (quote === '"' && char === '\\') {
        const next = command[index + 1];
        if (next === '"' || next === '\\') {
          current += next;
          index += 1;
          tokenStarted = true;
          continue;
        }
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        argv.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    // Verification executes argv directly, so shell control syntax is rejected.
    if (/[|&;<>()`$]/.test(char)) return undefined;

    current += char;
    tokenStarted = true;
  }

  if (quote !== undefined) return undefined;
  if (tokenStarted) argv.push(current);
  if (argv.length === 0) return undefined;
  if (argv.some((part) => part.length === 0)) return undefined;
  return argv;
}

function trimInlineCwd(value: string): string | undefined {
  const unquoted = /^`([^`]+)`$/u.exec(value.trim())?.[1] ?? value;
  const cwd = unquoted
    .trim()
    .replace(/[.:;,]+$/u, '')
    .trim();
  if (/^(?:the\s+)?(?:workspace|project|repo|repository)\s+root$/iu.test(cwd)) return '.';
  if (cwd.length === 0 || cwd.includes('\0')) return undefined;
  if (/\s/.test(cwd)) return undefined;
  if (cwd.startsWith('/') || cwd.split('/').some((segment) => segment === '..')) return undefined;
  return cwd;
}

function explicitInlineVerifyWithCommand(
  input: ResolveVerificationCommandsInput,
): VerificationCommand | undefined {
  const match =
    /\bverify with\s+`([^`]+)`\s+from\s+(?:(`[^`]+`)|((?:the\s+)?(?:workspace|project|repo|repository)\s+root)|([^\s`]+))/iu.exec(
      input.goal,
    );
  const rawCommand = match?.[1];
  const rawCwd = match?.[2] ?? match?.[3] ?? match?.[4];
  if (rawCommand === undefined || rawCwd === undefined) return undefined;
  const argv = parseSimpleArgv(rawCommand);
  const cwd = trimInlineCwd(rawCwd);
  if (argv === undefined || cwd === undefined) return undefined;
  return VerificationCommand.parse({
    id: `${input.commandIdPrefix}-objective-1`,
    cwd,
    argv,
    timeout_ms: input.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
    max_output_bytes: input.maxOutputBytes ?? 200_000,
    env: { ...(input.env ?? {}) },
  });
}

// `.circuit/config.yaml`, as the operator would write it in a message.
const PROJECT_CONFIG_DISPLAY_PATH = PROJECT_CONFIG_RELATIVE_SEGMENTS.join('/');

type DeclaredVerification =
  | { readonly status: 'none' }
  | { readonly status: 'declared'; readonly config: VerificationConfig }
  | { readonly status: 'invalid'; readonly reason: string };

function readDeclaredVerification(projectRoot: string): DeclaredVerification {
  const configPath = join(projectRoot, ...PROJECT_CONFIG_RELATIVE_SEGMENTS);
  if (!existsSync(configPath)) return { status: 'none' };

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch {
    // A config file this resolver cannot read is not this resolver's error to
    // report: the run's own config load already fails loudly on it, and
    // reporting it twice in different words would send the operator hunting in
    // two places. Fall through to the package.json path.
    return { status: 'none' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'none' };
  }

  const raw = (parsed as { verification?: unknown }).verification;
  if (raw === undefined) return { status: 'none' };

  const result = VerificationConfig.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${['verification', ...issue.path].join('.')}: ${issue.message}`)
      .join('; ');
    return {
      status: 'invalid',
      reason: `Cannot choose verification commands because ${PROJECT_CONFIG_DISPLAY_PATH} declares an unusable verification block (${detail}).`,
    };
  }
  return { status: 'declared', config: result.data };
}

function commandForDeclared(input: {
  readonly need: VerificationNeed;
  readonly declared: DeclaredVerificationCommand;
  readonly commandIdPrefix: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}): VerificationCommand | string {
  // Parsed rather than constructed: VerificationCommand already refuses a
  // shell executable and a cwd outside the project, so a declared command
  // clears exactly the same bar as a resolved one.
  const parsed = VerificationCommand.safeParse({
    id: `${input.commandIdPrefix}-${input.need}`,
    cwd: input.declared.cwd,
    argv: [...input.declared.argv],
    timeout_ms: input.declared.timeout_ms ?? input.timeoutMs,
    max_output_bytes: input.maxOutputBytes,
    env: { ...input.env },
  });
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
  return `Cannot choose verification commands because ${PROJECT_CONFIG_DISPLAY_PATH} declares an unusable command at verification.${input.need} (${detail}).`;
}

function resolveFromPackageScripts(
  input: ResolveVerificationCommandsInput & { readonly projectRoot: string },
  needs: readonly VerificationNeed[],
): VerificationResolverResult {
  const packageInfo = readPackageInfo(input.projectRoot);
  if (typeof packageInfo === 'string') return { status: 'blocked', reason: packageInfo };

  const manager = resolvePackageManager(input.projectRoot, packageInfo);
  if (typeof manager === 'string' && !['npm', 'pnpm', 'yarn'].includes(manager)) {
    return { status: 'blocked', reason: manager };
  }

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

export function resolveVerificationCommands(
  input: ResolveVerificationCommandsInput,
): VerificationResolverResult {
  const needs = uniqueNeeds(input.requestedNeeds);

  // An inline "verify with `cmd`" names a proof OF THE CHANGE, so it outranks
  // any script we would otherwise infer for one: general, build and lint are
  // all that same kind of proof, and a caller who spells the command out has
  // said what proving this change means.
  //
  // A census oracle is not that kind of proof. Sweep's scanner has to emit a
  // findings list on stdout and use its exit code as the honesty floor, so an
  // arbitrary verify command cannot stand in for it. Honoring the phrase there
  // would hand Sweep a scanner that measures something else, finds nothing, and
  // exits zero. Those needs must be declared.
  if (!needs.some((need) => CENSUS_ORACLE_NEEDS.has(need))) {
    const explicitCommand = explicitInlineVerifyWithCommand(input);
    if (explicitCommand !== undefined) return { status: 'ready', commands: [explicitCommand] };
  }

  const projectRoot = input.projectRoot;
  if (projectRoot === undefined) {
    return {
      status: 'blocked',
      reason: 'Cannot choose verification commands because projectRoot was not provided.',
    };
  }

  const declared = readDeclaredVerification(projectRoot);
  if (declared.status === 'invalid') return { status: 'blocked', reason: declared.reason };
  const declaredConfig: VerificationConfig = declared.status === 'declared' ? declared.config : {};

  const declaredCommands: VerificationCommand[] = [];
  const unresolved: VerificationNeed[] = [];

  for (const need of needs) {
    const entry = declaredConfig[need];
    if (entry === undefined) {
      unresolved.push(need);
      continue;
    }
    const built = commandForDeclared({
      need,
      declared: entry,
      commandIdPrefix: input.commandIdPrefix,
      timeoutMs: input.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes ?? 200_000,
      env: input.env ?? {},
    });
    if (typeof built === 'string') return { status: 'blocked', reason: built };
    declaredCommands.push(built);
  }

  if (unresolved.length === 0 && declaredCommands.length > 0) {
    return { status: 'ready', commands: declaredCommands };
  }

  // Needs the config did not cover fall back to the package.json scripts, so a
  // Node project can override one proof without having to restate the rest.
  const fromScripts = resolveFromPackageScripts({ ...input, projectRoot }, unresolved);
  if (fromScripts.status === 'blocked') {
    // Always name the key that would close the gap. A project with no matching
    // package.json script is often not a broken Node project at all — it is a
    // Python, Rust, or Makefile repo that was never going to have one — so a
    // bare scripts complaint sends the operator to the wrong file entirely.
    const wanted = unresolved.map((need) => `verification.${need}`).join(', ');
    // frozen_paths shares the block but is a path list, not a command, so it is
    // never something the operator could have declared to satisfy a need.
    const declaredKeys = Object.keys(declaredConfig).filter((key) => key !== 'frozen_paths');
    const listed = declaredKeys.map((key) => `verification.${key}`).join(', ');
    const declaredNote =
      declaredKeys.length === 0
        ? ''
        : ` ${PROJECT_CONFIG_DISPLAY_PATH} declares ${listed} but not ${wanted}.`;
    return {
      status: 'blocked',
      reason: `${fromScripts.reason}${declaredNote} Declare ${wanted} in ${PROJECT_CONFIG_DISPLAY_PATH}.`,
    };
  }

  return { status: 'ready', commands: [...declaredCommands, ...fromScripts.commands] };
}

// The config surface the project declared alongside its proof commands: the
// files an agent could edit to make a proof pass without fixing anything.
//
// Additive and best-effort. An absent or unreadable config yields none, because
// this widens a floor rather than being one — a flow that cannot be honest
// without a declared surface has to demand it itself, and Sweep does.
export function declaredFrozenPaths(projectRoot: string): readonly string[] {
  const declared = readDeclaredVerification(projectRoot);
  if (declared.status !== 'declared') return [];
  return declared.config.frozen_paths ?? [];
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

// Shared host-agnostic launcher core for the Circuit host wrappers.
//
// Both the Claude wrapper (plugins/claude/scripts/circuit.ts) and the Codex
// wrapper (plugins/codex/scripts/circuit.ts) need the same runtime-resolution,
// version-gate, flow-root-injection, and small IO helpers. This module is the
// single source of truth; it is mirrored verbatim next to each wrapper as
// `plugins/{claude,codex}/scripts/launcher-core.ts` by
// scripts/plugins/runtime-bundle.ts (drift-checked by `check-plugin-runtime`)
// and imported relatively, the same way the Claude wrapper imports
// `./auto-open-policy.ts`.
//
// Anything host-specific stays in each wrapper: Claude keeps its presentation
// status-block renderer and auto-open; Codex keeps its codex_hooks detection,
// the build-checkpoint smoke, and its doctor body. The two surfaces that touch
// module-level state in the wrappers (runtime resolution and the child env) are
// parameterized here so neither host assumption is baked into the shared core.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

export type JsonRecord = Record<string, unknown>;

export type RuntimeCommand = {
  source: string;
  command: string;
  path: string;
  argsPrefix: string[];
};

export type RuntimeResolution =
  | { ok: true; runtime: RuntimeCommand }
  | { ok: false; message: string };

// Host-specific paths the runtime resolver closes over in each wrapper.
// `localLauncherBaseDir` is the directory whose `bin/circuit` the dev-fallback
// looks for: the Claude wrapper uses its project dir (CLAUDE_PROJECT_DIR),
// the Codex wrapper uses process.cwd(). `pluginRoot` and `bundledRuntimePath`
// are computed from each wrapper's own location.
export type RuntimeContext = {
  pluginRoot: string;
  bundledRuntimePath: string;
  localLauncherBaseDir: string;
};

export const RUNTIME_SOURCE_ENV = 'CIRCUIT_RUNTIME_SOURCE';
export const RUNTIME_PATH_ENV = 'CIRCUIT_RUNTIME_PATH';
export const PLUGIN_ROOT_ENV = 'CIRCUIT_PLUGIN_ROOT';
export const GENERATED_FLOW_MIRROR_ROOT_ENV = 'CIRCUIT_GENERATED_FLOW_MIRROR_ROOT';
export const MIN_NODE_VERSION = '22.18.0';

export function numericVersionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10));
}

export function versionAtLeast(current: string, minimum: string): boolean {
  const currentParts = numericVersionParts(current);
  const minimumParts = numericVersionParts(minimum);
  for (let index = 0; index < Math.max(currentParts.length, minimumParts.length); index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (currentPart > minimumPart) return true;
    if (currentPart < minimumPart) return false;
  }
  return true;
}

export function nodeVersionSupported(): boolean {
  return versionAtLeast(process.versions.node, MIN_NODE_VERSION);
}

function findLocalLauncher(baseDir: string): string | undefined {
  const candidate = resolve(baseDir, 'bin/circuit');
  if (existsSync(candidate)) return candidate;
  return undefined;
}

function findPathCommand(command: string): string | undefined {
  const pathValue = process.env.PATH ?? '';
  for (const segment of pathValue.split(delimiter)) {
    if (segment.length === 0) continue;
    const candidate = resolve(segment, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function runtimeResolutionError(message: string): RuntimeResolution {
  return { ok: false, message };
}

function runtimeResolution(runtime: RuntimeCommand): RuntimeResolution {
  return { ok: true, runtime };
}

export function resolveRuntimeCommand(context: RuntimeContext): RuntimeResolution {
  const override = process.env.CIRCUIT_CLI;
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) {
      return runtimeResolutionError('CIRCUIT_CLI must be an absolute path');
    }
    if (!existsSync(override)) {
      return runtimeResolutionError(`CIRCUIT_CLI does not exist: ${override}`);
    }
    return runtimeResolution({
      source: 'override',
      command: override,
      path: override,
      argsPrefix: [],
    });
  }

  if (existsSync(context.bundledRuntimePath)) {
    return runtimeResolution({
      source: 'bundled',
      command: process.execPath,
      path: context.bundledRuntimePath,
      argsPrefix: [context.bundledRuntimePath],
    });
  }

  if (process.env.CIRCUIT_DEV === '1') {
    const localLauncher = findLocalLauncher(context.localLauncherBaseDir);
    if (localLauncher !== undefined) {
      return runtimeResolution({
        source: 'dev-fallback',
        command: localLauncher,
        path: localLauncher,
        argsPrefix: [],
      });
    }
    const pathLauncher = findPathCommand('circuit');
    if (pathLauncher !== undefined) {
      return runtimeResolution({
        source: 'dev-fallback',
        command: pathLauncher,
        path: pathLauncher,
        argsPrefix: [],
      });
    }
  }

  return runtimeResolutionError(
    `Circuit plugin packaging error: bundled runtime is missing at ${context.bundledRuntimePath}. Reinstall or upgrade the Circuit plugin.`,
  );
}

export function runtimeArgs(runtime: RuntimeCommand, args: readonly string[]): string[] {
  return [...runtime.argsPrefix, ...args];
}

export function runtimeEnv(
  runtime: RuntimeCommand,
  baseEnv: NodeJS.ProcessEnv,
  pluginRoot: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [RUNTIME_SOURCE_ENV]: runtime.source,
    [RUNTIME_PATH_ENV]: runtime.path,
    [PLUGIN_ROOT_ENV]: pluginRoot,
  };
}

export function readJson<T = JsonRecord>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
}

export function parseProgressEvents(stderr: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    events.push(JSON.parse(line));
  }
  return events;
}

export function shouldInjectPackagedFlowRoot(args: readonly string[]): boolean {
  if (args.includes('--fixture') || args.includes('--flow-root')) return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  if (
    args[0] === 'resume' ||
    args.includes('--checkpoint-review') ||
    args.includes('--checkpoint-choice') ||
    args.includes('--checkpoint-response') ||
    args.includes('--checkpoint-response-file')
  ) {
    return false;
  }
  return args[0] === 'run';
}

export function shouldInjectCreateTemplateRoot(args: readonly string[]): boolean {
  if (args.includes('--template-flow-root')) return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  return args[0] === 'create';
}

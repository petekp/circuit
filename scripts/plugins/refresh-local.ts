#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '../..');

export type CommandInvocation = {
  id: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type CommandResult = {
  exitCode: number;
};

export type RefreshOptions = {
  repoRoot?: string;
  homeDir?: string;
  codexHome?: string;
  runner?: (invocation: CommandInvocation) => CommandResult;
};

export type ClearedCacheRoot = {
  host: 'claude' | 'codex';
  purpose: 'claude-marketplace' | 'codex-local-marketplace' | 'codex-marketplace';
  path: string;
  existed: boolean;
};

type CacheRoot = Omit<ClearedCacheRoot, 'existed'>;

function parseArgs(argv: readonly string[]): { help: boolean } {
  const program = new Command('refresh-local')
    .description(
      'Rebuild generated plugin output, clear Circuit host plugin caches, sync/check local caches, and run installed-plugin doctor.',
    )
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  try {
    program.parse([...argv], { from: 'user' });
    return { help: false };
  } catch (err) {
    if (err instanceof CommanderError && err.code === 'commander.helpDisplayed') {
      return { help: true };
    }
    if (err instanceof CommanderError) {
      throw new Error(err.message.replace(/^error: /, ''));
    }
    throw err;
  }
}

function pathEndsWithSegments(path: string, suffix: readonly string[]): boolean {
  const parts = resolve(path)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length < suffix.length) return false;
  return suffix.every((segment, index) => parts[parts.length - suffix.length + index] === segment);
}

function commandEnv(options: RefreshOptions): NodeJS.ProcessEnv {
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? resolve(homeDir, '.codex');
  return {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHome,
  };
}

function defaultRunner(invocation: CommandInvocation): CommandResult {
  const [command, ...args] = invocation.argv;
  if (command === undefined) {
    throw new Error(`command ${invocation.id} has no executable`);
  }
  const result = spawnSync(command, args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: 'inherit',
  });
  return { exitCode: result.status ?? 1 };
}

export function circuitPluginCacheRoots(options: RefreshOptions = {}): CacheRoot[] {
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? resolve(homeDir, '.codex');
  return [
    {
      host: 'claude',
      purpose: 'claude-marketplace',
      path: resolve(homeDir, '.claude/plugins/cache/circuit'),
    },
    {
      host: 'codex',
      purpose: 'codex-local-marketplace',
      path: resolve(codexHome, 'plugins/cache/circuit-local'),
    },
    {
      host: 'codex',
      purpose: 'codex-marketplace',
      path: resolve(codexHome, 'plugins/cache/circuit'),
    },
  ];
}

function assertCircuitCacheRoot(root: CacheRoot): void {
  const expectedSuffixes: Record<CacheRoot['purpose'], string[]> = {
    'claude-marketplace': ['.claude', 'plugins', 'cache', 'circuit'],
    'codex-local-marketplace': ['plugins', 'cache', 'circuit-local'],
    'codex-marketplace': ['plugins', 'cache', 'circuit'],
  };
  const suffix = expectedSuffixes[root.purpose];
  if (!pathEndsWithSegments(root.path, suffix)) {
    throw new Error(
      `refusing to clear ${root.host} cache outside Circuit plugin cache root: ${root.path}`,
    );
  }
}

export function clearCircuitPluginCaches(roots: readonly CacheRoot[]): ClearedCacheRoot[] {
  return roots.map((root) => {
    assertCircuitCacheRoot(root);
    const existed = existsSync(root.path);
    rmSync(root.path, { recursive: true, force: true });
    return { ...root, existed };
  });
}

function runCommand(
  id: string,
  argv: string[],
  options: Required<Pick<RefreshOptions, 'runner'>> & { cwd: string; env: NodeJS.ProcessEnv },
): void {
  const result = options.runner({ id, argv, cwd: options.cwd, env: options.env });
  if (result.exitCode !== 0) {
    throw new Error(`${id} failed with exit code ${result.exitCode}`);
  }
}

export function runLocalPluginRefresh(options: RefreshOptions = {}): {
  status: 'ok';
  cleared_cache_roots: ClearedCacheRoot[];
  commands: string[];
} {
  const cwd = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const env = commandEnv(options);
  const runner = options.runner ?? defaultRunner;
  const commands: string[] = [];
  const run = (id: string, argv: string[]) => {
    commands.push(id);
    runCommand(id, argv, { runner, cwd, env });
  };

  run('emit_flows', ['npm', 'run', 'emit-flows']);
  const clearedCacheRoots = clearCircuitPluginCaches(circuitPluginCacheRoots(options));
  run('sync_host_plugin_caches', ['npm', 'run', 'sync:host-plugin-caches']);
  run('check_host_plugin_caches', ['npm', 'run', 'check:host-plugin-caches']);
  run('doctor_plugins_installed', ['npm', 'run', 'doctor:plugins:installed']);

  return {
    status: 'ok',
    cleared_cache_roots: clearedCacheRoots,
    commands,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    if (parseArgs(process.argv.slice(2)).help) {
      process.exit(0);
    }
    console.log(JSON.stringify(runLocalPluginRefresh(), null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

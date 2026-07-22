#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageTreeStatus } from './package-tree.ts';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const repoRoot = resolve(SCRIPT_DIR, '../..');

type JsonRecord = Record<string, unknown>;
type DoctorResult = {
  status: string;
  runtime_source: string | undefined;
  runtime_path: string | undefined;
  error?: string;
};

const CODEX_MCP_RUNTIME_FILES = [
  'mcp/server.cjs',
  'mcp/server.mjs',
  'mcp/supervisor.mjs',
  'mcp/worker.mjs',
] as const;
const CODEX_MCP_TOOLS = [
  'circuit_start',
  'circuit_status',
  'circuit_resume',
  'circuit_cancel',
  'circuit_list',
  'circuit_recover',
] as const;
const MAX_PRIVATE_STATE_ENTRIES = 4_096;

function readJson<T = JsonRecord>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function noAmbientCliPath() {
  const systemSegments = process.platform === 'win32' ? [] : ['/usr/bin', '/bin'];
  return [dirname(process.execPath), ...systemSegments].join(delimiter);
}

function noAmbientCliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: noAmbientCliPath(),
    CIRCUIT_CLI: undefined,
    CIRCUIT_DEV: undefined,
    ...extra,
  };
}

function codexDoctorPath(): string {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const codexDirectory = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .find((directory) => {
      try {
        accessSync(resolve(directory, executableName), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return [
    ...noAmbientCliPath().split(delimiter),
    ...(codexDirectory === undefined ? [] : [codexDirectory]),
  ]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(delimiter);
}

function runDoctor(scriptPath: string, env: NodeJS.ProcessEnv = {}): DoctorResult {
  if (!existsSync(scriptPath)) {
    return {
      status: 'missing',
      runtime_source: undefined,
      runtime_path: undefined,
      error: `missing doctor script: ${scriptPath}`,
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, 'doctor'], {
    cwd: repoRoot,
    env: noAmbientCliEnv(env),
    encoding: 'utf8',
  });
  if ((result.status ?? 1) !== 0) {
    return {
      status: 'invalid',
      runtime_source: undefined,
      runtime_path: undefined,
      error: (result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim(),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      status: parsed.status,
      runtime_source: parsed.runtime_source,
      runtime_path: parsed.runtime_path,
    };
  } catch (err) {
    return {
      status: 'invalid',
      runtime_source: undefined,
      runtime_path: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) words.push(current);
  return words;
}

function commandFromHookHandler(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as JsonRecord;
  return typeof record.command === 'string' ? record.command : undefined;
}

function circuitHookCommands(entries: readonly unknown[]): string[] {
  const commands: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    if (!('hooks' in entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      const command = commandFromHookHandler(hook);
      if (command?.includes('handoff hook --host codex')) commands.push(command);
    }
  }
  return commands;
}

function launcherPathFromCommand(command: string): string | undefined {
  const words = splitShellWords(command);
  const index = words.findIndex(
    (word, candidateIndex) =>
      word === 'handoff' &&
      words[candidateIndex + 1] === 'hook' &&
      words[candidateIndex + 2] === '--host' &&
      words[candidateIndex + 3] === 'codex',
  );
  return index >= 1 ? words[index - 1] : undefined;
}

function codexHookSummary(codexHome: string): JsonRecord {
  const hooksPath = resolve(codexHome, 'hooks.json');
  if (!existsSync(hooksPath)) {
    return {
      status: 'missing',
      hooks_path: hooksPath,
      circuit_hook_count: 0,
      foreign_session_start_count: 0,
      launchers: [],
      missing_launchers: [],
    };
  }

  let parsed: JsonRecord;
  try {
    parsed = readJson(hooksPath);
  } catch (err) {
    return {
      status: 'invalid',
      hooks_path: hooksPath,
      circuit_hook_count: 0,
      foreign_session_start_count: 0,
      launchers: [],
      missing_launchers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const hooks = parsed.hooks as JsonRecord | undefined;
  const entries = hooks?.SessionStart;
  if (!Array.isArray(entries)) {
    return {
      status: 'missing',
      hooks_path: hooksPath,
      circuit_hook_count: 0,
      foreign_session_start_count: 0,
      launchers: [],
      missing_launchers: [],
    };
  }

  const commands = circuitHookCommands(entries);
  const launchers = commands.map(launcherPathFromCommand).filter((item) => item !== undefined);
  const missingLaunchers = launchers.filter((launcher) => !existsSync(launcher));
  const status =
    commands.length === 0
      ? 'missing'
      : commands.length > 1 || launchers.length !== commands.length || missingLaunchers.length > 0
        ? 'invalid'
        : 'ok';

  return {
    status,
    hooks_path: hooksPath,
    circuit_hook_count: commands.length,
    foreign_session_start_count: entries.length - commands.length,
    launchers,
    missing_launchers: missingLaunchers,
  };
}

function pluginStatus(
  sourceRoot: string,
  installedRoot: string,
  env: NodeJS.ProcessEnv,
): JsonRecord {
  const packageTree = packageTreeStatus(sourceRoot, installedRoot);
  const doctor = runDoctor(resolve(installedRoot, 'scripts/circuit.ts'), env);
  return {
    installed_root: installedRoot,
    package_tree: packageTree,
    runtime_source: doctor.runtime_source,
    runtime_path: doctor.runtime_path,
    doctor_status: doctor.status,
    ...(doctor.error === undefined ? {} : { doctor_error: doctor.error }),
    status:
      packageTree.status === 'ok' && doctor.status === 'ok' && doctor.runtime_source === 'bundled'
        ? 'ok'
        : 'invalid',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameStrings(actual: unknown, expected: readonly string[]): actual is string[] {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function codexMcpManifestSummary(installedRoot: string): JsonRecord {
  const path = resolve(installedRoot, '.codex-plugin/plugin.json');
  const configPath = resolve(installedRoot, '.mcp.json');
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      return {
        status: 'invalid',
        path,
        config_path: configPath,
        error: 'Codex MCP manifest is not a regular installed file.',
      };
    }
    const manifest = readJson(path);
    if (manifest.mcpServers !== './.mcp.json') {
      return {
        status: 'invalid',
        path,
        config_path: configPath,
        error: 'Codex MCP manifest does not activate ./.mcp.json.',
      };
    }
    return { status: 'ok', path, config_path: configPath };
  } catch (error) {
    return { status: 'invalid', path, config_path: configPath, error: errorMessage(error) };
  }
}

function codexMcpConfigSummary(installedRoot: string): JsonRecord {
  const path = resolve(installedRoot, '.mcp.json');
  const serverEntrypoint = resolve(installedRoot, 'mcp/server.cjs');
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      return {
        status: 'invalid',
        path,
        server_entrypoint: serverEntrypoint,
        errors: ['Codex MCP config is not a regular installed file.'],
      };
    }
    const config = readJson(path);
    const servers = config.mcpServers;
    const server =
      typeof servers === 'object' && servers !== null && !Array.isArray(servers)
        ? (servers as JsonRecord).circuit
        : undefined;
    if (typeof server !== 'object' || server === null || Array.isArray(server)) {
      return {
        status: 'invalid',
        path,
        server_entrypoint: serverEntrypoint,
        errors: ['Codex MCP config does not define mcpServers.circuit.'],
      };
    }

    const record = server as JsonRecord;
    const errors: string[] = [];
    if (record.command !== 'node') errors.push('command must be node');
    if (!sameStrings(record.args, ['./mcp/server.cjs'])) {
      errors.push('args must point only at ./mcp/server.cjs');
    }
    if (record.cwd !== '.') errors.push('cwd must be .');
    if (record.required !== true) errors.push('the Circuit MCP server must be required');
    if (record.startup_timeout_sec !== 10) errors.push('startup timeout must be 10 seconds');
    if (record.tool_timeout_sec !== 240) errors.push('tool timeout must be 240 seconds');
    if (!sameStrings(record.enabled_tools, CODEX_MCP_TOOLS)) {
      errors.push('enabled tools do not match the Circuit MCP tool set');
    }
    const envVars = record.env_vars;
    if (
      !Array.isArray(envVars) ||
      !envVars.every((value) => typeof value === 'string') ||
      !['CODEX_HOME', 'HOME', 'PATH'].every((name) => envVars.includes(name))
    ) {
      errors.push('environment forwarding must include CODEX_HOME, HOME, and PATH');
    }
    return {
      status: errors.length === 0 ? 'ok' : 'invalid',
      path,
      server_entrypoint: serverEntrypoint,
      errors,
    };
  } catch (error) {
    return {
      status: 'invalid',
      path,
      server_entrypoint: serverEntrypoint,
      errors: [errorMessage(error)],
    };
  }
}

function codexMcpRuntimeSummary(installedRoot: string): JsonRecord {
  const missing: string[] = [];
  const unsafe: string[] = [];
  for (const relativePath of CODEX_MCP_RUNTIME_FILES) {
    const path = resolve(installedRoot, relativePath);
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size === 0) unsafe.push(relativePath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') missing.push(relativePath);
      else unsafe.push(relativePath);
    }
  }
  return {
    status: missing.length === 0 && unsafe.length === 0 ? 'ok' : 'invalid',
    expected: [...CODEX_MCP_RUNTIME_FILES],
    missing,
    unsafe,
  };
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

type PrivateStateViolation = {
  path: string;
  reason: string;
  expected_mode?: string;
  actual_mode?: string;
  error?: string;
};

function codexMcpPrivateStateSummary(codexHome: string): JsonRecord {
  const stateRoot = resolve(codexHome, 'circuit/mcp/v1');
  try {
    lstatSync(stateRoot);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        status: 'not_initialized',
        state_root: stateRoot,
        initialized: false,
        checked_directories: 0,
        checked_files: 0,
        violations: [],
      };
    }
    return {
      status: 'invalid',
      state_root: stateRoot,
      initialized: true,
      checked_directories: 0,
      checked_files: 0,
      violations: [{ path: stateRoot, reason: 'unreadable', error: errorMessage(error) }],
    };
  }

  const violations: PrivateStateViolation[] = [];
  const pending = [stateRoot];
  let checkedDirectories = 0;
  let checkedFiles = 0;
  let checkedEntries = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) break;
    checkedEntries += 1;
    if (checkedEntries > MAX_PRIVATE_STATE_ENTRIES) {
      violations.push({ path: stateRoot, reason: 'entry_limit' });
      break;
    }

    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch (error) {
      violations.push({ path, reason: 'unreadable', error: errorMessage(error) });
      continue;
    }
    if (info.isSymbolicLink()) {
      violations.push({ path, reason: 'symbolic_link' });
      continue;
    }
    if (info.isDirectory()) {
      checkedDirectories += 1;
      if ((info.mode & 0o777) !== 0o700) {
        violations.push({
          path,
          reason: 'directory_mode',
          expected_mode: '0700',
          actual_mode: modeString(info.mode),
        });
      }
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        violations.push({ path, reason: 'owner' });
      }
      try {
        const entries = readdirSync(path, { withFileTypes: true })
          .map((entry) => join(path, entry.name))
          .sort()
          .reverse();
        pending.push(...entries);
      } catch (error) {
        violations.push({ path, reason: 'unreadable', error: errorMessage(error) });
      }
      continue;
    }
    if (info.isFile()) {
      checkedFiles += 1;
      if ((info.mode & 0o777) !== 0o600) {
        violations.push({
          path,
          reason: 'file_mode',
          expected_mode: '0600',
          actual_mode: modeString(info.mode),
        });
      }
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        violations.push({ path, reason: 'owner' });
      }
      continue;
    }
    violations.push({ path, reason: 'unsafe_type' });
  }

  return {
    status: violations.length === 0 ? 'ok' : 'invalid',
    state_root: stateRoot,
    initialized: true,
    checked_directories: checkedDirectories,
    checked_files: checkedFiles,
    violations,
  };
}

function codexMcpSummary(installedRoot: string, codexHome: string): JsonRecord {
  const manifest = codexMcpManifestSummary(installedRoot);
  const config = codexMcpConfigSummary(installedRoot);
  const runtimeFiles = codexMcpRuntimeSummary(installedRoot);
  const privateState = codexMcpPrivateStateSummary(codexHome);
  const status =
    manifest.status === 'ok' &&
    config.status === 'ok' &&
    runtimeFiles.status === 'ok' &&
    (privateState.status === 'ok' || privateState.status === 'not_initialized')
      ? 'ok'
      : 'invalid';
  return {
    status,
    manifest,
    config,
    runtime_files: runtimeFiles,
    private_state: privateState,
  };
}

try {
  const version = readJson<{ version: string }>(resolve(repoRoot, 'plugins/version.json')).version;
  const home = process.env.HOME ?? homedir();
  const codexHome = process.env.CODEX_HOME ?? resolve(home, '.codex');
  const claudeInstalledRoot = resolve(home, '.claude/plugins/cache/circuit/circuit', version);
  const codexInstalledRoot = resolve(codexHome, 'plugins/cache/circuit-local/circuit', version);
  const claude = pluginStatus(resolve(repoRoot, 'plugins/claude'), claudeInstalledRoot, {
    HOME: home,
  });
  const codexPlugin = pluginStatus(resolve(repoRoot, 'plugins/codex'), codexInstalledRoot, {
    CODEX_HOME: codexHome,
    PATH: codexDoctorPath(),
  });
  const codexMcp = codexMcpSummary(codexInstalledRoot, codexHome);
  const codex = {
    ...codexPlugin,
    mcp: codexMcp,
    status: codexPlugin.status === 'ok' && codexMcp.status === 'ok' ? 'ok' : 'invalid',
  };
  const codexHooks = codexHookSummary(codexHome);
  const status =
    claude.status === 'ok' &&
    codex.status === 'ok' &&
    (codexHooks.status === 'ok' || codexHooks.status === 'missing')
      ? 'ok'
      : 'invalid';

  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        status,
        repo_root: repoRoot,
        repo_version: version,
        claude,
        codex,
        codex_hooks: codexHooks,
      },
      null,
      2,
    ),
  );
  process.exit(status === 'ok' ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

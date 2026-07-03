// Codex hooks install/uninstall/doctor plus the Codex install-assurance
// nudge. Extracted from src/cli/handoff.ts. This module must stay in
// src/cli/ because defaultLauncherPath resolves the source-tree fallback
// launcher relative to its own module location (import.meta.url).

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { continuityRoot } from '../app/continuity/records.js';
import { controlPlaneRoot } from '../shared/control-plane-paths.js';

export type HandoffHookHost = 'codex';
export type HandoffHooksAction = 'install' | 'uninstall' | 'doctor';

/** The slice of the handoff CLI arguments the Codex hooks domain reads. */
export interface CodexHooksArgs {
  readonly hooksAction?: HandoffHooksAction;
  readonly host?: string;
  readonly hooksFile?: string;
  readonly launcher?: string;
}

const HANDOFF_HOOKS_API_VERSION = 'handoff-hooks-v1';
const HANDOFF_HOOKS_SCHEMA_VERSION = 1;
const CIRCUIT_HOOK_MARKER = 'CIRCUIT_HANDOFF_HOOK=1';

function defaultCodexHooksFile(): string {
  const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), '.codex');
  return resolve(codexHome, 'hooks.json');
}

// The wrapper script that ships with the marketplace plugin is the only
// piece of code that knows where the plugin was installed; it passes its
// own plugin root to every child process via CIRCUIT_PLUGIN_ROOT. Reading
// that env var is the right answer for "what launcher path do I write
// into the hook config" because it survives every install layout (Claude
// marketplace, Codex cache, source-tree dev with the wrapper). We only
// fall back to computing a path from import.meta.url when the env var is
// absent — i.e., running bin/circuit directly from a source-tree
// checkout without the wrapper in the chain.
export function resolveDefaultLauncher(pluginRoot: string | undefined, moduleDir: string): string {
  if (pluginRoot !== undefined && pluginRoot.length > 0) {
    return resolve(pluginRoot, 'scripts/circuit.js');
  }
  return resolve(moduleDir, '../..', 'bin/circuit');
}

export function missingDefaultLauncherMessage(launcher: string): string {
  return [
    'CIRCUIT_PLUGIN_ROOT is unset and no wrapper was detected.',
    'Either set CIRCUIT_PLUGIN_ROOT or invoke through plugins/<host>/scripts/circuit.js.',
    `Tried source-tree fallback launcher: ${launcher}`,
  ].join(' ');
}

function defaultLauncherPath(): string {
  // Marketplace-safe by env var: CIRCUIT_PLUGIN_ROOT is the primary input;
  // the fileURLToPath argument is only consulted in the source-tree
  // fallback branch of resolveDefaultLauncher when the env var is unset.
  // Marketplace-safe by source-tree fallback: the fallback resolves to
  // <repo>/bin/circuit, which exists only in the dev checkout.
  return resolveDefaultLauncher(
    process.env.CIRCUIT_PLUGIN_ROOT,
    dirname(fileURLToPath(import.meta.url)),
  );
}

function parseCodexHooksHost(args: CodexHooksArgs): HandoffHookHost {
  if (args.host === 'codex') return 'codex';
  throw new Error('handoff hooks requires --host codex');
}

function resolveHooksFileArg(args: CodexHooksArgs): string {
  return resolve(args.hooksFile ?? defaultCodexHooksFile());
}

function resolveLauncherArg(args: CodexHooksArgs): string {
  const launcher = resolve(args.launcher ?? defaultLauncherPath());
  if (!existsSync(launcher)) {
    if (args.launcher === undefined && (process.env.CIRCUIT_PLUGIN_ROOT ?? '').length === 0) {
      throw new Error(missingDefaultLauncherMessage(launcher));
    }
    throw new Error(`Circuit launcher not found: ${launcher}`);
  }
  return launcher;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function codexHookCommand(launcher: string): string {
  return [
    CIRCUIT_HOOK_MARKER,
    shellQuote(process.execPath),
    shellQuote(launcher),
    'handoff',
    'hook',
    '--host',
    'codex',
  ].join(' ');
}

function defaultHooksConfig(): Record<string, unknown> {
  return { hooks: {} };
}

function readHooksConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return defaultHooksConfig();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('hooks file must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function hooksObject(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = config.hooks;
  if (hooks === undefined) {
    const next: Record<string, unknown> = {};
    config.hooks = next;
    return next;
  }
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new Error('hooks file has invalid hooks object');
  }
  return hooks as Record<string, unknown>;
}

function sessionStartEntries(config: Record<string, unknown>): unknown[] {
  const entries = hooksObject(config).SessionStart;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new Error('hooks.SessionStart must be an array');
  }
  return entries;
}

function setSessionStartEntries(config: Record<string, unknown>, entries: unknown[]): void {
  hooksObject(config).SessionStart = entries;
}

function circuitCodexHookEntry(command: string): Record<string, unknown> {
  return {
    matcher: 'startup|resume|clear',
    hooks: [
      {
        type: 'command',
        command,
        timeout: 3,
      },
    ],
  };
}

function isCircuitCodexHookEntry(entry: unknown): boolean {
  return JSON.stringify(entry).includes('handoff hook --host codex');
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
      continue;
    }
    if (!inSingle && /\s/.test(char ?? '')) {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) words.push(current);
  return words;
}

function commandFromHookHandler(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'command' in value &&
    typeof value.command === 'string'
  ) {
    return value.command;
  }
  return undefined;
}

function circuitHookCommands(entries: readonly unknown[]): string[] {
  const commands: string[] = [];
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('hooks' in entry) ||
      !Array.isArray(entry.hooks)
    ) {
      continue;
    }
    for (const hook of entry.hooks) {
      const command = commandFromHookHandler(hook);
      if (command?.includes('handoff hook --host codex')) {
        commands.push(command);
      }
    }
  }
  return commands;
}

function circuitHookEntryCount(entries: readonly unknown[]): number {
  return entries.filter(isCircuitCodexHookEntry).length;
}

function launcherPathFromCircuitHookCommand(command: string): string | undefined {
  const words = splitShellWords(command);
  const handoffIndex = words.findIndex(
    (word, index) =>
      word === 'handoff' &&
      words[index + 1] === 'hook' &&
      words[index + 2] === '--host' &&
      words[index + 3] === 'codex',
  );
  if (handoffIndex < 1) return undefined;
  const launcher = words[handoffIndex - 1];
  if (launcher === undefined || launcher.length === 0) return undefined;
  return launcher;
}

function writeHooksConfig(
  path: string,
  config: Record<string, unknown>,
): { readonly backupPath?: string } {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(path)) {
    const candidate = `${path}.circuit-backup`;
    if (!existsSync(candidate)) {
      copyFileSync(path, candidate);
      backupPath = candidate;
    }
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return backupPath === undefined ? {} : { backupPath };
}

function installCodexHandoffHook(args: CodexHooksArgs) {
  parseCodexHooksHost(args);
  const hooksPath = resolveHooksFileArg(args);
  const launcher = resolveLauncherArg(args);
  const command = codexHookCommand(launcher);
  const config = readHooksConfig(hooksPath);
  const entry = circuitCodexHookEntry(command);
  const entries = sessionStartEntries(config);
  const existingCircuitEntries = entries.filter(isCircuitCodexHookEntry);
  const alreadyInstalled =
    existingCircuitEntries.length === 1 &&
    JSON.stringify(existingCircuitEntries[0]) === JSON.stringify(entry);

  if (alreadyInstalled) {
    return {
      api_version: HANDOFF_HOOKS_API_VERSION,
      schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
      host: 'codex',
      action: 'install',
      status: 'already_installed',
      hooks_path: hooksPath,
      launcher,
      command,
    };
  }

  setSessionStartEntries(config, [
    ...entries.filter((item) => !isCircuitCodexHookEntry(item)),
    entry,
  ]);
  const { backupPath } = writeHooksConfig(hooksPath, config);
  return {
    api_version: HANDOFF_HOOKS_API_VERSION,
    schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
    host: 'codex',
    action: 'install',
    status: 'installed',
    hooks_path: hooksPath,
    launcher,
    command,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  };
}

function uninstallCodexHandoffHook(args: CodexHooksArgs) {
  parseCodexHooksHost(args);
  const hooksPath = resolveHooksFileArg(args);
  if (!existsSync(hooksPath)) {
    return {
      api_version: HANDOFF_HOOKS_API_VERSION,
      schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
      host: 'codex',
      action: 'uninstall',
      status: 'not_installed',
      hooks_path: hooksPath,
    };
  }
  const config = readHooksConfig(hooksPath);
  const entries = sessionStartEntries(config);
  const nextEntries = entries.filter((item) => !isCircuitCodexHookEntry(item));
  if (nextEntries.length === entries.length) {
    return {
      api_version: HANDOFF_HOOKS_API_VERSION,
      schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
      host: 'codex',
      action: 'uninstall',
      status: 'not_installed',
      hooks_path: hooksPath,
    };
  }

  setSessionStartEntries(config, nextEntries);
  const { backupPath } = writeHooksConfig(hooksPath, config);
  return {
    api_version: HANDOFF_HOOKS_API_VERSION,
    schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
    host: 'codex',
    action: 'uninstall',
    status: 'uninstalled',
    hooks_path: hooksPath,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  };
}

function doctorCodexHandoffHook(args: CodexHooksArgs) {
  parseCodexHooksHost(args);
  const hooksPath = resolveHooksFileArg(args);
  const checks: Array<{ name: string; ok: boolean; detail?: string; severity?: 'warning' }> = [];
  checks.push({ name: 'hooks_file_exists', ok: existsSync(hooksPath), detail: hooksPath });

  let config: Record<string, unknown> | undefined;
  try {
    config = readHooksConfig(hooksPath);
    checks.push({ name: 'hooks_file_parseable', ok: true, detail: hooksPath });
  } catch (err) {
    checks.push({
      name: 'hooks_file_parseable',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (config !== undefined) {
    try {
      const entries = sessionStartEntries(config);
      const circuitEntryCount = circuitHookEntryCount(entries);
      const commands = circuitHookCommands(entries);
      const launchers = commands
        .map(launcherPathFromCircuitHookCommand)
        .filter((item): item is string => item !== undefined);
      checks.push({ name: 'session_start_array', ok: true, detail: `${entries.length} entries` });
      checks.push({
        name: 'circuit_handoff_hook_installed',
        ok: circuitEntryCount > 0,
        detail: `${circuitEntryCount} Circuit hooks in ${hooksPath}`,
      });
      checks.push({
        name: 'circuit_handoff_hook_single',
        ok: circuitEntryCount === 1 && commands.length === 1,
        detail: `${circuitEntryCount} Circuit entries, ${commands.length} Circuit commands`,
      });
      checks.push({
        name: 'circuit_handoff_hook_launcher_exists',
        ok: launchers.length > 0 && launchers.every((launcher) => existsSync(launcher)),
        detail: launchers.length > 0 ? launchers.join(', ') : 'launcher not found in hook command',
      });
    } catch (err) {
      checks.push({
        name: 'session_start_array',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      checks.push({
        name: 'circuit_handoff_hook_installed',
        ok: false,
        detail: hooksPath,
      });
      checks.push({
        name: 'circuit_handoff_hook_launcher_exists',
        ok: false,
        detail: 'launcher not found in hook command',
      });
    }
  }

  const failed = checks.filter((item) => !item.ok && item.severity !== 'warning');
  const installedCheck = checks.find((item) => item.name === 'circuit_handoff_hook_installed');
  const structuralFailure = failed.some(
    (item) => item.name === 'hooks_file_parseable' || item.name === 'session_start_array',
  );
  const status = !existsSync(hooksPath)
    ? 'missing'
    : structuralFailure
      ? 'invalid'
      : installedCheck?.ok === false
        ? 'missing'
        : failed.length === 0
          ? 'ok'
          : 'invalid';
  return {
    api_version: HANDOFF_HOOKS_API_VERSION,
    schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
    host: 'codex',
    action: 'doctor',
    status,
    hooks_path: hooksPath,
    checks,
  };
}

export function runHandoffHooksCommand(args: CodexHooksArgs): unknown {
  if (args.hooksAction === 'install') return installCodexHandoffHook(args);
  if (args.hooksAction === 'uninstall') return uninstallCodexHandoffHook(args);
  if (args.hooksAction === 'doctor') return doctorCodexHandoffHook(args);
  throw new Error('handoff hooks requires install, uninstall, or doctor');
}

// --- A3: Codex install assurance ------------------------------------------
//
// Claude restore is zero-setup (the plugin ships hooks.json), but Codex
// requires a one-time `handoff hooks install --host codex`. A Codex user who
// never installs gets no restore and no signal that one is missing. The Codex
// wrapper sets CIRCUIT_HOST_KIND=codex on every circuit invocation, so the
// front-door `run` command can detect "running on Codex" regardless of install
// state and nudge once per repo. The nudge is written to a marker in the repo's
// control plane so it never repeats per session.
const CODEX_INSTALL_NUDGE_MARKER = '.codex-install-nudged';
const CODEX_INSTALL_NUDGE_NOTICE =
  'Circuit restores this repo automatically on Claude, but on Codex it needs a one-time hook install before each new session can restore your continuity. Run: circuit handoff hooks install --host codex (this notice shows once per repo).';
const CODEX_REINSTALL_NUDGE_MARKER = '.codex-reinstall-nudged';
const CODEX_REINSTALL_NUDGE_NOTICE =
  'The Codex continuity hook points at a launcher from an earlier Circuit version that no longer exists (this happens after an upgrade). Continuity restore is off until you re-run: circuit handoff hooks install --host codex (this notice shows once until fixed).';

function codexInstallNudgeMarkerPath(controlPlane: string): string {
  return join(continuityRoot(controlPlane), CODEX_INSTALL_NUDGE_MARKER);
}

// Key the reinstall marker to the stale launcher path so the signal fires once
// per broken state and re-fires if a future upgrade dangles a different
// launcher, rather than being suppressed forever after the first sighting.
function codexReinstallNudgeMarkerPath(controlPlane: string, staleLauncher: string): string {
  const digest = createHash('sha256').update(staleLauncher).digest('hex').slice(0, 12);
  return join(continuityRoot(controlPlane), `${CODEX_REINSTALL_NUDGE_MARKER}-${digest}`);
}

type CodexHookInstallState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid' }
  | { readonly kind: 'stale'; readonly launcher: string };

// Classify the Codex SessionStart hook for the front-door assurance:
// - absent: no Circuit hook entry (never installed) -> prompt install.
// - valid:  a Circuit hook entry whose launcher path resolves on disk.
// - stale:  a Circuit hook entry whose launcher path does not resolve. This is
//   the post-upgrade failure mode — the version-pinned launcher baked into
//   ~/.codex/hooks.json points into a cache dir the upgrade deleted. The entry
//   still matches, so a presence-only check reads it as installed; only
//   resolving the launcher on disk catches it.
function codexHookInstallState(hooksPath: string): CodexHookInstallState {
  if (!existsSync(hooksPath)) return { kind: 'absent' };
  let config: Record<string, unknown>;
  try {
    config = readHooksConfig(hooksPath);
  } catch {
    return { kind: 'absent' };
  }
  let entries: unknown[];
  try {
    entries = sessionStartEntries(config);
  } catch {
    return { kind: 'absent' };
  }
  const commands = circuitHookCommands(entries);
  if (commands.length === 0) return { kind: 'absent' };
  const launchers = commands
    .map(launcherPathFromCircuitHookCommand)
    .filter((launcher): launcher is string => launcher !== undefined);
  if (launchers.length > 0 && launchers.every((launcher) => existsSync(launcher))) {
    return { kind: 'valid' };
  }
  // A Circuit entry is present but its launcher does not resolve (a dangling
  // path, or a command we could not parse a launcher from). Either way the hook
  // cannot run and the fix is the same re-install.
  const staleLauncher =
    launchers.find((launcher) => !existsSync(launcher)) ?? '(unresolved launcher)';
  return { kind: 'stale', launcher: staleLauncher };
}

function writeNudgeMarker(markerPath: string, now?: () => Date): void {
  const stampedAt = (now ?? (() => new Date()))().toISOString();
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `nudged at ${stampedAt}\n`);
  } catch {
    // Best-effort: if we cannot persist the marker we still nudge once now,
    // rather than suppressing the only signal a Codex user would ever get.
  }
}

export interface CodexInstallAssuranceInput {
  readonly projectRoot: string;
  readonly hooksFile?: string;
  readonly controlPlane?: string;
  readonly now?: () => Date;
}

export interface CodexInstallAssuranceResult {
  readonly status:
    | 'ok'
    | 'nudge'
    | 'already_nudged'
    | 'reinstall_nudge'
    | 'already_reinstall_nudged';
  readonly notice?: string;
  readonly marker_path: string;
}

export function codexInstallAssurance(
  input: CodexInstallAssuranceInput,
): CodexInstallAssuranceResult {
  const controlPlane = input.controlPlane ?? controlPlaneRoot(input.projectRoot);
  const hooksPath = input.hooksFile ?? defaultCodexHooksFile();
  const state = codexHookInstallState(hooksPath);

  if (state.kind === 'valid') {
    return { status: 'ok', marker_path: codexInstallNudgeMarkerPath(controlPlane) };
  }

  // A stale launcher is a distinct failure from never-installed: the user acted,
  // an upgrade broke it, and doctor already flags it — but the front-door needs
  // its own signal, on its own marker, so the one-time install nudge cannot
  // swallow it.
  if (state.kind === 'stale') {
    const markerPath = codexReinstallNudgeMarkerPath(controlPlane, state.launcher);
    if (existsSync(markerPath)) {
      return { status: 'already_reinstall_nudged', marker_path: markerPath };
    }
    writeNudgeMarker(markerPath, input.now);
    return {
      status: 'reinstall_nudge',
      notice: CODEX_REINSTALL_NUDGE_NOTICE,
      marker_path: markerPath,
    };
  }

  const markerPath = codexInstallNudgeMarkerPath(controlPlane);
  if (existsSync(markerPath)) return { status: 'already_nudged', marker_path: markerPath };
  writeNudgeMarker(markerPath, input.now);
  return { status: 'nudge', notice: CODEX_INSTALL_NUDGE_NOTICE, marker_path: markerPath };
}

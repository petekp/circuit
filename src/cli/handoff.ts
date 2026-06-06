import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { projectRunStatusFromRunFolder } from '../app/run-status/run-folder-projector.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import {
  ContinuityIndex,
  type ContinuityIndex as ContinuityIndexValue,
  ContinuityRecord,
  type ContinuityRecord as ContinuityRecordValue,
} from '../schemas/continuity.js';
import type { ControlPlaneFileStem } from '../schemas/scalars.js';
import type { Snapshot, SnapshotStatus } from '../schemas/snapshot.js';
import { readManifestSnapshot } from '../shared/manifest-snapshot.js';
import { progressPresentation } from '../shared/progress-output.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { utilityProgress } from './utility-progress.js';

type HandoffAction = 'save' | 'resume' | 'done' | 'brief' | 'hook' | 'hooks' | 'harvest';
type AmbientSource = 'stop' | 'session-end';
type HandoffHookHost = 'codex';
type HandoffHooksAction = 'install' | 'uninstall' | 'doctor';

interface HandoffArgs {
  readonly action: HandoffAction;
  readonly hooksAction?: HandoffHooksAction;
  readonly host?: string;
  readonly goal?: string;
  readonly next?: string;
  readonly stateMarkdown?: string;
  readonly debtMarkdown?: string;
  readonly runFolder?: string;
  readonly controlPlane?: string;
  readonly projectRoot?: string;
  readonly hooksFile?: string;
  readonly launcher?: string;
  readonly recordId?: string;
  readonly createdAt?: string;
  readonly transcriptPath?: string;
  readonly sessionId?: string;
  readonly source?: string;
  readonly progress: boolean;
  readonly json: boolean;
}

interface HandoffMainOptions {
  readonly now?: () => Date;
}

const DEFAULT_CONTROL_PLANE = '.circuit';
const HANDOFF_BRIEF_API_VERSION = 'handoff-brief-v1';
const HANDOFF_BRIEF_SCHEMA_VERSION = 1;
const HANDOFF_BRIEF_MAX_CHARS = 3000;
const HANDOFF_HOOKS_API_VERSION = 'handoff-hooks-v1';
const HANDOFF_HOOKS_SCHEMA_VERSION = 1;
const CIRCUIT_HOOK_MARKER = 'CIRCUIT_HANDOFF_HOOK=1';

type HandoffBriefRenderResult =
  | { readonly ok: true; readonly additionalContext: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

type HandoffCommanderOptions = {
  host?: string;
  goal?: string;
  next?: string;
  stateMarkdown?: string;
  debtMarkdown?: string;
  runFolder?: string;
  controlPlane?: string;
  projectRoot?: string;
  hooksFile?: string;
  launcher?: string;
  recordId?: string;
  createdAt?: string;
  transcriptPath?: string;
  sessionId?: string;
  source?: string;
  progress?: string;
  json?: boolean;
};

function addHandoffOptions(program: Command): Command {
  return program
    .option('--host <host>')
    .option('--goal <goal>')
    .option('--next <next>')
    .option('--state-markdown <md>')
    .option('--debt-markdown <md>')
    .option('--run-folder <path>')
    .option('--control-plane <path>')
    .option('--project-root <path>')
    .option('--hooks-file <path>')
    .option('--launcher <path>')
    .option('--record-id <stem>')
    .option('--created-at <iso>')
    .option('--transcript-path <path>')
    .option('--session-id <id>')
    .option('--source <stop|session-end>')
    .option('--progress <format>')
    .option('--json');
}

function parseArgs(argv: readonly string[]): HandoffArgs {
  let parsed:
    | {
        readonly action: HandoffAction;
        readonly hooksAction?: HandoffHooksAction;
        readonly opts: HandoffCommanderOptions;
      }
    | undefined;
  const program = addHandoffOptions(
    new Command('circuit handoff')
      .exitOverride()
      .configureOutput({ writeErr: () => {} })
      .enablePositionalOptions(),
  );
  program.action(() => {
    parsed = { action: 'save', opts: program.opts<HandoffCommanderOptions>() };
  });
  const addAction = (action: Exclude<HandoffAction, 'hooks'>) => {
    const command = addHandoffOptions(program.command(action));
    command.action(() => {
      parsed = { action, opts: command.opts<HandoffCommanderOptions>() };
    });
  };
  addAction('save');
  addAction('resume');
  addAction('done');
  addAction('brief');
  addAction('hook');
  addAction('harvest');
  const hooks = program.command('hooks').action(() => {
    throw new Error('handoff hooks requires install, uninstall, or doctor');
  });
  const addHooksAction = (hooksAction: HandoffHooksAction) => {
    const command = addHandoffOptions(hooks.command(hooksAction));
    command.action(() => {
      parsed = { action: 'hooks', hooksAction, opts: command.opts<HandoffCommanderOptions>() };
    });
  };
  addHooksAction('install');
  addHooksAction('uninstall');
  addHooksAction('doctor');

  parseCommanderOrThrow(program, argv);
  if (parsed === undefined) throw new Error('handoff requires a subcommand');

  const { action, hooksAction, opts } = parsed;
  if (opts.progress !== undefined && opts.progress !== 'jsonl') {
    throw new Error("--progress only supports 'jsonl'");
  }

  return {
    action,
    ...(hooksAction === undefined ? {} : { hooksAction }),
    ...(opts.host === undefined ? {} : { host: opts.host }),
    progress: opts.progress === 'jsonl',
    json: opts.json === true,
    ...(opts.goal === undefined ? {} : { goal: opts.goal }),
    ...(opts.next === undefined ? {} : { next: opts.next }),
    ...(opts.stateMarkdown === undefined ? {} : { stateMarkdown: opts.stateMarkdown }),
    ...(opts.debtMarkdown === undefined ? {} : { debtMarkdown: opts.debtMarkdown }),
    ...(opts.runFolder === undefined ? {} : { runFolder: opts.runFolder }),
    ...(opts.controlPlane === undefined ? {} : { controlPlane: opts.controlPlane }),
    ...(opts.projectRoot === undefined ? {} : { projectRoot: opts.projectRoot }),
    ...(opts.hooksFile === undefined ? {} : { hooksFile: opts.hooksFile }),
    ...(opts.launcher === undefined ? {} : { launcher: opts.launcher }),
    ...(opts.recordId === undefined ? {} : { recordId: opts.recordId }),
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
    ...(opts.transcriptPath === undefined ? {} : { transcriptPath: opts.transcriptPath }),
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    ...(opts.source === undefined ? {} : { source: opts.source }),
  };
}

function resolveProjectRootArg(args: HandoffArgs): string {
  return resolve(args.projectRoot ?? process.cwd());
}

function resolveControlPlaneArg(args: HandoffArgs): string {
  if (args.controlPlane !== undefined) return resolve(args.controlPlane);
  return resolve(resolveProjectRootArg(args), DEFAULT_CONTROL_PLANE);
}

function continuityRoot(controlPlane: string): string {
  return resolve(controlPlane, 'continuity');
}

function recordsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'records');
}

function indexPath(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'index.json');
}

function recordPath(controlPlane: string, recordId: string): string {
  return join(recordsRoot(controlPlane), `${recordId}.json`);
}

function utilityReportsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'reports');
}

function handoffResultPath(controlPlane: string, action: HandoffAction): string {
  return join(utilityReportsRoot(controlPlane), `${action}-result.json`);
}

function operatorSummaryPath(controlPlane: string): string {
  return join(utilityReportsRoot(controlPlane), 'operator-summary.md');
}

function activeRunPath(controlPlane: string): string {
  return join(controlPlane, 'active-run.md');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Atomic JSON write: stage to a sibling temp file, then rename over the
 * target. Rename is atomic within a filesystem, so a concurrent reader sees
 * either the old file or the new one, never a torn half-write. The ambient
 * harvest fires on every Stop, so torn writes are a real risk without this.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
}

function writeMarkdown(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`);
}

function composeHandoffBrief(record: ContinuityRecordValue, state: string, debt: string): string {
  return [
    'Circuit handoff is present for this repo.',
    '',
    `Goal: ${record.narrative.goal}`,
    `Next: ${record.narrative.next}`,
    '',
    'State:',
    state,
    '',
    'Open constraints or debt:',
    debt,
    '',
    'Boundary: Use this as context only. Do not continue unless the user asks.',
    'Useful commands: /circuit:handoff resume, /circuit:handoff done',
  ].join('\n');
}

/**
 * Ambient records were captured mechanically, not saved by the operator, so
 * their brief is framed as an automatic snapshot keyed to this repo — not a
 * vetted plan. The boundary is deliberately more cautious than the manual
 * one: confirm the goal before acting, and never resume the work unasked.
 */
function composeAmbientBrief(record: ContinuityRecordValue, state: string, debt: string): string {
  const repo = basename(record.git.cwd) || record.git.cwd;
  return [
    `Circuit automatically captured the recent state of ${repo}. No handoff was saved.`,
    '',
    `Latest request: ${record.narrative.goal}`,
    `Suggested next: ${record.narrative.next}`,
    '',
    'Recent state:',
    state,
    '',
    'Notes:',
    debt,
    '',
    'Boundary: This is an automatic snapshot, not a saved plan. Confirm the current goal with the user before acting on it, and do not resume this work unasked.',
  ].join('\n');
}

function composeBriefFor(record: ContinuityRecordValue, state: string, debt: string): string {
  return record.continuity_kind === 'ambient'
    ? composeAmbientBrief(record, state, debt)
    : composeHandoffBrief(record, state, debt);
}

function fitText(value: string, budget: number): string {
  const marker = '\n[truncated]';
  if (value.length <= budget) return value;
  if (budget <= 0) return '';
  if (budget <= marker.length) return marker.slice(0, budget);
  return `${value.slice(0, budget - marker.length)}${marker}`;
}

function renderHandoffBrief(record: ContinuityRecordValue): HandoffBriefRenderResult {
  const state = record.narrative.state_markdown;
  const debt = record.narrative.debt_markdown;
  const full = composeBriefFor(record, state, debt);
  if (full.length <= HANDOFF_BRIEF_MAX_CHARS) {
    return { ok: true, additionalContext: full };
  }

  const fixed = composeBriefFor(record, '', '');
  if (fixed.length > HANDOFF_BRIEF_MAX_CHARS) {
    return {
      ok: false,
      code: 'brief_too_large',
      message:
        'Handoff goal and next action are too large to inject without dropping required safety framing.',
    };
  }
  const remaining = Math.max(0, HANDOFF_BRIEF_MAX_CHARS - fixed.length);
  let stateBudget = Math.floor(remaining / 2);
  let debtBudget = remaining - stateBudget;

  if (state.length < stateBudget) {
    debtBudget += stateBudget - state.length;
    stateBudget = state.length;
  }
  if (debt.length < debtBudget) {
    stateBudget += debtBudget - debt.length;
    debtBudget = debt.length;
  }

  let renderedState = fitText(state, stateBudget);
  let renderedDebt = fitText(debt, debtBudget);
  let rendered = composeBriefFor(record, renderedState, renderedDebt);

  if (rendered.length > HANDOFF_BRIEF_MAX_CHARS) {
    const overflow = rendered.length - HANDOFF_BRIEF_MAX_CHARS;
    renderedDebt = fitText(renderedDebt, Math.max(0, renderedDebt.length - overflow));
    rendered = composeBriefFor(record, renderedState, renderedDebt);
  }
  if (rendered.length > HANDOFF_BRIEF_MAX_CHARS) {
    const overflow = rendered.length - HANDOFF_BRIEF_MAX_CHARS;
    renderedState = fitText(renderedState, Math.max(0, renderedState.length - overflow));
    rendered = composeBriefFor(record, renderedState, renderedDebt);
  }

  if (rendered.length > HANDOFF_BRIEF_MAX_CHARS) {
    return {
      ok: false,
      code: 'brief_too_large',
      message: 'Handoff brief could not fit within the injection cap.',
    };
  }

  return { ok: true, additionalContext: rendered };
}

function emptyBrief(args: HandoffArgs, reason: 'no_index' | 'no_pending_record') {
  const projectRoot = resolveProjectRootArg(args);
  const controlPlane = resolveControlPlaneArg(args);
  return {
    api_version: HANDOFF_BRIEF_API_VERSION,
    schema_version: HANDOFF_BRIEF_SCHEMA_VERSION,
    status: 'empty',
    reason,
    project_root: projectRoot,
    control_plane: controlPlane,
    index_path: indexPath(controlPlane),
  };
}

function invalidBrief(
  args: HandoffArgs,
  code: string,
  message: string,
  recordId?: ControlPlaneFileStem,
) {
  const projectRoot = resolveProjectRootArg(args);
  const controlPlane = resolveControlPlaneArg(args);
  return {
    api_version: HANDOFF_BRIEF_API_VERSION,
    schema_version: HANDOFF_BRIEF_SCHEMA_VERSION,
    status: 'invalid',
    project_root: projectRoot,
    control_plane: controlPlane,
    index_path: indexPath(controlPlane),
    ...(recordId === undefined ? {} : { record_id: recordId }),
    error: { code, message },
  };
}

type BriefPointer = {
  readonly record_id: ControlPlaneFileStem;
  readonly continuity_kind: 'standalone' | 'run-backed' | 'ambient';
};

/**
 * Resolve one index pointer to a rendered brief, surfacing the same
 * invalid-state envelopes (missing record, malformed record, kind mismatch,
 * over-cap) the single-pointer path always used. `source` names which pointer
 * won so the host can distinguish a manual save from an ambient fallback.
 */
function resolvePointerBrief(
  args: HandoffArgs,
  controlPlane: string,
  pointer: BriefPointer,
  source: 'pending_record' | 'ambient_record',
) {
  const projectRoot = resolveProjectRootArg(args);
  const indexAbs = indexPath(controlPlane);
  const recordAbs = recordPath(controlPlane, pointer.record_id);
  if (!existsSync(recordAbs)) {
    return invalidBrief(
      args,
      'record_missing',
      'Continuity index points at a missing record.',
      pointer.record_id,
    );
  }

  let record: ContinuityRecordValue;
  try {
    record = ContinuityRecord.parse(JSON.parse(readFileSync(recordAbs, 'utf8')));
  } catch {
    return invalidBrief(
      args,
      'record_invalid',
      'Continuity record is malformed.',
      pointer.record_id,
    );
  }

  if (record.continuity_kind !== pointer.continuity_kind) {
    return invalidBrief(
      args,
      'record_kind_mismatch',
      'Continuity index kind disagrees with the pointed record.',
      pointer.record_id,
    );
  }

  const rendered = renderHandoffBrief(record);
  if (!rendered.ok) {
    return invalidBrief(args, rendered.code, rendered.message, pointer.record_id);
  }

  return {
    api_version: HANDOFF_BRIEF_API_VERSION,
    schema_version: HANDOFF_BRIEF_SCHEMA_VERSION,
    status: 'available',
    project_root: projectRoot,
    control_plane: controlPlane,
    index_path: indexAbs,
    source,
    record_id: record.record_id,
    continuity_kind: record.continuity_kind,
    created_at: record.created_at,
    additional_context: rendered.additionalContext,
  };
}

function handoffBrief(args: HandoffArgs) {
  const controlPlane = resolveControlPlaneArg(args);
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) return emptyBrief(args, 'no_index');

  let index: ContinuityIndexValue;
  try {
    index = ContinuityIndex.parse(JSON.parse(readFileSync(indexAbs, 'utf8')));
  } catch {
    return invalidBrief(args, 'index_invalid', 'Continuity index is malformed.');
  }

  // Precedence (docs/contracts/continuity.md §Resolver precedence): a
  // deliberate manual save outranks a mechanical ambient harvest. The ambient
  // pointer is the fallback safety net when nothing manual is pending.
  if (index.pending_record !== null) {
    return resolvePointerBrief(args, controlPlane, index.pending_record, 'pending_record');
  }
  if (index.ambient_record) {
    return resolvePointerBrief(args, controlPlane, index.ambient_record, 'ambient_record');
  }
  return emptyBrief(args, 'no_pending_record');
}

function debugHook(message: string): void {
  if (process.env.CIRCUIT_HANDOFF_HOOK_DEBUG === '1') {
    process.stderr.write(`Circuit handoff hook: ${message}\n`);
  }
}

function readHookInput(): unknown {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function projectRootFromHookInput(input: unknown): string | undefined {
  if (
    typeof input === 'object' &&
    input !== null &&
    'cwd' in input &&
    typeof input.cwd === 'string' &&
    input.cwd.length > 0
  ) {
    return input.cwd;
  }
  return undefined;
}

function parseHookHost(args: HandoffArgs): HandoffHookHost {
  if (args.host === 'codex') return 'codex';
  throw new Error('handoff hook requires --host codex');
}

function runHandoffHook(args: HandoffArgs): number {
  try {
    parseHookHost(args);
  } catch (err) {
    debugHook(err instanceof Error ? err.message : String(err));
    return 0;
  }

  let projectRoot = args.projectRoot;
  if (projectRoot === undefined) {
    let input: unknown;
    try {
      input = readHookInput();
    } catch (err) {
      debugHook(`could not parse hook input: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    projectRoot = projectRootFromHookInput(input);
  }

  if (projectRoot === undefined || projectRoot.length === 0) {
    debugHook('hook input did not include cwd; skipping handoff injection');
    return 0;
  }

  try {
    const brief = handoffBrief({
      action: 'brief',
      projectRoot,
      progress: false,
      json: true,
    }) as { status?: string; additional_context?: unknown; error?: { code?: string } };
    if (brief.status === 'invalid') {
      debugHook(`brief state is invalid: ${brief.error?.code ?? 'unknown'}`);
      return 0;
    }
    if (brief.status !== 'available' || typeof brief.additional_context !== 'string') return 0;

    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: brief.additional_context,
        },
      })}\n`,
    );
  } catch (err) {
    debugHook(`brief command failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return 0;
}

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
    return resolve(pluginRoot, 'scripts/circuit.ts');
  }
  return resolve(moduleDir, '../..', 'bin/circuit');
}

export function missingDefaultLauncherMessage(launcher: string): string {
  return [
    'CIRCUIT_PLUGIN_ROOT is unset and no wrapper was detected.',
    'Either set CIRCUIT_PLUGIN_ROOT or invoke through plugins/<host>/scripts/circuit.ts.',
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

function parseCodexHooksHost(args: HandoffArgs): HandoffHookHost {
  if (args.host === 'codex') return 'codex';
  throw new Error('handoff hooks requires --host codex');
}

function resolveHooksFileArg(args: HandoffArgs): string {
  return resolve(args.hooksFile ?? defaultCodexHooksFile());
}

function resolveLauncherArg(args: HandoffArgs): string {
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

function installCodexHandoffHook(args: HandoffArgs) {
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

function uninstallCodexHandoffHook(args: HandoffArgs) {
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

function doctorCodexHandoffHook(args: HandoffArgs) {
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

function runHandoffHooksCommand(args: HandoffArgs): unknown {
  if (args.hooksAction === 'install') return installCodexHandoffHook(args);
  if (args.hooksAction === 'uninstall') return uninstallCodexHandoffHook(args);
  if (args.hooksAction === 'doctor') return doctorCodexHandoffHook(args);
  throw new Error('handoff hooks requires install, uninstall, or doctor');
}

function stageForCurrentStep(flow: CompiledFlow, currentStep: string): string {
  const stage = flow.stages.find((candidate) => candidate.steps.includes(currentStep as never));
  return stage?.canonical ?? stage?.id ?? 'frame';
}

function snapshotStatusFromRunStatus(
  status: ReturnType<typeof projectRunStatusFromRunFolder>,
): SnapshotStatus {
  switch (status.engine_state) {
    case 'open':
    case 'waiting_checkpoint':
      return 'in_progress';
    case 'completed':
      return status.terminal_outcome;
    case 'aborted':
      return 'aborted';
    case 'invalid':
      throw new Error('cannot save run-backed continuity: run status is invalid');
  }
}

function loadRunBackedSnapshot(runFolder: string): {
  readonly snapshot: Pick<
    Snapshot,
    'run_id' | 'invocation_id' | 'current_step' | 'status' | 'updated_at'
  >;
  readonly currentStage: string;
} {
  const status = projectRunStatusFromRunFolder(runFolder);
  if (status.engine_state === 'invalid') {
    throw new Error(`cannot save run-backed continuity: ${status.error.message}`);
  }
  const manifest = readManifestSnapshot(runFolder);
  const flow = CompiledFlow.parse(
    JSON.parse(Buffer.from(manifest.bytes_base64, 'base64').toString('utf8')),
  );
  const currentStep =
    ('current_step' in status ? status.current_step?.step_id : undefined) ?? flow.starts_at;
  if (currentStep === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no current step`);
  }
  const updatedAt = status.last_event?.timestamp;
  if (updatedAt === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no latest event`);
  }
  return {
    snapshot: {
      run_id: status.run_id,
      current_step: currentStep,
      status: snapshotStatusFromRunStatus(status),
      updated_at: updatedAt,
    },
    currentStage: stageForCurrentStep(flow, currentStep),
  };
}

function buildRecord(args: HandoffArgs, now: () => Date): ContinuityRecordValue {
  if (args.goal === undefined || args.goal.length === 0) {
    throw new Error('--goal is required when saving handoff continuity');
  }
  if (args.next === undefined || args.next.length === 0) {
    throw new Error('--next is required when saving handoff continuity');
  }
  const projectRoot = resolveProjectRootArg(args);
  const createdAt = args.createdAt ?? now().toISOString();
  const recordId = (args.recordId ?? `continuity-${randomUUID()}`) as ControlPlaneFileStem;
  const base = {
    schema_version: 1 as const,
    record_id: recordId,
    project_root: projectRoot,
    created_at: createdAt,
    git: { cwd: projectRoot },
    narrative: {
      goal: args.goal,
      next: args.next,
      state_markdown: args.stateMarkdown ?? '- No extra session state was provided.',
      debt_markdown: args.debtMarkdown ?? '- No open debt was recorded.',
    },
  };

  if (args.runFolder === undefined) {
    return ContinuityRecord.parse({
      ...base,
      continuity_kind: 'standalone',
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
  }

  const runFolder = resolve(args.runFolder);
  const { snapshot, currentStage } = loadRunBackedSnapshot(runFolder);
  if (snapshot.current_step === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no current step`);
  }
  return ContinuityRecord.parse({
    ...base,
    continuity_kind: 'run-backed',
    run_ref: {
      run_id: snapshot.run_id,
      ...(snapshot.invocation_id === undefined ? {} : { invocation_id: snapshot.invocation_id }),
      current_stage: currentStage,
      current_step: snapshot.current_step,
      runtime_status: snapshot.status,
      runtime_updated_at: snapshot.updated_at,
    },
    resume_contract: {
      mode: 'resume_run',
      auto_resume: false,
      requires_explicit_resume: true,
    },
  });
}

function summaryForRecord(record: ContinuityRecordValue, source: string): string {
  return [
    '# Circuit Handoff',
    '',
    `Source: ${source}`,
    `Record: ${record.record_id}`,
    `Kind: ${record.continuity_kind}`,
    '',
    '## Goal',
    record.narrative.goal,
    '',
    '## Next Action',
    record.narrative.next,
    '',
    '## State',
    record.narrative.state_markdown,
    '',
    '## Debt',
    record.narrative.debt_markdown,
  ].join('\n');
}

function writeActiveRun(controlPlane: string, record: ContinuityRecordValue): string | undefined {
  if (record.continuity_kind !== 'run-backed') return undefined;
  const path = activeRunPath(controlPlane);
  writeMarkdown(
    path,
    [
      '# Active Circuit Run',
      '',
      `Run: ${record.run_ref.run_id}`,
      `Status: ${record.run_ref.runtime_status}`,
      `Stage: ${record.run_ref.current_stage}`,
      `Step: ${record.run_ref.current_step}`,
      '',
      `Next: ${record.narrative.next}`,
    ].join('\n'),
  );
  return path;
}

function saveContinuity(args: HandoffArgs, now: () => Date) {
  const controlPlane = resolveControlPlaneArg(args);
  const record = buildRecord(args, now);
  const recordAbs = recordPath(controlPlane, record.record_id);
  writeJson(recordAbs, record);
  // A manual save owns pending_record/current_run, but a mechanical ambient
  // harvest lives in its own pointer; carry it forward so the save does not
  // clobber it (the two writers must never overwrite each other).
  const existing = readContinuityIndexOrNull(controlPlane);
  const index = ContinuityIndex.parse({
    schema_version: 1,
    project_root: record.project_root,
    pending_record: {
      record_id: record.record_id,
      continuity_kind: record.continuity_kind,
      created_at: record.created_at,
    },
    current_run:
      record.continuity_kind === 'run-backed'
        ? {
            run_id: record.run_ref.run_id,
            current_stage: record.run_ref.current_stage,
            current_step: record.run_ref.current_step,
            runtime_status: record.run_ref.runtime_status,
            attached_at: record.created_at,
            last_validated_at: record.created_at,
          }
        : null,
    ...(existing?.ambient_record ? { ambient_record: existing.ambient_record } : {}),
  });
  writeJson(indexPath(controlPlane), index);
  const activeRun = writeActiveRun(controlPlane, record);
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(summaryPath, summaryForRecord(record, 'saved continuity record'));
  const result = {
    schema_version: 1,
    action: 'save',
    status: 'saved',
    record_id: record.record_id,
    continuity_path: recordAbs,
    index_path: indexPath(controlPlane),
    ...(activeRun === undefined ? {} : { active_run_path: activeRun }),
    operator_summary_markdown_path: summaryPath,
  };
  const resultPath = handoffResultPath(controlPlane, 'save');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

function readJsonSafely(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

function invalidResumeResult(
  controlPlane: string,
  code: string,
  message: string,
  recordId?: ControlPlaneFileStem,
) {
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(
    summaryPath,
    `# Circuit Handoff\n\nSaved continuity record could not be resumed: ${message}`,
  );
  const result = {
    schema_version: 1 as const,
    action: 'resume' as const,
    status: 'invalid' as const,
    index_path: indexPath(controlPlane),
    ...(recordId === undefined ? {} : { record_id: recordId }),
    operator_summary_markdown_path: summaryPath,
    error: { code, message },
  };
  const resultPath = handoffResultPath(controlPlane, 'resume');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

function resumeContinuity(args: HandoffArgs) {
  const controlPlane = resolveControlPlaneArg(args);
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) {
    const summaryPath = operatorSummaryPath(controlPlane);
    writeMarkdown(summaryPath, '# Circuit Handoff\n\nNo saved continuity found.');
    const result = {
      schema_version: 1,
      action: 'resume',
      status: 'not_found',
      index_path: indexAbs,
      operator_summary_markdown_path: summaryPath,
    };
    const resultPath = handoffResultPath(controlPlane, 'resume');
    writeJson(resultPath, result);
    return { ...result, result_path: resultPath };
  }
  const indexRaw = readJsonSafely(indexAbs);
  if (!indexRaw.ok) {
    return invalidResumeResult(controlPlane, 'index_invalid', 'Continuity index is malformed.');
  }
  const indexParsed = ContinuityIndex.safeParse(indexRaw.value);
  if (!indexParsed.success) {
    return invalidResumeResult(controlPlane, 'index_invalid', 'Continuity index is malformed.');
  }
  const index = indexParsed.data;
  if (index.pending_record === null) {
    const summaryPath = operatorSummaryPath(controlPlane);
    writeMarkdown(summaryPath, '# Circuit Handoff\n\nNo saved continuity found.');
    const result = {
      schema_version: 1,
      action: 'resume',
      status: 'not_found',
      index_path: indexAbs,
      operator_summary_markdown_path: summaryPath,
    };
    const resultPath = handoffResultPath(controlPlane, 'resume');
    writeJson(resultPath, result);
    return { ...result, result_path: resultPath };
  }
  const recordAbs = recordPath(controlPlane, index.pending_record.record_id);
  if (!existsSync(recordAbs)) {
    return invalidResumeResult(
      controlPlane,
      'record_missing',
      'Continuity index points at a missing record.',
      index.pending_record.record_id,
    );
  }
  const recordRaw = readJsonSafely(recordAbs);
  if (!recordRaw.ok) {
    return invalidResumeResult(
      controlPlane,
      'record_invalid',
      'Continuity record is malformed.',
      index.pending_record.record_id,
    );
  }
  const recordParsed = ContinuityRecord.safeParse(recordRaw.value);
  if (!recordParsed.success) {
    return invalidResumeResult(
      controlPlane,
      'record_invalid',
      'Continuity record is malformed.',
      index.pending_record.record_id,
    );
  }
  const record = recordParsed.data;
  if (record.continuity_kind !== index.pending_record.continuity_kind) {
    return invalidResumeResult(
      controlPlane,
      'record_kind_mismatch',
      'Continuity index kind disagrees with the pointed record.',
      record.record_id,
    );
  }
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(summaryPath, summaryForRecord(record, 'pending_record'));
  const result = {
    schema_version: 1,
    action: 'resume',
    status: 'resumed',
    source: 'pending_record',
    record_id: record.record_id,
    continuity_path: recordAbs,
    index_path: indexAbs,
    operator_summary_markdown_path: summaryPath,
  };
  const resultPath = handoffResultPath(controlPlane, 'resume');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

function clearContinuity(args: HandoffArgs, now: () => Date) {
  const controlPlane = resolveControlPlaneArg(args);
  const projectRoot = resolveProjectRootArg(args);
  const createdAt = args.createdAt ?? now().toISOString();
  // `done` clears the manual save only. The ambient harvest is an orthogonal
  // freshness cache, kept so a finished manual task still leaves the latest
  // auto-captured state available as a fallback.
  const existing = readContinuityIndexOrNull(controlPlane);
  const index = ContinuityIndex.parse({
    schema_version: 1,
    project_root: projectRoot,
    pending_record: null,
    current_run: null,
    ...(existing?.ambient_record ? { ambient_record: existing.ambient_record } : {}),
  });
  writeJson(indexPath(controlPlane), index);
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(summaryPath, '# Circuit Handoff\n\nContinuity cleared.');
  const result = {
    schema_version: 1,
    action: 'done',
    status: 'cleared',
    index_path: indexPath(controlPlane),
    operator_summary_markdown_path: summaryPath,
    cleared_at: createdAt,
  };
  const resultPath = handoffResultPath(controlPlane, 'done');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

// --- Ambient continuity harvest -------------------------------------------
//
// `circuit handoff harvest` is the mechanical producer for the third
// continuity kind. A Stop/SessionEnd hook drives it with the live transcript;
// it lifts genuine human intents and the latest compaction summary, builds an
// `ambient` continuity record, and points the index's `ambient_record` at it
// WITHOUT touching the manual `pending_record`. This is the in-engine
// replacement for the personal warm-handoff shell writer, so the two
// continuity layers stop disagreeing (see docs/contracts/continuity.md
// CONT-I13..I18).

const DEFAULT_AMBIENT_RECORD_STEM = 'ambient-latest';
const AMBIENT_INTENT_MAX_CHARS = 280;
const AMBIENT_MAX_INTENTS = 4;

// Host-injected user turns the model should never treat as human intent.
// Mirrors the proven warm-writer filter, plus the writer's own header so a
// prior ambient record can never re-ingest itself.
const AMBIENT_HOST_TAG_PREFIX =
  /^<(command-name|command-message|command-args|local-command|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)/;
const AMBIENT_DROP_LINE_PREFIX = /^(# \/|# Warm continuity record|Caveat:|\[SESSION CONTINUITY\])/;
const AMBIENT_INTERRUPT_MARKER = /Request interrupted/;

export interface AmbientGitProbe {
  readonly branch?: string;
  readonly head?: string;
  readonly statusPorcelain?: string;
}

export interface AmbientHarvestInput {
  readonly transcriptPath: string;
  readonly projectRoot: string;
  readonly source: AmbientSource;
  readonly controlPlane?: string;
  readonly sessionId?: string;
  readonly recordId?: string;
  readonly createdAt?: string;
  readonly now: () => Date;
  readonly gitProbe?: (projectRoot: string) => AmbientGitProbe;
}

export type AmbientHarvestResult =
  | {
      readonly schema_version: 1;
      readonly action: 'harvest';
      readonly status: 'harvested';
      readonly record_id: ControlPlaneFileStem;
      readonly continuity_path: string;
      readonly index_path: string;
      readonly intents_captured: number;
      readonly summary_captured: boolean;
    }
  | {
      readonly schema_version: 1;
      readonly action: 'harvest';
      readonly status: 'skipped';
      readonly reason: 'no_transcript' | 'transcript_unreadable' | 'nothing_to_harvest';
      readonly index_path: string;
    };

interface ParsedTranscript {
  readonly intents: readonly string[];
  readonly summary: string | undefined;
}

function collapseWhitespace(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDroppedIntent(text: string): boolean {
  return (
    text.length === 0 ||
    AMBIENT_HOST_TAG_PREFIX.test(text) ||
    AMBIENT_DROP_LINE_PREFIX.test(text) ||
    AMBIENT_INTERRUPT_MARKER.test(text)
  );
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      blocks.push((block as { text: string }).text);
    }
  }
  return blocks;
}

/**
 * Genuine human intent from a user turn. A string is the typed message; an
 * array is a structured turn (pasted images, tool results) where only the
 * `text` blocks are human — tool_result/image blocks are dropped. Collapses
 * whitespace so the host-tag prefix test is reliable.
 */
function userMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const collapsed = collapseWhitespace(content);
    return collapsed.length === 0 ? undefined : collapsed;
  }
  if (Array.isArray(content)) {
    const collapsed = collapseWhitespace(textBlocks(content).join(' '));
    return collapsed.length === 0 ? undefined : collapsed;
  }
  return undefined;
}

/**
 * Rich narrative from a compaction summary turn. Unlike intents, newlines are
 * preserved so the harvested markdown structure survives.
 */
function compactSummaryText(content: unknown): string | undefined {
  const raw = typeof content === 'string' ? content : textBlocks(content).join('\n');
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse a Claude Code transcript (JSONL) in TypeScript — no jq, UTF-8 safe by
 * virtue of reading as utf8. Malformed lines are skipped, not fatal. Returns
 * undefined only when the file itself cannot be read.
 */
function parseTranscriptForHarvest(transcriptPath: string): ParsedTranscript | undefined {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
  const intents: string[] = [];
  let summary: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entry = parsed as {
      type?: unknown;
      isCompactSummary?: unknown;
      message?: { content?: unknown };
    };
    const content = entry.message?.content;
    if (entry.isCompactSummary === true) {
      const text = compactSummaryText(content);
      if (text !== undefined) summary = text; // keep the latest
      continue;
    }
    if (entry.type !== 'user') continue;
    const text = userMessageText(content);
    if (text === undefined || isDroppedIntent(text)) continue;
    intents.push(text.slice(0, AMBIENT_INTENT_MAX_CHARS));
  }
  return { intents: intents.slice(-AMBIENT_MAX_INTENTS), summary };
}

function realAmbientGitProbe(projectRoot: string): AmbientGitProbe {
  const git = (gitArgs: readonly string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  };
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return {};
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const status = git(['status', '--porcelain=v1']);
  const statusPorcelain =
    status === undefined || status.length === 0
      ? undefined
      : status.split('\n').slice(0, 40).join('\n');
  return {
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    ...(statusPorcelain ? { statusPorcelain } : {}),
  };
}

function composeAmbientStateMarkdown(
  intents: readonly string[],
  summary: string | undefined,
  git: AmbientGitProbe,
  transcriptPath: string,
): string {
  const lines: string[] = ['## Recent intent (your last requests, newest last)'];
  if (intents.length > 0) {
    for (const intent of intents) lines.push(`- ${intent}`);
  } else {
    lines.push('- (none captured; see the transcript below)');
  }
  lines.push('', '## Working tree (uncommitted)');
  if (git.statusPorcelain !== undefined) {
    lines.push('```', git.statusPorcelain, '```');
  } else {
    lines.push('clean, or not a git repo');
  }
  lines.push('', '## Structured summary (harvested from the last compaction)');
  lines.push(summary ?? 'None captured this session. Full history is in the transcript below.');
  lines.push('', '## Full detail', `Transcript: ${transcriptPath}`);
  return lines.join('\n');
}

function readContinuityIndexOrNull(controlPlane: string): ContinuityIndexValue | null {
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) return null;
  const raw = readJsonSafely(indexAbs);
  if (!raw.ok) return null;
  const parsed = ContinuityIndex.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
}

export function harvestAmbientContinuity(input: AmbientHarvestInput): AmbientHarvestResult {
  const projectRoot = resolve(input.projectRoot);
  const controlPlane =
    input.controlPlane === undefined
      ? resolve(projectRoot, DEFAULT_CONTROL_PLANE)
      : resolve(input.controlPlane);
  const skip = (
    reason: 'no_transcript' | 'transcript_unreadable' | 'nothing_to_harvest',
  ): AmbientHarvestResult => ({
    schema_version: 1,
    action: 'harvest',
    status: 'skipped',
    reason,
    index_path: indexPath(controlPlane),
  });

  if (!existsSync(input.transcriptPath)) return skip('no_transcript');
  const parsed = parseTranscriptForHarvest(input.transcriptPath);
  if (parsed === undefined) return skip('transcript_unreadable');

  const git: AmbientGitProbe = (input.gitProbe ?? ((): AmbientGitProbe => ({})))(projectRoot);
  if (
    parsed.intents.length === 0 &&
    parsed.summary === undefined &&
    git.statusPorcelain === undefined
  ) {
    // Mirror the warm-writer guard: never blank a good prior record just
    // because this turn captured nothing.
    return skip('nothing_to_harvest');
  }

  const createdAt = input.createdAt ?? input.now().toISOString();
  const recordId = (input.recordId ?? DEFAULT_AMBIENT_RECORD_STEM) as ControlPlaneFileStem;
  const latestIntent = parsed.intents[parsed.intents.length - 1];
  const goal =
    latestIntent ??
    `Resume the mechanically captured session in ${basename(projectRoot) || projectRoot}`;

  const record = ContinuityRecord.parse({
    schema_version: 1,
    record_id: recordId,
    project_root: projectRoot,
    created_at: createdAt,
    git: {
      cwd: projectRoot,
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.head ? { head: git.head } : {}),
    },
    narrative: {
      goal,
      next: 'Review the recent intents and harvested summary below, then continue. This record was captured automatically, not saved by you, so confirm before acting.',
      state_markdown: composeAmbientStateMarkdown(
        parsed.intents,
        parsed.summary,
        git,
        input.transcriptPath,
      ),
      debt_markdown: `- Mechanically harvested from the live transcript at ${createdAt}. Treat it as a hint, not a verified plan.`,
    },
    continuity_kind: 'ambient',
    ambient_provenance: {
      transcript_path: input.transcriptPath,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      source: input.source,
    },
    resume_contract: {
      mode: 'resume_ambient',
      auto_resume: false,
      requires_explicit_resume: true,
    },
  });

  const recordAbs = recordPath(controlPlane, record.record_id);
  writeJsonAtomic(recordAbs, record);

  // Read-merge-write so a deliberate manual save (pending_record) and any
  // attached run (current_run) survive untouched; only ambient_record moves.
  const existing = readContinuityIndexOrNull(controlPlane);
  const index = ContinuityIndex.parse({
    schema_version: 1,
    project_root: existing?.project_root ?? projectRoot,
    pending_record: existing?.pending_record ?? null,
    current_run: existing?.current_run ?? null,
    ambient_record: {
      record_id: record.record_id,
      continuity_kind: 'ambient',
      created_at: record.created_at,
    },
  });
  writeJsonAtomic(indexPath(controlPlane), index);

  return {
    schema_version: 1,
    action: 'harvest',
    status: 'harvested',
    record_id: record.record_id,
    continuity_path: recordAbs,
    index_path: indexPath(controlPlane),
    intents_captured: parsed.intents.length,
    summary_captured: parsed.summary !== undefined,
  };
}

function ambientSourceFrom(value: string | undefined, hookEventName: unknown): AmbientSource {
  if (value === 'session-end') return 'session-end';
  if (value === 'stop') return 'stop';
  if (typeof hookEventName === 'string' && hookEventName === 'SessionEnd') return 'session-end';
  return 'stop';
}

function runHandoffHarvest(args: HandoffArgs, now: () => Date): number {
  let transcriptPath = args.transcriptPath;
  let projectRoot = args.projectRoot;
  let sessionId = args.sessionId;
  let hookEventName: unknown;
  if (transcriptPath === undefined || projectRoot === undefined || sessionId === undefined) {
    let input: unknown = {};
    try {
      input = readHookInput();
    } catch (err) {
      debugHook(
        `harvest could not parse hook input: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof input === 'object' && input !== null) {
      const hi = input as Record<string, unknown>;
      if (transcriptPath === undefined && typeof hi.transcript_path === 'string') {
        transcriptPath = hi.transcript_path;
      }
      if (projectRoot === undefined && typeof hi.cwd === 'string') projectRoot = hi.cwd;
      if (sessionId === undefined && typeof hi.session_id === 'string') sessionId = hi.session_id;
      hookEventName = hi.hook_event_name;
    }
  }
  const resolvedProjectRoot = projectRoot ?? process.cwd();
  const source = ambientSourceFrom(args.source, hookEventName);
  const controlPlane = args.controlPlane === undefined ? undefined : resolve(args.controlPlane);
  const fallbackIndexPath = indexPath(
    controlPlane ?? resolve(resolvedProjectRoot, DEFAULT_CONTROL_PLANE),
  );

  if (transcriptPath === undefined) {
    const result: AmbientHarvestResult = {
      schema_version: 1,
      action: 'harvest',
      status: 'skipped',
      reason: 'no_transcript',
      index_path: fallbackIndexPath,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  try {
    const result = harvestAmbientContinuity({
      transcriptPath,
      projectRoot: resolvedProjectRoot,
      source,
      ...(controlPlane === undefined ? {} : { controlPlane }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(args.recordId === undefined ? {} : { recordId: args.recordId }),
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
      now,
      gitProbe: realAmbientGitProbe,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    // A continuity harvest must never break the session it fires in.
    debugHook(`harvest failed: ${err instanceof Error ? err.message : String(err)}`);
    const result: AmbientHarvestResult = {
      schema_version: 1,
      action: 'harvest',
      status: 'skipped',
      reason: 'transcript_unreadable',
      index_path: fallbackIndexPath,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return 0;
}

export async function runHandoffCommand(
  argv: readonly string[],
  options: HandoffMainOptions = {},
): Promise<number> {
  let args: HandoffArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (args.action === 'brief') {
    if (!args.json) {
      process.stderr.write(
        'handoff brief returns machine-readable JSON for host injection. Pass --json to confirm that output mode and run it.\n',
      );
      return 2;
    }
    process.stdout.write(`${JSON.stringify(handoffBrief(args), null, 2)}\n`);
    return 0;
  }

  if (args.action === 'hook') {
    return runHandoffHook(args);
  }

  if (args.action === 'harvest') {
    return runHandoffHarvest(args, options.now ?? (() => new Date()));
  }

  if (args.action === 'hooks') {
    try {
      process.stdout.write(`${JSON.stringify(runHandoffHooksCommand(args), null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const now = options.now ?? (() => new Date());
  const progress = utilityProgress({
    enabled: args.progress,
    flowId: 'handoff',
    now,
  });
  if (progress !== undefined) {
    progress.emit({
      type: 'route.selected',
      recorded_at: now().toISOString(),
      label: 'Selected Handoff',
      display: {
        text: `Circuit selected handoff ${args.action}.`,
        importance: 'major',
        tone: 'info',
      },
      presentation: progressPresentation({
        blockId: progress.runId,
        statusText: `Chose handoff ${args.action}.`,
      }),
      selected_flow: 'handoff' as never,
      routed_by: 'explicit',
      router_reason: 'explicit handoff utility command',
    });
  }

  try {
    const result =
      args.action === 'save'
        ? saveContinuity(args, now)
        : args.action === 'resume'
          ? resumeContinuity(args)
          : clearContinuity(args, now);
    const isInvalidResume = args.action === 'resume' && result.status === 'invalid';
    const isNotFoundResume = args.action === 'resume' && result.status === 'not_found';
    const invalidMessage =
      isInvalidResume &&
      'error' in result &&
      typeof result.error === 'object' &&
      result.error !== null &&
      'message' in result.error &&
      typeof result.error.message === 'string'
        ? result.error.message
        : 'malformed continuity record';
    if (progress !== undefined) {
      const statusText = isInvalidResume
        ? 'Saved Circuit handoff could not be resumed.'
        : isNotFoundResume
          ? 'No saved Circuit handoff was found.'
          : `Handoff ${args.action} completed.`;
      const text = isInvalidResume
        ? `Circuit handoff resume aborted: ${invalidMessage}`
        : isNotFoundResume
          ? 'No saved Circuit handoff was found.'
          : `Circuit handoff ${args.action} completed.`;
      const tone = isInvalidResume ? 'error' : isNotFoundResume ? 'warning' : 'success';
      if (isInvalidResume) {
        progress.emit({
          type: 'run.aborted',
          recorded_at: now().toISOString(),
          label: 'Handoff aborted',
          display: { text, importance: 'major', tone },
          presentation: progressPresentation({ blockId: progress.runId, statusText }),
          outcome: 'aborted',
          result_path: result.result_path,
          reason: invalidMessage,
        });
      } else {
        progress.emit({
          type: 'run.completed',
          recorded_at: now().toISOString(),
          label: 'Handoff completed',
          display: { text, importance: 'major', tone },
          presentation: progressPresentation({ blockId: progress.runId, statusText }),
          outcome: 'complete',
          result_path: result.result_path,
        });
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return isInvalidResume ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

import { execFile, spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 5_000_000;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_CHARS = 64 * 1024;
const MAX_ENV_VALUE_CHARS = 32 * 1024;
const DEFAULT_INTERRUPT_GRACE_MS = 250;
const DEFAULT_CLEANUP_WAIT_MS = 1_000;
const PROCESS_POLL_MS = 25;

const REQUEST_FIELDS = new Set(['id', 'cwd', 'argv', 'env', 'timeout_ms', 'max_output_bytes']);
const COMMAND_ENV_KEYS = new Set(['CI', 'FORCE_COLOR', 'NODE_ENV', 'NO_COLOR', 'TZ']);
const MACOS_RUNTIME_READ_ROOTS = [
  '/System/Library',
  '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld',
  '/Library/Apple',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/libexec',
  '/usr/share',
  '/bin',
  '/sbin',
  '/private/var/db/timezone',
  '/private/var/select',
  '/var/select',
] as const;
const MACOS_RUNTIME_READ_FILES = [
  '/',
  '/dev/autofs_nowait',
  '/dev/null',
  '/dev/random',
  '/dev/urandom',
  '/dev/zero',
] as const;

export type ProofSandboxStatus =
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'output_limit'
  | 'cleanup_unconfirmed';

export interface ProofSandboxCommand {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}

export interface ProofSandboxCleanup {
  readonly required: boolean;
  readonly confirmed: boolean;
  readonly observed_pids: readonly number[];
  readonly remaining_pids: readonly number[];
  readonly inspection_error?: string;
}

export interface ProofSandboxResult {
  readonly schema_version: 1;
  readonly status: ProofSandboxStatus;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly duration_ms: number;
  readonly cleanup: ProofSandboxCleanup;
  readonly sandbox: {
    readonly provider: 'macos-seatbelt' | 'test-only-unsandboxed' | 'not-launched';
    readonly network: 'denied' | 'not_enforced_test_only' | 'not_started';
    readonly access: 'workspace-write' | 'git-read-only';
    readonly writable_roots: readonly string[];
    readonly mach_services: readonly [];
  };
}

export interface ProofSandboxLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly provider: 'macos-seatbelt' | 'test-only-unsandboxed';
  readonly network: 'denied' | 'not_enforced_test_only';
}

export interface ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startToken: string;
}

interface MacosProofSandboxOptions {
  readonly workspace: string;
  readonly privateRoot: string;
  readonly pathEntries: readonly string[];
  /** The private worker group that owns every production proof process. */
  readonly ownerProcessGroupId?: number;
  readonly platform?: NodeJS.Platform;
  readonly sandboxExecutable?: string;
  readonly interruptGraceMs?: number;
  readonly cleanupWaitMs?: number;
  readonly inspectProcesses?: () => Promise<readonly ProcessTableEntry[]>;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly allowUnsafeTestLaunch?: boolean;
  readonly testOnlyLaunch?: (input: {
    readonly cwd: string;
    readonly argv: readonly string[];
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly access: 'workspace-write' | 'git-read-only';
  }) => ProofSandboxLaunch;
}

export interface GitReadSandboxRequest extends ProofSandboxCommand {
  readonly access: 'git-read-only';
  readonly readRoots: readonly string[];
  readonly git_environment: Readonly<Record<string, string>>;
}

export interface MacosProofSandbox {
  readonly run: (request: unknown) => Promise<ProofSandboxResult>;
  readonly execute: (
    request: ProofSandboxCommand,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ProofSandboxResult>;
  readonly executeGitRead: (
    request: GitReadSandboxRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ProofSandboxResult>;
}

export class ProofSandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProofSandboxError';
    this.code = code;
  }
}

export class UnsupportedProofPlatformError extends ProofSandboxError {
  constructor(platform: string) {
    super(
      'unsupported_platform',
      `Circuit proof commands require macOS Seatbelt; ${platform} is not supported.`,
    );
    this.name = 'UnsupportedProofPlatformError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProofSandboxError(
      'invalid_proof_request',
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

function boundedString(value: unknown, name: string, maximum = MAX_ARGUMENT_CHARS): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProofSandboxError('invalid_proof_request', `${name} must be a non-empty string.`);
  }
  if (value.includes('\0') || value.length > maximum) {
    throw new ProofSandboxError('invalid_proof_request', `${name} is invalid.`);
  }
  return value;
}

function parseCommandEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new ProofSandboxError('invalid_proof_request', 'env must be an object.');
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!COMMAND_ENV_KEYS.has(key)) {
      throw new ProofSandboxError(
        'invalid_proof_request',
        `Proof env key ${JSON.stringify(key)} is not allowed.`,
      );
    }
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > MAX_ENV_VALUE_CHARS) {
      throw new ProofSandboxError(
        'invalid_proof_request',
        `Proof env value for ${JSON.stringify(key)} is invalid.`,
      );
    }
    environment[key] = entry;
  }
  return Object.freeze(environment);
}

function parseProofCommand(value: unknown): ProofSandboxCommand {
  if (!isRecord(value)) {
    throw new ProofSandboxError('invalid_proof_request', 'Proof request must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(key)) {
      throw new ProofSandboxError('invalid_proof_request', `Unknown field ${JSON.stringify(key)}.`);
    }
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > MAX_ARGUMENTS) {
    throw new ProofSandboxError(
      'invalid_proof_request',
      `argv must contain 1 to ${MAX_ARGUMENTS} strings.`,
    );
  }
  const argv = value.argv.map((entry, index) => boundedString(entry, `argv[${index}]`));
  if (argv.reduce((total, entry) => total + entry.length, 0) > MAX_ARGUMENT_CHARS) {
    throw new ProofSandboxError('invalid_proof_request', 'argv is too large.');
  }
  if (!isAbsolute(argv[0] ?? '')) {
    throw new ProofSandboxError('invalid_proof_request', 'argv[0] must be an absolute path.');
  }

  return Object.freeze({
    id: boundedString(value.id, 'id', 256),
    cwd: boundedString(value.cwd, 'cwd'),
    argv: Object.freeze(argv),
    env: parseCommandEnvironment(value.env),
    timeout_ms: boundedInteger(value.timeout_ms, 'timeout_ms', 1, MAX_TIMEOUT_MS),
    max_output_bytes: boundedInteger(
      value.max_output_bytes,
      'max_output_bytes',
      1,
      MAX_OUTPUT_BYTES,
    ),
  });
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

async function canonicalDirectory(candidate: string, name: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new ProofSandboxError('invalid_sandbox_path', `${name} must be absolute.`);
  }
  const input = resolve(candidate);
  const link = await lstat(input).catch((error: unknown) => {
    throw new ProofSandboxError(
      'invalid_sandbox_path',
      `${name} could not be inspected: ${errorMessage(error)}`,
    );
  });
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new ProofSandboxError('invalid_sandbox_path', `${name} must be a real directory.`);
  }
  const canonical = await realpath(input);
  if (canonical !== input) {
    throw new ProofSandboxError('invalid_sandbox_path', `${name} must already be canonical.`);
  }
  return canonical;
}

async function validatePrivateRoot(workspace: string, privateRootInput: string): Promise<string> {
  const privateRoot = await canonicalDirectory(privateRootInput, 'Private proof root');
  if (isInside(workspace, privateRoot) || isInside(privateRoot, workspace)) {
    throw new ProofSandboxError(
      'invalid_sandbox_path',
      'Private proof root must be separate from the workspace.',
    );
  }
  const metadata = await stat(privateRoot);
  if ((metadata.mode & 0o077) !== 0) {
    throw new ProofSandboxError(
      'invalid_sandbox_path',
      'Private proof root must not be accessible to group or other users.',
    );
  }
  if (typeof process.geteuid === 'function' && metadata.uid !== process.geteuid()) {
    throw new ProofSandboxError(
      'invalid_sandbox_path',
      'Private proof root must be owned by the current user.',
    );
  }
  return privateRoot;
}

async function resolveProofCwd(workspace: string, cwd: string): Promise<string> {
  if (isAbsolute(cwd)) {
    throw new ProofSandboxError('invalid_proof_request', 'Proof cwd must be workspace-relative.');
  }
  const target = resolve(workspace, cwd);
  if (!isInside(workspace, target)) {
    throw new ProofSandboxError('invalid_proof_request', 'Proof cwd escapes the workspace.');
  }
  let cursor = workspace;
  for (const segment of relative(workspace, target).split('/')) {
    if (segment === '' || segment === '.') continue;
    cursor = join(cursor, segment);
    const metadata = await lstat(cursor).catch((error: unknown) => {
      throw new ProofSandboxError(
        'invalid_proof_request',
        `Proof cwd does not exist: ${errorMessage(error)}`,
      );
    });
    if (metadata.isSymbolicLink()) {
      throw new ProofSandboxError('invalid_proof_request', 'Proof cwd crosses a symbolic link.');
    }
  }
  const canonical = await canonicalDirectory(target, 'Proof cwd');
  if (!isInside(workspace, canonical)) {
    throw new ProofSandboxError('invalid_proof_request', 'Proof cwd escapes the workspace.');
  }
  return canonical;
}

async function resolveExecutable(candidate: string): Promise<string> {
  const canonical = await realpath(candidate).catch((error: unknown) => {
    throw new ProofSandboxError(
      'invalid_proof_request',
      `Proof executable could not be resolved: ${errorMessage(error)}`,
    );
  });
  const metadata = await stat(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new ProofSandboxError(
      'invalid_proof_request',
      'Proof executable must be an executable regular file.',
    );
  }
  return canonical;
}

interface ProofRuntimeAccess {
  readonly readFiles: readonly string[];
  readonly readRoots: readonly string[];
}

function selectedDeveloperToolchainRoots(executable: string): readonly string[] {
  const xcode = /^\/Applications\/[^/]*Xcode[^/]*\.app\/Contents\/Developer(?:\/|$)/u.exec(
    executable,
  );
  if (xcode !== null) return Object.freeze([xcode[0].replace(/\/$/u, '')]);
  if (isInside('/Library/Developer/CommandLineTools', executable)) {
    return Object.freeze(['/Library/Developer/CommandLineTools']);
  }
  return Object.freeze([]);
}

function npmPackageRoot(executable: string): string | undefined {
  const marker = '/lib/node_modules/npm/';
  const markerIndex = executable.indexOf(marker);
  if (markerIndex < 0) return undefined;
  return executable.slice(0, markerIndex + marker.length - 1);
}

async function selectedExecutableRuntimeAccess(executable: string): Promise<ProofRuntimeAccess> {
  const readFiles = new Set([executable]);
  const readRoots = new Set(selectedDeveloperToolchainRoots(executable));
  const npmRoot = npmPackageRoot(executable);
  if (npmRoot !== undefined) {
    const hostNode = await resolveExecutable(process.execPath);
    readFiles.add(hostNode);
    readRoots.add(npmRoot);
  }
  return Object.freeze({
    readFiles: Object.freeze([...readFiles]),
    readRoots: Object.freeze([...readRoots]),
  });
}

function seatbeltString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}"`;
}

function pathAndAncestors(candidate: string): readonly string[] {
  const paths: string[] = [];
  let cursor = resolve(candidate);
  while (true) {
    paths.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return paths;
    cursor = parent;
  }
}

export function buildMacosSeatbeltProfile(input: {
  readonly workspace: string;
  readonly privateDirectory: string;
  readonly access: 'workspace-write' | 'git-read-only';
  readonly readRoots: readonly string[];
  readonly readFiles?: readonly string[];
}): string {
  const readRoots = [
    ...new Set([...MACOS_RUNTIME_READ_ROOTS, ...input.readRoots, input.privateDirectory]),
  ];
  const readFiles = [...new Set(input.readFiles ?? [])];
  const metadataPaths = [
    ...new Set([...readRoots.flatMap(pathAndAncestors), ...readFiles.flatMap(pathAndAncestors)]),
  ];
  const writableRoots =
    input.access === 'workspace-write'
      ? [input.workspace, input.privateDirectory]
      : [input.privateDirectory];
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink',
    '  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$")',
    ')',
    '(allow system-mac-syscall (mac-policy-name "vnguard"))',
    '(allow system-mac-syscall',
    '  (require-all',
    '    (mac-policy-name "Sandbox")',
    '    (mac-syscall-number 67)',
    '  )',
    ')',
    '(deny mach-lookup)',
  ];

  profile.push(
    '(allow file-read* file-test-existence',
    ...readRoots.map((root) => `  (subpath ${seatbeltString(root)})`),
    ...readFiles.map((file) => `  (literal ${seatbeltString(file)})`),
    ...MACOS_RUNTIME_READ_FILES.map((file) => `  (literal ${seatbeltString(file)})`),
    ')',
    '(allow file-map-executable',
    ...readRoots.map((root) => `  (subpath ${seatbeltString(root)})`),
    ...readFiles.map((file) => `  (literal ${seatbeltString(file)})`),
    ')',
    '(allow file-read-metadata file-test-existence',
    ...metadataPaths.map((candidate) => `  (literal ${seatbeltString(candidate)})`),
    ')',
  );

  profile.push(
    '(allow file-write*',
    ...writableRoots.map((root) => `  (subpath ${seatbeltString(root)})`),
    '  (literal "/dev/null")',
    ')',
    '(deny network*)',
  );
  return profile.join('\n');
}

export function parseProcessTable(
  stdout: string,
  excludedPid?: number,
): readonly ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const pid = Number(match[1]);
    if (pid === excludedPid) continue;
    entries.push({
      pid,
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      startToken: match[4] ?? '',
    });
  }
  return entries;
}

function defaultInspectProcesses(): Promise<readonly ProcessTableEntry[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        resolvePromise(parseProcessTable(stdout, child.pid));
      },
    );
  });
}

interface OwnedProcessGroup {
  readonly id: number;
  readonly baseline: ReadonlyMap<number, string>;
}

export function relatedProcesses(
  table: readonly ProcessTableEntry[],
  rootPid: number,
  ownedGroup?: OwnedProcessGroup,
): readonly ProcessTableEntry[] {
  const children = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  const found = new Map<number, ProcessTableEntry>();
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child.pid)) continue;
      found.set(child.pid, child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  for (const entry of table) {
    if (entry.pid === rootPid || entry.processGroupId === rootPid) found.set(entry.pid, entry);
    if (
      ownedGroup !== undefined &&
      entry.processGroupId === ownedGroup.id &&
      ownedGroup.baseline.get(entry.pid) !== entry.startToken
    ) {
      found.set(entry.pid, entry);
    }
  }
  return [...found.values()];
}

interface ProcessObserver {
  readonly stop: () => Promise<{
    readonly identities: ReadonlyMap<number, ProcessTableEntry>;
    readonly inspectionError?: string;
    readonly lastTable: readonly ProcessTableEntry[];
  }>;
}

function observeProcesses(
  rootPid: number,
  inspect: () => Promise<readonly ProcessTableEntry[]>,
  ownedGroup?: OwnedProcessGroup,
): ProcessObserver {
  const identities = new Map<number, ProcessTableEntry>();
  let inspectionError: string | undefined;
  let lastTable: readonly ProcessTableEntry[] = [];
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  const capture = async (): Promise<void> => {
    try {
      const table = await inspect();
      lastTable = table;
      for (const processEntry of relatedProcesses(table, rootPid, ownedGroup)) {
        if (!identities.has(processEntry.pid)) {
          identities.set(processEntry.pid, processEntry);
        }
      }
    } catch (error) {
      inspectionError ??= errorMessage(error);
    }
  };
  const poll = (): void => {
    if (stopped || active !== undefined) return;
    active = capture().finally(() => {
      active = undefined;
      if (!stopped) {
        timer = setTimeout(poll, PROCESS_POLL_MS);
        timer.unref();
      }
    });
  };
  poll();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (active !== undefined) await active;
      await capture();
      return {
        identities,
        ...(inspectionError === undefined ? {} : { inspectionError }),
        lastTable,
      };
    },
  };
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function signalExpectedProofProcess(input: {
  readonly expected: ProcessTableEntry;
  readonly signal: NodeJS.Signals;
  readonly inspect: () => Promise<readonly ProcessTableEntry[]>;
  readonly send?: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<'signaled' | 'absent' | 'replaced'> {
  const current = (await input.inspect()).find((entry) => entry.pid === input.expected.pid);
  if (current === undefined) return 'absent';
  if (
    current.startToken !== input.expected.startToken ||
    current.processGroupId !== input.expected.processGroupId
  ) {
    return 'replaced';
  }
  (input.send ?? sendSignal)(input.expected.pid, input.signal);
  return 'signaled';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function cleanupProcesses(input: {
  readonly rootPid: number;
  readonly observer: ProcessObserver;
  readonly inspect: () => Promise<readonly ProcessTableEntry[]>;
  readonly terminate: boolean;
  readonly interruptGraceMs: number;
  readonly cleanupWaitMs: number;
  readonly ownedGroup?: OwnedProcessGroup;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<ProofSandboxCleanup> {
  const observation = await input.observer.stop();
  const identities = new Map(observation.identities);
  for (const entry of relatedProcesses(observation.lastTable, input.rootPid, input.ownedGroup)) {
    if (!identities.has(entry.pid)) identities.set(entry.pid, entry);
  }
  let inspectionError = observation.inspectionError;

  const rememberRelated = (candidateTable: readonly ProcessTableEntry[]): void => {
    for (const entry of relatedProcesses(candidateTable, input.rootPid, input.ownedGroup)) {
      if (!identities.has(entry.pid)) identities.set(entry.pid, entry);
    }
  };
  const replacementIn = (
    candidateTable: readonly ProcessTableEntry[],
  ): ProcessTableEntry | undefined =>
    candidateTable.find((entry) => {
      const expected = identities.get(entry.pid);
      return (
        expected !== undefined &&
        (expected.startToken !== entry.startToken ||
          expected.processGroupId !== entry.processGroupId)
      );
    });
  const aliveKnown = (candidateTable: readonly ProcessTableEntry[]): readonly ProcessTableEntry[] =>
    candidateTable.filter((entry) => {
      const expected = identities.get(entry.pid);
      return (
        expected?.startToken === entry.startToken &&
        expected.processGroupId === entry.processGroupId
      );
    });
  const signalAlive = async (
    entries: readonly ProcessTableEntry[],
    signal: NodeJS.Signals,
  ): Promise<string | undefined> => {
    for (const expected of entries) {
      let outcome: 'signaled' | 'absent' | 'replaced';
      try {
        outcome = await signalExpectedProofProcess({
          expected,
          signal,
          inspect: input.inspect,
          send: input.signalProcess,
        });
      } catch (error) {
        return `Process inspection failed before ${signal}: ${errorMessage(error)}`;
      }
      if (outcome === 'replaced') {
        return `Process identity changed before ${signal}; no signal was sent to pid ${expected.pid}.`;
      }
    }
    return undefined;
  };
  let table = observation.lastTable;
  const observedReplacement = replacementIn(table);
  if (inspectionError === undefined && observedReplacement !== undefined) {
    inspectionError = `Process identity changed before cleanup; no signal was sent to pid ${observedReplacement.pid}.`;
  }
  let alive = aliveKnown(table);
  const required = input.terminate || alive.some((entry) => entry.pid !== input.rootPid);
  if (required && inspectionError === undefined) {
    inspectionError = await signalAlive(alive, 'SIGSTOP');
    if (inspectionError === undefined) {
      try {
        table = await input.inspect();
        rememberRelated(table);
        alive = aliveKnown(table);
      } catch (error) {
        inspectionError ??= errorMessage(error);
      }
    }
    if (inspectionError === undefined) {
      inspectionError = await signalAlive(alive, 'SIGTERM');
    }
    if (inspectionError === undefined) {
      await delay(input.interruptGraceMs);
      inspectionError = await signalAlive(alive, 'SIGKILL');
    }
  }

  const deadline = Date.now() + input.cleanupWaitMs;
  let remaining = alive;
  while (Date.now() <= deadline) {
    try {
      table = await input.inspect();
      remaining = aliveKnown(table);
    } catch (error) {
      inspectionError ??= errorMessage(error);
      break;
    }
    if (remaining.length === 0) break;
    await delay(25);
  }

  return {
    required,
    confirmed: inspectionError === undefined && remaining.length === 0,
    observed_pids: [...identities.keys()].sort((left, right) => left - right),
    remaining_pids: remaining.map((entry) => entry.pid).sort((left, right) => left - right),
    ...(inspectionError === undefined ? {} : { inspection_error: inspectionError }),
  };
}

function safePath(pathEntries: readonly string[]): string {
  if (pathEntries.length === 0) {
    throw new ProofSandboxError('invalid_sandbox_path', 'At least one PATH entry is required.');
  }
  for (const entry of pathEntries) {
    if (!isAbsolute(entry) || entry.includes('\0') || entry.includes(delimiter)) {
      throw new ProofSandboxError('invalid_sandbox_path', 'Proof PATH entries must be absolute.');
    }
  }
  return pathEntries.join(delimiter);
}

function boundedEnvironment(input: {
  readonly command: Readonly<Record<string, string>>;
  readonly privateDirectory: string;
  readonly path: string;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  const temp = join(input.privateDirectory, 'tmp');
  const cache = join(input.privateDirectory, 'cache');
  return {
    PATH: input.path,
    HOME: join(input.privateDirectory, 'home'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, 'npm'),
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
    ...input.command,
    ...input.gitEnvironment,
  };
}

async function preparePrivateDirectory(privateRoot: string): Promise<string> {
  const directory = await mkdtemp(join(privateRoot, 'circuit-proof-'));
  await Promise.all(
    ['home', 'tmp', 'cache', 'cache/npm'].map((child) =>
      mkdir(join(directory, child), { recursive: true, mode: 0o700 }),
    ),
  );
  return directory;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  remainingBytes: number,
): { readonly added: number; readonly capped: boolean } {
  if (remainingBytes <= 0) return { added: 0, capped: chunk.length > 0 };
  const added = Math.min(chunk.length, remainingBytes);
  if (added > 0) chunks.push(chunk.subarray(0, added));
  return { added, capped: chunk.length > added };
}

async function validateReadRoots(readRoots: readonly string[]): Promise<readonly string[]> {
  const unique = [...new Set(readRoots)];
  if (unique.length === 0 || unique.length > 32) {
    throw new ProofSandboxError('invalid_sandbox_path', 'Sandbox read roots are invalid.');
  }
  return Object.freeze(
    await Promise.all(unique.map((root) => canonicalDirectory(root, 'Sandbox read root'))),
  );
}

async function validateReadFiles(readFiles: readonly string[]): Promise<readonly string[]> {
  const unique = [...new Set(readFiles)];
  if (unique.length === 0 || unique.length > 16) {
    throw new ProofSandboxError('invalid_sandbox_path', 'Sandbox read files are invalid.');
  }
  return Object.freeze(
    await Promise.all(
      unique.map(async (candidate) => {
        if (!isAbsolute(candidate)) {
          throw new ProofSandboxError(
            'invalid_sandbox_path',
            'Sandbox read file must be absolute.',
          );
        }
        const canonical = await realpath(candidate).catch((error: unknown) => {
          throw new ProofSandboxError(
            'invalid_sandbox_path',
            `Sandbox read file could not be inspected: ${errorMessage(error)}`,
          );
        });
        if (canonical !== resolve(candidate)) {
          throw new ProofSandboxError(
            'invalid_sandbox_path',
            'Sandbox read file must already be canonical.',
          );
        }
        const metadata = await stat(canonical);
        if (!metadata.isFile()) {
          throw new ProofSandboxError(
            'invalid_sandbox_path',
            'Sandbox read file must be a regular file.',
          );
        }
        return canonical;
      }),
    ),
  );
}

function validateGitEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const expected: Readonly<Record<string, string>> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  if (JSON.stringify(environment) !== JSON.stringify(expected)) {
    throw new ProofSandboxError('invalid_git_read', 'Safe Git environment is incomplete.');
  }
  return expected;
}

async function validateSandboxExecutable(candidate: string): Promise<string> {
  if (candidate !== '/usr/bin/sandbox-exec') {
    throw new ProofSandboxError(
      'sandbox_unavailable',
      'Circuit only trusts the macOS system Seatbelt launcher.',
    );
  }
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== 0) {
    throw new ProofSandboxError(
      'sandbox_unavailable',
      'The macOS system Seatbelt launcher is unavailable or changed.',
    );
  }
  return candidate;
}

export function createMacosProofSandbox(options: MacosProofSandboxOptions): MacosProofSandbox {
  if (options.testOnlyLaunch !== undefined && options.allowUnsafeTestLaunch !== true) {
    throw new ProofSandboxError(
      'unsafe_test_launcher',
      'A test-only launcher requires the explicit unsafe test opt-in.',
    );
  }
  const platform = options.platform ?? process.platform;
  const path = safePath(options.pathEntries);
  const inspect = options.inspectProcesses ?? defaultInspectProcesses;
  const signalProcess = options.signalProcess ?? sendSignal;
  const interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  const cleanupWaitMs = options.cleanupWaitMs ?? DEFAULT_CLEANUP_WAIT_MS;

  const executeInternal = async (input: {
    readonly command: ProofSandboxCommand;
    readonly access: 'workspace-write' | 'git-read-only';
    readonly readRoots?: readonly string[];
    readonly gitEnvironment?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<ProofSandboxResult> => {
    if (platform !== 'darwin') throw new UnsupportedProofPlatformError(platform);
    const command = parseProofCommand(input.command);
    const workspace = await canonicalDirectory(options.workspace, 'Trusted workspace');
    const privateRoot = await validatePrivateRoot(workspace, options.privateRoot);
    const cwd = await resolveProofCwd(workspace, command.cwd);
    const executable = await resolveExecutable(command.argv[0] ?? '');
    const argv = Object.freeze([executable, ...command.argv.slice(1)]);
    const executableAccess = await selectedExecutableRuntimeAccess(executable);
    const readRoots = await validateReadRoots([
      ...(input.access === 'git-read-only' ? (input.readRoots ?? []) : [workspace]),
      ...executableAccess.readRoots,
    ]);
    const readFiles = await validateReadFiles(executableAccess.readFiles);
    const gitEnvironment =
      input.access === 'git-read-only'
        ? validateGitEnvironment(input.gitEnvironment ?? {})
        : undefined;

    if (input.signal?.aborted === true) {
      return {
        schema_version: 1,
        status: 'cancelled',
        exit_code: null,
        signal: null,
        stdout: '',
        stderr: 'Proof command was cancelled before launch.',
        truncated: false,
        duration_ms: 0,
        cleanup: { required: false, confirmed: true, observed_pids: [], remaining_pids: [] },
        sandbox: {
          provider: 'not-launched',
          network: 'not_started',
          access: input.access,
          writable_roots: [],
          mach_services: [],
        },
      };
    }

    const privateDirectory = await preparePrivateDirectory(privateRoot);
    const writableRoots =
      input.access === 'workspace-write'
        ? Object.freeze([workspace, privateDirectory])
        : Object.freeze([privateDirectory]);
    const environment = boundedEnvironment({
      command: command.env,
      privateDirectory,
      path,
      ...(gitEnvironment === undefined ? {} : { gitEnvironment }),
    });
    let launch: ProofSandboxLaunch;
    try {
      if (options.testOnlyLaunch !== undefined) {
        launch = options.testOnlyLaunch({ cwd, argv, env: environment, access: input.access });
      } else {
        const sandboxExecutable = await validateSandboxExecutable(
          options.sandboxExecutable ?? '/usr/bin/sandbox-exec',
        );
        launch = {
          executable: sandboxExecutable,
          args: [
            '-p',
            buildMacosSeatbeltProfile({
              workspace,
              privateDirectory,
              access: input.access,
              readRoots,
              readFiles,
            }),
            ...argv,
          ],
          provider: 'macos-seatbelt',
          network: 'denied',
        };
      }
    } catch (error) {
      await rm(privateDirectory, { recursive: true, force: true });
      throw error;
    }

    const startedAt = performance.now();
    let ownedGroup: OwnedProcessGroup | undefined;
    if (options.ownerProcessGroupId !== undefined) {
      const ownerProcessGroupId = options.ownerProcessGroupId;
      if (!Number.isSafeInteger(ownerProcessGroupId) || ownerProcessGroupId <= 0) {
        await rm(privateDirectory, { recursive: true, force: true });
        throw new ProofSandboxError(
          'invalid_sandbox_process_group',
          'The proof owner process group is invalid.',
        );
      }
      const before = await inspect().catch(async (error: unknown) => {
        await rm(privateDirectory, { recursive: true, force: true });
        throw new ProofSandboxError(
          'sandbox_process_inspection_failed',
          `Circuit could not inspect the proof owner process group: ${errorMessage(error)}`,
        );
      });
      const owner = before.find((entry) => entry.pid === process.pid);
      if (owner?.processGroupId !== ownerProcessGroupId) {
        await rm(privateDirectory, { recursive: true, force: true });
        throw new ProofSandboxError(
          'invalid_sandbox_process_group',
          'The proof owner is not the recorded worker process-group leader.',
        );
      }
      ownedGroup = {
        id: ownerProcessGroupId,
        baseline: new Map(
          before
            .filter((entry) => entry.processGroupId === ownerProcessGroupId)
            .map((entry) => [entry.pid, entry.startToken]),
        ),
      };
    }
    const child = spawn(launch.executable, launch.args, {
      cwd,
      env: environment,
      // The worker already has a private, supervisor-owned process group.
      // Keeping proof and Git commands inside it means run cancellation and
      // recovery can observe and clean the whole tree even if the worker dies.
      detached: false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rootPid = child.pid;
    if (rootPid === undefined) {
      await rm(privateDirectory, { recursive: true, force: true });
      throw new ProofSandboxError('proof_launch_failed', 'Proof command started without a pid.');
    }
    const observer = observeProcesses(rootPid, inspect, ownedGroup);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let stopReason: 'timed_out' | 'cancelled' | 'output_limit' | undefined;
    let requestStop: ((reason: 'timed_out' | 'cancelled' | 'output_limit') => void) | undefined;
    const stop = new Promise<'timed_out' | 'cancelled' | 'output_limit'>((resolvePromise) => {
      requestStop = (reason) => {
        if (stopReason !== undefined) return;
        stopReason = reason;
        resolvePromise(reason);
      };
    });
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const appended = appendBounded(target, chunk, command.max_output_bytes - capturedBytes);
      capturedBytes += appended.added;
      if (appended.capped) {
        truncated = true;
        requestStop?.('output_limit');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderrChunks, chunk));

    const completion = new Promise<{
      readonly kind: 'close' | 'error';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly error?: Error;
    }>((resolvePromise) => {
      child.once('error', (error) =>
        resolvePromise({ kind: 'error', code: null, signal: null, error }),
      );
      child.once('close', (code, signal) => resolvePromise({ kind: 'close', code, signal }));
    });
    const timeout = setTimeout(() => requestStop?.('timed_out'), command.timeout_ms);
    const abort = (): void => requestStop?.('cancelled');
    input.signal?.addEventListener('abort', abort, { once: true });

    const first = await Promise.race([
      completion.then((result) => ({ type: 'completion' as const, result })),
      stop.then((reason) => ({ type: 'stop' as const, reason })),
    ]);
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
    const cleanup = await cleanupProcesses({
      rootPid,
      observer,
      inspect,
      terminate: first.type === 'stop',
      interruptGraceMs,
      cleanupWaitMs,
      ...(ownedGroup === undefined ? {} : { ownedGroup }),
      signalProcess,
    });
    const completionResult =
      first.type === 'completion'
        ? first.result
        : await Promise.race([
            completion,
            delay(250).then(() => ({
              kind: 'error' as const,
              code: null,
              signal: null,
              error: new Error('Proof process did not report exit after cleanup.'),
            })),
          ]);
    await rm(privateDirectory, { recursive: true, force: true });

    let status: ProofSandboxStatus;
    if (!cleanup.confirmed) status = 'cleanup_unconfirmed';
    else if (first.type === 'stop') status = first.reason;
    else if (cleanup.required) status = 'failed';
    else if (completionResult.kind === 'error' || completionResult.code !== 0) status = 'failed';
    else status = 'passed';

    let stderr = Buffer.concat(stderrChunks).toString('utf8');
    if (status === 'failed' && first.type === 'completion' && cleanup.required) {
      stderr += `${stderr.length === 0 ? '' : '\n'}Proof command left a background process; cleanup was required.`;
    }
    if (completionResult.kind === 'error' && completionResult.error !== undefined) {
      stderr += `${stderr.length === 0 ? '' : '\n'}${completionResult.error.message}`;
    }

    return {
      schema_version: 1,
      status,
      exit_code: completionResult.code,
      signal: completionResult.signal,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr,
      truncated,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      cleanup,
      sandbox: {
        provider: launch.provider,
        network: launch.network,
        access: input.access,
        writable_roots: writableRoots,
        mach_services: [],
      },
    };
  };

  return Object.freeze({
    run: async (request: unknown) =>
      await executeInternal({ command: parseProofCommand(request), access: 'workspace-write' }),
    execute: async (
      request: ProofSandboxCommand,
      executionOptions: { readonly signal?: AbortSignal } = {},
    ) =>
      await executeInternal({
        command: request,
        access: 'workspace-write',
        ...(executionOptions.signal === undefined ? {} : { signal: executionOptions.signal }),
      }),
    executeGitRead: async (
      request: GitReadSandboxRequest,
      executionOptions: { readonly signal?: AbortSignal } = {},
    ) =>
      await executeInternal({
        command: {
          id: request.id,
          cwd: request.cwd,
          argv: request.argv,
          env: request.env,
          timeout_ms: request.timeout_ms,
          max_output_bytes: request.max_output_bytes,
        },
        access: 'git-read-only',
        readRoots: request.readRoots,
        gitEnvironment: request.git_environment,
        ...(executionOptions.signal === undefined ? {} : { signal: executionOptions.signal }),
      }),
  });
}

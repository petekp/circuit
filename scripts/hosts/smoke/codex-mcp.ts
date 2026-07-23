#!/usr/bin/env node

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { REQUIRED_NODE } from '../../../bin/node-version-guard.js';
import { MINIMUM_CODEX_VERSION } from '../../../src/hosts/codex-mcp/capabilities.ts';
import { MCP_TOOL_NAMES } from '../../../src/hosts/codex-mcp/contracts.ts';
import { resolveCodexExecutableOnPath } from '../../../src/hosts/codex-mcp/production-paths.ts';
import { CODEX_MCP_NODE_REMEDY } from '../../plugins/codex-mcp-launcher.ts';
import { packageGitTreeSha256, packageTreeSha256 } from '../../plugins/package-tree.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/codex');
const PRIVATE_TEST_ROOT = resolve(REPO_ROOT, '.mcp-host-tests');
const TIMEOUT_MS = 60_000;
const HOST_NATURAL_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MARKETPLACE = 'circuit-fresh-host-probe';
const PUBLIC_MARKETPLACE = 'circuit';
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_MARKETPLACE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;
const MINIMUM_NODE_VERSION = `${REQUIRED_NODE.major}.${REQUIRED_NODE.minor}.0`;
export const SENTINEL_RUN_ID = '019f64f5-1f4d-7d91-8cda-a309cc72c301';
const DIAGNOSTIC_SENTINELS = [
  ['scratch-root', '019f64f5-1f4d-7d91-8cda-a309cc72c310'],
  ['isolated-home', '019f64f5-1f4d-7d91-8cda-a309cc72c311'],
  ['isolated-codex-home', '019f64f5-1f4d-7d91-8cda-a309cc72c312'],
  ['marketplace-root', '019f64f5-1f4d-7d91-8cda-a309cc72c313'],
  ['marketplace-plugin-source', '019f64f5-1f4d-7d91-8cda-a309cc72c314'],
] as const;

type SmokeStatus = 'pass' | 'fail' | 'skip';
export type SmokeMode = 'packed' | 'published' | 'upgrade';
export type SmokeFailureClass =
  | 'configuration'
  | 'dependency'
  | 'network'
  | 'timeout'
  | 'host'
  | 'product'
  | 'cleanup';

export interface SmokeOptions {
  readonly help: boolean;
  readonly live: boolean;
  readonly mode: SmokeMode;
  readonly marketplace: string;
  readonly source?: string;
  readonly ref?: string;
  readonly expectedVersion?: string;
  readonly oldRef?: string;
  readonly oldVersion?: string;
  readonly output?: string;
}

export interface MarketplaceInstallStep {
  readonly id: string;
  readonly args: readonly string[];
}

export interface MarketplaceInstallPhases {
  readonly beforeOldHost: readonly MarketplaceInstallStep[];
  readonly afterOldHost: readonly MarketplaceInstallStep[];
}

export interface Evidence {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SmokeOutcome {
  readonly schema_version: 1;
  readonly host: 'codex';
  readonly surface: 'mcp';
  readonly mode: SmokeMode;
  readonly status: SmokeStatus;
  readonly reason: string;
  readonly failure?: {
    readonly class: SmokeFailureClass;
    readonly code: string;
    readonly retryable: boolean;
    readonly next_action?: string;
  };
  readonly source?: {
    readonly repository: string;
    readonly ref: string;
    readonly expected_version: string;
    readonly old_ref?: string;
    readonly old_version?: string;
  };
  readonly versions: {
    readonly codex?: string;
    readonly node?: string;
    readonly plugin?: string;
    readonly previous_plugin?: string;
    readonly plugin_tree_sha256?: string;
  };
  readonly evidence: readonly Evidence[];
}

export function isRetryablePublishedSmokeOutcome(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (report.schema_version !== 1 || report.mode !== 'published' || report.status !== 'fail') {
    return false;
  }
  if (
    typeof report.failure !== 'object' ||
    report.failure === null ||
    Array.isArray(report.failure)
  ) {
    return false;
  }
  const failure = report.failure as Record<string, unknown>;
  return failure.class === 'network' && failure.retryable === true;
}

function classifySmokeFailureMessage(message: string): NonNullable<SmokeOutcome['failure']> {
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|Could not resolve host|network is unreachable|temporary failure in name resolution|connection reset by peer/i.test(
      message,
    )
  ) {
    return { class: 'network', code: 'network_unavailable', retryable: true };
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) {
    return { class: 'timeout', code: 'probe_timeout', retryable: false };
  }
  if (
    /Circuit MCP requires Node\.js 22\.18 or newer\. Current Node\.js is [0-9.]+\./i.test(message)
  ) {
    return {
      class: 'dependency',
      code: 'node_too_old',
      retryable: false,
      next_action: CODEX_MCP_NODE_REMEDY,
    };
  }
  if (
    /Circuit MCP (?:requires Node\.js 22\.18 or newer|could not read the Node\.js version)|spawn\s+node\s+ENOENT|node(?:\.exe)?: command not found|executable node.*not found/i.test(
      message,
    )
  ) {
    return {
      class: 'dependency',
      code: 'node_missing',
      retryable: false,
      next_action: CODEX_MCP_NODE_REMEDY,
    };
  }
  if (/ENOENT|could not find an executable/i.test(message)) {
    return {
      class: 'dependency',
      code: 'host_dependency_missing',
      retryable: false,
      next_action: 'Install the missing host dependency, ensure it is on PATH, then retry.',
    };
  }
  if (/cleanup/i.test(message)) {
    return { class: 'cleanup', code: 'cleanup_uncertain', retryable: false };
  }
  return { class: 'product', code: 'probe_failed', retryable: false };
}

class SmokeProbeError extends Error {
  readonly failure: NonNullable<SmokeOutcome['failure']>;

  constructor(
    message: string,
    failure: NonNullable<SmokeOutcome['failure']> = classifySmokeFailureMessage(message),
  ) {
    super(message);
    this.name = 'SmokeProbeError';
    this.failure = failure;
  }
}

export interface SmokeCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  /** True only when the process group was already gone without help from the harness. */
  readonly cleanup_confirmed: boolean;
  readonly cleanup_intervention_required: boolean;
  readonly cleanup_after_intervention_confirmed: boolean;
}

export interface SmokeCommandTiming {
  readonly timeout_ms?: number;
  readonly force_kill_delay_ms?: number;
  readonly settlement_timeout_ms?: number;
  readonly natural_cleanup_timeout_ms?: number;
}

function processGroupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForProcessGroupAbsence(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (processGroupAbsent(pid)) return true;
    const remaining = deadline - Date.now();
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(25, remaining)));
  }
  return processGroupAbsent(pid);
}

async function terminateProcessGroup(pid: number): Promise<boolean> {
  if (processGroupAbsent(pid)) return true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return processGroupAbsent(pid);
  }
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
  if (processGroupAbsent(pid)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    if (processGroupAbsent(pid)) return true;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    if (processGroupAbsent(pid)) return true;
  }
  return false;
}

interface ProbeServer {
  readonly port: number;
  readonly requests: () => number;
  readonly discoveredTools: () => readonly string[];
  readonly protocolError: () => string | undefined;
  readonly close: () => Promise<void>;
}

function outcome(
  mode: SmokeMode,
  status: SmokeStatus,
  reason: string,
  evidence: readonly Evidence[],
  input: Pick<SmokeOutcome, 'failure' | 'source' | 'versions'> = { versions: {} },
): SmokeOutcome {
  return {
    schema_version: 1,
    host: 'codex',
    surface: 'mcp',
    mode,
    status,
    reason,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.source === undefined ? {} : { source: input.source }),
    versions: input.versions,
    evidence,
  };
}

function remoteSource(source: string): boolean {
  if (source.trim() !== source || source.length === 0 || source.includes('\0')) return false;
  if (
    source === '.' ||
    source === '..' ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('/') ||
    source.startsWith('file:') ||
    source.startsWith('~')
  ) {
    return false;
  }
  try {
    const url = new URL(source);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ssh:') {
      return (
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    }
  } catch {
    // owner/repository and Git SCP-style sources are not URL objects.
  }
  return /^(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+)$/.test(source);
}

function validateRef(ref: string | undefined, label: string): asserts ref is string {
  if (ref === undefined || !SAFE_REF.test(ref) || ref.includes('..')) {
    throw new SmokeProbeError(`${label} must be a bounded immutable Git ref.`, {
      class: 'configuration',
      code: 'invalid_ref',
      retryable: false,
    });
  }
}

function validateVersion(version: string | undefined, label: string): asserts version is string {
  if (version === undefined || !SEMVER_PATTERN.test(version)) {
    throw new SmokeProbeError(`${label} must be a semantic version.`, {
      class: 'configuration',
      code: 'invalid_version',
      retryable: false,
    });
  }
}

export function parseSmokeOptions(argv: readonly string[]): SmokeOptions {
  const program = new Command('codex-mcp-host-smoke')
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('-h, --help')
    .option('--live')
    .option('--mode <mode>', 'packed, published, or upgrade', 'packed')
    .option('--source <repository>')
    .option('--ref <ref>')
    .option('--expected-version <version>')
    .option('--old-ref <ref>')
    .option('--old-version <version>')
    .option('--marketplace <name>')
    .option('--output <path>');
  try {
    program.parse([...argv], { from: 'user' });
  } catch (error) {
    throw new SmokeProbeError(error instanceof Error ? error.message : String(error), {
      class: 'configuration',
      code: 'invalid_arguments',
      retryable: false,
    });
  }
  const raw = program.opts<{
    help?: boolean;
    live?: boolean;
    mode?: string;
    source?: string;
    ref?: string;
    expectedVersion?: string;
    oldRef?: string;
    oldVersion?: string;
    marketplace?: string;
    output?: string;
  }>();
  if (raw.mode !== 'packed' && raw.mode !== 'published' && raw.mode !== 'upgrade') {
    throw new SmokeProbeError('--mode must be packed, published, or upgrade.', {
      class: 'configuration',
      code: 'invalid_mode',
      retryable: false,
    });
  }
  const marketplace = raw.marketplace ?? (raw.mode === 'packed' ? MARKETPLACE : PUBLIC_MARKETPLACE);
  if (!SAFE_MARKETPLACE_NAME.test(marketplace)) {
    throw new SmokeProbeError('--marketplace must be a safe marketplace name.', {
      class: 'configuration',
      code: 'invalid_marketplace',
      retryable: false,
    });
  }
  const common = {
    help: raw.help === true,
    live: raw.live === true,
    mode: raw.mode,
    marketplace,
    ...(raw.source === undefined ? {} : { source: raw.source }),
    ...(raw.ref === undefined ? {} : { ref: raw.ref }),
    ...(raw.expectedVersion === undefined ? {} : { expectedVersion: raw.expectedVersion }),
    ...(raw.oldRef === undefined ? {} : { oldRef: raw.oldRef }),
    ...(raw.oldVersion === undefined ? {} : { oldVersion: raw.oldVersion }),
    ...(raw.output === undefined ? {} : { output: resolve(raw.output) }),
  } satisfies SmokeOptions;

  if (raw.mode === 'packed') {
    if (
      raw.source !== undefined ||
      raw.ref !== undefined ||
      raw.oldRef !== undefined ||
      raw.oldVersion !== undefined
    ) {
      throw new SmokeProbeError(
        'packed mode does not accept --source, --ref, --old-ref, or --old-version.',
        { class: 'configuration', code: 'invalid_arguments', retryable: false },
      );
    }
    if (raw.expectedVersion !== undefined)
      validateVersion(raw.expectedVersion, '--expected-version');
    return common;
  }

  if (raw.source === undefined || raw.ref === undefined || raw.expectedVersion === undefined) {
    throw new SmokeProbeError(
      `${raw.mode} mode requires --source, --ref, and --expected-version.`,
      { class: 'configuration', code: 'missing_arguments', retryable: false },
    );
  }
  if (!remoteSource(raw.source)) {
    throw new SmokeProbeError('--source must name a remote repository without credentials.', {
      class: 'configuration',
      code: 'invalid_source',
      retryable: false,
    });
  }
  validateRef(raw.ref, '--ref');
  validateVersion(raw.expectedVersion, '--expected-version');

  if (raw.mode === 'published') {
    if (raw.oldRef !== undefined || raw.oldVersion !== undefined) {
      throw new SmokeProbeError('published mode does not accept old-version options.', {
        class: 'configuration',
        code: 'invalid_arguments',
        retryable: false,
      });
    }
    return common;
  }

  if (raw.oldRef === undefined || raw.oldVersion === undefined) {
    throw new SmokeProbeError('upgrade mode requires --old-ref and --old-version.', {
      class: 'configuration',
      code: 'missing_arguments',
      retryable: false,
    });
  }
  validateRef(raw.oldRef, '--old-ref');
  validateVersion(raw.oldVersion, '--old-version');
  if (raw.oldRef === raw.ref || raw.oldVersion === raw.expectedVersion) {
    throw new SmokeProbeError('upgrade mode requires distinct old and new refs and versions.', {
      class: 'configuration',
      code: 'invalid_upgrade',
      retryable: false,
    });
  }
  return common;
}

export function buildMarketplaceInstallPhases(
  options: SmokeOptions,
  packedMarketplaceRoot = '<packed-marketplace>',
): MarketplaceInstallPhases {
  const install = (id: string): MarketplaceInstallStep => ({
    id,
    args: ['plugin', 'add', `circuit@${options.marketplace}`, '--json'],
  });
  if (options.mode === 'packed') {
    return {
      beforeOldHost: [],
      afterOldHost: [
        {
          id: 'marketplace_add_packed',
          args: ['plugin', 'marketplace', 'add', packedMarketplaceRoot, '--json'],
        },
        install('plugin_install_packed'),
      ],
    };
  }
  const source = options.source as string;
  const ref = options.ref as string;
  if (options.mode === 'published') {
    return {
      beforeOldHost: [],
      afterOldHost: [
        {
          id: 'marketplace_add_published',
          args: ['plugin', 'marketplace', 'add', source, '--ref', ref, '--json'],
        },
        install('plugin_install_published'),
      ],
    };
  }
  return {
    beforeOldHost: [
      {
        id: 'marketplace_add_upgrade_old',
        args: ['plugin', 'marketplace', 'add', source, '--ref', options.oldRef as string, '--json'],
      },
      install('plugin_install_upgrade_old'),
    ],
    afterOldHost: [
      {
        id: 'marketplace_remove_upgrade_old',
        args: ['plugin', 'marketplace', 'remove', options.marketplace, '--json'],
      },
      {
        id: 'marketplace_add_upgrade_new',
        args: ['plugin', 'marketplace', 'add', source, '--ref', ref, '--json'],
      },
      install('plugin_install_upgrade_new'),
    ],
  };
}

export function buildMarketplaceInstallPlan(
  options: SmokeOptions,
  packedMarketplaceRoot = '<packed-marketplace>',
): readonly MarketplaceInstallStep[] {
  const phases = buildMarketplaceInstallPhases(options, packedMarketplaceRoot);
  return [...phases.beforeOldHost, ...phases.afterOldHost];
}

export function classifySmokeFailure(error: unknown): NonNullable<SmokeOutcome['failure']> {
  if (error instanceof SmokeProbeError) return error.failure;
  const message = error instanceof Error ? error.message : String(error);
  return classifySmokeFailureMessage(message);
}

function redactText(value: string, paths: readonly string[]): string {
  let redacted = value;
  for (const path of [...paths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(path, '<redacted-path>');
    try {
      redacted = redacted.replaceAll(realpathSync.native(path), '<redacted-path>');
    } catch {
      // A path may be a removed scratch directory. Its textual form is still redacted.
    }
  }
  return redacted.replace(/(https?:\/\/)[^\s/@]+@/giu, '$1<redacted>@');
}

function redactSmokeOutcome(value: SmokeOutcome, paths: readonly string[]): SmokeOutcome {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? redactText(item, paths) : item,
    ),
  ) as SmokeOutcome;
}

export function writeSmokeOutput(
  path: string,
  value: SmokeOutcome,
  redactedPaths: readonly string[] = [],
): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const redacted = redactSmokeOutcome(value, redactedPaths);
  try {
    writeFileSync(temporary, `${JSON.stringify(redacted, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function runSync(
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    ...(environment === undefined ? {} : { env: environment }),
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(0, 2_000);
    throw new Error(detail.length === 0 ? `${command} ${args[0] ?? ''} failed` : detail);
  }
  return result.stdout;
}

export async function runDetachedSmokeCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timing: SmokeCommandTiming = {},
): Promise<SmokeCommandResult> {
  return await new Promise<SmokeCommandResult>((resolveRun, rejectRun) => {
    let child: ChildProcess | undefined;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let exitStatus: number | null = null;
    const append = (current: string, chunk: Buffer | string): string => {
      if (Buffer.byteLength(current, 'utf8') >= MAX_OUTPUT_BYTES) return current;
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8');
      return current + Buffer.from(chunk).subarray(0, remaining).toString('utf8');
    };
    try {
      child = spawn(command, [...args], {
        env: environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectRun(error);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    let forceTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    };
    const settle = async (status: number | null, closeObserved: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimers();
      const pid = child?.pid;

      if (!closeObserved) {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        if (pid !== undefined) await terminateProcessGroup(pid);
        resolveRun({
          status,
          stdout,
          stderr,
          timed_out: timedOut,
          cleanup_confirmed: false,
          cleanup_intervention_required: true,
          cleanup_after_intervention_confirmed: false,
        });
        return;
      }

      const cleanupConfirmed =
        pid === undefined
          ? true
          : await waitForProcessGroupAbsence(pid, timing.natural_cleanup_timeout_ms);
      const cleanupAfterInterventionConfirmed = cleanupConfirmed
        ? true
        : await terminateProcessGroup(pid as number);
      resolveRun({
        status,
        stdout,
        stderr,
        timed_out: timedOut,
        cleanup_confirmed: cleanupConfirmed,
        cleanup_intervention_required: !cleanupConfirmed,
        cleanup_after_intervention_confirmed: cleanupAfterInterventionConfirmed,
      });
    };
    const armSettlementWatchdog = (): void => {
      if (settlementTimer !== undefined || settled) return;
      settlementTimer = setTimeout(() => {
        void settle(exitStatus, false);
      }, timing.settlement_timeout_ms ?? 1_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        forceTimer = setTimeout(() => {
          if (child?.pid === undefined) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          armSettlementWatchdog();
        }, timing.force_kill_delay_ms ?? 1_000);
      }
    }, timing.timeout_ms ?? TIMEOUT_MS);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectRun(error);
    });
    child.once('exit', (status) => {
      exitStatus = status;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      armSettlementWatchdog();
    });
    child.once('close', (status) => {
      void settle(status, true);
    });
  });
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function completedResponse(id: string, output: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: output },
    {
      type: 'response.completed',
      response: {
        id,
        output: [output],
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

async function startProbeServer(mode: 'mcp' | 'old-host' = 'mcp'): Promise<ProbeServer> {
  let requestCount = 0;
  let discoveredTools: readonly string[] = [];
  let protocolError: string | undefined;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_OUTPUT_BYTES) request.destroy();
    });
    request.on('end', () => {
      if ((request.url ?? '').startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      if (!(request.url ?? '').startsWith('/v1/responses')) {
        response.writeHead(404).end();
        return;
      }
      requestCount += 1;
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(body || '{}') as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('request is not an object');
        }
        payload = parsed as Record<string, unknown>;
      } catch (error) {
        protocolError = `request ${requestCount} was not valid JSON: ${String(error)}`;
        response.writeHead(400).end();
        return;
      }

      let events: readonly Record<string, unknown>[];
      if (mode === 'old-host' && requestCount === 1) {
        const item = {
          type: 'message',
          role: 'assistant',
          id: 'msg_old_host_ready',
          content: [{ type: 'output_text', text: 'OLD_CODEX_HOST_READY' }],
        };
        events = completedResponse('resp_old_host', item);
      } else if (mode === 'old-host') {
        protocolError = 'The old Codex host sent an unexpected second provider request.';
        response.writeHead(500).end();
        return;
      } else if (requestCount === 1) {
        const item = {
          type: 'tool_search_call',
          id: 'ts_tool_search',
          call_id: 'call_tool_search',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'Circuit circuit_list recent runs', limit: 8 },
        };
        events = completedResponse('resp_probe_1', item);
      } else if (requestCount === 2) {
        const searchOutput = records(payload.input).find(
          (item) => item.type === 'tool_search_output' && item.call_id === 'call_tool_search',
        );
        const namespace = records(searchOutput?.tools).find(
          (item) => item.type === 'namespace' && item.name === 'mcp__circuit',
        );
        discoveredTools = records(namespace?.tools)
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === 'string')
          .sort();
        if (JSON.stringify(discoveredTools) !== JSON.stringify([...MCP_TOOL_NAMES].sort())) {
          protocolError = `tool_search returned unexpected Circuit tools: ${discoveredTools.join(', ')}`;
          response.writeHead(500).end();
          return;
        }
        const item = {
          type: 'function_call',
          id: 'fc_circuit_list',
          call_id: 'call_circuit_list',
          namespace: 'mcp__circuit',
          name: 'circuit_list',
          arguments: '{}',
        };
        events = completedResponse('resp_probe_2', item);
      } else if (requestCount === 3) {
        const functionOutput = records(payload.input).find(
          (item) => item.type === 'function_call_output' && item.call_id === 'call_circuit_list',
        );
        if (functionOutput === undefined) {
          protocolError = 'Codex did not return the circuit_list function output to the provider.';
          response.writeHead(500).end();
          return;
        }
        const item = {
          type: 'message',
          role: 'assistant',
          id: 'msg_probe_complete',
          content: [{ type: 'output_text', text: 'NO_SPEND_PROBE_COMPLETE' }],
        };
        events = completedResponse('resp_probe_3', item);
      } else {
        protocolError = 'Codex sent an unexpected fourth provider request.';
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(events));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not bind the fresh-host loopback provider.');
  }
  return {
    port: address.port,
    requests: () => requestCount,
    discoveredTools: () => discoveredTools,
    protocolError: () => protocolError,
    close: async () => {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}

export function assertOldHostRoundSucceeded(
  run: SmokeCommandResult,
  providerRequests: number,
  protocolError: string | undefined,
): void {
  if (protocolError !== undefined) throw new SmokeProbeError(protocolError);
  if (run.timed_out) {
    throw new SmokeProbeError('The old Codex host probe timed out.', {
      class: 'timeout',
      code: 'probe_timeout',
      retryable: false,
    });
  }
  if (!run.cleanup_confirmed) {
    throw new SmokeProbeError('Old Codex host cleanup could not be confirmed.', {
      class: 'cleanup',
      code: 'cleanup_uncertain',
      retryable: false,
    });
  }
  if (run.status !== 0) {
    throw new SmokeProbeError(
      run.stderr.trim().slice(0, 2_000) || 'The old Codex host probe failed.',
    );
  }
  if (providerRequests !== 1) {
    throw new SmokeProbeError('The old Codex host did not reach the loopback provider.');
  }
  if (!run.stdout.includes('OLD_CODEX_HOST_READY')) {
    throw new SmokeProbeError('The old Codex host did not complete the loopback response.');
  }
}

function parseMcpResult(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== 'item.completed') continue;
    const item =
      typeof event.item === 'object' && event.item !== null && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : undefined;
    if (
      item?.type !== 'mcp_tool_call' ||
      item.server !== 'circuit' ||
      item.tool !== 'circuit_list'
    ) {
      continue;
    }
    const result =
      typeof item.result === 'object' && item.result !== null && !Array.isArray(item.result)
        ? (item.result as Record<string, unknown>)
        : undefined;
    const structured = result?.structured_content;
    if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
      return structured as Record<string, unknown>;
    }
  }
  return undefined;
}

function privateDirectory(path: string): boolean {
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700;
}

function privateFile(path: string): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600;
}

function pluginCacheDirectories(codexHome: string): readonly string[] {
  const pluginsRoot = join(codexHome, 'plugins');
  if (!existsSync(pluginsRoot)) return [];
  const directories: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 5) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(child);
      } catch {
        continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (existsSync(join(child, '.codex-plugin', 'plugin.json'))) directories.push(child);
      visit(child, depth + 1);
    }
  };
  visit(pluginsRoot, 0);
  return directories;
}

export function seedWorkspaceSentinel(
  codexHome: string,
  workspace: string,
  runId = SENTINEL_RUN_ID,
  summary = 'Fresh-host workspace identity sentinel.',
): void {
  const canonicalWorkspace = realpathSync.native(workspace);
  const workspaceInfo = statSync(canonicalWorkspace);
  const workspaceKey = createHash('sha256').update(canonicalWorkspace, 'utf8').digest('hex');
  const executablePath = realpathSync.native(process.execPath);
  const executableInfo = statSync(executablePath);
  const now = new Date().toISOString();
  const owner = {
    pid: process.pid,
    process_group_id: process.pid,
    started_at: now,
    birth_token: 'fresh-host-workspace-sentinel',
    executable: {
      real_path: executablePath,
      device: String(executableInfo.dev),
      inode: String(executableInfo.ino),
      sha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex'),
    },
    instance_id: 'fresh-host-workspace-sentinel',
  } as const;
  const stateRoot = join(codexHome, 'circuit', 'mcp', 'v1');
  const runsRoot = join(stateRoot, 'runs');
  const runDirectory = join(runsRoot, workspaceKey, runId);
  for (const directory of [stateRoot, runsRoot, join(stateRoot, 'leases'), runDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const record = {
    schema_version: 1,
    record_kind: 'circuit.mcp.run-state',
    revision: 2,
    run_id: runId,
    lease_id: '019f64f5-1f4d-7d91-8cda-a309cc72c303',
    workspace: {
      key: workspaceKey,
      canonical_path: canonicalWorkspace,
      device: String(workspaceInfo.dev),
      inode: String(workspaceInfo.ino),
    },
    request: {
      flow: 'review',
      goal: 'Verify the exact fresh-host workspace identity.',
      web_search: 'off',
    },
    state: 'interrupted',
    summary,
    runtime_assets_sha256: 'a'.repeat(64),
    run_relative_path: `.circuit/runs/${runId}`,
    created_at: now,
    updated_at: now,
    finished_at: now,
    allocation: { owner, created_at: now },
    launch: {
      generation: 1,
      phase: 'exited',
      allocation_owner: owner,
      exit: {
        observed_at: now,
        exit_code: 0,
        process_group_cleanup: 'confirmed',
      },
    },
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
  } as const;
  writeFileSync(join(runDirectory, 'state.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function marketplaceManifest(marketplaceName: string): string {
  return `${JSON.stringify(
    {
      name: marketplaceName,
      interface: { displayName: 'Circuit Fresh Host Probe' },
      plugins: [
        {
          name: 'circuit',
          source: { source: 'local', path: './plugins/circuit' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Coding',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function parseJsonObject(label: string, value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new SmokeProbeError(`${label} returned malformed JSON.`, {
      class: 'host',
      code: 'malformed_host_output',
      retryable: false,
    });
  }
}

function pluginManifestVersion(pluginRoot: string): string {
  const manifest = parseJsonObject(
    'Circuit plugin manifest',
    readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    throw new SmokeProbeError('Circuit plugin manifest has no valid version.', {
      class: 'product',
      code: 'invalid_plugin_version',
      retryable: false,
    });
  }
  return manifest.version;
}

function parseInstalledPlugin(
  label: string,
  value: string,
  expectedVersion: string,
): { readonly version: string; readonly installedPath: string } {
  const parsed = parseJsonObject(label, value);
  if (parsed.version !== expectedVersion) {
    throw new SmokeProbeError(
      `${label} installed Circuit ${String(parsed.version ?? '<missing>')}; expected ${expectedVersion}.`,
      { class: 'product', code: 'plugin_version_mismatch', retryable: false },
    );
  }
  if (typeof parsed.installedPath !== 'string' || !existsSync(parsed.installedPath)) {
    throw new SmokeProbeError(`${label} did not return an installed Circuit package path.`, {
      class: 'host',
      code: 'installed_path_missing',
      retryable: false,
    });
  }
  if (pluginManifestVersion(parsed.installedPath) !== expectedVersion) {
    throw new SmokeProbeError(`${label} package bytes do not match ${expectedVersion}.`, {
      class: 'product',
      code: 'plugin_version_mismatch',
      retryable: false,
    });
  }
  return { version: expectedVersion, installedPath: parsed.installedPath };
}

function assertPluginTreeDigest(
  expectedSha256: string,
  installedRoot: string,
  label: string,
): string {
  const installedSha256 = packageTreeSha256(installedRoot);
  if (installedSha256 !== expectedSha256) {
    throw new SmokeProbeError(`${label} tree does not match its verified source.`, {
      class: 'product',
      code: 'plugin_tree_mismatch',
      retryable: false,
    });
  }
  return installedSha256;
}

export function assertPluginTreeMatchesSource(
  sourceRoot: string,
  installedRoot: string,
  label: string,
): string {
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new SmokeProbeError(`${label} has no readable source package tree.`, {
      class: 'product',
      code: 'plugin_source_missing',
      retryable: false,
    });
  }
  return assertPluginTreeDigest(packageTreeSha256(sourceRoot), installedRoot, label);
}

function assertInstalledPluginPath(codexHome: string, installedPath: string): void {
  let canonicalCodexHome: string;
  let canonicalInstalledPath: string;
  try {
    canonicalCodexHome = realpathSync.native(codexHome);
    canonicalInstalledPath = realpathSync.native(installedPath);
  } catch {
    throw new SmokeProbeError('Codex returned an unreadable installed plugin path.', {
      class: 'host',
      code: 'installed_path_missing',
      retryable: false,
    });
  }
  if (!pathInside(canonicalCodexHome, canonicalInstalledPath)) {
    throw new SmokeProbeError('Codex installed Circuit outside the isolated profile.', {
      class: 'host',
      code: 'installed_path_escaped',
      retryable: false,
    });
  }
}

export function normalizeGitSource(source: string): string {
  let normalized = source.trim();
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(normalized)) {
    normalized = `github.com/${normalized}`;
  } else if (normalized.startsWith('git@')) {
    const separator = normalized.indexOf(':', 4);
    const host = normalized.slice(4, separator).toLowerCase();
    normalized = `${host}/${normalized.slice(separator + 1)}`;
  } else {
    try {
      const url = new URL(normalized);
      normalized = `${url.host.toLowerCase()}${url.pathname}`;
    } catch {
      // Leave non-URL Git sources in their bounded CLI form.
    }
  }
  return normalized.replace(/\/+$/u, '').replace(/\.git$/u, '');
}

function parseVersionTuple(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) return undefined;
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return tuple.every(Number.isSafeInteger) ? tuple : undefined;
}

function versionAtLeast(version: string, minimum: string): boolean {
  const actual = parseVersionTuple(version);
  const floor = parseVersionTuple(minimum);
  if (actual === undefined || floor === undefined) return false;
  for (let index = 0; index < actual.length; index += 1) {
    const actualPart = actual[index] as number;
    const floorPart = floor[index] as number;
    if (actualPart !== floorPart) return actualPart > floorPart;
  }
  return true;
}

export function assertSupportedSmokeVersions(nodeVersion: string, codexVersion: string): void {
  if (!versionAtLeast(nodeVersion, MINIMUM_NODE_VERSION)) {
    throw new SmokeProbeError(
      `Circuit MCP requires Node.js ${MINIMUM_NODE_VERSION} or newer; this host reports ${nodeVersion}.`,
      {
        class: 'dependency',
        code: 'node_version_unsupported',
        retryable: false,
        next_action: `Install Node.js ${MINIMUM_NODE_VERSION} or newer, then retry.`,
      },
    );
  }
  if (!versionAtLeast(codexVersion, MINIMUM_CODEX_VERSION)) {
    throw new SmokeProbeError(
      `Circuit MCP requires Codex ${MINIMUM_CODEX_VERSION} or newer; this host reports ${codexVersion}.`,
      {
        class: 'dependency',
        code: 'codex_version_unsupported',
        retryable: false,
        next_action: `Install Codex ${MINIMUM_CODEX_VERSION} or newer, then retry.`,
      },
    );
  }
}

function pathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

interface VerifiedRemoteCheckout {
  readonly commit: string;
  readonly pluginTreeSha256: string;
}

function verifyRemoteCheckout(
  root: string,
  codexHome: string,
  source: string,
  ref: string,
  environment: NodeJS.ProcessEnv,
): VerifiedRemoteCheckout {
  let canonicalRoot: string;
  let canonicalCodexHome: string;
  try {
    canonicalRoot = realpathSync.native(root);
    canonicalCodexHome = realpathSync.native(codexHome);
  } catch {
    throw new SmokeProbeError('Codex did not create a readable remote marketplace checkout.', {
      class: 'host',
      code: 'marketplace_checkout_missing',
      retryable: false,
    });
  }
  if (!pathInside(canonicalCodexHome, canonicalRoot)) {
    throw new SmokeProbeError('Codex placed the remote marketplace outside the isolated profile.', {
      class: 'host',
      code: 'marketplace_checkout_escaped',
      retryable: false,
    });
  }
  const actualSource = runSync(
    '/usr/bin/git',
    ['-C', canonicalRoot, 'remote', 'get-url', 'origin'],
    environment,
  ).trim();
  if (normalizeGitSource(actualSource) !== normalizeGitSource(source)) {
    throw new SmokeProbeError('Codex resolved a different marketplace repository than requested.', {
      class: 'product',
      code: 'source_mismatch',
      retryable: false,
    });
  }
  const head = runSync(
    '/usr/bin/git',
    ['-C', canonicalRoot, 'rev-parse', 'HEAD^{commit}'],
    environment,
  ).trim();
  const expected = runSync(
    '/usr/bin/git',
    ['-C', canonicalRoot, 'rev-parse', `${ref}^{commit}`],
    environment,
  ).trim();
  if (!/^[0-9a-f]{40}$/u.test(head) || head !== expected) {
    throw new SmokeProbeError('Codex did not check out the exact requested marketplace ref.', {
      class: 'product',
      code: 'ref_mismatch',
      retryable: false,
    });
  }
  let pluginTreeSha256: string;
  try {
    pluginTreeSha256 = packageGitTreeSha256(canonicalRoot, head, 'plugins/codex');
  } catch (error) {
    throw new SmokeProbeError(
      `The requested marketplace ref has no readable Codex plugin tree: ${String(error)}`,
      { class: 'product', code: 'plugin_source_missing', retryable: false },
    );
  }
  return { commit: head, pluginTreeSha256 };
}

function installedMarketplaceRoot(value: string): string {
  const parsed = parseJsonObject('Codex marketplace add', value);
  if (typeof parsed.installedRoot !== 'string' || !existsSync(parsed.installedRoot)) {
    throw new SmokeProbeError('Codex marketplace add did not return its installed root.', {
      class: 'host',
      code: 'marketplace_checkout_missing',
      retryable: false,
    });
  }
  return parsed.installedRoot;
}

function parseCodexVersion(value: string): string {
  const match = value.match(/(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u);
  if (match?.[1] === undefined) {
    throw new SmokeProbeError('Codex did not report a parseable version.', {
      class: 'host',
      code: 'codex_version_unknown',
      retryable: false,
    });
  }
  return match[1];
}

export async function runLiveProbe(
  options: SmokeOptions,
  dependencies: { readonly runtimePath?: string } = {},
): Promise<SmokeOutcome> {
  const evidence: Evidence[] = [];
  mkdirSync(PRIVATE_TEST_ROOT, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(PRIVATE_TEST_ROOT, `${options.mode}-`));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const privateTemp = join(home, 'tmp');
  const workspace = join(root, 'workspace');
  const marketplace = join(root, 'marketplace');
  const marketplacePlugin = join(marketplace, 'plugins', 'circuit');
  const archive = join(root, 'circuit-codex-plugin.tar');
  let codexVersion: string | undefined;
  let pluginVersion: string | undefined;
  let previousPluginVersion: string | undefined;
  let pluginTreeSha256: string | undefined;
  const sourceDetails: SmokeOutcome['source'] =
    options.mode === 'packed'
      ? undefined
      : {
          repository: options.source as string,
          ref: options.ref as string,
          expected_version: options.expectedVersion as string,
          ...(options.oldRef === undefined ? {} : { old_ref: options.oldRef }),
          ...(options.oldVersion === undefined ? {} : { old_version: options.oldVersion }),
        };
  const versions = (): SmokeOutcome['versions'] => ({
    ...(codexVersion === undefined ? {} : { codex: codexVersion }),
    node: process.versions.node,
    ...(pluginVersion === undefined ? {} : { plugin: pluginVersion }),
    ...(previousPluginVersion === undefined ? {} : { previous_plugin: previousPluginVersion }),
    ...(pluginTreeSha256 === undefined ? {} : { plugin_tree_sha256: pluginTreeSha256 }),
  });
  try {
    const codex = resolveCodexExecutableOnPath(process.env.PATH);
    const safePath = dependencies.runtimePath ?? `${dirname(process.execPath)}:/usr/bin:/bin`;
    for (const directory of [home, codexHome, privateTemp, workspace]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    runSync('/usr/bin/git', ['init', '-q', workspace]);
    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: safePath,
      TMPDIR: privateTemp,
      LANG: 'C',
      LC_ALL: 'C',
    };
    const runLoaderRound = async (): Promise<{
      readonly run: SmokeCommandResult;
      readonly probe: ProbeServer;
    }> => {
      const probe = await startProbeServer();
      try {
        const provider = `model_providers.circuit_probe={name="Circuit Probe",base_url="http://127.0.0.1:${probe.port}/v1",env_key="CIRCUIT_PROBE_API_KEY",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`;
        const run = await runDetachedSmokeCommand(
          codex,
          [
            'exec',
            '--strict-config',
            '-C',
            workspace,
            '--ephemeral',
            '--sandbox',
            'read-only',
            '-c',
            'approval_policy="never"',
            '-c',
            'model="gpt-5.4"',
            '-c',
            'model_provider="circuit_probe"',
            '-c',
            provider,
            '-c',
            'analytics.enabled=false',
            '-c',
            'check_for_update_on_startup=false',
            '--json',
            'Use Circuit to list recent runs for this workspace. You must call circuit_list. If it is deferred, call tool_search first to load it. Do not call shell or any other tool. Then report whether the fresh-host workspace sentinel was present.',
          ],
          {
            ...environment,
            CIRCUIT_PROBE_API_KEY: 'canary-not-a-secret',
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          },
          { natural_cleanup_timeout_ms: HOST_NATURAL_CLEANUP_TIMEOUT_MS },
        );
        return { run, probe };
      } finally {
        await probe.close().catch(() => {});
      }
    };
    const runOldHostRound = async (): Promise<{
      readonly run: SmokeCommandResult;
      readonly probe: ProbeServer;
    }> => {
      const probe = await startProbeServer('old-host');
      try {
        const provider = `model_providers.circuit_probe={name="Circuit Probe",base_url="http://127.0.0.1:${probe.port}/v1",env_key="CIRCUIT_PROBE_API_KEY",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`;
        const run = await runDetachedSmokeCommand(
          codex,
          [
            'exec',
            '--strict-config',
            '-C',
            workspace,
            '--ephemeral',
            '--sandbox',
            'read-only',
            '-c',
            'approval_policy="never"',
            '-c',
            'model="gpt-5.4"',
            '-c',
            'model_provider="circuit_probe"',
            '-c',
            provider,
            '-c',
            'analytics.enabled=false',
            '-c',
            'check_for_update_on_startup=false',
            '--json',
            'Reply exactly OLD_CODEX_HOST_READY. Do not call any tool.',
          ],
          {
            ...environment,
            CIRCUIT_PROBE_API_KEY: 'canary-not-a-secret',
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          },
          { natural_cleanup_timeout_ms: HOST_NATURAL_CLEANUP_TIMEOUT_MS },
        );
        return { run, probe };
      } finally {
        await probe.close().catch(() => {});
      }
    };
    codexVersion = parseCodexVersion(runSync(codex, ['--version'], environment));
    assertSupportedSmokeVersions(process.versions.node, codexVersion);
    evidence.push({ name: 'codex_version_recorded', ok: true, detail: codexVersion });
    evidence.push({ name: 'node_version_recorded', ok: true, detail: process.versions.node });

    if (options.mode === 'packed') {
      mkdirSync(marketplacePlugin, { recursive: true, mode: 0o700 });
      mkdirSync(join(marketplace, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(marketplace, '.agents', 'plugins', 'marketplace.json'),
        marketplaceManifest(options.marketplace),
        { mode: 0o600, flag: 'wx' },
      );
      runSync('tar', ['-cf', archive, '-C', PLUGIN_ROOT, '.']);
      runSync('tar', ['-xf', archive, '-C', marketplacePlugin]);
    }

    const expectedVersion =
      options.expectedVersion ??
      (options.mode === 'packed' ? pluginManifestVersion(PLUGIN_ROOT) : '');
    const stateRoot = join(codexHome, 'circuit', 'mcp', 'v1');
    let installedPluginPath: string | undefined;
    let installedMarketplacePath = marketplace;
    let oldExpectedTreeSha256: string | undefined;
    let currentExpectedTreeSha256 =
      options.mode === 'packed' ? packageTreeSha256(PLUGIN_ROOT) : undefined;
    const assertPluginListed = (version: string, label: string): void => {
      const listing = parseJsonObject(
        `Codex plugin list (${label})`,
        runSync(codex, ['plugin', 'list', '--available', '--json'], environment),
      );
      const installedEntry = records(listing.installed).find(
        (entry) =>
          entry.pluginId === `circuit@${options.marketplace}` &&
          entry.version === version &&
          entry.installed === true &&
          entry.enabled === true,
      );
      if (installedEntry === undefined) {
        throw new SmokeProbeError(
          `Codex did not list the exact ${label} Circuit installation as enabled.`,
          { class: 'product', code: 'plugin_installation_mismatch', retryable: false },
        );
      }
    };
    const executeInstallStep = (step: MarketplaceInstallStep): void => {
      const commandOutput = runSync(codex, step.args, environment);
      if (step.id.startsWith('marketplace_add_')) {
        installedMarketplacePath = installedMarketplaceRoot(commandOutput);
        if (options.mode !== 'packed') {
          const stepRef = step.id === 'marketplace_add_upgrade_old' ? options.oldRef : options.ref;
          const verified = verifyRemoteCheckout(
            installedMarketplacePath,
            codexHome,
            options.source as string,
            stepRef as string,
            environment,
          );
          if (step.id === 'marketplace_add_upgrade_old') {
            oldExpectedTreeSha256 = verified.pluginTreeSha256;
          } else {
            currentExpectedTreeSha256 = verified.pluginTreeSha256;
          }
          evidence.push({
            name:
              step.id === 'marketplace_add_upgrade_old'
                ? 'old_source_ref_exact'
                : 'source_ref_exact',
            ok: true,
            detail: `${stepRef}@${verified.commit}`,
          });
        }
      }
      if (step.id.startsWith('plugin_install_')) {
        const isOld = step.id === 'plugin_install_upgrade_old';
        const versionExpected = isOld ? (options.oldVersion as string) : expectedVersion;
        const installed = parseInstalledPlugin(step.id, commandOutput, versionExpected);
        assertInstalledPluginPath(codexHome, installed.installedPath);
        const expectedTreeSha256 = isOld ? oldExpectedTreeSha256 : currentExpectedTreeSha256;
        if (expectedTreeSha256 === undefined) {
          throw new SmokeProbeError(`${step.id} has no verified source package tree.`, {
            class: 'product',
            code: 'plugin_source_missing',
            retryable: false,
          });
        }
        const installedTreeSha256 = assertPluginTreeDigest(
          expectedTreeSha256,
          installed.installedPath,
          isOld ? 'old installed plugin' : 'installed plugin',
        );
        if (isOld) {
          previousPluginVersion = installed.version;
          evidence.push({ name: 'old_plugin_version_exact', ok: true, detail: installed.version });
          evidence.push({
            name: 'old_plugin_tree_exact',
            ok: true,
            detail: installedTreeSha256,
          });
        } else {
          pluginVersion = installed.version;
          installedPluginPath = installed.installedPath;
          pluginTreeSha256 = installedTreeSha256;
          evidence.push({ name: 'plugin_version_exact', ok: true, detail: installed.version });
          evidence.push({ name: 'plugin_tree_exact', ok: true, detail: installedTreeSha256 });
        }
      }
      if (step.id === 'marketplace_remove_upgrade_old') {
        evidence.push({ name: 'old_marketplace_removed', ok: true });
      }
    };

    const installPhases = buildMarketplaceInstallPhases(options, marketplace);
    for (const step of installPhases.beforeOldHost) executeInstallStep(step);
    if (options.mode === 'upgrade') {
      if (previousPluginVersion !== options.oldVersion) {
        throw new SmokeProbeError('Codex did not install the expected old Circuit version.', {
          class: 'product',
          code: 'plugin_version_mismatch',
          retryable: false,
        });
      }
      assertPluginListed(options.oldVersion as string, 'old');
      evidence.push({
        name: 'old_installed_plugin_enabled',
        ok: true,
        detail: options.oldVersion as string,
      });
      const oldHost = await runOldHostRound();
      assertOldHostRoundSucceeded(
        oldHost.run,
        oldHost.probe.requests(),
        oldHost.probe.protocolError(),
      );
      evidence.push({ name: 'old_real_codex_host_completed', ok: true });
      evidence.push({ name: 'old_owned_process_cleanup', ok: true });
      if (existsSync(stateRoot)) {
        throw new SmokeProbeError(
          'The pre-MCP Circuit version unexpectedly created current MCP control state.',
          { class: 'product', code: 'old_plugin_state_mismatch', retryable: false },
        );
      }
    }
    for (const step of installPhases.afterOldHost) executeInstallStep(step);
    if (installedPluginPath === undefined || pluginVersion !== expectedVersion) {
      throw new SmokeProbeError('Codex did not install the expected Circuit plugin version.', {
        class: 'product',
        code: 'plugin_version_mismatch',
        retryable: false,
      });
    }
    if (pluginTreeSha256 === undefined) {
      throw new SmokeProbeError(
        'Codex did not bind the installed plugin to verified source bytes.',
        {
          class: 'product',
          code: 'plugin_tree_mismatch',
          retryable: false,
        },
      );
    }
    evidence.push({ name: 'plugin_tree_sha256', ok: true, detail: pluginTreeSha256 });
    assertPluginListed(expectedVersion, 'current');
    evidence.push({ name: 'installed_plugin_enabled', ok: true, detail: expectedVersion });

    if (existsSync(stateRoot)) {
      throw new SmokeProbeError(
        'The isolated profile contained Circuit control state before the real loader started.',
        { class: 'host', code: 'profile_not_fresh', retryable: false },
      );
    }
    const bootstrap = await runLoaderRound();
    const bootstrapStructured = parseMcpResult(bootstrap.run.stdout);
    const bootstrapStatePrivate =
      existsSync(stateRoot) &&
      privateDirectory(stateRoot) &&
      privateDirectory(join(stateRoot, 'runs')) &&
      privateDirectory(join(stateRoot, 'leases'));
    const bootstrapPassed =
      bootstrap.run.status === 0 &&
      !bootstrap.run.timed_out &&
      bootstrap.run.cleanup_confirmed &&
      bootstrap.probe.protocolError() === undefined &&
      bootstrap.probe.requests() === 3 &&
      bootstrapStructured?.ok === true &&
      records(bootstrapStructured.runs).length === 0;
    evidence.push({
      name: 'product_created_private_control_state',
      ok: bootstrapPassed && bootstrapStatePrivate,
      detail: bootstrapStatePrivate
        ? 'The packaged MCP runtime created 0700 control directories. Product-created 0600 files are enforced by tests/mcp/state-store.test.ts (creates one atomic workspace lease and private state files).'
        : 'The packaged MCP runtime did not create control directories with 0700 permissions.',
    });
    if (!bootstrap.run.cleanup_confirmed) {
      throw new SmokeProbeError('Bootstrap loader cleanup could not be confirmed.', {
        class: 'cleanup',
        code: 'cleanup_uncertain',
        retryable: false,
      });
    }
    if (!bootstrapPassed || !bootstrapStatePrivate) {
      throw new SmokeProbeError(
        bootstrap.probe.protocolError() ||
          bootstrap.run.stderr.trim().slice(0, 2_000) ||
          'The packaged MCP runtime did not initialize private state through the real loader.',
      );
    }
    if (options.mode === 'upgrade') {
      evidence.push({
        name: 'codex_restart_boundary',
        ok: true,
        detail:
          'One Codex host completed with the old plugin, then a separate host loaded the replacement.',
      });
    }

    const diagnosticSentinels = new Map<string, string>();
    seedWorkspaceSentinel(codexHome, workspace);
    for (const [label, runId] of DIAGNOSTIC_SENTINELS) {
      const candidate =
        label === 'scratch-root'
          ? root
          : label === 'isolated-home'
            ? home
            : label === 'isolated-codex-home'
              ? codexHome
              : label === 'marketplace-root'
                ? installedMarketplacePath
                : installedPluginPath;
      seedWorkspaceSentinel(
        codexHome,
        candidate,
        runId,
        `Fresh-host diagnostic sentinel: ${label}.`,
      );
      diagnosticSentinels.set(runId, label);
    }
    let pluginCacheIndex = 0;
    for (const directory of pluginCacheDirectories(codexHome)) {
      pluginCacheIndex += 1;
      const runId = `019f64f5-1f4d-7d91-8cda-a309cc72c4${String(pluginCacheIndex).padStart(
        2,
        '0',
      )}`;
      seedWorkspaceSentinel(
        codexHome,
        directory,
        runId,
        `Fresh-host diagnostic sentinel: installed-plugin-${pluginCacheIndex}.`,
      );
      diagnosticSentinels.set(runId, `installed-plugin-${pluginCacheIndex}`);
    }

    const loaded = await runLoaderRound();
    const { run, probe } = loaded;
    evidence.push({
      name: 'real_plugin_loader_completed',
      ok: run.status === 0 && !run.timed_out && run.cleanup_confirmed,
      ...(run.status === 0 ? {} : { detail: run.stderr.slice(0, 500) }),
    });
    evidence.push({ name: 'owned_process_cleanup', ok: run.cleanup_confirmed });
    const expectedTools = [...MCP_TOOL_NAMES].sort();
    const discoveredTools = [...probe.discoveredTools()].sort();
    evidence.push({
      name: 'tool_search_discovered_six_tools',
      ok: JSON.stringify(discoveredTools) === JSON.stringify(expectedTools),
      detail: discoveredTools.join(', '),
    });
    evidence.push({
      name: 'circuit_list_invoked',
      ok: probe.requests() === 3,
      detail: `${probe.requests()} provider requests`,
    });
    if (probe.protocolError() !== undefined) {
      throw new SmokeProbeError(probe.protocolError() as string);
    }
    if (run.timed_out) {
      throw new SmokeProbeError('The real Codex loader probe timed out.', {
        class: 'timeout',
        code: 'probe_timeout',
        retryable: false,
      });
    }
    if (!run.cleanup_confirmed) {
      throw new SmokeProbeError('Owned process cleanup could not be confirmed.', {
        class: 'cleanup',
        code: 'cleanup_uncertain',
        retryable: false,
      });
    }
    if (run.status !== 0) {
      throw new SmokeProbeError(
        run.stderr.trim().slice(0, 2_000) || 'The real Codex loader probe failed.',
      );
    }

    const workspaceKey = createHash('sha256')
      .update(realpathSync.native(workspace), 'utf8')
      .digest('hex');
    const statePrivate =
      privateDirectory(stateRoot) &&
      privateDirectory(join(stateRoot, 'runs')) &&
      privateDirectory(join(stateRoot, 'leases')) &&
      privateDirectory(join(stateRoot, 'runs', workspaceKey, SENTINEL_RUN_ID)) &&
      privateFile(join(stateRoot, 'runs', workspaceKey, SENTINEL_RUN_ID, 'state.json'));
    evidence.push({
      name: 'diagnostic_sentinel_permissions',
      ok: statePrivate,
      detail:
        'This 0600 file is a harness-seeded fixture; product file creation is covered by tests/mcp/state-store.test.ts (creates one atomic workspace lease and private state files).',
    });
    if (!statePrivate) {
      throw new SmokeProbeError(
        'The harness could not create a private diagnostic state fixture.',
        {
          class: 'product',
          code: 'private_state_permissions',
          retryable: false,
        },
      );
    }

    const structured = parseMcpResult(run.stdout);
    const workspaceMetadataPassed = structured?.ok === true;
    const error =
      typeof structured?.error === 'object' && structured.error !== null
        ? (structured.error as Record<string, unknown>)
        : undefined;
    evidence.push({
      name: 'trusted_workspace_metadata',
      ok: workspaceMetadataPassed,
      detail: workspaceMetadataPassed
        ? 'circuit_list accepted codex/sandbox-state-meta'
        : typeof error?.code === 'string'
          ? error.code
          : 'no structured circuit_list result',
    });
    if (!workspaceMetadataPassed) {
      throw new SmokeProbeError(
        typeof error?.message === 'string'
          ? error.message
          : 'The real Codex plugin loader did not provide trusted workspace metadata.',
      );
    }
    const listedRuns = records(structured.runs);
    const exactWorkspacePassed =
      listedRuns.length === 1 && listedRuns[0]?.run_id === SENTINEL_RUN_ID;
    evidence.push({
      name: 'exact_workspace_identity',
      ok: exactWorkspacePassed,
      detail: listedRuns
        .map((run) => run.run_id)
        .filter((runId): runId is string => typeof runId === 'string')
        .map(
          (runId) =>
            `${runId}${diagnosticSentinels.has(runId) ? ` (${diagnosticSentinels.get(runId)})` : ''}`,
        )
        .join(', '),
    });
    if (!exactWorkspacePassed) {
      throw new SmokeProbeError(
        'Circuit accepted workspace metadata, but it did not identify the exact fresh-host worktree.',
      );
    }
    return outcome(
      options.mode,
      'pass',
      `The ${options.mode} plugin loaded, discovered Circuit, and identified the exact fresh-host worktree.`,
      evidence,
      { ...(sourceDetails === undefined ? {} : { source: sourceDetails }), versions: versions() },
    );
  } catch (error) {
    const failure = classifySmokeFailure(error);
    const rawReason = error instanceof Error ? error.message : String(error);
    return outcome(
      options.mode,
      'fail',
      failure.code === 'node_missing' && failure.next_action !== undefined
        ? failure.next_action
        : rawReason,
      evidence,
      {
        failure,
        ...(sourceDetails === undefined ? {} : { source: sourceDetails }),
        versions: versions(),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function usage(): string {
  return [
    'Usage: npm run smoke:host:codex:mcp -- --live [options]',
    '',
    'Modes:',
    '  packed     Pack the current checkout (default).',
    '  published  Install --source at exact --ref and --expected-version.',
    '  upgrade    Install --old-ref/--old-version, replace the marketplace, then',
    '             install --ref/--expected-version and restart the loader proof.',
    '',
    'Common options:',
    '  --mode <packed|published|upgrade>',
    '  --marketplace <name>',
    '  --output <path>       Atomically write a private redacted JSON report.',
    '',
    'Remote modes also require --source, --ref, and --expected-version.',
    'Uses a local no-spend Responses provider to invoke circuit_list through',
    'the real Codex plugin loader.',
  ].join('\n');
}

function requestedEvidenceSettings(argv: readonly string[]): {
  readonly mode: SmokeMode;
  readonly output?: string;
} {
  let mode: SmokeMode = 'packed';
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') {
      const candidate = argv[index + 1];
      if (candidate === 'packed' || candidate === 'published' || candidate === 'upgrade') {
        mode = candidate;
      }
      index += 1;
    } else if (value?.startsWith('--mode=')) {
      const candidate = value.slice('--mode='.length);
      if (candidate === 'packed' || candidate === 'published' || candidate === 'upgrade') {
        mode = candidate;
      }
    } else if (value === '--output') {
      const candidate = argv[index + 1];
      if (candidate !== undefined && candidate.length > 0 && !candidate.startsWith('-')) {
        output = resolve(candidate);
      }
      index += 1;
    } else if (value?.startsWith('--output=')) {
      const candidate = value.slice('--output='.length);
      if (candidate.length > 0) output = resolve(candidate);
    }
  }
  return { mode, ...(output === undefined ? {} : { output }) };
}

async function main(): Promise<number> {
  let options: SmokeOptions;
  const requested = requestedEvidenceSettings(process.argv.slice(2));
  try {
    options = parseSmokeOptions(process.argv.slice(2));
  } catch (error) {
    const result = outcome(
      requested.mode,
      'fail',
      error instanceof Error ? error.message : String(error),
      [],
      { failure: classifySmokeFailure(error), versions: { node: process.versions.node } },
    );
    const redactedPaths = [PRIVATE_TEST_ROOT, REPO_ROOT, process.env.HOME ?? ''];
    const redacted = redactSmokeOutcome(result, redactedPaths);
    if (requested.output !== undefined) writeSmokeOutput(requested.output, redacted, redactedPaths);
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let result: SmokeOutcome;
  if (process.platform !== 'darwin') {
    result = outcome(
      options.mode,
      'skip',
      'The Codex MCP host smoke currently supports macOS only.',
      [],
      { versions: {} },
    );
  } else if (!options.live) {
    result = outcome(
      options.mode,
      'skip',
      'Safe preflight passed. Re-run with --live to start the isolated no-spend host probe.',
      [],
      { versions: {} },
    );
  } else {
    result = await runLiveProbe(options);
  }
  const redactedPaths = [PRIVATE_TEST_ROOT, REPO_ROOT, process.env.HOME ?? ''];
  const redacted = redactSmokeOutcome(result, redactedPaths);
  if (options.output !== undefined) writeSmokeOutput(options.output, redacted, redactedPaths);
  process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  return result.status === 'fail' ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();

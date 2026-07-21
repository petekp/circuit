import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A one-request proof that a sandboxed Circuit process can ask a host-owned
 * helper to launch Codex without widening Circuit's own sandbox.
 *
 * This is intentionally an experiment, not a production transport. The host
 * owns every capability-bearing value. The request can supply only a prompt
 * plus identifiers and a signature.
 */

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 192 * 1024;

const FRAME_HEADER_BYTES = 4;
const POLL_MS = 20;
const CODEX_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const CODEX_STDERR_MAX_BYTES = 256 * 1024;
const WORKER_KILL_GRACE_MS = 1_000;
const RESPONSE_RESERVE_MS = 3_000;
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BRIDGE_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAC_PATTERN = /^[a-f0-9]{64}$/;

class BridgeDeadlineError extends Error {}

export type BridgeEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type BridgeSearchMode = 'disabled' | 'cached';

export interface BridgeRequestPayload {
  readonly version: typeof BRIDGE_PROTOCOL_VERSION;
  readonly bridge_id: string;
  readonly request_id: string;
  readonly op: 'codex.exec';
  readonly prompt: string;
}

export interface BridgeSuccessPayload {
  readonly version: typeof BRIDGE_PROTOCOL_VERSION;
  readonly bridge_id: string;
  readonly request_id: string;
  readonly ok: true;
  readonly result: {
    readonly result_body: string;
    readonly thread_id: string;
    readonly cli_version: string;
    readonly duration_ms: number;
    readonly model: string;
    readonly sandbox: 'workspace-write';
    readonly web_search: BridgeSearchMode;
    readonly web_search_count: number;
    readonly command_exit_codes: readonly number[];
  };
}

export interface BridgeFailurePayload {
  readonly version: typeof BRIDGE_PROTOCOL_VERSION;
  readonly bridge_id: string;
  readonly request_id: string;
  readonly ok: false;
  readonly error: {
    readonly code: 'invalid_request' | 'worker_failed' | 'worker_timed_out';
    readonly message: string;
  };
}

export type BridgeResponsePayload = BridgeSuccessPayload | BridgeFailurePayload;

export interface SignedEnvelope<T> {
  readonly payload: T;
  readonly mac: string;
}

export interface HostBridgeConfig {
  readonly workspace: string;
  readonly codexExecutable: string;
  readonly model: string;
  readonly effort: BridgeEffort;
  readonly webSearch: BridgeSearchMode;
  readonly timeoutMs: number;
  readonly mailboxDir?: string;
  readonly bridgeId?: string;
  readonly secret?: string;
}

export interface ClientBridgeConfig {
  readonly mailboxDir: string;
  readonly bridgeId: string;
  readonly requestId: string;
  readonly secretFile: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

interface CodexRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly stdoutCapped: boolean;
  readonly stderrCapped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`expected exactly these fields: ${wanted.join(', ')}`);
  }
}

function hmacForPayload(secret: string, payload: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload), 'utf8').digest('hex');
}

export function signPayload<T>(secret: string, payload: T): SignedEnvelope<T> {
  if (secret.length < 32) throw new Error('bridge secret must contain at least 32 characters');
  return { payload, mac: hmacForPayload(secret, payload) };
}

function verifyMac(secret: string, payload: unknown, mac: unknown): void {
  if (typeof mac !== 'string' || !MAC_PATTERN.test(mac)) {
    throw new Error('bridge signature is malformed');
  }
  const expected = Buffer.from(hmacForPayload(secret, payload), 'hex');
  const actual = Buffer.from(mac, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('bridge signature does not match');
  }
}

export function parseSignedRequest(
  raw: unknown,
  expected: { readonly secret: string; readonly bridgeId: string },
): BridgeRequestPayload {
  if (!isRecord(raw)) throw new Error('request envelope must be an object');
  assertExactKeys(raw, ['payload', 'mac']);
  const payload = raw.payload;
  verifyMac(expected.secret, payload, raw.mac);
  if (!isRecord(payload)) throw new Error('request payload must be an object');
  assertExactKeys(payload, ['version', 'bridge_id', 'request_id', 'op', 'prompt']);
  if (payload.version !== BRIDGE_PROTOCOL_VERSION) throw new Error('unsupported bridge version');
  if (payload.bridge_id !== expected.bridgeId) throw new Error('bridge id does not match');
  if (typeof payload.bridge_id !== 'string' || !BRIDGE_ID_PATTERN.test(payload.bridge_id)) {
    throw new Error('bridge id is malformed');
  }
  if (typeof payload.request_id !== 'string' || !REQUEST_ID_PATTERN.test(payload.request_id)) {
    throw new Error('request id is malformed');
  }
  if (payload.op !== 'codex.exec') throw new Error('unsupported bridge operation');
  if (typeof payload.prompt !== 'string' || payload.prompt.trim() === '') {
    throw new Error('prompt must be a non-empty string');
  }
  if (Buffer.byteLength(payload.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  return payload as unknown as BridgeRequestPayload;
}

export function parseSignedResponse(
  raw: unknown,
  expected: {
    readonly secret: string;
    readonly bridgeId: string;
    readonly requestId: string;
  },
): BridgeResponsePayload {
  if (!isRecord(raw)) throw new Error('response envelope must be an object');
  assertExactKeys(raw, ['payload', 'mac']);
  const payload = raw.payload;
  verifyMac(expected.secret, payload, raw.mac);
  if (!isRecord(payload)) throw new Error('response payload must be an object');
  if (payload.version !== BRIDGE_PROTOCOL_VERSION) throw new Error('unsupported bridge version');
  if (payload.bridge_id !== expected.bridgeId) throw new Error('bridge id does not match');
  if (payload.request_id !== expected.requestId) throw new Error('request id does not match');
  if (payload.ok === true) {
    assertExactKeys(payload, ['version', 'bridge_id', 'request_id', 'ok', 'result']);
    if (!isRecord(payload.result) || typeof payload.result.result_body !== 'string') {
      throw new Error('successful response has no result body');
    }
    return payload as unknown as BridgeSuccessPayload;
  }
  if (payload.ok === false) {
    assertExactKeys(payload, ['version', 'bridge_id', 'request_id', 'ok', 'error']);
    if (!isRecord(payload.error) || typeof payload.error.message !== 'string') {
      throw new Error('failed response has no error message');
    }
    return payload as unknown as BridgeFailurePayload;
  }
  throw new Error('response ok field must be boolean');
}

export function buildHostCodexArgs(input: {
  readonly workspace: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort: BridgeEffort;
  readonly webSearch: BridgeSearchMode;
}): string[] {
  if (input.webSearch !== 'disabled' && input.webSearch !== 'cached') {
    throw new Error('host web search must be disabled or cached');
  }
  const workspace = resolve(input.workspace);
  return [
    'exec',
    '--json',
    '-s',
    'workspace-write',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '-c',
    `web_search=${JSON.stringify(input.webSearch)}`,
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'shell_environment_policy.inherit="core"',
    '-c',
    'shell_environment_policy.ignore_default_excludes=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.remote_plugin=false',
    '-c',
    'features.plugin_sharing=false',
    '-c',
    'features.skill_mcp_dependency_install=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
    '--cd',
    workspace,
    '-m',
    input.model,
    '-c',
    `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    input.prompt,
  ];
}

const HOST_ENV_ALLOWLIST = new Set([
  'ALL_PROXY',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'USER',
]);

export function buildHostCodexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        HOST_ENV_ALLOWLIST.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isWouldBlock(error: unknown): boolean {
  return isRecord(error) && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK');
}

async function readExact(fd: number, byteLength: number, deadline: number): Promise<Buffer> {
  const output = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < output.length) {
    if (Date.now() >= deadline) throw new Error('bridge read timed out');
    try {
      const count = readSync(fd, output, offset, output.length - offset, null);
      if (count === 0) {
        await sleep(POLL_MS);
        continue;
      }
      offset += count;
    } catch (error) {
      if (!isWouldBlock(error)) throw error;
      await sleep(POLL_MS);
    }
  }
  return output;
}

async function writeAll(fd: number, bytes: Buffer, deadline: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    if (Date.now() >= deadline) throw new Error('bridge write timed out');
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (!isWouldBlock(error)) throw error;
      await sleep(POLL_MS);
    }
  }
}

export async function readFrame(fd: number, maxBytes: number, deadline: number): Promise<unknown> {
  const header = await readExact(fd, FRAME_HEADER_BYTES, deadline);
  const length = header.readUInt32BE(0);
  if (length === 0 || length > maxBytes) {
    throw new Error(`bridge frame length ${length} is outside the 1..${maxBytes} byte limit`);
  }
  const body = await readExact(fd, length, deadline);
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`bridge frame is not valid JSON: ${(error as Error).message}`);
  }
}

export async function writeFrame(
  fd: number,
  value: unknown,
  maxBytes: number,
  deadline: number,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > maxBytes) {
    throw new Error(`bridge frame body is outside the 1..${maxBytes} byte limit`);
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  await writeAll(fd, Buffer.concat([header, body]), deadline);
}

function appendCappedChunk(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): { bytes: number; capped: boolean } {
  if (currentBytes >= maxBytes) return { bytes: currentBytes, capped: true };
  const remaining = maxBytes - currentBytes;
  const kept = chunk.subarray(0, remaining);
  chunks.push(kept);
  return { bytes: currentBytes + kept.length, capped: chunk.length > remaining };
}

async function runCodex(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CodexRunResult> {
  const startedAt = performance.now();
  return await new Promise<CodexRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      argv0: 'codex',
      cwd,
      env: buildHostCodexEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        killTimer = setTimeout(() => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, WORKER_KILL_GRACE_MS);
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendCappedChunk(stdoutChunks, chunk, stdoutBytes, CODEX_STDOUT_MAX_BYTES);
      stdoutBytes = next.bytes;
      stdoutCapped ||= next.capped;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendCappedChunk(stderrChunks, chunk, stderrBytes, CODEX_STDERR_MAX_BYTES);
      stderrBytes = next.bytes;
      stderrCapped ||= next.capped;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      rejectPromise(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        timedOut,
        stdoutCapped,
        stderrCapped,
      });
    });
  });
}

function parseCodexSuccess(stdout: string): {
  resultBody: string;
  threadId: string;
  webSearchCount: number;
  commandExitCodes: number[];
} {
  const events = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const threadStarted = events.find((event) => event.type === 'thread.started');
  const threadId = threadStarted?.thread_id;
  if (typeof threadId !== 'string' || threadId === '') {
    throw new Error('Codex did not emit a thread id');
  }
  if (!events.some((event) => event.type === 'turn.completed')) {
    throw new Error('Codex did not complete its turn');
  }
  const agentMessages = events
    .filter((event) => event.type === 'item.completed')
    .map((event) => event.item)
    .filter(isRecord)
    .filter((item) => item.type === 'agent_message');
  const lastMessage = agentMessages.at(-1)?.text;
  if (typeof lastMessage !== 'string' || lastMessage === '') {
    throw new Error('Codex did not emit a final agent message');
  }
  const completedItems = events
    .filter((event) => event.type === 'item.completed')
    .map((event) => event.item)
    .filter(isRecord);
  const commandExitCodes = completedItems
    .filter((item) => item.type === 'command_execution')
    .map((item) => item.exit_code)
    .filter((exitCode): exitCode is number => typeof exitCode === 'number');
  const webSearchCount = completedItems.filter((item) => item.type === 'web_search').length;
  return { resultBody: lastMessage, threadId, webSearchCount, commandExitCodes };
}

function makeFailure(
  ids: { readonly bridgeId: string; readonly requestId: string },
  code: BridgeFailurePayload['error']['code'],
  message: string,
): BridgeFailurePayload {
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    bridge_id: ids.bridgeId,
    request_id: ids.requestId,
    ok: false,
    error: { code, message },
  };
}

async function writeSignedResponse(
  fd: number,
  secret: string,
  response: BridgeResponsePayload,
  deadline: number,
): Promise<BridgeResponsePayload> {
  let boundedResponse = response;
  let envelope = signPayload(secret, boundedResponse);
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_RESPONSE_BYTES) {
    boundedResponse = makeFailure(
      { bridgeId: response.bridge_id, requestId: response.request_id },
      'worker_failed',
      'Codex returned more data than the host bridge permits.',
    );
    envelope = signPayload(secret, boundedResponse);
  }
  await writeFrame(fd, envelope, MAX_RESPONSE_BYTES, deadline);
  return boundedResponse;
}

function assertPrivateFifo(path: string): void {
  const stat = statSync(path);
  if (!stat.isFIFO()) throw new Error(`${path} is not a named pipe`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${path} is accessible to other users`);
}

function createMailbox(mailboxDir: string): { requestPath: string; responsePath: string } {
  mkdirSync(mailboxDir, { mode: 0o700, recursive: false });
  chmodSync(mailboxDir, 0o700);
  const requestPath = join(mailboxDir, 'request.fifo');
  const responsePath = join(mailboxDir, 'response.fifo');
  execFileSync('/usr/bin/mkfifo', [requestPath, responsePath], { stdio: 'ignore' });
  chmodSync(requestPath, 0o600);
  chmodSync(responsePath, 0o600);
  assertPrivateFifo(requestPath);
  assertPrivateFifo(responsePath);
  return { requestPath, responsePath };
}

function writeSecretFile(mailboxDir: string, secret: string): string {
  const path = join(mailboxDir, 'secret');
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${secret}\n`, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return path;
}

export function consumeBridgeSecret(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let secret: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('bridge secret path is not a regular file');
    if ((stat.mode & 0o077) !== 0)
      throw new Error('bridge secret file is accessible to other users');
    if (stat.size < 32 || stat.size > 256)
      throw new Error('bridge secret file has an invalid size');
    secret = readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
  if (secret.length < 32) throw new Error('bridge secret must contain at least 32 characters');
  return secret;
}

export async function runHostBridge(config: HostBridgeConfig): Promise<BridgeResponsePayload> {
  const workspace = realpathSync(resolve(config.workspace));
  const workspaceStat = statSync(workspace);
  if (!workspaceStat.isDirectory()) throw new Error('workspace must be a directory');
  const codexExecutable = realpathSync(resolve(config.codexExecutable));
  const codexStat = statSync(codexExecutable);
  if (!codexStat.isFile()) throw new Error('Codex executable must be a regular file');
  if (config.timeoutMs < 5_000 || config.timeoutMs > 30 * 60_000) {
    throw new Error('host timeout must be between 5 seconds and 30 minutes');
  }

  const bridgeId = config.bridgeId ?? randomBytes(16).toString('hex');
  const secret = config.secret ?? randomBytes(32).toString('hex');
  if (!BRIDGE_ID_PATTERN.test(bridgeId)) throw new Error('bridge id is malformed');
  if (secret.length < 32) throw new Error('bridge secret must contain at least 32 characters');
  const mailboxDir = resolve(
    config.mailboxDir ?? join(tmpdir(), `circuit-codex-bridge-${bridgeId}`),
  );
  if (existsSync(mailboxDir)) throw new Error('mailbox directory already exists');

  let requestFd: number | undefined;
  let responseFd: number | undefined;
  try {
    const { requestPath, responsePath } = createMailbox(mailboxDir);
    const secretFile = writeSecretFile(mailboxDir, secret);
    requestFd = openSync(requestPath, constants.O_RDWR | constants.O_NONBLOCK);
    responseFd = openSync(responsePath, constants.O_RDWR | constants.O_NONBLOCK);
    const ready = {
      ready: true,
      mailbox_dir: mailboxDir,
      bridge_id: bridgeId,
      secret_file: secretFile,
      workspace,
      model: config.model,
      effort: config.effort,
      web_search: config.webSearch,
    } as const;
    process.stdout.write(`${JSON.stringify(ready)}\n`);

    const requestDeadline = Date.now() + config.timeoutMs;
    let requestId = 'invalid-request';
    let response: BridgeResponsePayload;
    let request: BridgeRequestPayload;
    try {
      const raw = await readFrame(requestFd, MAX_REQUEST_BYTES, requestDeadline);
      request = parseSignedRequest(raw, { secret, bridgeId });
      requestId = request.request_id;
    } catch (error) {
      response = makeFailure(
        { bridgeId, requestId },
        'invalid_request',
        `Bridge rejected the request: ${(error as Error).message}`,
      );
      response = await writeSignedResponse(responseFd, secret, response, requestDeadline);
      return response;
    }

    let cliVersion: string;
    let run: CodexRunResult;
    try {
      const versionBudget = requestDeadline - Date.now() - RESPONSE_RESERVE_MS;
      if (versionBudget <= 0) throw new BridgeDeadlineError('bridge deadline expired');
      const versionRun = spawnSync(codexExecutable, ['--version'], {
        argv0: 'codex',
        encoding: 'utf8',
        timeout: Math.min(5_000, versionBudget),
        stdio: ['ignore', 'pipe', 'ignore'],
        env: buildHostCodexEnvironment(process.env),
      });
      if (versionRun.error !== undefined || versionRun.status !== 0) {
        throw versionRun.error ?? new Error('Codex version probe failed');
      }
      cliVersion = versionRun.stdout.trim();
      if (cliVersion === '') throw new Error('Codex version probe returned no version');
      const args = buildHostCodexArgs({
        workspace,
        prompt: request.prompt,
        model: config.model,
        effort: config.effort,
        webSearch: config.webSearch,
      });
      const workerBudget = requestDeadline - Date.now() - RESPONSE_RESERVE_MS;
      if (workerBudget <= 0) throw new BridgeDeadlineError('bridge deadline expired');
      run = await runCodex(codexExecutable, args, workspace, workerBudget);
    } catch (error) {
      const deadlineExpired = error instanceof BridgeDeadlineError;
      response = makeFailure(
        { bridgeId, requestId },
        deadlineExpired ? 'worker_timed_out' : 'worker_failed',
        deadlineExpired
          ? 'The host bridge reached its fixed overall deadline before Codex could finish.'
          : 'The host bridge could not start Codex. Raw launch details were not returned across the boundary.',
      );
      response = await writeSignedResponse(responseFd, secret, response, requestDeadline);
      return response;
    }
    if (run.timedOut) {
      response = makeFailure(
        { bridgeId, requestId },
        'worker_timed_out',
        'The host bridge stopped Codex after its fixed deadline.',
      );
    } else if (run.code !== 0 || run.stdoutCapped || run.stderrCapped) {
      response = makeFailure(
        { bridgeId, requestId },
        'worker_failed',
        'Codex failed inside the host bridge. Raw worker output was not returned across the boundary.',
      );
    } else {
      try {
        const parsed = parseCodexSuccess(run.stdout);
        response = {
          version: BRIDGE_PROTOCOL_VERSION,
          bridge_id: bridgeId,
          request_id: requestId,
          ok: true,
          result: {
            result_body: parsed.resultBody,
            thread_id: parsed.threadId,
            cli_version: cliVersion,
            duration_ms: run.durationMs,
            model: config.model,
            sandbox: 'workspace-write',
            web_search: config.webSearch,
            web_search_count: parsed.webSearchCount,
            command_exit_codes: parsed.commandExitCodes,
          },
        };
      } catch {
        response = makeFailure(
          { bridgeId, requestId },
          'worker_failed',
          'Codex returned an unfamiliar response. Raw worker output was not returned across the boundary.',
        );
      }
    }
    response = await writeSignedResponse(responseFd, secret, response, requestDeadline);
    return response;
  } finally {
    if (requestFd !== undefined) closeSync(requestFd);
    if (responseFd !== undefined) closeSync(responseFd);
    rmSync(mailboxDir, { recursive: true, force: true });
  }
}

export async function runBridgeClient(config: ClientBridgeConfig): Promise<BridgeResponsePayload> {
  if (!BRIDGE_ID_PATTERN.test(config.bridgeId)) throw new Error('bridge id is malformed');
  if (!REQUEST_ID_PATTERN.test(config.requestId)) throw new Error('request id is malformed');
  if (config.timeoutMs < 5_000 || config.timeoutMs > 30 * 60_000) {
    throw new Error('client timeout must be between 5 seconds and 30 minutes');
  }
  if (config.prompt.trim() === '') throw new Error('prompt must be a non-empty string');
  if (Buffer.byteLength(config.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  const requestPath = join(resolve(config.mailboxDir), 'request.fifo');
  const responsePath = join(resolve(config.mailboxDir), 'response.fifo');
  let requestFd: number | undefined;
  let responseFd: number | undefined;
  try {
    assertPrivateFifo(requestPath);
    assertPrivateFifo(responsePath);
    requestFd = openSync(requestPath, constants.O_RDWR | constants.O_NONBLOCK);
    responseFd = openSync(responsePath, constants.O_RDWR | constants.O_NONBLOCK);
    const secret = consumeBridgeSecret(config.secretFile);
    const deadline = Date.now() + config.timeoutMs;
    const payload: BridgeRequestPayload = {
      version: BRIDGE_PROTOCOL_VERSION,
      bridge_id: config.bridgeId,
      request_id: config.requestId,
      op: 'codex.exec',
      prompt: config.prompt,
    };
    await writeFrame(requestFd, signPayload(secret, payload), MAX_REQUEST_BYTES, deadline);
    const raw = await readFrame(responseFd, MAX_RESPONSE_BYTES, deadline);
    return parseSignedResponse(raw, {
      secret,
      bridgeId: config.bridgeId,
      requestId: config.requestId,
    });
  } finally {
    if (requestFd !== undefined) closeSync(requestFd);
    if (responseFd !== undefined) closeSync(responseFd);
  }
}

function parseCliOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('options must be --name value pairs');
    }
    options.set(key.slice(2), value);
  }
  return options;
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value === '') throw new Error(`missing --${name}`);
  return value;
}

function parseBoundedTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 30 * 60_000) {
    throw new Error('timeout must be an integer from 5000 to 1800000 milliseconds');
  }
  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const options = parseCliOptions(argv.slice(1));
  if (command === 'host') {
    const effort = requiredOption(options, 'effort');
    if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('invalid effort');
    const webSearch = requiredOption(options, 'web-search');
    if (webSearch !== 'disabled' && webSearch !== 'cached') {
      throw new Error('web search must be disabled or cached');
    }
    const response = await runHostBridge({
      workspace: requiredOption(options, 'workspace'),
      codexExecutable: requiredOption(options, 'codex'),
      model: requiredOption(options, 'model'),
      effort: effort as BridgeEffort,
      webSearch,
      timeoutMs: parseBoundedTimeout(options.get('timeout-ms'), 180_000),
      ...(options.has('mailbox') ? { mailboxDir: requiredOption(options, 'mailbox') } : {}),
      ...(options.has('bridge-id') ? { bridgeId: requiredOption(options, 'bridge-id') } : {}),
    });
    process.stderr.write(
      `${JSON.stringify({ complete: true, ok: response.ok, request_id: response.request_id })}\n`,
    );
    return response.ok ? 0 : 1;
  }
  if (command === 'client') {
    const response = await runBridgeClient({
      mailboxDir: requiredOption(options, 'mailbox'),
      bridgeId: requiredOption(options, 'bridge-id'),
      requestId: requiredOption(options, 'request-id'),
      secretFile: requiredOption(options, 'secret-file'),
      prompt: requiredOption(options, 'prompt'),
      timeoutMs: parseBoundedTimeout(options.get('timeout-ms'), 180_000),
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  }
  throw new Error('usage: bridge.ts host|client --name value ...');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`bridge error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}

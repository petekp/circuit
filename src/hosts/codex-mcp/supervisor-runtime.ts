import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ReadStream, WriteStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { sha256OfJson } from '../../schemas/hashing.js';
import { verifyMcpRuntimeAssets } from './asset-pins.js';
import { SupervisorProgressWriter } from './supervisor-progress.js';
import {
  ExitJournalV1,
  MAX_SUPERVISOR_MESSAGE_BYTES,
  RuntimeJournalV1,
  type SupervisorAuthorization,
  SupervisorAuthorizationV1,
  SupervisorHelloV1,
  SupervisorLaunchFailureV1,
  type SupervisorProcessObservation,
  SupervisorRuntimeStartedV1,
  decodeSupervisorMessage,
  encodeSupervisorMessage,
} from './supervisor-protocol.js';
import { mcpTransientEnvironment } from './transient-environment.js';

const PROCESS_OBSERVATION_ATTEMPTS = 40;
const PROCESS_OBSERVATION_DELAY_MS = 10;
export const MCP_PROCESS_TOKEN_ARGUMENT = '--circuit-mcp-process-token=';

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function psValue(pid: number, field: 'pgid' | 'command'): string {
  const result = spawnSync('/bin/ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    env: mcpTransientEnvironment(process.env),
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`could not inspect process ${pid}`);
  }
  const value = result.stdout.trim();
  if (value.length === 0 || value.length > 256) {
    throw new Error(`process ${pid} returned invalid ${field} evidence`);
  }
  return value;
}

async function observeProcess(
  pid: number,
  expectedProcessGroup: number,
  expectedBirthToken: string,
): Promise<SupervisorProcessObservation> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROCESS_OBSERVATION_ATTEMPTS; attempt += 1) {
    try {
      const processGroup = Number.parseInt(psValue(pid, 'pgid'), 10);
      if (processGroup !== expectedProcessGroup) {
        throw new Error(`process ${pid} did not enter its private process group`);
      }
      const command = psValue(pid, 'command');
      if (!command.split(/\s+/u).includes(`${MCP_PROCESS_TOKEN_ARGUMENT}${expectedBirthToken}`)) {
        throw new Error(`process ${pid} did not retain its private identity token`);
      }
      return {
        pid,
        process_group_id: processGroup,
        birth_token: expectedBirthToken,
        started_at: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
      await delay(PROCESS_OBSERVATION_DELAY_MS);
    }
  }
  throw new Error(`could not record process ${pid}: ${describeError(lastError)}`);
}

export class BoundedLineReader {
  readonly #stream: Readable;
  #buffer = Buffer.alloc(0);
  #ended = false;
  readonly #waiters: (() => void)[] = [];
  #error: Error | undefined;

  constructor(stream: Readable) {
    this.#stream = stream;
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      if (this.#buffer.byteLength > MAX_SUPERVISOR_MESSAGE_BYTES) {
        this.#error = new Error('supervisor message exceeds the protocol limit');
        stream.destroy(this.#error);
      }
      this.#wake();
    });
    stream.once('end', () => {
      this.#ended = true;
      this.#wake();
    });
    stream.once('error', (error) => {
      this.#error = error;
      this.#wake();
    });
  }

  async read(timeoutMs?: number): Promise<Buffer> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (true) {
      if (this.#error !== undefined) throw this.#error;
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        return line;
      }
      if (this.#ended) throw new Error('supervisor channel closed before a complete message');
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) {
        throw new Error('supervisor channel timed out');
      }
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const wake = () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        this.#waiters.push(wake);
        if (remaining !== undefined) {
          timer = setTimeout(() => {
            const index = this.#waiters.indexOf(wake);
            if (index >= 0) this.#waiters.splice(index, 1);
            reject(new Error('supervisor channel timed out'));
          }, remaining);
          timer.unref();
        }
      });
    }
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

function writeMessage(stream: WriteStream, value: unknown): Promise<void> {
  const bytes = encodeSupervisorMessage(value);
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function assertPrivateDirectory(path: string): void {
  const direct = lstatSync(path);
  if (direct.isSymbolicLink() || !direct.isDirectory()) {
    throw new Error('supervisor control directory is not a real directory');
  }
  if ((direct.mode & 0o777) !== 0o700) {
    throw new Error('supervisor control directory is not private');
  }
  if (typeof process.getuid === 'function' && direct.uid !== process.getuid()) {
    throw new Error('supervisor control directory has the wrong owner');
  }
  if (realpathSync.native(path) !== path) {
    throw new Error('supervisor control directory must be canonical');
  }
}

function writeJournalExclusive(path: string, value: unknown): void {
  assertPrivateDirectory(dirname(path));
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SUPERVISOR_MESSAGE_BYTES) {
    throw new Error('supervisor journal exceeds the size limit');
  }
  const stage = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw new Error('supervisor journal is not a private regular file');
    }
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(stage, path);
    unlinkSync(stage);
  } catch (error) {
    rmSync(stage, { force: true });
    throw error;
  }
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function assertPinnedWorkerPath(path: string, executable: boolean): void {
  if (realpathSync.native(path) !== path) throw new Error('worker asset path is not canonical');
  const direct = lstatSync(path);
  const info = statSync(path);
  if (direct.isSymbolicLink() || !info.isFile()) throw new Error('worker asset is not a real file');
  if (executable && (info.mode & 0o111) === 0)
    throw new Error('worker executable is not executable');
}

function assertLaunchAssetBindings(authorization: SupervisorAuthorization): void {
  const node = authorization.runtime_assets.assets.find(
    (asset) => asset.role === 'node' && asset.real_path === authorization.worker.node_executable,
  );
  if (node === undefined) throw new Error('worker Node executable is not a sealed runtime asset');
  const entrypoint = authorization.runtime_assets.assets.find(
    (asset) => asset.real_path === authorization.worker.entrypoint,
  );
  if (entrypoint === undefined || entrypoint.role !== 'plugin_runtime') {
    throw new Error('worker entrypoint is not a sealed plugin runtime asset');
  }
  const payload = authorization.worker.launch_payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('worker launch payload is invalid');
  }
  const fields = payload as Record<string, unknown>;
  if (fields.authorization !== authorization.authorization_token) {
    throw new Error('worker launch payload is not bound to this private authorization');
  }
  if (fields.asset_digest_sha256 !== authorization.runtime_assets.digest_sha256) {
    throw new Error('worker launch payload is not bound to the sealed runtime assets');
  }
  if (sha256OfJson(fields.runtime_assets) !== sha256OfJson(authorization.runtime_assets)) {
    throw new Error('worker launch payload does not contain the sealed runtime asset pins');
  }
}

function runtimeExecutable(authorization: SupervisorAuthorization) {
  const node = authorization.runtime_assets.assets.find(
    (asset) => asset.role === 'node' && asset.real_path === authorization.worker.node_executable,
  );
  if (node === undefined) throw new Error('worker Node executable is not a sealed runtime asset');
  return {
    real_path: node.real_path,
    device: node.device,
    inode: node.inode,
    sha256: node.sha256,
  };
}

function processGroupStatus(processGroupId: number): 'alive' | 'absent' | 'unknown' {
  try {
    process.kill(-processGroupId, 0);
    return 'alive';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

async function waitForGroupAbsence(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupStatus(processGroupId) === 'absent') return true;
    await delay(25);
  }
  return processGroupStatus(processGroupId) === 'absent';
}

async function cleanupProcessGroup(
  processGroupId: number,
  terminateMs: number,
  killMs: number,
): Promise<'confirmed' | 'unconfirmed'> {
  const initial = processGroupStatus(processGroupId);
  if (initial === 'absent') return 'confirmed';
  if (initial === 'unknown') return 'unconfirmed';
  try {
    process.kill(-processGroupId, 'SIGTERM');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') return 'unconfirmed';
  }
  if (await waitForGroupAbsence(processGroupId, terminateMs)) return 'confirmed';
  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') return 'unconfirmed';
  }
  return (await waitForGroupAbsence(processGroupId, killMs)) ? 'confirmed' : 'unconfirmed';
}

function sendWorkerPayload(worker: ChildProcess, payload: unknown): Promise<void> {
  const channel = worker.stdio[3];
  if (channel === null || channel === undefined || !('write' in channel)) {
    throw new Error('worker authorization channel is unavailable');
  }
  return new Promise((resolve, reject) => {
    channel.end(encodeSupervisorMessage(payload), (error?: Error | null) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function captureBounded(
  stream: Readable | null,
  limit: number,
  kind: 'stdout' | 'stderr',
  onLimit: (kind: 'stdout' | 'stderr') => void,
  onChunk?: (chunk: Buffer | string) => void,
): void {
  if (stream === null) return;
  let bytes = 0;
  let chunkHandler = onChunk;
  stream.on('data', (chunk: Buffer | string) => {
    if (chunkHandler !== undefined) {
      try {
        chunkHandler(chunk);
      } catch {
        // Progress is advisory. A full or damaged control directory must not
        // crash the supervisor before it records worker cleanup.
        chunkHandler = undefined;
      }
    }
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) {
      stream.destroy();
      onLimit(kind);
    }
  });
}

async function waitForWorker(child: ChildProcess): Promise<{
  readonly exitCode?: number;
  readonly signal?: string;
}> {
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      });
    });
  });
}

function journalPath(authorization: SupervisorAuthorization, kind: 'runtime' | 'exit'): string {
  const name = `launch-${authorization.generation}-${kind}.json`;
  if (basename(name) !== name) throw new Error('invalid supervisor journal name');
  return join(authorization.control_directory, name);
}

function closeProgressWriter(writer: SupervisorProgressWriter | undefined): void {
  try {
    writer?.close();
  } catch {
    // Runtime and cleanup evidence must still be journaled. A corrupt or
    // unwritable progress stream is handled separately by status projection.
  }
}

export interface RunSupervisorOptions {
  readonly authorizationFd?: number;
  readonly responseFd?: number;
  readonly observeProcess?: (
    pid: number,
    expectedProcessGroup: number,
    expectedBirthToken: string,
  ) => Promise<SupervisorProcessObservation>;
  readonly verifyRuntimeAssets?: typeof verifyMcpRuntimeAssets;
}

async function verifyAssetsBeforeSpawn(
  authorization: SupervisorAuthorization,
  verify: typeof verifyMcpRuntimeAssets,
): Promise<void> {
  const controller = new AbortController();
  try {
    await Promise.race([
      verify(authorization.runtime_assets),
      delay(authorization.limits.worker_start_ms, undefined, { signal: controller.signal }).then(
        () => {
          throw new Error('runtime asset verification timed out before worker spawn');
        },
      ),
    ]);
  } finally {
    controller.abort();
  }
}

function processBirthToken(): string {
  const argument = process.argv.find((value) => value.startsWith(MCP_PROCESS_TOKEN_ARGUMENT));
  const token = argument?.slice(MCP_PROCESS_TOKEN_ARGUMENT.length);
  if (token === undefined || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(token)) {
    throw new Error('supervisor process identity token is missing or invalid');
  }
  return token;
}

export async function runSupervisor(options: RunSupervisorOptions = {}): Promise<void> {
  const authorizationFd = options.authorizationFd ?? 3;
  const responseFd = options.responseFd ?? 4;
  const processObserver = options.observeProcess ?? observeProcess;
  const assetVerifier = options.verifyRuntimeAssets ?? verifyMcpRuntimeAssets;
  const authorizationStream: ReadStream = createReadStream('/dev/null', {
    fd: authorizationFd,
    autoClose: false,
  });
  const responseStream: WriteStream = createWriteStream('/dev/null', {
    fd: responseFd,
    autoClose: false,
  });
  // The parent may disappear after authorization. A closed response pipe must
  // not crash the supervisor before it journals worker cleanup.
  responseStream.on('error', () => undefined);
  const reader = new BoundedLineReader(authorizationStream);
  const supervisor = await processObserver(process.pid, process.pid, processBirthToken());
  await writeMessage(
    responseStream,
    SupervisorHelloV1.parse({
      schema_version: 1,
      kind: 'supervisor_ready',
      supervisor,
    }),
  );

  let authorization: SupervisorAuthorization;
  try {
    authorization = decodeSupervisorMessage(await reader.read(), SupervisorAuthorizationV1);
    assertPrivateDirectory(authorization.control_directory);
    await verifyAssetsBeforeSpawn(authorization, assetVerifier);
    assertLaunchAssetBindings(authorization);
    assertPinnedWorkerPath(authorization.worker.node_executable, true);
    assertPinnedWorkerPath(authorization.worker.entrypoint, false);
  } catch (error) {
    await writeMessage(
      responseStream,
      SupervisorLaunchFailureV1.parse({
        schema_version: 1,
        kind: 'launch_failed',
        stage: 'authorization',
        message: describeError(error),
        cleanup_confirmed: true,
      }),
    ).catch(() => undefined);
    throw error;
  }

  const authorizationSha256 = createHash('sha256')
    .update(authorization.authorization_token, 'utf8')
    .digest('hex');
  let worker: ChildProcess;
  const workerBirthToken = randomUUID();
  try {
    worker = spawn(
      authorization.worker.node_executable,
      [authorization.worker.entrypoint, `${MCP_PROCESS_TOKEN_ARGUMENT}${workerBirthToken}`],
      {
        cwd: authorization.control_directory,
        detached: true,
        env: mcpTransientEnvironment(process.env),
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    await writeMessage(
      responseStream,
      SupervisorLaunchFailureV1.parse({
        schema_version: 1,
        kind: 'launch_failed',
        stage: 'worker_spawn',
        message: describeError(error),
        cleanup_confirmed: true,
      }),
    );
    throw error;
  }
  const workerResult: Promise<{ readonly exitCode?: number; readonly signal?: string }> =
    waitForWorker(worker).catch(() => ({}));
  if (worker.pid === undefined) {
    await workerResult;
    const error = new Error('worker did not provide a process ID');
    await writeMessage(
      responseStream,
      SupervisorLaunchFailureV1.parse({
        schema_version: 1,
        kind: 'launch_failed',
        stage: 'worker_spawn',
        message: error.message,
        cleanup_confirmed: true,
      }),
    ).catch(() => undefined);
    throw error;
  }

  let runtime: SupervisorProcessObservation;
  let progressWriter: SupervisorProgressWriter | undefined;
  try {
    runtime = await processObserver(worker.pid, worker.pid, workerBirthToken);
    const runtimeJournal = RuntimeJournalV1.parse({
      schema_version: 1,
      record_kind: 'circuit.mcp.runtime-observation',
      run_id: authorization.run_id,
      generation: authorization.generation,
      authorization_sha256: authorizationSha256,
      runtime,
      runtime_executable: runtimeExecutable(authorization),
      recorded_at: new Date().toISOString(),
    });
    writeJournalExclusive(journalPath(authorization, 'runtime'), runtimeJournal);
    progressWriter = new SupervisorProgressWriter({
      control_directory: authorization.control_directory,
      run_id: authorization.run_id,
      generation: authorization.generation,
    });
    await sendWorkerPayload(worker, authorization.worker.launch_payload);
  } catch (error) {
    const cleanup = await cleanupProcessGroup(
      worker.pid,
      authorization.limits.terminate_ms,
      authorization.limits.kill_ms,
    );
    closeProgressWriter(progressWriter);
    await writeMessage(
      responseStream,
      SupervisorLaunchFailureV1.parse({
        schema_version: 1,
        kind: 'launch_failed',
        stage: 'worker_identity',
        message: describeError(error),
        cleanup_confirmed: cleanup === 'confirmed',
      }),
    ).catch(() => undefined);
    throw error;
  }

  await writeMessage(
    responseStream,
    SupervisorRuntimeStartedV1.parse({
      schema_version: 1,
      kind: 'runtime_started',
      authorization_sha256: authorizationSha256,
      runtime,
    }),
  ).catch(() => undefined);
  responseStream.end();
  authorizationStream.destroy();

  let outputLimitExceeded: 'stdout' | 'stderr' | undefined;
  let resolveForcedCompletion: ((cleanup: 'confirmed' | 'unconfirmed') => void) | undefined;
  const forcedCompletion = new Promise<'confirmed' | 'unconfirmed'>((resolve) => {
    resolveForcedCompletion = resolve;
  });
  const stopForOutputLimit = (kind: 'stdout' | 'stderr'): void => {
    if (outputLimitExceeded !== undefined) return;
    outputLimitExceeded = kind;
    void cleanupProcessGroup(
      runtime.process_group_id,
      authorization.limits.terminate_ms,
      authorization.limits.kill_ms,
    ).then((cleanup) => resolveForcedCompletion?.(cleanup));
  };
  captureBounded(worker.stdout, authorization.limits.stdout_bytes, 'stdout', stopForOutputLimit);
  captureBounded(
    worker.stderr,
    authorization.limits.stderr_bytes,
    'stderr',
    stopForOutputLimit,
    (chunk) => progressWriter?.ingest(chunk),
  );
  const outcome = await Promise.race([
    workerResult.then((result) => ({ kind: 'worker' as const, result })),
    forcedCompletion.then((cleanup) => ({ kind: 'forced' as const, cleanup })),
  ]);
  const result = outcome.kind === 'worker' ? outcome.result : {};
  const cleanup =
    outcome.kind === 'forced'
      ? outcome.cleanup
      : await cleanupProcessGroup(
          runtime.process_group_id,
          authorization.limits.terminate_ms,
          authorization.limits.kill_ms,
        );
  closeProgressWriter(progressWriter);
  const exitJournal = ExitJournalV1.parse({
    schema_version: 1,
    record_kind: 'circuit.mcp.exit-observation',
    run_id: authorization.run_id,
    generation: authorization.generation,
    authorization_sha256: authorizationSha256,
    runtime,
    observed_at: new Date().toISOString(),
    ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    process_group_cleanup: cleanup,
    ...(outputLimitExceeded === undefined ? {} : { output_limit_exceeded: outputLimitExceeded }),
  });
  writeJournalExclusive(journalPath(authorization, 'exit'), exitJournal);
}

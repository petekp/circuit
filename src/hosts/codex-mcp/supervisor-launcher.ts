import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  LifecycleExecutableIdentity,
  LifecycleProcessIdentity,
  LifecycleWorkerLaunch,
} from './lifecycle-types.js';
import {
  SupervisorHelloV1,
  SupervisorMessageV1,
  type SupervisorRuntimeAssets,
  SupervisorRuntimeStartedV1,
  decodeSupervisorMessage,
  encodeSupervisorMessage,
} from './supervisor-protocol.js';
import { BoundedLineReader } from './supervisor-runtime.js';
import { MCP_PROCESS_TOKEN_ARGUMENT } from './supervisor-runtime.js';
import { mcpTransientEnvironment } from './transient-environment.js';

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
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

async function stopAndConfirmSupervisor(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const initial = processGroupStatus(processGroupId);
  if (initial === 'absent') return true;
  if (initial === 'unknown') return false;
  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupStatus(processGroupId) === 'absent') return true;
    await delay(20);
  }
  return processGroupStatus(processGroupId) === 'absent';
}

export class SupervisorLaunchError extends Error {
  readonly cleanup_confirmed: boolean;

  constructor(message: string, cleanupConfirmed: boolean) {
    super(message);
    this.name = 'SupervisorLaunchError';
    this.cleanup_confirmed = cleanupConfirmed;
  }
}

function writeAuthorization(channel: Writable, value: unknown): Promise<void> {
  const bytes = encodeSupervisorMessage(value);
  return new Promise((resolve, reject) => {
    channel.end(bytes, (error?: Error | null) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function processIdentity(
  observation: {
    readonly pid: number;
    readonly process_group_id: number;
    readonly birth_token: string;
    readonly started_at: string;
  },
  executable: LifecycleExecutableIdentity,
): LifecycleProcessIdentity {
  return { ...observation, executable };
}

function childChannel(child: ChildProcess, index: number): Readable | Writable {
  const channel = child.stdio[index];
  if (channel === null || channel === undefined) {
    throw new Error(`supervisor channel ${index} is unavailable`);
  }
  return channel;
}

export interface BeginSupervisorLaunchInput {
  readonly run_id: string;
  readonly generation: number;
  readonly control_directory: string;
  readonly runtime_assets: SupervisorRuntimeAssets;
}

export interface AuthorizeSupervisorInput {
  readonly worker: LifecycleWorkerLaunch;
}

export interface SupervisorLaunchSession {
  readonly supervisor: LifecycleProcessIdentity;
  readonly authorization_token: string;
  readonly authorization_sha256: string;
  readonly authorize: (input: AuthorizeSupervisorInput) => Promise<LifecycleProcessIdentity>;
  readonly closeBeforeAuthorization: () => Promise<boolean>;
}

export interface SupervisorLauncher {
  readonly begin: (input: BeginSupervisorLaunchInput) => Promise<SupervisorLaunchSession>;
}

export interface ProcessSupervisorLauncherOptions {
  readonly nodeExecutable: string;
  readonly nodeIdentity: LifecycleExecutableIdentity;
  readonly supervisorEntrypoint: string;
  readonly verifySupervisorEntrypoint: () => Promise<void>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly helloTimeoutMs?: number;
  readonly workerStartMs?: number;
  readonly terminateMs?: number;
  readonly killMs?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

export class ProcessSupervisorLauncher implements SupervisorLauncher {
  readonly #options: Required<
    Omit<ProcessSupervisorLauncherOptions, 'environment' | 'spawnProcess'>
  > & {
    readonly environment: NodeJS.ProcessEnv;
    readonly spawnProcess: NonNullable<ProcessSupervisorLauncherOptions['spawnProcess']>;
  };

  constructor(options: ProcessSupervisorLauncherOptions) {
    this.#options = {
      ...options,
      environment: mcpTransientEnvironment(options.environment ?? process.env),
      helloTimeoutMs: options.helloTimeoutMs ?? 5_000,
      workerStartMs: options.workerStartMs ?? 5_000,
      terminateMs: options.terminateMs ?? 3_000,
      killMs: options.killMs ?? 3_000,
      stdoutBytes: options.stdoutBytes ?? 16 * 1_048_576,
      stderrBytes: options.stderrBytes ?? 1_048_576,
      spawnProcess:
        options.spawnProcess ??
        ((executable, args, spawnOptions) => spawn(executable, [...args], spawnOptions)),
    };
  }

  async begin(input: BeginSupervisorLaunchInput): Promise<SupervisorLaunchSession> {
    try {
      await this.#options.verifySupervisorEntrypoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SupervisorLaunchError(message, true);
    }
    const supervisorBirthToken = randomUUID();
    let child: ChildProcess;
    try {
      child = this.#options.spawnProcess(
        this.#options.nodeExecutable,
        [
          this.#options.supervisorEntrypoint,
          `${MCP_PROCESS_TOKEN_ARGUMENT}${supervisorBirthToken}`,
        ],
        {
          cwd: input.control_directory,
          detached: true,
          env: this.#options.environment,
          stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SupervisorLaunchError(message, true);
    }
    const childError = new Promise<Error>((resolve) => {
      child.once('error', (error) => resolve(error));
    });
    if (child.pid === undefined) {
      const error = await Promise.race([
        childError,
        delay(100).then(() => new Error('supervisor did not provide a process ID')),
      ]);
      throw new SupervisorLaunchError(error.message, true);
    }
    const childPid = child.pid;
    const supervisorStderr = child.stderr;
    let stderrText = '';
    supervisorStderr?.on('data', (chunk: Buffer | string) => {
      if (stderrText.length >= 8_192) return;
      stderrText += Buffer.from(chunk)
        .toString('utf8')
        .slice(0, 8_192 - stderrText.length);
    });
    let authorization: Writable;
    let responses: Readable;
    let reader: BoundedLineReader;
    let hello: ReturnType<typeof SupervisorHelloV1.parse>;
    try {
      const authorizationChannel = childChannel(child, 3);
      if (!(authorizationChannel instanceof Writable)) {
        throw new Error('supervisor authorization pipe is invalid');
      }
      authorization = authorizationChannel;
      const responseChannel = childChannel(child, 4);
      if (!(responseChannel instanceof Readable)) {
        throw new Error('supervisor response pipe is invalid');
      }
      responses = responseChannel;
      reader = new BoundedLineReader(responses);
      hello = decodeSupervisorMessage(
        await reader.read(this.#options.helloTimeoutMs),
        SupervisorHelloV1,
      );
      if (hello.supervisor.pid !== childPid || hello.supervisor.process_group_id !== childPid) {
        throw new Error('supervisor identity does not match its spawned process group');
      }
      if (hello.supervisor.birth_token !== supervisorBirthToken) {
        throw new Error('supervisor identity token does not match its spawned process');
      }
    } catch (error) {
      const confirmed = await stopAndConfirmSupervisor(childPid, this.#options.killMs);
      const baseMessage = error instanceof Error ? error.message : String(error);
      const message =
        stderrText.trim().length === 0 ? baseMessage : `${baseMessage}: ${stderrText.trim()}`;
      throw new SupervisorLaunchError(message, confirmed);
    }

    const authorizationToken = randomBytes(32).toString('hex');
    const authorizationSha256 = createHash('sha256')
      .update(authorizationToken, 'utf8')
      .digest('hex');
    let used = false;
    let closed = false;

    return {
      supervisor: processIdentity(hello.supervisor, this.#options.nodeIdentity),
      authorization_token: authorizationToken,
      authorization_sha256: authorizationSha256,
      authorize: async ({ worker }) => {
        if (used || closed) throw new Error('supervisor launch session is already closed');
        used = true;
        try {
          await writeAuthorization(authorization, {
            schema_version: 1,
            kind: 'launch_authorization',
            authorization_token: authorizationToken,
            run_id: input.run_id,
            generation: input.generation,
            control_directory: input.control_directory,
            runtime_assets: input.runtime_assets,
            worker: {
              node_executable: this.#options.nodeExecutable,
              entrypoint: worker.worker_entrypoint,
              launch_payload: worker.launch_payload,
            },
            limits: {
              worker_start_ms: this.#options.workerStartMs,
              terminate_ms: this.#options.terminateMs,
              kill_ms: this.#options.killMs,
              stdout_bytes: this.#options.stdoutBytes,
              stderr_bytes: this.#options.stderrBytes,
            },
          });
          const message = decodeSupervisorMessage(await reader.read(), SupervisorMessageV1);
          if (message.kind === 'launch_failed') {
            const supervisorCleanupConfirmed = await stopAndConfirmSupervisor(
              childPid,
              this.#options.killMs,
            );
            throw new SupervisorLaunchError(
              message.message,
              message.cleanup_confirmed && supervisorCleanupConfirmed,
            );
          }
          const started = SupervisorRuntimeStartedV1.parse(message);
          if (started.authorization_sha256 !== authorizationSha256) {
            throw new Error('supervisor returned the wrong launch authorization');
          }
          if (
            started.runtime.pid !== started.runtime.process_group_id ||
            started.runtime.pid === hello.supervisor.pid
          ) {
            throw new Error('worker identity does not name its own process group');
          }
          closed = true;
          return processIdentity(started.runtime, this.#options.nodeIdentity);
        } catch (error) {
          if (error instanceof SupervisorLaunchError) throw error;
          await stopAndConfirmSupervisor(childPid, this.#options.killMs);
          const message = error instanceof Error ? error.message : String(error);
          // A broken response does not prove whether a worker was launched.
          throw new SupervisorLaunchError(message, false);
        } finally {
          responses.destroy();
          supervisorStderr?.destroy();
          child.unref();
        }
      },
      closeBeforeAuthorization: async () => {
        if (used || closed) return false;
        closed = true;
        authorization.destroy();
        responses.destroy();
        supervisorStderr?.destroy();
        return await stopAndConfirmSupervisor(childPid, this.#options.killMs);
      },
    };
  }
}

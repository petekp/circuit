import { spawnSync } from 'node:child_process';

import type { LifecycleProcessIdentity } from './lifecycle-types.js';
import type { LifecycleProcessProbe, LifecycleProcessStatus } from './process-cleanup.js';
import { MCP_PROCESS_TOKEN_ARGUMENT } from './supervisor-runtime.js';

interface PsObservation {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: Error;
}

export interface MacOsProcessProbeOptions {
  readonly runPs?: (pid: number) => PsObservation;
  readonly inspectGroup?: (processGroupId: number) => LifecycleProcessStatus;
  readonly signalGroup?: (
    processGroupId: number,
    signal: 'SIGTERM' | 'SIGKILL',
  ) => 'sent' | 'absent' | 'unknown';
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function defaultPs(pid: number): PsObservation {
  const result = spawnSync(
    '/bin/ps',
    ['-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'command=', '-p', String(pid)],
    {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 16_384,
      env: { LANG: 'C', LC_ALL: 'C' },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function defaultGroupStatus(processGroupId: number): LifecycleProcessStatus {
  try {
    process.kill(-processGroupId, 0);
    return 'alive';
  } catch (error) {
    return errorCode(error) === 'ESRCH' ? 'absent' : 'unknown';
  }
}

function defaultSignalGroup(
  processGroupId: number,
  signal: 'SIGTERM' | 'SIGKILL',
): 'sent' | 'absent' | 'unknown' {
  try {
    process.kill(-processGroupId, signal);
    return 'sent';
  } catch (error) {
    return errorCode(error) === 'ESRCH' ? 'absent' : 'unknown';
  }
}

function parsePs(
  value: string,
): { readonly pid: number; readonly processGroupId: number; readonly command: string } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(value);
  if (match === null) return undefined;
  const pid = Number.parseInt(match[1] ?? '', 10);
  const processGroupId = Number.parseInt(match[2] ?? '', 10);
  const command = match[3] ?? '';
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(processGroupId) || command.length === 0) {
    return undefined;
  }
  return { pid, processGroupId, command };
}

export class MacOsProcessProbe implements LifecycleProcessProbe {
  readonly #runPs: (pid: number) => PsObservation;
  readonly #inspectGroup: (processGroupId: number) => LifecycleProcessStatus;
  readonly #signalGroup: NonNullable<MacOsProcessProbeOptions['signalGroup']>;

  constructor(options: MacOsProcessProbeOptions = {}) {
    this.#runPs = options.runPs ?? defaultPs;
    this.#inspectGroup = options.inspectGroup ?? defaultGroupStatus;
    this.#signalGroup = options.signalGroup ?? defaultSignalGroup;
  }

  inspectProcessNow(identity: LifecycleProcessIdentity): LifecycleProcessStatus {
    const result = this.#runPs(identity.pid);
    if (result.error !== undefined) return 'unknown';
    if (result.status === 1 && result.stdout.trim().length === 0) return 'absent';
    if (result.status !== 0) return 'unknown';
    const observed = parsePs(result.stdout);
    if (observed === undefined || observed.pid !== identity.pid) return 'unknown';
    if (observed.processGroupId !== identity.process_group_id) return 'unknown';
    if (
      observed.command !== identity.executable.real_path &&
      !observed.command.startsWith(`${identity.executable.real_path} `)
    ) {
      return 'unknown';
    }
    const tokenArgument = `${MCP_PROCESS_TOKEN_ARGUMENT}${identity.birth_token}`;
    return observed.command.split(/\s+/u).includes(tokenArgument) ? 'alive' : 'unknown';
  }

  inspectProcessGroupNow(identity: LifecycleProcessIdentity): LifecycleProcessStatus {
    const processStatus = this.inspectProcessNow(identity);
    const groupStatus = this.#inspectGroup(identity.process_group_id);
    if (processStatus === 'unknown' || groupStatus === 'unknown') return 'unknown';
    // POSIX does not reuse a process-group ID while members of that group
    // remain, so an absent leader with a live group still names its children.
    return groupStatus;
  }

  async inspectProcess(identity: LifecycleProcessIdentity): Promise<LifecycleProcessStatus> {
    return this.inspectProcessNow(identity);
  }

  async inspectProcessGroup(identity: LifecycleProcessIdentity): Promise<LifecycleProcessStatus> {
    return this.inspectProcessGroupNow(identity);
  }

  async signalProcessGroup(
    processGroupId: number,
    signal: 'SIGTERM' | 'SIGKILL',
  ): Promise<'sent' | 'absent' | 'unknown'> {
    return this.#signalGroup(processGroupId, signal);
  }
}

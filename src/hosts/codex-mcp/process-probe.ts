import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { ProcessIdentity, ProcessOwnerIdentity, ProcessStatus } from './state-store.js';

const UUID_PROCESS_TOKEN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHA256_PROCESS_TOKEN = '[0-9a-f]{64}';
const PROCESS_TOKEN = new RegExp(`^(?:${UUID_PROCESS_TOKEN}|${SHA256_PROCESS_TOKEN})$`, 'u');

export function isMcpProcessToken(value: string): boolean {
  return PROCESS_TOKEN.test(value);
}

export type ProcessSnapshot =
  | { readonly status: 'absent' | 'unknown' }
  | {
      readonly status: 'alive';
      readonly process_group_id: number;
      readonly birth_token: string;
      readonly process_token?: string;
    };

export interface ObservedProcessProbeDependencies {
  readonly readProcess: (pid: number) => ProcessSnapshot;
  readonly readProcessGroup: (processGroupId: number) => ProcessStatus;
  readonly readProcessToken?: (token: string) => ProcessStatus;
  readonly executableMatches: (identity: ProcessIdentity['executable']) => boolean;
  readonly signalProcessGroup: (
    processGroupId: number,
    signal: 'SIGTERM' | 'SIGKILL',
  ) => 'sent' | 'absent' | 'unknown';
}

export function readExecutableIdentity(path: string): ProcessIdentity['executable'] {
  if (!isAbsolute(path)) throw new Error('The host executable path must be absolute.');
  const realPath = realpathSync.native(path);
  const before = statSync(realPath);
  if (!before.isFile() || (before.mode & 0o111) === 0) {
    throw new Error('The host executable must be an executable regular file.');
  }
  const sha256 = createHash('sha256').update(readFileSync(realPath)).digest('hex');
  const after = statSync(realPath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mode !== after.mode ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error('The host executable changed while Circuit inspected it.');
  }
  return {
    real_path: realPath,
    device: String(after.dev),
    inode: String(after.ino),
    sha256,
  };
}

export class ObservedProcessProbe {
  readonly #dependencies: ObservedProcessProbeDependencies;

  constructor(dependencies: ObservedProcessProbeDependencies) {
    this.#dependencies = dependencies;
  }

  observeOwner(input: {
    readonly executable: ProcessIdentity['executable'];
    readonly instance_id: string;
    readonly pid?: number;
    readonly now?: () => Date;
  }): ProcessOwnerIdentity {
    const pid = input.pid ?? process.pid;
    const observed = this.#dependencies.readProcess(pid);
    if (observed.status !== 'alive' || !this.#dependencies.executableMatches(input.executable)) {
      throw new Error('Circuit could not prove the MCP server process identity.');
    }
    return {
      instance_id: input.instance_id,
      pid,
      process_group_id: observed.process_group_id,
      birth_token: observed.birth_token,
      started_at: (input.now ?? (() => new Date()))().toISOString(),
      executable: input.executable,
    };
  }

  inspectProcessSync(identity: ProcessIdentity): ProcessStatus {
    const observed = this.#dependencies.readProcess(identity.pid);
    if (observed.status !== 'alive') return observed.status;
    if (
      observed.process_group_id !== identity.process_group_id ||
      (observed.birth_token !== identity.birth_token &&
        observed.process_token !== identity.birth_token) ||
      !this.#dependencies.executableMatches(identity.executable)
    ) {
      return 'unknown';
    }
    return 'alive';
  }

  inspectProcessGroupSync(identity: ProcessIdentity): ProcessStatus {
    const leader = this.inspectProcessSync(identity);
    if (leader === 'unknown') return 'unknown';
    const group = this.#dependencies.readProcessGroup(identity.process_group_id);
    if (leader === 'absent') {
      // Once the exact leader is gone, an alive numeric PGID could already
      // belong to another process tree. Report uncertainty and never carry the
      // old signal authorization forward.
      return group === 'absent' ? 'absent' : 'unknown';
    }
    return group;
  }

  inspectProcessTokenSync(token: string): ProcessStatus {
    if (!isMcpProcessToken(token)) return 'unknown';
    return this.#dependencies.readProcessToken?.(token) ?? 'unknown';
  }

  async inspectProcess(identity: ProcessIdentity): Promise<ProcessStatus> {
    return this.inspectProcessSync(identity);
  }

  async inspectProcessGroup(identity: ProcessIdentity): Promise<ProcessStatus> {
    return this.inspectProcessGroupSync(identity);
  }

  async signalOwnedProcessGroup(
    identity: ProcessIdentity,
    signal: 'SIGTERM' | 'SIGKILL',
  ): Promise<'sent' | 'absent' | 'unknown'> {
    // Do not carry signal authority across an await or a previous inspection.
    // Re-read the full PID, group, private token/start time, and executable now,
    // then issue the group signal synchronously from the same call.
    const leader = this.inspectProcessSync(identity);
    if (leader !== 'alive') {
      return leader === 'absent' &&
        this.#dependencies.readProcessGroup(identity.process_group_id) === 'absent'
        ? 'absent'
        : 'unknown';
    }
    const group = this.#dependencies.readProcessGroup(identity.process_group_id);
    if (group !== 'alive') return group;
    return this.#dependencies.signalProcessGroup(identity.process_group_id, signal);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function processExists(pid: number): ProcessStatus {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

function psValue(pid: number, field: 'pgid' | 'lstart' | 'command'): string | undefined {
  const result = spawnSync('/bin/ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 16_384,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const value = result.stdout.trim();
  const maximum = field === 'command' ? 8_192 : 256;
  return value.length > 0 && value.length <= maximum ? value : undefined;
}

function readMacProcess(pid: number): ProcessSnapshot {
  const exists = processExists(pid);
  if (exists !== 'alive') return { status: exists };
  const groupText = psValue(pid, 'pgid');
  const birthToken = psValue(pid, 'lstart');
  if (groupText === undefined || birthToken === undefined) return { status: 'unknown' };
  const processGroupId = Number.parseInt(groupText, 10);
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return { status: 'unknown' };
  const command = psValue(pid, 'command');
  const processToken = new RegExp(
    `(?:^|\\s)--circuit-mcp-process-token=(${UUID_PROCESS_TOKEN}|${SHA256_PROCESS_TOKEN})(?:\\s|$)`,
    'u',
  ).exec(command ?? '')?.[1];
  return {
    status: 'alive',
    process_group_id: processGroupId,
    birth_token: birthToken,
    ...(processToken === undefined ? {} : { process_token: processToken }),
  };
}

export function processTokenStatusFromPsOutput(token: string, output: string): ProcessStatus {
  if (!isMcpProcessToken(token)) return 'unknown';
  const exactArgument = new RegExp(`(?:^|\\s)--circuit-mcp-process-token=${token}(?:\\s|$)`, 'u');
  return output.split('\n').some((command) => exactArgument.test(command)) ? 'alive' : 'absent';
}

function readProcessToken(token: string): ProcessStatus {
  if (!isMcpProcessToken(token)) return 'unknown';
  const result = spawnSync('/bin/ps', ['-ww', '-axo', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 4 * 1_048_576,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') {
    return 'unknown';
  }
  return processTokenStatusFromPsOutput(token, result.stdout);
}

function readProcessGroup(processGroupId: number): ProcessStatus {
  try {
    process.kill(-processGroupId, 0);
    return 'alive';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: 'SIGTERM' | 'SIGKILL',
): 'sent' | 'absent' | 'unknown' {
  try {
    process.kill(-processGroupId, signal);
    return 'sent';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

function createExecutableMatcher(): (identity: ProcessIdentity['executable']) => boolean {
  const cached = new Map<string, { readonly mtimeMs: number; readonly ctimeMs: number }>();
  return (identity) => {
    try {
      if (realpathSync.native(identity.real_path) !== identity.real_path) return false;
      const info = statSync(identity.real_path);
      if (
        !info.isFile() ||
        String(info.dev) !== identity.device ||
        String(info.ino) !== identity.inode
      ) {
        return false;
      }
      const key = `${identity.real_path}\0${identity.device}\0${identity.inode}\0${identity.sha256}`;
      const prior = cached.get(key);
      if (prior?.mtimeMs === info.mtimeMs && prior.ctimeMs === info.ctimeMs) return true;
      const sha256 = createHash('sha256').update(readFileSync(identity.real_path)).digest('hex');
      if (sha256 !== identity.sha256) return false;
      cached.set(key, { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      return true;
    } catch {
      return false;
    }
  };
}

export function createMacOsProcessProbe(): ObservedProcessProbe {
  return new ObservedProcessProbe({
    readProcess: readMacProcess,
    readProcessGroup,
    readProcessToken,
    executableMatches: createExecutableMatcher(),
    signalProcessGroup,
  });
}

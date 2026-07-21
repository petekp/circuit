import { setTimeout as delay } from 'node:timers/promises';

import type { LifecycleCleanupController, LifecycleProcessIdentity } from './lifecycle-types.js';

export type LifecycleProcessStatus = 'alive' | 'absent' | 'unknown';

export interface LifecycleProcessProbe {
  /** Checks PID, executable identity, and birth token together. */
  readonly inspectProcess: (identity: LifecycleProcessIdentity) => Promise<LifecycleProcessStatus>;
  /** Checks the recorded process group without treating EPERM as absence. */
  readonly inspectProcessGroup: (
    identity: LifecycleProcessIdentity,
  ) => Promise<LifecycleProcessStatus>;
  readonly signalProcessGroup: (
    processGroupId: number,
    signal: 'SIGTERM' | 'SIGKILL',
  ) => Promise<'sent' | 'absent' | 'unknown'>;
}

export interface ObservedCleanupControllerOptions {
  readonly probe: LifecycleProcessProbe;
  readonly terminateMs?: number;
  readonly killMs?: number;
  readonly pollMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

async function waitForAbsence(
  probe: LifecycleProcessProbe,
  identity: LifecycleProcessIdentity,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<LifecycleProcessStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await probe.inspectProcessGroup(identity);
    if (status !== 'alive') return status;
    await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return await probe.inspectProcessGroup(identity);
}

async function stopOneGroup(
  probe: LifecycleProcessProbe,
  identity: LifecycleProcessIdentity,
  terminateMs: number,
  killMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<LifecycleProcessStatus> {
  const process = await probe.inspectProcess(identity);
  const group = await probe.inspectProcessGroup(identity);
  if (process === 'unknown' || group === 'unknown') return 'unknown';
  if (group === 'absent') return process === 'absent' ? 'absent' : 'unknown';

  // A live group with an absent leader is still the recorded worker tree.
  // A live replacement at the recorded PID is never signalled because the
  // birth token and executable identity check above would return unknown.
  const term = await probe.signalProcessGroup(identity.process_group_id, 'SIGTERM');
  if (term === 'unknown') return 'unknown';
  let after = await waitForAbsence(probe, identity, terminateMs, pollMs, wait);
  if (after !== 'alive') return after;
  const kill = await probe.signalProcessGroup(identity.process_group_id, 'SIGKILL');
  if (kill === 'unknown') return 'unknown';
  after = await waitForAbsence(probe, identity, killMs, pollMs, wait);
  return after;
}

export class ObservedCleanupController implements LifecycleCleanupController {
  readonly #probe: LifecycleProcessProbe;
  readonly #terminateMs: number;
  readonly #killMs: number;
  readonly #pollMs: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: ObservedCleanupControllerOptions) {
    this.#probe = options.probe;
    this.#terminateMs = options.terminateMs ?? 3_000;
    this.#killMs = options.killMs ?? 3_000;
    this.#pollMs = options.pollMs ?? 25;
    this.#wait = options.wait ?? (async (milliseconds) => await delay(milliseconds));
  }

  async cancel(
    input: Parameters<LifecycleCleanupController['cancel']>[0],
  ): ReturnType<LifecycleCleanupController['cancel']> {
    const runtime = input.run.launch.runtime;
    const supervisor = input.run.launch.supervisor;
    const runtimeStatus =
      runtime === undefined
        ? undefined
        : await stopOneGroup(
            this.#probe,
            runtime,
            this.#terminateMs,
            this.#killMs,
            this.#pollMs,
            this.#wait,
          );
    const supervisorStatus =
      supervisor === undefined
        ? 'absent'
        : await stopOneGroup(
            this.#probe,
            supervisor,
            this.#terminateMs,
            this.#killMs,
            this.#pollMs,
            this.#wait,
          );
    const processGroupStatus: LifecycleProcessStatus =
      runtimeStatus === 'unknown' || supervisorStatus === 'unknown'
        ? 'unknown'
        : runtimeStatus === 'alive' || supervisorStatus === 'alive'
          ? 'alive'
          : 'absent';
    return {
      cleanup_confirmed: processGroupStatus === 'absent',
      supervisor_status: supervisorStatus,
      ...(runtimeStatus === undefined ? {} : { runtime_status: runtimeStatus }),
      process_group_status: processGroupStatus,
    };
  }
}

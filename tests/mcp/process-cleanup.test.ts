import { describe, expect, it, vi } from 'vitest';

import type { LifecycleRunRecord } from '../../src/hosts/codex-mcp/lifecycle-types.js';
import {
  type LifecycleProcessProbe,
  type LifecycleProcessStatus,
  ObservedCleanupController,
} from '../../src/hosts/codex-mcp/process-cleanup.js';

const NOW = '2026-07-21T08:00:00.000Z';
const EXECUTABLE = {
  real_path: '/usr/local/bin/node',
  device: '1',
  inode: '2',
  sha256: 'a'.repeat(64),
};
const OWNER = {
  instance_id: 'server-one',
  pid: 10,
  process_group_id: 10,
  birth_token: 'server-birth',
  started_at: NOW,
  executable: EXECUTABLE,
};
const SUPERVISOR = {
  pid: 20,
  process_group_id: 20,
  birth_token: 'supervisor-birth',
  started_at: NOW,
  executable: EXECUTABLE,
};
const RUNTIME = {
  pid: 30,
  process_group_id: 30,
  birth_token: 'runtime-birth',
  started_at: NOW,
  executable: EXECUTABLE,
};

function run(): LifecycleRunRecord {
  return {
    revision: 1,
    run_id: '11111111-1111-4111-8111-111111111111',
    workspace: {
      key: 'b'.repeat(64),
      canonical_path: '/tmp/workspace',
      device: '1',
      inode: '4',
    },
    request: { flow: 'review', goal: 'Review', web_search: 'off' },
    state: 'cancelling',
    summary: 'Cancelling.',
    runtime_assets_sha256: 'c'.repeat(64),
    updated_at: NOW,
    allocation: { owner: OWNER, created_at: NOW },
    launch: {
      generation: 1,
      allocation_owner: OWNER,
      phase: 'runtime_recorded',
      supervisor: SUPERVISOR,
      runtime: RUNTIME,
      authorization_sha256: 'd'.repeat(64),
      authorized_at: NOW,
    },
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
  };
}

function probeWith(statuses: Map<number, LifecycleProcessStatus>): {
  readonly probe: LifecycleProcessProbe;
  readonly signals: ReturnType<typeof vi.fn>;
} {
  const signals = vi.fn(async (identity: typeof RUNTIME) => {
    statuses.set(identity.process_group_id, 'absent');
    statuses.set(identity.pid, 'absent');
    return 'sent' as const;
  });
  return {
    signals,
    probe: {
      inspectProcess: async (identity) => statuses.get(identity.pid) ?? 'unknown',
      inspectProcessGroup: async (identity) => statuses.get(identity.process_group_id) ?? 'unknown',
      signalOwnedProcessGroup: signals,
    },
  };
}

describe('observed MCP process cleanup', () => {
  it('reports confirmed cleanup only after both recorded groups are absent', async () => {
    const { probe, signals } = probeWith(
      new Map([
        [SUPERVISOR.pid, 'absent'],
        [RUNTIME.pid, 'absent'],
      ]),
    );
    const cleanup = new ObservedCleanupController({ probe, wait: async () => undefined });
    await expect(cleanup.cancel({ workspace: run().workspace, run: run() })).resolves.toEqual({
      cleanup_confirmed: true,
      supervisor_status: 'absent',
      runtime_status: 'absent',
      process_group_status: 'absent',
    });
    expect(signals).not.toHaveBeenCalled();
  });

  it('signals the runtime group before its supervisor and confirms observation', async () => {
    const { probe, signals } = probeWith(
      new Map([
        [SUPERVISOR.pid, 'alive'],
        [RUNTIME.pid, 'alive'],
      ]),
    );
    const cleanup = new ObservedCleanupController({
      probe,
      wait: async () => undefined,
      terminateMs: 10,
      killMs: 10,
    });
    const result = await cleanup.cancel({ workspace: run().workspace, run: run() });
    expect(result.cleanup_confirmed).toBe(true);
    expect(signals.mock.calls.map((entry) => entry[0].process_group_id)).toEqual([
      RUNTIME.process_group_id,
      SUPERVISOR.process_group_id,
    ]);
  });

  it('stops without signalling when exact identity is unknown', async () => {
    const { probe, signals } = probeWith(
      new Map([
        [SUPERVISOR.pid, 'absent'],
        [RUNTIME.pid, 'unknown'],
      ]),
    );
    const cleanup = new ObservedCleanupController({ probe, wait: async () => undefined });
    const result = await cleanup.cancel({ workspace: run().workspace, run: run() });
    expect(result).toMatchObject({
      cleanup_confirmed: false,
      runtime_status: 'unknown',
      process_group_status: 'unknown',
    });
    expect(signals).not.toHaveBeenCalled();
  });

  it('does not signal descendants after the exact worker leader is already absent', async () => {
    let runtimeProcessChecks = 0;
    const group = new Map<number, LifecycleProcessStatus>([
      [SUPERVISOR.pid, 'absent'],
      [RUNTIME.pid, 'alive'],
    ]);
    const signals = vi.fn(async () => 'sent' as const);
    const probe: LifecycleProcessProbe = {
      inspectProcess: async (identity) => {
        if (identity.pid === RUNTIME.pid) {
          runtimeProcessChecks += 1;
          return 'absent';
        }
        return 'absent';
      },
      inspectProcessGroup: async (identity) => group.get(identity.process_group_id) ?? 'unknown',
      signalOwnedProcessGroup: signals,
    };
    const cleanup = new ObservedCleanupController({ probe, wait: async () => undefined });
    const result = await cleanup.cancel({ workspace: run().workspace, run: run() });
    expect(result).toMatchObject({
      cleanup_confirmed: false,
      runtime_status: 'unknown',
      process_group_status: 'unknown',
    });
    expect(runtimeProcessChecks).toBeGreaterThan(0);
    expect(signals).not.toHaveBeenCalled();
  });

  it('leaves the supervisor alive when worker cleanup is uncertain', async () => {
    const signals = vi.fn(async () => 'sent' as const);
    const probe: LifecycleProcessProbe = {
      inspectProcess: async (identity) => (identity.pid === RUNTIME.pid ? 'absent' : 'alive'),
      inspectProcessGroup: async () => 'alive',
      signalOwnedProcessGroup: signals,
    };
    const cleanup = new ObservedCleanupController({ probe, wait: async () => undefined });

    await expect(cleanup.cancel({ workspace: run().workspace, run: run() })).resolves.toEqual({
      cleanup_confirmed: false,
      supervisor_status: 'alive',
      runtime_status: 'unknown',
      process_group_status: 'unknown',
    });
    expect(signals).not.toHaveBeenCalled();
  });
});

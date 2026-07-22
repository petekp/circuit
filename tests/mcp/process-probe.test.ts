import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  ObservedProcessProbe,
  isMcpProcessToken,
  processTokenStatusFromPsOutput,
  readExecutableIdentity,
} from '../../src/hosts/codex-mcp/process-probe.js';
import type { ProcessIdentity } from '../../src/hosts/codex-mcp/state-store.js';

const IDENTITY: ProcessIdentity = {
  pid: 101,
  process_group_id: 101,
  birth_token: 'Mon Jul 20 02:00:00 2026',
  started_at: '2026-07-20T09:00:01.000Z',
  executable: {
    real_path: '/trusted/node',
    device: '1',
    inode: '2',
    sha256: 'a'.repeat(64),
  },
};

describe('Codex MCP process identity probe', () => {
  it('accepts UUID supervisor tokens and SHA-256 worker tokens as exact process arguments', () => {
    const workerToken = 'a'.repeat(64);
    const supervisorToken = '11111111-1111-4111-8111-111111111111';
    expect(isMcpProcessToken(workerToken)).toBe(true);
    expect(isMcpProcessToken(supervisorToken)).toBe(true);
    expect(isMcpProcessToken(`${workerToken}0`)).toBe(false);
    expect(
      processTokenStatusFromPsOutput(
        workerToken,
        `/usr/bin/node worker.mjs --circuit-mcp-process-token=${workerToken}\n`,
      ),
    ).toBe('alive');
    expect(
      processTokenStatusFromPsOutput(
        workerToken,
        `/usr/bin/node worker.mjs --circuit-mcp-process-token=${workerToken}0\n`,
      ),
    ).toBe('absent');
  });

  it('pins the real bytes and filesystem identity of a host executable', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-executable-'));
    const executable = resolve(root, 'node');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);

    expect(readExecutableIdentity(executable)).toMatchObject({
      real_path: realpathSync.native(executable),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('calls a process alive only when birth, group, and executable still match', async () => {
    const probe = new ObservedProcessProbe({
      readProcess: () => ({
        status: 'alive',
        process_group_id: 101,
        birth_token: IDENTITY.birth_token,
      }),
      readProcessGroup: () => 'alive',
      executableMatches: () => true,
      signalProcessGroup: () => 'sent',
    });

    await expect(probe.inspectProcess(IDENTITY)).resolves.toBe('alive');
    expect(probe.inspectProcessSync(IDENTITY)).toBe('alive');
    await expect(probe.inspectProcessGroup(IDENTITY)).resolves.toBe('alive');
    expect(
      probe.observeOwner({
        executable: IDENTITY.executable,
        instance_id: 'server-instance',
        pid: IDENTITY.pid,
        now: () => new Date('2026-07-20T09:00:01.000Z'),
      }),
    ).toMatchObject({
      instance_id: 'server-instance',
      pid: 101,
      process_group_id: 101,
      birth_token: IDENTITY.birth_token,
    });
  });

  it('fails closed when a PID or executable may have been replaced', async () => {
    const replacement = new ObservedProcessProbe({
      readProcess: () => ({
        status: 'alive',
        process_group_id: 101,
        birth_token: 'different process',
      }),
      readProcessGroup: () => 'alive',
      executableMatches: () => true,
      signalProcessGroup: () => 'sent',
    });
    const changedExecutable = new ObservedProcessProbe({
      readProcess: () => ({
        status: 'alive',
        process_group_id: 101,
        birth_token: IDENTITY.birth_token,
      }),
      readProcessGroup: () => 'alive',
      executableMatches: () => false,
      signalProcessGroup: () => 'sent',
    });

    await expect(replacement.inspectProcess(IDENTITY)).resolves.toBe('unknown');
    await expect(changedExecutable.inspectProcess(IDENTITY)).resolves.toBe('unknown');
  });

  it('accepts the private supervisor token as stronger birth evidence', async () => {
    const probe = new ObservedProcessProbe({
      readProcess: () => ({
        status: 'alive',
        process_group_id: 101,
        birth_token: 'operating-system start time',
        process_token: IDENTITY.birth_token,
      }),
      readProcessGroup: () => 'alive',
      executableMatches: () => true,
      signalProcessGroup: () => 'sent',
    });

    await expect(probe.inspectProcess(IDENTITY)).resolves.toBe('alive');
  });

  it('never signals a group unless the recorded leader identity still matches', async () => {
    const signal = vi.fn(() => 'sent' as const);
    const probe = new ObservedProcessProbe({
      readProcess: () => ({ status: 'unknown' }),
      readProcessGroup: () => 'alive',
      executableMatches: () => true,
      signalProcessGroup: signal,
    });

    await expect(probe.signalOwnedProcessGroup(IDENTITY, 'SIGTERM')).resolves.toBe('unknown');
    expect(signal).not.toHaveBeenCalled();
  });

  it('keeps global worker-token scans read-only when a replacement process retains the token', () => {
    const signal = vi.fn(() => 'sent' as const);
    const readProcessToken = vi.fn(() => 'alive' as const);
    const probe = new ObservedProcessProbe({
      readProcess: () => ({ status: 'unknown' }),
      readProcessGroup: () => 'alive',
      readProcessToken,
      executableMatches: () => true,
      signalProcessGroup: signal,
    });

    expect(probe.inspectProcessTokenSync('a'.repeat(64))).toBe('alive');
    expect(readProcessToken).toHaveBeenCalledWith('a'.repeat(64));
    expect(signal).not.toHaveBeenCalled();
  });

  it('revalidates the exact leader inside the signal call after a prior inspection', async () => {
    let snapshot:
      | { readonly status: 'absent' }
      | {
          readonly status: 'alive';
          readonly process_group_id: number;
          readonly birth_token: string;
        } = {
      status: 'alive',
      process_group_id: 101,
      birth_token: IDENTITY.birth_token,
    };
    const signal = vi.fn(() => 'sent' as const);
    const probe = new ObservedProcessProbe({
      readProcess: () => snapshot,
      readProcessGroup: () => 'alive',
      executableMatches: () => true,
      signalProcessGroup: signal,
    });

    await expect(probe.inspectProcessGroup(IDENTITY)).resolves.toBe('alive');
    snapshot = {
      status: 'alive',
      process_group_id: 101,
      birth_token: 'replacement leader',
    };

    // Another process group can receive the same numeric ID after inspection.
    // The old observation must not authorize a signal to that replacement.
    await expect(probe.signalOwnedProcessGroup(IDENTITY, 'SIGKILL')).resolves.toBe('unknown');
    expect(signal).not.toHaveBeenCalled();
  });
});

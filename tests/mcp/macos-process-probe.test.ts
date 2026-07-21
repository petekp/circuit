import { describe, expect, it, vi } from 'vitest';

import type { LifecycleProcessIdentity } from '../../src/hosts/codex-mcp/lifecycle-types.js';
import { MacOsProcessProbe } from '../../src/hosts/codex-mcp/macos-process-probe.js';
import { MCP_PROCESS_TOKEN_ARGUMENT } from '../../src/hosts/codex-mcp/supervisor-runtime.js';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const PROCESS: LifecycleProcessIdentity = {
  pid: 200,
  process_group_id: 200,
  birth_token: TOKEN,
  started_at: '2026-07-21T08:00:00.000Z',
  executable: {
    real_path: '/Applications/Codex.app/Contents/Resources/node',
    device: '1',
    inode: '2',
    sha256: 'a'.repeat(64),
  },
};

function command(token = TOKEN): string {
  return `  200  200 ${PROCESS.executable.real_path} supervisor.mjs ${MCP_PROCESS_TOKEN_ARGUMENT}${token}\n`;
}

describe('macOS MCP process probe', () => {
  it('requires PID, process group, executable, and unique token together', async () => {
    const probe = new MacOsProcessProbe({
      runPs: () => ({ status: 0, stdout: command() }),
      inspectGroup: () => 'alive',
    });
    await expect(probe.inspectProcess(PROCESS)).resolves.toBe('alive');
    await expect(probe.inspectProcessGroup(PROCESS)).resolves.toBe('alive');
  });

  it('treats PID reuse without the unique token as unknown', async () => {
    const probe = new MacOsProcessProbe({
      runPs: () => ({ status: 0, stdout: command('22222222-2222-4222-8222-222222222222') }),
      inspectGroup: () => 'alive',
    });
    await expect(probe.inspectProcess(PROCESS)).resolves.toBe('unknown');
    await expect(probe.inspectProcessGroup(PROCESS)).resolves.toBe('unknown');
  });

  it('reports exact absence and forwards only recorded group signals', async () => {
    const signalGroup = vi.fn(() => 'sent' as const);
    const probe = new MacOsProcessProbe({
      runPs: () => ({ status: 1, stdout: '' }),
      inspectGroup: () => 'absent',
      signalGroup,
    });
    await expect(probe.inspectProcess(PROCESS)).resolves.toBe('absent');
    await expect(probe.signalProcessGroup(200, 'SIGTERM')).resolves.toBe('sent');
    expect(signalGroup).toHaveBeenCalledWith(200, 'SIGTERM');
  });
});

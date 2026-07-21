import { describe, expect, it, vi } from 'vitest';

import {
  McpHostPreflightError,
  probeCodexHostCapabilities,
} from '../../src/hosts/codex-mcp/host-preflight.js';

const HELP = `
  --strict-config
  --ignore-user-config
  --ignore-rules
  --json
  --sandbox <MODE>
  --ephemeral
`;

const nested = {
  policy: {
    executable: '/trusted/codex',
    cliVersion: '0.144.3',
    workspace: '/trusted/workspace',
    tempRoot: '/trusted/control/probe/private',
    nodeExecutable: '/trusted/node/bin/node',
    nodeInstallationRoot: '/trusted/node',
    gitExecutable: '/usr/bin/git',
    searchMode: 'off' as const,
    defaultModel: 'gpt-5.4',
    allowedModels: new Set(['gpt-5.4']),
  },
  codexHome: '/trusted/control/probe/codex-home',
  environment: {},
};

const passingCanaries = {
  runToolSurfaceCanary: vi.fn(async () => {}),
  runSandboxCanary: vi.fn(async () => {}),
};

describe('Codex MCP host preflight', () => {
  it('proves version and the exact strict nested-Codex configuration without a paid model run', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.144.3\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: no transport configured; use --listen or enable remote control',
      });

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        ...passingCanaries,
      }),
    ).resolves.toMatchObject({
      codex_version: '0.144.3',
      strict_config: true,
      nested_sandbox: true,
    });
    expect(run).toHaveBeenNthCalledWith(
      2,
      '/trusted/codex',
      expect.arrayContaining([
        'exec',
        '--strict-config',
        '--ignore-user-config',
        '--ignore-rules',
        '--help',
      ]),
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      '/trusted/codex',
      expect.arrayContaining([
        'app-server',
        '--strict-config',
        '--listen',
        'off',
        '-c',
        'default_permissions="circuit_mcp"',
        '-c',
        'permissions.circuit_mcp.network.enabled=false',
        '-c',
        'features.shell_snapshot=false',
        '-c',
        'project_doc_max_bytes=0',
      ]),
    );
    expect(passingCanaries.runToolSurfaceCanary).toHaveBeenCalledWith(nested);
    expect(passingCanaries.runSandboxCanary).toHaveBeenCalledWith(nested);
    expect(passingCanaries.runSandboxCanary.mock.invocationCallOrder[0]).toBeLessThan(
      passingCanaries.runToolSurfaceCanary.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('fails closed when the strict probe exits unsuccessfully', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.144.3\n', stderr: '' })
      .mockReturnValueOnce({ status: 2, stdout: '', stderr: 'unknown config key' });

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        ...passingCanaries,
      }),
    ).rejects.toThrow(McpHostPreflightError);
  });

  it('fails when Codex does not strictly accept every fixed hardening key', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.144.3\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: unknown configuration field `features.plugin_hooks`',
      });

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        ...passingCanaries,
      }),
    ).rejects.toThrow(McpHostPreflightError);
  });

  it('fails closed when the real named sandbox canary finds an unsafe host', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.144.3\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: no transport configured; use --listen or enable remote control',
      });

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        runToolSurfaceCanary: async () => {},
        runSandboxCanary: async () => {
          throw new Error('shared temporary files remained writable');
        },
      }),
    ).rejects.toThrow(/shared temporary files/);
  });
});

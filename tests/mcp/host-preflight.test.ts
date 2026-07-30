import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  runSandboxCanary: vi.fn(async () => ({ shared_temp_isolation: 'isolated' as const })),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Codex MCP host preflight', () => {
  it.each([
    [
      'a relative pinned executable',
      'codex',
      { ...nested, policy: { ...nested.policy, executable: 'codex' } },
      /reinstall the Circuit plugin.*absolute Codex executable/i,
    ],
    [
      'a mismatched nested executable',
      '/trusted/codex',
      { ...nested, policy: { ...nested.policy, executable: '/other/codex' } },
      /reinstall the Circuit plugin.*pinned Codex executable/i,
    ],
  ] as const)('gives a specific remedy for %s', async (_label, executable, probe, nextAction) => {
    await expect(
      probeCodexHostCapabilities(executable, {
        run: vi.fn(),
        workspaceMetadataValidated: true,
        nested: probe,
        ...passingCanaries,
      }),
    ).rejects.toMatchObject({ nextAction: expect.stringMatching(nextAction) });
  });

  it('proves version and the exact strict nested-Codex configuration without a paid model run', async () => {
    const strictParseStopped = {
      status: 1,
      stdout: '',
      stderr: 'Error: no transport configured; use --listen or enable remote control',
    };
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce(strictParseStopped)
      .mockReturnValueOnce(strictParseStopped);

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        ...passingCanaries,
      }),
    ).resolves.toMatchObject({
      codex_version: '0.146.0',
      strict_config: true,
      nested_sandbox: true,
      shared_temp_isolation: 'isolated',
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
    // The prompt-only relay sends extra hardening fields, and older Codex
    // releases reject unknown fields under --strict-config. The probe must
    // prove the exact prompt-only shape too, not just the tool-run shape.
    const promptOnlyProbe = run.mock.calls[3];
    expect(promptOnlyProbe?.[1]).toEqual(
      expect.arrayContaining([
        'app-server',
        '--strict-config',
        'skills.include_instructions=false',
        'tools.update_plan.enabled=false',
        'features.shell_tool=false',
      ]),
    );
    expect(promptOnlyProbe?.[1]).not.toEqual(expect.arrayContaining(['features.shell_tool=true']));
    expect(passingCanaries.runToolSurfaceCanary).toHaveBeenCalledWith(nested);
    expect(passingCanaries.runSandboxCanary).toHaveBeenCalledWith(nested);
    expect(passingCanaries.runSandboxCanary.mock.invocationCallOrder[0]).toBeLessThan(
      passingCanaries.runToolSurfaceCanary.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('fails closed when the strict probe exits unsuccessfully', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockReturnValueOnce({ status: 2, stdout: '', stderr: 'unknown config key' });

    const failure = probeCodexHostCapabilities('/trusted/codex', {
      run,
      workspaceMetadataValidated: true,
      nested,
      ...passingCanaries,
    });
    await expect(failure).rejects.toThrow(McpHostPreflightError);
    await expect(failure).rejects.toMatchObject({
      message: expect.stringMatching(/unknown config key/),
    });
  });

  it('names the version floor when Codex is too old, before any config probe can speak', async () => {
    // A 0.145 host also fails the strict-config probe (it rejects the
    // prompt-only fields), but the operator's real problem is the version.
    // The floor check must run first so the message says "update to 0.146.0"
    // instead of quoting a config-field error.
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.145.0\n', stderr: '' });

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        ...passingCanaries,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/requires Codex 0\.146\.0 or newer.*reports 0\.145\.0/),
      nextAction: expect.stringMatching(/Update Codex to 0\.146\.0 or newer/),
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails when Codex does not strictly accept every fixed hardening key', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
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
    ).rejects.toMatchObject({
      message: expect.stringMatching(/strictly accept.*features\.plugin_hooks/is),
      nextAction: expect.stringMatching(/strict configuration/i),
    });
  });

  it('reports what Codex said when the strict probe fails for a non-config reason', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'No such file or directory (os error 2)',
      });

    await expect(
      probeCodexHostCapabilities('/trusted/codex', {
        run,
        workspaceMetadataValidated: true,
        nested,
        ...passingCanaries,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/os error 2/),
    });
  });

  it('keeps probes working after the host deletes the directory the server was launched from', async () => {
    // Codex 0.146 reinstalls the plugin cache after spawning the MCP server,
    // which deletes the server's working directory. Probes must not inherit
    // that doomed directory: the live failure was a strict-config probe that
    // died on current-directory resolution and was misread as a config
    // rejection. The fake Codex below mirrors the live behavior: --version and
    // exec --help never resolve the working directory, app-server does.
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'circuit-preflight-cwd-'));
    const fakeCodex = join(fixtureRoot, 'codex');
    writeFileSync(
      fakeCodex,
      `#!/bin/sh
case "$1" in
  --version)
    printf 'codex-cli 0.146.0\\n'
    exit 0
    ;;
  exec)
    printf -- '--strict-config\\n--ignore-user-config\\n--ignore-rules\\n--json\\n--sandbox <MODE>\\n--ephemeral\\n'
    exit 0
    ;;
  app-server)
    if ! "${process.execPath}" -e 'process.cwd()' 2>/dev/null; then
      printf 'No such file or directory (os error 2)\\n' >&2
      exit 1
    fi
    printf 'Error: no transport configured; use --listen or enable remote control\\n' >&2
    exit 1
    ;;
esac
exit 9
`,
    );
    chmodSync(fakeCodex, 0o755);
    const nodeExecutable = process.execPath;
    const policy = {
      ...nested.policy,
      executable: fakeCodex,
      workspace: fixtureRoot,
      tempRoot: join(fixtureRoot, 'private'),
      nodeExecutable,
      nodeInstallationRoot: dirname(dirname(nodeExecutable)),
    };
    const originalCwd = process.cwd();
    const doomed = mkdtempSync(join(tmpdir(), 'circuit-preflight-doomed-'));
    process.chdir(doomed);
    rmSync(doomed, { recursive: true, force: true });
    try {
      await expect(
        probeCodexHostCapabilities(fakeCodex, {
          workspaceMetadataValidated: true,
          environment: process.env,
          nested: {
            policy,
            codexHome: join(fixtureRoot, 'codex-home'),
            environment: {},
          },
          ...passingCanaries,
        }),
      ).resolves.toMatchObject({ codex_version: '0.146.0', strict_config: true });
    } finally {
      process.chdir(originalCwd);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('accepts Codex-equivalent shared temporary exposure and records it privately', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: no transport configured; use --listen or enable remote control',
      })
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
        runSandboxCanary: async () => ({ shared_temp_isolation: 'exposed' }),
      }),
    ).resolves.toMatchObject({
      nested_sandbox: true,
      shared_temp_isolation: 'exposed',
    });
  });

  it('fails closed when the real named sandbox canary finds an unsafe required boundary', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: no transport configured; use --listen or enable remote control',
      })
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
          throw new Error('a sibling file remained readable');
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/nested Codex sandbox.*sibling file/i),
      nextAction: expect.stringMatching(/sandbox capability/i),
    });
  });

  it('names a tool-surface canary failure and gives its own remedy', async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: HELP, stderr: '' })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: no transport configured; use --listen or enable remote control',
      })
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
        runSandboxCanary: async () => ({ shared_temp_isolation: 'isolated' }),
        runToolSurfaceCanary: async () => {
          throw new Error('an unexpected tool was enabled');
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/tool surface.*unexpected tool/i),
      nextAction: expect.stringMatching(/tool-surface capability/i),
    });
  });
});

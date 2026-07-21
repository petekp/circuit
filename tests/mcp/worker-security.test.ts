import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MacosProofSandbox } from '../../src/hosts/codex-mcp/proof-sandbox.js';
import type { SafeGitReader } from '../../src/hosts/codex-mcp/safe-git-reader.js';
import { createMcpWorkerSecurity } from '../../src/hosts/codex-mcp/worker-security.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { workspace: string; privateRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'circuit-worker-security-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const privateRoot = join(root, 'private');
  mkdirSync(join(workspace, 'packages', 'app'), { recursive: true });
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  return { workspace, privateRoot };
}

describe('MCP worker security adapters', () => {
  it('does not turn ambient package-manager PATH entries into sandbox read roots', () => {
    const { workspace, privateRoot } = fixture();
    const createSandbox = vi.fn(
      (_options: unknown) => ({ execute: vi.fn() }) as unknown as MacosProofSandbox,
    );

    createMcpWorkerSecurity(
      {
        workspace,
        privateRoot,
        gitExecutable: '/usr/bin/git',
        environment: {
          PATH: [
            '/Users/operator/.vite-plus/bin',
            '/Users/operator/Library/pnpm',
            '/Users/operator/.cargo/bin',
            '/usr/bin',
          ].join(':'),
        },
      },
      {
        createSandbox,
        createGitReader: () => ({ read: vi.fn() }) as unknown as SafeGitReader,
      },
    );

    expect(createSandbox).toHaveBeenCalledOnce();
    expect(createSandbox.mock.calls[0]?.[0]).not.toHaveProperty('toolchainReadRoots');
  });

  it('routes proof commands through the injected sandbox and preserves bounded results', async () => {
    const { workspace, privateRoot } = fixture();
    const execute = vi.fn(async () => ({
      schema_version: 1 as const,
      status: 'passed' as const,
      exit_code: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      truncated: false,
      duration_ms: 4,
      cleanup: { required: false, confirmed: true, observed_pids: [], remaining_pids: [] },
      sandbox: {
        provider: 'macos-seatbelt' as const,
        network: 'denied' as const,
        access: 'workspace-write' as const,
        writable_roots: [workspace, privateRoot],
        mach_services: [] as const,
      },
    }));
    const sandbox = { execute } as unknown as MacosProofSandbox;
    const safeGit = { read: vi.fn() } as unknown as SafeGitReader;
    const security = createMcpWorkerSecurity(
      {
        workspace,
        privateRoot,
        gitExecutable: '/usr/bin/git',
        environment: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      },
      {
        createSandbox: () => sandbox,
        createGitReader: () => safeGit,
      },
    );

    await expect(
      security.proofCommandRunner(
        {
          id: 'unit-tests',
          cwd: 'packages/app',
          argv: [process.execPath, '-e', 'process.exit(0)'],
          env: {},
          timeout_ms: 5_000,
          max_output_bytes: 1_000,
        },
        workspace,
      ),
    ).resolves.toMatchObject({ status: 'passed', stdout_summary: 'ok\n', timed_out: false });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'packages/app',
        argv: [process.execPath, '-e', 'process.exit(0)'],
      }),
    );
  });

  it.each([
    ['/tmp/operator-tool', 'absolute executable outside PATH'],
    ['../operator-tool', 'relative traversal'],
  ])('rejects an unsealed proof executable (%s: %s)', async (argv0) => {
    const { workspace, privateRoot } = fixture();
    const execute = vi.fn();
    const security = createMcpWorkerSecurity(
      {
        workspace,
        privateRoot,
        gitExecutable: '/usr/bin/git',
        environment: { PATH: '/usr/bin:/bin' },
      },
      {
        createSandbox: () => ({ execute }) as unknown as MacosProofSandbox,
        createGitReader: () => ({ read: vi.fn() }) as unknown as SafeGitReader,
      },
    );

    await expect(
      security.proofCommandRunner(
        {
          id: 'unsealed-tool',
          cwd: '.',
          argv: [argv0],
          env: {},
          timeout_ms: 5_000,
          max_output_bytes: 1_000,
        },
        workspace,
      ),
    ).rejects.toThrow(/outside the fixed proof toolchain/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards an allowed Git operation through the reader sealed to the workspace', async () => {
    const { workspace, privateRoot } = fixture();
    const result = {
      schema_version: 1 as const,
      ok: true,
      operation: 'staged_diff' as const,
      stdout: 'diff --git a/src/app.ts b/src/app.ts\n',
      stderr: '',
      exit_code: 0,
      truncated: false,
      limit_bytes: 2 * 1024 * 1024,
      submodules: [],
      submodule_policy: 'reported_without_recursive_execution' as const,
      attribute_policy: 'external_commands_disabled' as const,
      cleanup_confirmed: true,
    };
    const read = vi.fn(async () => result);
    const security = createMcpWorkerSecurity(
      {
        workspace,
        privateRoot,
        gitExecutable: '/usr/bin/git',
        environment: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      },
      {
        createSandbox: () => ({}) as MacosProofSandbox,
        createGitReader: () => ({ read }) as unknown as SafeGitReader,
      },
    );

    await expect(
      security.gitReader.read({ operation: 'staged_diff', projectRoot: workspace }),
    ).resolves.toBe(result);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ operation: 'staged_diff' });
  });

  it('fails closed when cleanup is uncertain and never rebinds Git to another root', async () => {
    const { workspace, privateRoot } = fixture();
    const sandbox = {
      execute: vi.fn(async () => ({
        schema_version: 1 as const,
        status: 'cleanup_unconfirmed' as const,
        exit_code: null,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        duration_ms: 1,
        cleanup: {
          required: true,
          confirmed: false,
          observed_pids: [123],
          remaining_pids: [123],
        },
        sandbox: {
          provider: 'macos-seatbelt' as const,
          network: 'denied' as const,
          access: 'workspace-write' as const,
          writable_roots: [workspace, privateRoot],
          mach_services: [] as const,
        },
      })),
    } as unknown as MacosProofSandbox;
    const safeGit = { read: vi.fn() } as unknown as SafeGitReader;
    const security = createMcpWorkerSecurity(
      {
        workspace,
        privateRoot,
        gitExecutable: '/usr/bin/git',
        environment: { PATH: '/usr/bin:/bin' },
      },
      { createSandbox: () => sandbox, createGitReader: () => safeGit },
    );

    await expect(
      security.proofCommandRunner(
        {
          id: 'leaked-child',
          cwd: '.',
          argv: [process.execPath, '-e', 'process.exit(0)'],
          env: {},
          timeout_ms: 5_000,
          max_output_bytes: 1_000,
        },
        workspace,
      ),
    ).rejects.toThrow(/cleanup could not be confirmed/);
    await expect(
      security.gitReader.read({ operation: 'status', projectRoot: join(workspace, 'nested') }),
    ).rejects.toThrow(/sealed to the trusted workspace/);
    expect(safeGit.read).not.toHaveBeenCalled();
  });

  it.each(['timed_out', 'cancelled', 'output_limit'] as const)(
    'never turns %s with exit code zero into passing proof',
    async (status) => {
      const { workspace, privateRoot } = fixture();
      const sandbox = {
        execute: vi.fn(async () => ({
          schema_version: 1 as const,
          status,
          exit_code: 0,
          signal: null,
          stdout: '',
          stderr: '',
          truncated: status === 'output_limit',
          duration_ms: 1,
          cleanup: {
            required: true,
            confirmed: true,
            observed_pids: [],
            remaining_pids: [],
          },
          sandbox: {
            provider: 'macos-seatbelt' as const,
            network: 'denied' as const,
            access: 'workspace-write' as const,
            writable_roots: [workspace, privateRoot],
            mach_services: [] as const,
          },
        })),
      } as unknown as MacosProofSandbox;
      const security = createMcpWorkerSecurity(
        {
          workspace,
          privateRoot,
          gitExecutable: '/usr/bin/git',
          environment: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
        },
        {
          createSandbox: () => sandbox,
          createGitReader: () => ({ read: vi.fn() }) as unknown as SafeGitReader,
        },
      );

      await expect(
        security.proofCommandRunner(
          {
            id: 'stopped-proof',
            cwd: '.',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            env: {},
            timeout_ms: 5_000,
            max_output_bytes: 1_000,
          },
          workspace,
        ),
      ).resolves.toMatchObject({
        exit_code: 1,
        status: 'failed',
        timed_out: status === 'timed_out',
      });
    },
  );
});

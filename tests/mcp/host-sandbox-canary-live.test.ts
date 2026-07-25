import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  runCodexNestedSandboxCanary,
  runCodexToolSurfaceCanary,
} from '../../src/hosts/codex-mcp/host-sandbox-canary.js';
import {
  derivePinnedNodeInstallation,
  resolveCodexExecutableOnPath,
} from '../../src/hosts/codex-mcp/production-paths.js';

const enabled = process.platform === 'darwin' && process.env.CIRCUIT_MCP_LIVE_SECURITY === '1';
const suite = enabled ? describe : describe.skip;
const cleanup: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

suite('live no-spend Codex security canaries', () => {
  it('parses the final config locally, closes external tools, and reports current sandbox safety', async () => {
    const workspaceParent = join(process.cwd(), '.mcp-security-live');
    await mkdir(workspaceParent, { recursive: true, mode: 0o700 });
    cleanup.push(workspaceParent);
    const workspace = await mkdtemp(join(workspaceParent, 'workspace-'));
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'circuit-live-security-'));
    cleanup.push(fixtureRoot);
    const tempRoot = join(fixtureRoot, 'private');
    const codexHome = join(fixtureRoot, 'codex-home');
    await Promise.all([
      mkdir(tempRoot, { recursive: true, mode: 0o700 }),
      mkdir(codexHome, { recursive: true, mode: 0o700 }),
    ]);
    const node = derivePinnedNodeInstallation(process.execPath);
    const codex = resolveCodexExecutableOnPath(process.env.PATH);
    const input = {
      policy: {
        executable: codex,
        cliVersion: '0.144.3',
        workspace,
        tempRoot,
        nodeExecutable: node.executable,
        nodeInstallationRoot: node.root,
        gitExecutable: '/usr/bin/git',
        searchMode: 'off' as const,
        defaultModel: 'gpt-5.4',
        allowedModels: new Set(['gpt-5.4']),
      },
      codexHome,
      environment: process.env,
    };

    const sandbox = await runCodexNestedSandboxCanary(input);
    expect(['isolated', 'exposed']).toContain(sandbox.shared_temp_isolation);
    await expect(runCodexToolSurfaceCanary(input)).resolves.toBeUndefined();
    await expect(
      runCodexToolSurfaceCanary({
        ...input,
        policy: { ...input.policy, searchMode: 'cached' as const },
      }),
    ).resolves.toBeUndefined();
    // Three sequential nested-Codex probes, each with its own fail-closed
    // budget. The ceiling has to clear all three on the slowest supported host.
  }, 180_000);
});

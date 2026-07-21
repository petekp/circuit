import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pinMcpRuntimeAssets } from '../../src/hosts/codex-mcp/asset-pins.js';
import { createMcpRuntimeContext } from '../../src/hosts/codex-mcp/runtime-context.js';

describe('sealed Codex MCP runtime context', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'circuit-mcp-context-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('seals trusted workspace, assets, policies, and injected boundaries together', async () => {
    const node = join(root, 'node');
    const codex = join(root, 'codex');
    const runtime = join(root, 'server.js');
    const git = join(root, 'git.js');
    const flow = join(root, 'review.json');
    await Promise.all([
      writeFile(node, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(codex, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(runtime, 'server\n'),
      writeFile(git, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(flow, '{}\n'),
    ]);
    const assets = await pinMcpRuntimeAssets({
      node,
      codex,
      plugin_runtimes: [{ id: 'server', path: runtime }],
      git_helper: git,
      packaged_flows: [{ id: 'review', path: flow }],
    });
    const workspaceStat = await stat(root);
    const proofExecutor = { run: vi.fn() };
    const gitReader = { read: vi.fn() };
    const cancellation = { cancel: vi.fn() };

    const context = createMcpRuntimeContext({
      workspace: {
        metadata_key: 'codex/sandbox-state-meta',
        workspace: root,
      },
      workspaceIdentity: {
        device: String(workspaceStat.dev),
        inode: String(workspaceStat.ino),
      },
      capabilities: {
        codex_version: '0.144.3',
        minimum_version: '0.144.3',
        plugin_mcp: true,
        strict_config: true,
        workspace_metadata: true,
      },
      assets,
      search: { mode: 'off', consented: false },
      proofExecutor,
      gitReader,
      cancellation,
    });

    expect(context.workspace.canonical_path).toBe(root);
    expect(context.codex.executable).toBe(
      assets.assets.find((asset) => asset.id === 'codex')?.real_path,
    );
    expect(context.user_hooks).toBe('disabled');
    expect(context.history).toBe('disabled');
    expect(context.extra_write_roots).toEqual([]);
    expect(context.proofExecutor).toBe(proofExecutor);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.workspace)).toBe(true);
  });

  it('requires explicit consent for cached search and rejects live search at the type boundary', () => {
    expect(() =>
      createMcpRuntimeContext({
        workspace: {
          metadata_key: 'codex/sandbox-state-meta',
          workspace: root,
        },
        workspaceIdentity: { device: '1', inode: '1' },
        capabilities: {
          codex_version: '0.144.3',
          minimum_version: '0.144.3',
          plugin_mcp: true,
          strict_config: true,
          workspace_metadata: true,
        },
        assets: {
          schema_version: 1,
          digest_sha256: 'a'.repeat(64),
          assets: [],
        },
        search: { mode: 'cached', consented: false },
        proofExecutor: { run: vi.fn() },
        gitReader: { read: vi.fn() },
        cancellation: { cancel: vi.fn() },
      }),
    ).toThrow(/consent/);
  });
});

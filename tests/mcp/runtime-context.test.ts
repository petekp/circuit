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
    const proofExecutor = vi.fn();
    const gitReader = { read: vi.fn() };
    const cancellation = {
      owner: 'supervisor' as const,
      process_group_cleanup: 'observed' as const,
      run_id: '019f64f5-1f4d-7d91-8cda-a309cc72c300',
    };

    const context = createMcpRuntimeContext({
      workspace: {
        identity_source: 'mcp/roots',
        workspace: root,
      },
      workspaceIdentity: {
        device: String(workspaceStat.dev),
        inode: String(workspaceStat.ino),
      },
      capabilities: {
        codex_version: '0.146.0',
        minimum_version: '0.146.0',
        plugin_mcp: true,
        strict_config: true,
        workspace_metadata: true,
        nested_sandbox: true,
        shared_temp_isolation: 'exposed',
      },
      assets,
      search: { mode: 'off', consented: false },
      proofExecutor,
      gitReader,
      cancellation,
    });

    expect(context.workspace.canonical_path).toBe(root);
    expect(context.workspace.identity_source).toBe('mcp/roots');
    expect(context.codex.executable).toBe(
      assets.assets.find((asset) => asset.id === 'codex')?.real_path,
    );
    expect(context.codex.pinned_real_path).toBe(
      assets.assets.find((asset) => asset.id === 'codex')?.real_path,
    );
    expect(context.user_hooks).toBe('disabled');
    expect(context.history).toBe('disabled');
    expect(context.shared_temp_isolation).toBe('exposed');
    expect(context.configured_extra_write_roots).toEqual([]);
    expect(context).not.toHaveProperty('extra_write_roots');
    expect(context.proofExecutor).toBe(proofExecutor);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.workspace)).toBe(true);
  });

  it('requires explicit consent for cached search and rejects live search at the type boundary', () => {
    expect(() =>
      createMcpRuntimeContext({
        workspace: {
          identity_source: 'codex/sandbox-state-meta',
          workspace: root,
        },
        workspaceIdentity: { device: '1', inode: '1' },
        capabilities: {
          codex_version: '0.146.0',
          minimum_version: '0.146.0',
          plugin_mcp: true,
          strict_config: true,
          workspace_metadata: true,
          nested_sandbox: true,
          shared_temp_isolation: 'isolated',
        },
        assets: {
          schema_version: 1,
          digest_sha256: 'a'.repeat(64),
          assets: [],
        },
        search: { mode: 'cached', consented: false },
        proofExecutor: vi.fn(),
        gitReader: { read: vi.fn() },
        cancellation: {
          owner: 'supervisor',
          process_group_cleanup: 'observed',
          run_id: '019f64f5-1f4d-7d91-8cda-a309cc72c300',
        },
      }),
    ).toThrow(/consent/);
  });
});

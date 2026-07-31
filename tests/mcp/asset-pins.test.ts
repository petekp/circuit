import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AssetDriftError,
  pinMcpRuntimeAssets,
  pinMcpRuntimeAssetsSettled,
  verifyMcpRuntimeAssets,
} from '../../src/hosts/codex-mcp/asset-pins.js';

describe('Codex MCP installed asset pins', () => {
  let root: string;
  let nodePath: string;
  let codexPath: string;
  let serverRuntimePath: string;
  let workerRuntimePath: string;
  let gitHelperPath: string;
  let flowPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'circuit-mcp-pins-'));
    nodePath = join(root, 'node');
    codexPath = join(root, 'codex');
    serverRuntimePath = join(root, 'server.js');
    workerRuntimePath = join(root, 'worker.js');
    gitHelperPath = join(root, 'git-state.js');
    flowPath = join(root, 'review.json');
    await Promise.all([
      writeFile(nodePath, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(codexPath, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(serverRuntimePath, 'server\n', { mode: 0o600 }),
      writeFile(workerRuntimePath, 'worker\n', { mode: 0o600 }),
      writeFile(gitHelperPath, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(flowPath, '{"flow":"review"}\n', { mode: 0o600 }),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function pin() {
    return pinMcpRuntimeAssets({
      node: nodePath,
      codex: codexPath,
      plugin_runtimes: [
        { id: 'server', path: serverRuntimePath },
        { id: 'worker', path: workerRuntimePath },
      ],
      git_helper: gitHelperPath,
      packaged_flows: [{ id: 'review', path: flowPath }],
    });
  }

  it('pins the real path, file identity, bytes, and one combined digest', async () => {
    const pins = await pin();
    expect(pins.schema_version).toBe(1);
    expect(pins.assets.map((asset) => asset.id)).toEqual([
      'node',
      'codex',
      'plugin_runtime:server',
      'plugin_runtime:worker',
      'git_helper',
      'flow:review',
    ]);
    expect(pins.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true);
    expect(pins.digest_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyMcpRuntimeAssets(pins)).resolves.toBeUndefined();
    expect(Object.isFrozen(pins)).toBe(true);
    expect(Object.isFrozen(pins.assets)).toBe(true);
  });

  it('blocks byte replacement before start or resume', async () => {
    const pins = await pin();
    await writeFile(flowPath, '{"flow":"changed"}\n');
    await expect(verifyMcpRuntimeAssets(pins)).rejects.toBeInstanceOf(AssetDriftError);
  });

  it('accepts a same-content replacement that only changed file identity', async () => {
    // Codex reinstalls the plugin cache at session start. The reinstall writes
    // byte-identical files under the same paths with fresh inodes; that must
    // not kill the first launch.
    const pins = await pin();
    await rm(flowPath);
    await writeFile(flowPath, '{"flow":"review"}\n', { mode: 0o600 });
    await rm(serverRuntimePath);
    await writeFile(serverRuntimePath, 'server\n', { mode: 0o600 });
    const replaced = await pin();
    const flowBefore = pins.assets.find((asset) => asset.id === 'flow:review');
    const flowAfter = replaced.assets.find((asset) => asset.id === 'flow:review');
    expect(flowAfter?.inode).not.toBe(flowBefore?.inode);
    await expect(verifyMcpRuntimeAssets(pins)).resolves.toBeUndefined();
  });

  it('blocks a source symlink that is retargeted after pinning', async () => {
    const first = join(root, 'first-codex');
    const second = join(root, 'second-codex');
    const link = join(root, 'codex-link');
    await writeFile(first, '#!/bin/sh\n', { mode: 0o700 });
    await writeFile(second, '#!/bin/sh\n# replacement\n', { mode: 0o700 });
    await symlink(first, link);
    codexPath = link;
    const pins = await pin();
    await rm(link);
    await symlink(second, link);
    await expect(verifyMcpRuntimeAssets(pins)).rejects.toThrow(/changed/);
  });

  it('retries pinning through a transient cache reinstall, then succeeds', async () => {
    // A pin that lands while Codex is rewriting the plugin cache sees files
    // change mid-hash or vanish for a moment. Settling through that window
    // must not surface as a failed start.
    let calls = 0;
    const pins = await pinMcpRuntimeAssetsSettled(
      {
        node: nodePath,
        codex: codexPath,
        plugin_runtimes: [{ id: 'server', path: serverRuntimePath }],
        git_helper: gitHelperPath,
        packaged_flows: [{ id: 'review', path: flowPath }],
      },
      {
        pin: async (paths) => {
          calls += 1;
          if (calls === 1)
            throw new AssetDriftError('server asset changed while Circuit was hashing it');
          if (calls === 2) throw new Error('server asset could not be resolved: ENOENT');
          return pinMcpRuntimeAssets(paths);
        },
        delayMs: 1,
      },
    );
    expect(calls).toBe(3);
    expect(pins.digest_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not retry pinning on a permanent validation failure', async () => {
    let calls = 0;
    await expect(
      pinMcpRuntimeAssetsSettled(
        {
          node: nodePath,
          codex: codexPath,
          plugin_runtimes: [{ id: 'server', path: serverRuntimePath }],
          git_helper: gitHelperPath,
          packaged_flows: [{ id: 'review', path: flowPath }],
        },
        {
          pin: async () => {
            calls += 1;
            throw new Error('codex asset must be executable');
          },
          delayMs: 1,
        },
      ),
    ).rejects.toThrow(/executable/);
    expect(calls).toBe(1);
  });

  it('gives up settling after bounded attempts', async () => {
    let calls = 0;
    await expect(
      pinMcpRuntimeAssetsSettled(
        {
          node: nodePath,
          codex: codexPath,
          plugin_runtimes: [{ id: 'server', path: serverRuntimePath }],
          git_helper: gitHelperPath,
          packaged_flows: [{ id: 'review', path: flowPath }],
        },
        {
          pin: async () => {
            calls += 1;
            throw new AssetDriftError('server asset changed while Circuit was hashing it');
          },
          delayMs: 1,
        },
      ),
    ).rejects.toBeInstanceOf(AssetDriftError);
    expect(calls).toBe(5);
  });

  it('rejects relative paths, directories, duplicate flow ids, and non-executable tools', async () => {
    await expect(
      pinMcpRuntimeAssets({
        node: 'node',
        codex: codexPath,
        plugin_runtimes: [{ id: 'server', path: serverRuntimePath }],
        git_helper: gitHelperPath,
        packaged_flows: [{ id: 'review', path: flowPath }],
      }),
    ).rejects.toThrow(/absolute/);

    const directory = join(root, 'directory');
    await mkdir(directory);
    await expect(
      pinMcpRuntimeAssets({
        node: nodePath,
        codex: codexPath,
        plugin_runtimes: [{ id: 'server', path: directory }],
        git_helper: gitHelperPath,
        packaged_flows: [{ id: 'review', path: flowPath }],
      }),
    ).rejects.toThrow(/regular file/);

    await expect(
      pinMcpRuntimeAssets({
        node: nodePath,
        codex: codexPath,
        plugin_runtimes: [{ id: 'server', path: serverRuntimePath }],
        git_helper: gitHelperPath,
        packaged_flows: [
          { id: 'review', path: flowPath },
          { id: 'review', path: flowPath },
        ],
      }),
    ).rejects.toThrow(/duplicate/);

    await expect(
      pinMcpRuntimeAssets({
        node: nodePath,
        codex: codexPath,
        plugin_runtimes: [
          { id: 'server', path: serverRuntimePath },
          { id: 'server', path: workerRuntimePath },
        ],
        git_helper: gitHelperPath,
        packaged_flows: [{ id: 'review', path: flowPath }],
      }),
    ).rejects.toThrow(/duplicate plugin runtime/);

    await chmod(codexPath, 0o600);
    await expect(pin()).rejects.toThrow(/executable/);
  });
});

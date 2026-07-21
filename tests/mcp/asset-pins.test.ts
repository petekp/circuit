import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AssetDriftError,
  pinMcpRuntimeAssets,
  verifyMcpRuntimeAssets,
} from '../../src/hosts/codex-mcp/asset-pins.js';

describe('Codex MCP installed asset pins', () => {
  let root: string;
  let nodePath: string;
  let codexPath: string;
  let runtimePath: string;
  let gitHelperPath: string;
  let flowPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'circuit-mcp-pins-'));
    nodePath = join(root, 'node');
    codexPath = join(root, 'codex');
    runtimePath = join(root, 'server.js');
    gitHelperPath = join(root, 'git-state.js');
    flowPath = join(root, 'review.json');
    await Promise.all([
      writeFile(nodePath, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(codexPath, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(runtimePath, 'server\n', { mode: 0o600 }),
      writeFile(gitHelperPath, 'git\n', { mode: 0o600 }),
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
      plugin_runtime: runtimePath,
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
      'plugin_runtime',
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

  it('rejects relative paths, directories, duplicate flow ids, and non-executable tools', async () => {
    await expect(
      pinMcpRuntimeAssets({
        node: 'node',
        codex: codexPath,
        plugin_runtime: runtimePath,
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
        plugin_runtime: directory,
        git_helper: gitHelperPath,
        packaged_flows: [{ id: 'review', path: flowPath }],
      }),
    ).rejects.toThrow(/regular file/);

    await expect(
      pinMcpRuntimeAssets({
        node: nodePath,
        codex: codexPath,
        plugin_runtime: runtimePath,
        git_helper: gitHelperPath,
        packaged_flows: [
          { id: 'review', path: flowPath },
          { id: 'review', path: flowPath },
        ],
      }),
    ).rejects.toThrow(/duplicate/);

    await chmod(codexPath, 0o600);
    await expect(pin()).rejects.toThrow(/executable/);
  });
});

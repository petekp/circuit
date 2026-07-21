import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertTrustedCodexExecutableUnchanged,
  discoverTrustedCodexExecutable,
  discoverTrustedCodexHome,
} from './host-discovery.mjs';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'circuit-mcp-host-')));
  tempRoots.push(root);
  return root;
}

async function fakeExecutable(candidate: string): Promise<void> {
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, '#!/bin/sh\nexit 0\n');
  await chmod(candidate, 0o755);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable trusted Codex host discovery', () => {
  it('prefers the MCP-host absolute path and never consults PATH', async () => {
    const root = await tempRoot();
    const trusted = path.join(root, 'trusted-codex');
    const poisonedPath = path.join(root, 'workspace-bin', 'codex');
    await fakeExecutable(trusted);
    await fakeExecutable(poisonedPath);
    const versionProbe = vi.fn(async () => 'codex-cli 1.2.3');
    const pin = await discoverTrustedCodexExecutable({
      env: {
        PATH: path.dirname(poisonedPath),
        CIRCUIT_MCP_CODEX_EXECUTABLE: trusted,
      },
      platform: 'linux',
      versionProbe,
    });
    expect(pin).toMatchObject({
      executable: trusted,
      source: 'CIRCUIT_MCP_CODEX_EXECUTABLE',
      version: 'codex-cli 1.2.3',
    });
    expect(versionProbe).toHaveBeenCalledWith(trusted);
  });

  it('fails closed on a bad explicit path instead of falling back', async () => {
    const root = await tempRoot();
    const bundled = path.join(root, 'ChatGPT.app/Contents/Resources/codex');
    await fakeExecutable(bundled);
    await expect(
      discoverTrustedCodexExecutable({
        env: { CIRCUIT_MCP_CODEX_EXECUTABLE: 'relative/codex' },
        platform: 'darwin',
        systemApplicationsRoot: root,
        versionProbe: async () => 'codex-cli 1.2.3',
      }),
    ).rejects.toThrow('must be absolute');
  });

  it('finds the ChatGPT-bundled Codex on macOS without PATH', async () => {
    const root = await tempRoot();
    const bundled = path.join(root, 'ChatGPT.app/Contents/Resources/codex');
    await fakeExecutable(bundled);
    await expect(
      discoverTrustedCodexExecutable({
        env: {},
        platform: 'darwin',
        systemApplicationsRoot: root,
        userApplicationsRoot: path.join(root, 'unused'),
        versionProbe: async () => 'codex-cli 9.9.9',
      }),
    ).resolves.toMatchObject({ executable: bundled, source: 'chatgpt-app-bundle' });
  });

  it('requires an explicit path on platforms with no trusted bundled location', async () => {
    await expect(
      discoverTrustedCodexExecutable({ env: { PATH: '/workspace/bin' }, platform: 'linux' }),
    ).rejects.toThrow('must provide CIRCUIT_MCP_CODEX_EXECUTABLE or CODEX_CLI_PATH');
  });

  it('rejects a binary that does not identify itself as Codex', async () => {
    const root = await tempRoot();
    const executable = path.join(root, 'not-codex');
    await fakeExecutable(executable);
    await expect(
      discoverTrustedCodexExecutable({
        env: { CODEX_CLI_PATH: executable },
        versionProbe: async () => 'other-cli 1.0.0',
      }),
    ).rejects.toThrow('unexpected version');
  });

  it('detects executable replacement after the host was pinned', async () => {
    const root = await tempRoot();
    const executable = path.join(root, 'codex');
    await fakeExecutable(executable);
    const versionProbe = async () => 'codex-cli 1.2.3';
    const pin = await discoverTrustedCodexExecutable({
      env: { CODEX_CLI_PATH: executable },
      versionProbe,
    });
    await writeFile(executable, '#!/bin/sh\n# replaced\nexit 0\n');
    await expect(assertTrustedCodexExecutableUnchanged(pin, { versionProbe })).rejects.toThrow(
      'changed after it was pinned',
    );
  });

  it('uses explicit CODEX_HOME or the normal home fallback and canonicalizes it', async () => {
    const root = await tempRoot();
    const explicit = path.join(root, 'explicit-codex-home');
    const fallback = path.join(root, 'user-home', '.codex');
    await mkdir(explicit, { recursive: true });
    await mkdir(fallback, { recursive: true });
    await expect(
      discoverTrustedCodexHome({ env: { CODEX_HOME: explicit }, homeDir: '/ignored' }),
    ).resolves.toEqual({ path: explicit, source: 'CODEX_HOME' });
    await expect(
      discoverTrustedCodexHome({ env: {}, homeDir: path.dirname(fallback) }),
    ).resolves.toEqual({ path: fallback, source: 'home-default' });
  });
});

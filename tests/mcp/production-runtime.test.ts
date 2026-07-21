import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SENTINEL_RUN_ID, seedWorkspaceSentinel } from '../../scripts/hosts/smoke/codex-mcp.js';
import {
  type McpRuntimeAssetPins,
  verifyMcpRuntimeAssets,
} from '../../src/hosts/codex-mcp/asset-pins.js';
import type { CodexModelRoster } from '../../src/hosts/codex-mcp/codex-model-roster.js';
import type { McpPublicFlowV1 } from '../../src/hosts/codex-mcp/contracts.js';
import type {
  LifecycleProcessOwnerIdentity,
  LifecycleRunRecord,
  LifecycleWorkspaceIdentity,
} from '../../src/hosts/codex-mcp/lifecycle-types.js';
import {
  createProductionAssetLoader,
  createProductionCircuitMcpHandler,
  createProductionLaunchPreflight,
  createProductionWorkerFactory,
  productionMcpLayout,
  resolvePrivateProductionCodexHome,
  resolveProductionCodexHome,
} from '../../src/hosts/codex-mcp/production-runtime.js';
import { parseMcpWorkerLaunch } from '../../src/hosts/codex-mcp/worker-runtime.js';

const roots: string[] = [];
const PRIVATE_TEST_ROOT = join(process.cwd(), '.mcp-host-tests');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateTestDirectory(prefix: string): Promise<string> {
  await mkdir(PRIVATE_TEST_ROOT, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(PRIVATE_TEST_ROOT, prefix)));
  roots.push(root);
  return root;
}

async function pluginTree(): Promise<{
  readonly root: string;
  readonly codexHome: string;
  readonly bin: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'circuit-mcp-production-'));
  roots.push(root);
  const plugin = join(root, 'plugin');
  const codexHome = join(root, 'codex-home');
  const bin = join(root, 'bin');
  await Promise.all([
    mkdir(join(plugin, '.codex-plugin'), { recursive: true }),
    mkdir(join(plugin, 'mcp'), { recursive: true }),
    mkdir(join(plugin, 'runtime'), { recursive: true }),
    mkdir(join(plugin, 'flows', 'review'), { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  for (const path of [
    join(plugin, '.codex-plugin', 'plugin.json'),
    join(plugin, '.mcp.json'),
    join(plugin, 'mcp', 'server.cjs'),
    join(plugin, 'mcp', 'server.mjs'),
    join(plugin, 'mcp', 'supervisor.mjs'),
    join(plugin, 'mcp', 'worker.mjs'),
    join(plugin, 'runtime', 'circuit.js'),
    join(plugin, 'runtime', 'git-state.js'),
    join(plugin, 'flows', 'catalog.json'),
    join(plugin, 'flows', 'review', 'circuit.json'),
  ]) {
    await writeFile(path, '{}\n');
  }
  for (const name of ['node', 'git']) {
    const path = join(bin, name);
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  await writeFile(
    join(bin, 'codex'),
    Buffer.concat([
      process.platform === 'darwin'
        ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from('native-codex'),
    ]),
    { mode: 0o700 },
  );
  return { root: plugin, codexHome, bin };
}

function pin(
  id: string,
  role: 'node' | 'codex' | 'plugin_runtime' | 'git_helper' | 'packaged_flow',
  path: string,
) {
  return {
    id,
    role,
    source_path: path,
    real_path: path,
    device: '1',
    inode: '2',
    mode: 0o100700,
    byte_length: 1,
    sha256: 'a'.repeat(64),
  };
}

function assets(root: string): McpRuntimeAssetPins {
  const digest = 'b'.repeat(64);
  return {
    schema_version: 1,
    digest_sha256: digest,
    assets: [
      pin('node', 'node', '/opt/node'),
      {
        ...pin('codex', 'codex', '/opt/codex-real'),
        source_path: '/opt/codex-launcher',
      },
      pin('plugin_runtime:worker', 'plugin_runtime', join(root, 'mcp', 'worker.mjs')),
      pin('plugin_runtime:supervisor', 'plugin_runtime', join(root, 'mcp', 'supervisor.mjs')),
      pin('git_helper', 'git_helper', '/usr/bin/git'),
      pin('flow:catalog', 'packaged_flow', join(root, 'flows', 'catalog.json')),
      pin('flow:review-circuit', 'packaged_flow', join(root, 'flows', 'review', 'circuit.json')),
    ],
  };
}

const owner: LifecycleProcessOwnerIdentity = {
  instance_id: 'server-1',
  pid: 100,
  process_group_id: 100,
  birth_token: 'owner',
  started_at: '2026-07-20T00:00:00.000Z',
  executable: {
    real_path: '/opt/node',
    device: '1',
    inode: '2',
    sha256: 'a'.repeat(64),
  },
};

const workspace: LifecycleWorkspaceIdentity = {
  key: 'c'.repeat(64),
  canonical_path: '/workspace',
  device: '10',
  inode: '20',
};

const fixtureNodeInstallation = () => ({
  executable: '/opt/node/bin/node',
  bin: '/opt/node/bin',
  root: '/opt/node',
});

function runRecord(): LifecycleRunRecord {
  return {
    revision: 0,
    run_id: '019f64f5-1f4d-7d91-8cda-a309cc72c300',
    workspace,
    request: { flow: 'review', goal: 'Review this change', web_search: 'off' },
    state: 'starting',
    summary: 'Starting Review.',
    runtime_assets_sha256: 'b'.repeat(64),
    updated_at: '2026-07-20T00:00:00.000Z',
    allocation: { owner, created_at: '2026-07-20T00:00:00.000Z' },
    launch: { generation: 1, allocation_owner: owner, phase: 'reserved' },
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
  };
}

describe('production Codex MCP composition', () => {
  it('uses the explicit Codex home or the standard home fallback, never a relative path', () => {
    expect(resolveProductionCodexHome({ CODEX_HOME: '/private/codex' })).toBe('/private/codex');
    expect(resolveProductionCodexHome({ HOME: '/Users/operator' })).toBe('/Users/operator/.codex');
    expect(() => resolveProductionCodexHome({ CODEX_HOME: 'relative' })).toThrow(/absolute/i);
    expect(() => resolveProductionCodexHome({})).toThrow(/CODEX_HOME/i);
  });

  it('keeps durable MCP control state outside canonical shared temporary roots', async () => {
    const safeParent = await privateTestDirectory('production-home-');
    const safeHome = join(safeParent, 'codex-home');
    await mkdir(safeHome, { recursive: true });

    await expect(resolvePrivateProductionCodexHome(safeHome)).resolves.toBe(
      await realpath(safeHome),
    );

    const sharedHome = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-shared-home-')));
    roots.push(sharedHome);
    await expect(resolvePrivateProductionCodexHome(sharedHome)).rejects.toThrow(
      /shared temporary directory/i,
    );

    const symlinkParent = join(safeParent, 'links');
    const symlinkHome = join(symlinkParent, 'codex-home');
    await mkdir(symlinkParent, { recursive: true });
    await symlink(sharedHome, symlinkHome, 'dir');
    await expect(resolvePrivateProductionCodexHome(symlinkHome)).rejects.toThrow(
      /shared temporary directory/i,
    );
  });

  it.skipIf(process.platform !== 'darwin')(
    'recognizes the canonical macOS aliases for both shared temp roots',
    async () => {
      for (const sharedRoot of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']) {
        await expect(resolvePrivateProductionCodexHome(sharedRoot)).rejects.toThrow(
          /shared temporary directory/i,
        );
      }
    },
  );

  it('rejects an intermediate state-directory symlink before opening control state', async () => {
    const safeParent = await privateTestDirectory('state-symlink-');
    const safeHome = join(safeParent, 'codex-home');
    const sharedTarget = await realpath(
      await mkdtemp(join(tmpdir(), 'circuit-mcp-shared-state-target-')),
    );
    roots.push(sharedTarget);
    await mkdir(safeHome, { recursive: true });
    await symlink(sharedTarget, join(safeHome, 'circuit'), 'dir');

    const processProbe = {
      inspectProcessSync: () => 'alive' as const,
      inspectProcessGroupSync: () => 'alive' as const,
      inspectProcessTokenSync: () => 'unknown' as const,
      inspectProcess: async () => 'alive' as const,
      inspectProcessGroup: async () => 'alive' as const,
      signalOwnedProcessGroup: async () => 'unknown' as const,
    };
    await expect(
      createProductionCircuitMcpHandler({
        pluginRoot: join(safeParent, 'plugin'),
        codexHome: safeHome,
        environment: { PATH: '' },
        platform: 'linux',
        owner,
        processProbe,
      }),
    ).rejects.toThrow(/state directory.*symbolic link/i);
    await expect(lstat(join(sharedTarget, 'mcp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps recovery tools available without loading drifted runtime assets', async () => {
    const root = await privateTestDirectory('lazy-server-');
    const pluginRoot = join(root, 'missing-plugin-assets');
    const codexHome = join(root, 'codex-home');
    const workspacePath = join(root, 'workspace');
    const otherWorkspacePath = join(root, 'other-workspace');
    await Promise.all([
      mkdir(pluginRoot, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      mkdir(workspacePath, { recursive: true }),
      mkdir(otherWorkspacePath, { recursive: true }),
    ]);
    seedWorkspaceSentinel(codexHome, workspacePath);
    const processProbe = {
      inspectProcessSync: () => 'alive' as const,
      inspectProcessGroupSync: () => 'alive' as const,
      inspectProcessTokenSync: () => 'unknown' as const,
      inspectProcess: async () => 'alive' as const,
      inspectProcessGroup: async () => 'alive' as const,
      signalOwnedProcessGroup: async () => 'unknown' as const,
    };
    const handler = await createProductionCircuitMcpHandler({
      pluginRoot,
      codexHome,
      environment: { PATH: '' },
      platform: 'linux',
      owner,
      processProbe,
    });
    const signal = new AbortController().signal;

    await expect(
      handler({
        name: 'circuit_list',
        input: {},
        metadata: undefined,
        listRoots: async () => [{ uri: workspacePath, name: 'workspace' }],
        signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      runs: [expect.objectContaining({ run_id: SENTINEL_RUN_ID })],
    });
    await expect(
      handler({
        name: 'circuit_list',
        input: {},
        metadata: undefined,
        signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'workspace_metadata_missing' },
    });
    await expect(
      handler({
        name: 'circuit_list',
        input: {},
        metadata: {
          'codex/sandbox-state-meta': { sandboxCwd: workspacePath },
        },
        signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      runs: [expect.objectContaining({ run_id: SENTINEL_RUN_ID })],
    });
    await expect(
      handler({
        name: 'circuit_list',
        input: {},
        metadata: {
          'codex/sandbox-state-meta': { sandboxCwd: otherWorkspacePath },
        },
        signal,
      }),
    ).resolves.toMatchObject({ ok: true, runs: [] });
    await expect(
      handler({
        name: 'circuit_start',
        input: { flow: 'review', goal: 'Review', web_search: 'off' },
        metadata: undefined,
        signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported_platform' },
    });
  });

  it('derives every executable and packaged asset from the installed plugin and host', async () => {
    const tree = await pluginTree();
    const layout = productionMcpLayout({
      pluginRoot: tree.root,
      codexHome: tree.codexHome,
      nodeExecutable: join(tree.bin, 'node'),
      gitExecutable: join(tree.bin, 'git'),
      pathValue: tree.bin,
    });

    expect(layout.stateRoot).toBe(join(tree.codexHome, 'circuit', 'mcp', 'v1'));
    expect(layout.codexExecutable).toBe(join(tree.bin, 'codex'));
    expect(layout.pluginRuntimes.map((asset) => asset.id)).toEqual([
      'manifest',
      'config',
      'server_shim',
      'server',
      'supervisor',
      'worker',
      'circuit',
      'git_state',
    ]);
    expect(layout.packagedFlows.map((asset) => asset.id)).toEqual(['catalog', 'review-circuit']);
  });

  it('pins the native executable behind an npm launcher so an unchanged launcher cannot hide replacement', async () => {
    const tree = await pluginTree();
    const installRoot = join(tree.root, '..');
    const packageRoot = join(installRoot, 'node_modules', '@openai', 'codex');
    const target =
      process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' }
          : { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' }
        : process.arch === 'arm64'
          ? { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' }
          : { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' };
    const platformPackageRoot = join(installRoot, 'node_modules', ...target.packageName.split('/'));
    const launcher = join(packageRoot, 'bin', 'codex.js');
    const native = join(platformPackageRoot, 'vendor', target.triple, 'bin', 'codex');
    await Promise.all([
      mkdir(join(packageRoot, 'bin'), { recursive: true }),
      mkdir(join(platformPackageRoot, 'vendor', target.triple, 'bin'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@openai/codex',
          bin: { codex: 'bin/codex.js' },
          optionalDependencies: { [target.packageName]: '0.144.3' },
        }),
      ),
      writeFile(
        join(platformPackageRoot, 'package.json'),
        JSON.stringify({ name: target.packageName, version: '0.144.3' }),
      ),
      writeFile(launcher, '#!/usr/bin/env node\n// unchanged launcher\n', { mode: 0o700 }),
      writeFile(
        native,
        Buffer.concat([
          process.platform === 'darwin'
            ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
            : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
          Buffer.from('native-codex-v1'),
        ]),
        { mode: 0o700 },
      ),
    ]);
    await rm(join(tree.bin, 'codex'));
    await symlink('../node_modules/@openai/codex/bin/codex.js', join(tree.bin, 'codex'));
    await chmod(launcher, 0o700);

    const layout = productionMcpLayout({
      pluginRoot: tree.root,
      codexHome: tree.codexHome,
      nodeExecutable: join(tree.bin, 'node'),
      gitExecutable: join(tree.bin, 'git'),
      pathValue: tree.bin,
    });
    const pins = await createProductionAssetLoader(layout)();
    const codexPin = pins.assets.find((asset) => asset.id === 'codex');
    const canonicalNative = await realpath(native);
    expect(codexPin?.source_path).toBe(canonicalNative);
    expect(codexPin?.real_path).toBe(canonicalNative);

    await writeFile(
      native,
      Buffer.concat([
        process.platform === 'darwin'
          ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
          : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from('native-codex-v2'),
      ]),
      { mode: 0o700 },
    );
    await expect(verifyMcpRuntimeAssets(pins)).rejects.toMatchObject({
      code: 'runtime_asset_changed',
    });
  });

  it('keeps identical concurrent preflights bound to their own opaque preparations', async () => {
    const runtimeAssets = assets('/plugin');
    const verifyAssets = vi.fn(async () => {});
    const probeHost = vi.fn(async () => ({
      codex_version: '0.144.3',
      minimum_version: '0.144.3' as const,
      plugin_mcp: true as const,
      strict_config: true as const,
      workspace_metadata: true as const,
      nested_sandbox: true as const,
      shared_temp_isolation: 'exposed' as const,
    }));
    let rosterNumber = 0;
    const loadRoster = vi.fn((): CodexModelRoster => {
      rosterNumber += 1;
      const model = `gpt-fixture-${rosterNumber}`;
      return {
        default_model: model,
        allowed_models: [model],
        efforts_by_model: new Map([
          [model, new Set<'low' | 'medium' | 'high' | 'xhigh'>(['low', 'high'])],
        ]),
        cached_search_models: new Set([model]),
      };
    });
    const loadCatalog = vi.fn(
      (): ReadonlySet<McpPublicFlowV1> =>
        new Set(['review', 'fix', 'build', 'explore', 'prototype']),
    );
    const preflight = createProductionLaunchPreflight({
      codexHome: '/codex-home',
      stateRoot: '/control-state',
      environment: {},
      verifyAssets,
      probeHost,
      loadRoster,
      loadCatalog,
      deriveNodeInstallation: fixtureNodeInstallation,
    });

    const input = {
      workspace,
      request: {
        flow: 'review' as const,
        goal: 'Review',
        web_search: 'cached' as const,
        consent: { cached_web_search: true as const },
      },
      runtime_assets: runtimeAssets,
    };
    const [first, second] = await Promise.all([
      preflight.validate(input),
      preflight.validate(input),
    ]);
    expect(first).toEqual(expect.any(Object));
    expect(second).toEqual(expect.any(Object));
    expect(first).not.toBe(second);
    expect(Object.keys(first)).toEqual([]);
    expect(Object.keys(second)).toEqual([]);
    expect(
      new Set([first.consume().roster.default_model, second.consume().roster.default_model]),
    ).toEqual(new Set(['gpt-fixture-1', 'gpt-fixture-2']));
    expect(preflight).not.toHaveProperty('take');
    expect(verifyAssets).toHaveBeenCalledTimes(2);
    expect(probeHost).toHaveBeenCalledWith(
      '/opt/codex-real',
      expect.objectContaining({
        workspaceMetadataValidated: true,
        nested: expect.objectContaining({
          policy: expect.objectContaining({
            workspace: '/workspace',
            nodeExecutable: '/opt/node/bin/node',
            nodeInstallationRoot: '/opt/node',
            gitExecutable: '/usr/bin/git',
            searchMode: 'cached',
          }),
        }),
      }),
    );
    expect(loadRoster).toHaveBeenCalledWith('/codex-home/models_cache.json');
    expect(loadCatalog).toHaveBeenCalledWith('/plugin/flows/catalog.json');
  });

  it('does not retain an abandoned preparation behind an input lookup', async () => {
    const runtimeAssets = assets('/plugin');
    const preflight = createProductionLaunchPreflight({
      codexHome: '/codex-home',
      stateRoot: '/control-state',
      environment: {},
      verifyAssets: async () => {},
      probeHost: async () => ({
        codex_version: '0.144.3',
        minimum_version: '0.144.3',
        plugin_mcp: true,
        strict_config: true,
        workspace_metadata: true,
        nested_sandbox: true,
        shared_temp_isolation: 'exposed',
      }),
      loadRoster: (): CodexModelRoster => ({
        default_model: 'gpt-5.2-codex',
        allowed_models: ['gpt-5.2-codex'],
        efforts_by_model: new Map([['gpt-5.2-codex', new Set(['low' as const])]]),
        cached_search_models: new Set(),
      }),
      loadCatalog: (): ReadonlySet<McpPublicFlowV1> => new Set(['review']),
      deriveNodeInstallation: fixtureNodeInstallation,
    });
    const input = {
      workspace,
      request: runRecord().request,
      runtime_assets: runtimeAssets,
    };

    await preflight.validate(input);
    const current = await preflight.validate(input);

    expect(current).toEqual(expect.any(Object));
    expect(Reflect.ownKeys(preflight)).toEqual(['validate']);
  });

  it('builds a private worker launch and consumes its exact preparation once', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'circuit-mcp-worker-factory-'));
    roots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const pluginRoot = join(root, 'plugin');
    const controlDirectory = join(root, 'control');
    await Promise.all([
      mkdir(join(pluginRoot, 'mcp'), { recursive: true }),
      mkdir(join(pluginRoot, 'flows'), { recursive: true }),
      mkdir(controlDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const runtimeAssets = assets(pluginRoot);
    const preflight = createProductionLaunchPreflight({
      codexHome: '/codex-home',
      stateRoot: '/control-state',
      environment: {},
      verifyAssets: async () => {},
      probeHost: async () => ({
        codex_version: '0.144.3',
        minimum_version: '0.144.3',
        plugin_mcp: true,
        strict_config: true,
        workspace_metadata: true,
        nested_sandbox: true,
        shared_temp_isolation: 'isolated',
      }),
      loadRoster: (): CodexModelRoster => ({
        default_model: 'gpt-5.2-codex',
        allowed_models: ['gpt-5.2-codex'],
        efforts_by_model: new Map([
          ['gpt-5.2-codex', new Set<'low' | 'medium' | 'high' | 'xhigh'>(['low'])],
        ]),
        cached_search_models: new Set(['gpt-5.2-codex']),
      }),
      loadCatalog: (): ReadonlySet<McpPublicFlowV1> =>
        new Set(['review', 'fix', 'build', 'explore', 'prototype']),
      deriveNodeInstallation: fixtureNodeInstallation,
    });
    const record = runRecord();
    const preparedLaunch = await preflight.validate({
      workspace,
      request: record.request,
      runtime_assets: runtimeAssets,
    });
    const factory = createProductionWorkerFactory({
      pluginRoot,
      controlDirectory: () => controlDirectory,
    });

    const launch = await factory.createStart({
      workspace,
      run: record,
      authorization_token: 'd'.repeat(64),
      runtime_assets: runtimeAssets,
      prepared_launch: preparedLaunch,
    });
    const payload = parseMcpWorkerLaunch(launch.launch_payload);
    expect(launch.worker_entrypoint).toBe(join(pluginRoot, 'mcp', 'worker.mjs'));
    expect(payload).toMatchObject({
      authorization: 'd'.repeat(64),
      run_id: record.run_id,
      operation: { kind: 'start' },
      workspace: { canonical_path: '/workspace', device: '10', inode: '20' },
      asset_digest_sha256: runtimeAssets.digest_sha256,
      codex: {
        executable: '/opt/codex-real',
        version: '0.144.3',
        default_model: 'gpt-5.2-codex',
        allowed_models: ['gpt-5.2-codex'],
      },
      git: { executable: '/usr/bin/git' },
      request: record.request,
    });
    expect(payload.private_temp_root).toContain('/private/generation-1');

    await expect(
      factory.createStart({
        workspace,
        run: record,
        authorization_token: 'd'.repeat(64),
        runtime_assets: runtimeAssets,
        prepared_launch: preparedLaunch,
      }),
    ).rejects.toThrow(/already consumed/i);
  });
});

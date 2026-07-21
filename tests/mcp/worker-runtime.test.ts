import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pinMcpRuntimeAssets } from '../../src/hosts/codex-mcp/asset-pins.js';
import { createMcpCodexRelayer } from '../../src/hosts/codex-mcp/nested-codex.js';
import { createMcpRuntimeContext } from '../../src/hosts/codex-mcp/runtime-context.js';
import {
  buildMcpWorkerArgv,
  buildMcpWorkerInvocationConfig,
  parseMcpWorkerLaunch,
  runMcpWorkerLaunch,
  verifyMcpWorkerLaunch,
} from '../../src/hosts/codex-mcp/worker-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function asset(id: string, role: string, path: string) {
  return {
    id,
    role,
    source_path: path,
    real_path: path,
    device: '1',
    inode: '2',
    mode: 0o100700,
    byte_length: 1,
    sha256: 'c'.repeat(64),
  };
}

function startLaunch(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    authorization: 'a'.repeat(64),
    run_id: '019f64f5-1f4d-7d91-8cda-a309cc72c300',
    operation: { kind: 'start' as const },
    workspace: {
      canonical_path: '/repo',
      device: '1',
      inode: '2',
    },
    flow_root: '/plugin/flows',
    private_temp_root: '/private/state/run',
    asset_digest_sha256: 'b'.repeat(64),
    runtime_assets: {
      schema_version: 1 as const,
      digest_sha256: 'b'.repeat(64),
      assets: [
        asset('node', 'node', '/opt/node/bin/node'),
        asset('codex', 'codex', '/opt/codex/bin/codex'),
        asset('plugin_runtime:worker', 'plugin_runtime', '/plugin/mcp/worker.mjs'),
        asset('git_helper', 'git_helper', '/usr/bin/git'),
        asset('flow:prototype', 'packaged_flow', '/plugin/flows/prototype/circuit.json'),
      ],
    },
    capabilities: {
      codex_version: '0.144.3',
      minimum_version: '0.144.3' as const,
      plugin_mcp: true as const,
      strict_config: true as const,
      workspace_metadata: true as const,
      nested_sandbox: true as const,
      shared_temp_isolation: 'exposed' as const,
    },
    codex: {
      executable: '/opt/codex/bin/codex',
      version: '0.144.3',
      default_model: 'gpt-5.1-codex-mini',
      allowed_models: ['gpt-5.1-codex-mini', 'gpt-5.2-codex'],
    },
    git: { executable: '/usr/bin/git' },
    request: {
      flow: 'prototype' as const,
      goal: 'compare two approaches',
      tournament: 2,
      web_search: 'cached' as const,
      consent: { cached_web_search: true as const },
      variants: [
        { id: 'small', label: 'Small', model: 'gpt-5.1-codex-mini', effort: 'low' as const },
        { id: 'large', label: 'Large', model: 'gpt-5.2-codex', effort: 'high' as const },
      ],
    },
    ...overrides,
  };
}

describe('MCP dedicated worker runtime', () => {
  it('strictly parses the private inherited launch payload', () => {
    expect(parseMcpWorkerLaunch(startLaunch())).toMatchObject({
      operation: { kind: 'start' },
      request: { flow: 'prototype', web_search: 'cached' },
    });
    expect(() => parseMcpWorkerLaunch({ ...startLaunch(), command: 'curl example.com' })).toThrow();
    expect(() =>
      parseMcpWorkerLaunch({
        ...startLaunch(),
        codex: { ...startLaunch().codex, executable: 'codex' },
      }),
    ).toThrow();
    expect(() =>
      parseMcpWorkerLaunch({
        ...startLaunch(),
        git: { executable: 'git' },
      }),
    ).toThrow();
    expect(() =>
      parseMcpWorkerLaunch({
        ...startLaunch(),
        capabilities: { ...startLaunch().capabilities, codex_version: '0.145.0' },
      }),
    ).toThrow(/match the sealed Codex capability/i);

    const { shared_temp_isolation: _isolation, ...missingIsolation } = startLaunch().capabilities;
    expect(() =>
      parseMcpWorkerLaunch({ ...startLaunch(), capabilities: missingIsolation }),
    ).toThrow();
    expect(() =>
      parseMcpWorkerLaunch({
        ...startLaunch(),
        capabilities: { ...startLaunch().capabilities, shared_temp_isolation: 'unknown' },
      }),
    ).toThrow();
  });

  it('derives every path and argument from sealed data', () => {
    expect(buildMcpWorkerArgv(parseMcpWorkerLaunch(startLaunch()))).toEqual([
      'run',
      'prototype',
      '--goal',
      'compare two approaches',
      '--run-folder',
      '/repo/.circuit/runs/019f64f5-1f4d-7d91-8cda-a309cc72c300',
      '--flow-root',
      '/plugin/flows',
      '--tournament',
      '2',
      '--progress',
      'jsonl',
    ]);
  });

  it.each(['review', 'fix', 'build', 'explore', 'prototype'] as const)(
    'routes the public %s flow through the sealed worker',
    (flow) => {
      const base = startLaunch();
      const launch = parseMcpWorkerLaunch({
        ...base,
        request: { flow, goal: `Run ${flow}`, web_search: 'off' },
      });
      expect(buildMcpWorkerArgv(launch).slice(0, 4)).toEqual([
        'run',
        flow,
        '--goal',
        `Run ${flow}`,
      ]);
    },
  );

  it('routes Explore tournament mode without accepting arbitrary variants', () => {
    const base = startLaunch();
    const launch = parseMcpWorkerLaunch({
      ...base,
      request: {
        flow: 'explore',
        goal: 'Compare approaches',
        tournament: 2,
        web_search: 'off',
      },
    });
    expect(buildMcpWorkerArgv(launch)).toEqual(
      expect.arrayContaining(['run', 'explore', '--tournament', '2']),
    );
    expect(launch.request.variants).toBeUndefined();
  });

  it('builds a Codex-only config with bounded Prototype variants and no hooks', () => {
    expect(buildMcpWorkerInvocationConfig(parseMcpWorkerLaunch(startLaunch()))).toMatchObject({
      schema_version: 1,
      host: { kind: 'codex' },
      relay: { default: 'codex', roles: {}, flows: {}, connectors: {} },
      skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
      flows: {
        prototype: {
          variant_models: [
            {
              id: 'small',
              label: 'Small',
              connector: { kind: 'builtin', name: 'codex' },
              selection: {
                model: { provider: 'openai', model: 'gpt-5.1-codex-mini' },
                effort: 'low',
              },
            },
            {
              id: 'large',
              label: 'Large',
              connector: { kind: 'builtin', name: 'codex' },
              selection: {
                model: { provider: 'openai', model: 'gpt-5.2-codex' },
                effort: 'high',
              },
            },
          ],
        },
      },
    });
  });

  it('builds resume only from the saved run and validated choice', () => {
    const launch = parseMcpWorkerLaunch({
      ...startLaunch({ operation: { kind: 'resume', choice_id: 'accept-small' } }),
    });
    expect(buildMcpWorkerArgv(launch)).toEqual([
      'resume',
      '--run-folder',
      '/repo/.circuit/runs/019f64f5-1f4d-7d91-8cda-a309cc72c300',
      '--checkpoint-choice',
      'accept-small',
      '--progress',
      'jsonl',
    ]);
  });

  it('calls the normal engine through explicit injection, never an ambient activation variable', async () => {
    const main = vi.fn(async () => 0);
    const createRuntimeContextSpy = vi.fn(createMcpRuntimeContext);
    const createRelayer = vi.fn(() => ({
      connectorName: 'codex',
      relay: vi.fn(),
    }));
    await expect(
      runMcpWorkerLaunch(parseMcpWorkerLaunch(startLaunch()), {
        main,
        createRelayer,
        createRuntimeContext: createRuntimeContextSpy,
        verifyLaunch: async () => {},
        prepareDirectories: async () => ({
          configHome: '/private/state/run/config-home',
          configCwd: '/private/state/run/config-workspace',
        }),
        prepareRunDirectory: async () => ({
          runFolder: '/repo/.circuit/runs/019f64f5-1f4d-7d91-8cda-a309cc72c300',
          validate: async () => {},
          close: async () => {},
        }),
        environment: {
          CIRCUIT_MCP_PROOF_RUNNER: '/tmp/ignored',
          CIRCUIT_MCP_ACTIVATE: '1',
          PATH: '/bin',
        },
      }),
    ).resolves.toBe(0);
    expect(main).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        projectRoot: '/repo',
        runId: '019f64f5-1f4d-7d91-8cda-a309cc72c300',
        generatedFlowMirrorRoot: '/plugin/flows',
        hostKind: 'codex',
        historyRecall: 'disabled',
        codexInstallAssurance: 'disabled',
        invocationConfig: expect.any(Object),
        relayer: expect.any(Object),
        proofCommandRunner: expect.any(Function),
        gitReader: expect.objectContaining({ read: expect.any(Function) }),
      }),
    );
    expect(createRelayer).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/opt/codex/bin/codex',
      }),
      expect.objectContaining({
        environment: {
          CIRCUIT_MCP_PROOF_RUNNER: '/tmp/ignored',
          CIRCUIT_MCP_ACTIVATE: '1',
          PATH: '/bin',
        },
      }),
    );
    expect(createRuntimeContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          metadata_key: 'codex/sandbox-state-meta',
          workspace: '/repo',
        },
        capabilities: expect.objectContaining({
          plugin_mcp: true,
          strict_config: true,
          workspace_metadata: true,
          nested_sandbox: true,
          shared_temp_isolation: 'exposed',
        }),
        search: { mode: 'cached', consented: true },
        proofExecutor: expect.any(Function),
        gitReader: expect.objectContaining({ read: expect.any(Function) }),
        cancellation: {
          owner: 'supervisor',
          process_group_cleanup: 'observed',
          run_id: '019f64f5-1f4d-7d91-8cda-a309cc72c300',
        },
      }),
    );
  });

  it('rejects a linked .circuit directory before the normal engine can write outside the workspace', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-worker-run-path-')));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const privateRoot = join(root, 'private');
    await Promise.all([mkdir(workspace), mkdir(outside), mkdir(privateRoot, { mode: 0o700 })]);
    await symlink(outside, join(workspace, '.circuit'), 'dir');
    const workspaceInfo = await stat(workspace);
    const launch = parseMcpWorkerLaunch(
      startLaunch({
        workspace: {
          canonical_path: workspace,
          device: String(workspaceInfo.dev),
          inode: String(workspaceInfo.ino),
        },
        private_temp_root: privateRoot,
      }),
    );
    const main = vi.fn(async (argv: readonly string[]) => {
      const runFolderFlag = argv.indexOf('--run-folder');
      const escapedRunFolder = argv[runFolderFlag + 1];
      if (escapedRunFolder === undefined) throw new Error('missing run folder');
      await mkdir(escapedRunFolder, { recursive: true });
      await writeFile(join(escapedRunFolder, 'escaped.txt'), 'escaped\n');
      return 0;
    });

    await expect(
      runMcpWorkerLaunch(launch, {
        main,
        createRelayer: () => ({ connectorName: 'codex', relay: vi.fn() }),
        verifyLaunch: async () => {},
        environment: {},
      }),
    ).rejects.toThrow(/\.circuit|symbolic link/i);
    expect(main).not.toHaveBeenCalled();
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it.each(['runs', 'run'] as const)(
    'rejects a linked %s directory before the normal engine can write outside the workspace',
    async (linkedDirectory) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-worker-linked-run-')));
      roots.push(root);
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      const privateRoot = join(root, 'private');
      const runsRoot = join(workspace, '.circuit', 'runs');
      await Promise.all([
        mkdir(workspace),
        mkdir(outside),
        mkdir(privateRoot, { mode: 0o700 }),
        mkdir(linkedDirectory === 'runs' ? join(workspace, '.circuit') : runsRoot, {
          recursive: true,
        }),
      ]);
      const linkedPath =
        linkedDirectory === 'runs'
          ? runsRoot
          : join(runsRoot, '019f64f5-1f4d-7d91-8cda-a309cc72c300');
      await symlink(outside, linkedPath, 'dir');
      const workspaceInfo = await stat(workspace);
      const launch = parseMcpWorkerLaunch(
        startLaunch({
          workspace: {
            canonical_path: workspace,
            device: String(workspaceInfo.dev),
            inode: String(workspaceInfo.ino),
          },
          private_temp_root: privateRoot,
        }),
      );
      const main = vi.fn(async () => 0);

      await expect(
        runMcpWorkerLaunch(launch, {
          main,
          createRelayer: () => ({ connectorName: 'codex', relay: vi.fn() }),
          verifyLaunch: async () => {},
          environment: {},
        }),
      ).rejects.toThrow(/symbolic link/i);
      expect(main).not.toHaveBeenCalled();
      await expect(readdir(outside)).resolves.toEqual([]);
    },
  );

  it('rejects a non-directory .circuit entry before calling the normal engine', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-worker-file-run-')));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const privateRoot = join(root, 'private');
    await Promise.all([mkdir(workspace), mkdir(privateRoot, { mode: 0o700 })]);
    await writeFile(join(workspace, '.circuit'), 'not a directory\n');
    const workspaceInfo = await stat(workspace);
    const launch = parseMcpWorkerLaunch(
      startLaunch({
        workspace: {
          canonical_path: workspace,
          device: String(workspaceInfo.dev),
          inode: String(workspaceInfo.ino),
        },
        private_temp_root: privateRoot,
      }),
    );
    const main = vi.fn(async () => 0);

    await expect(
      runMcpWorkerLaunch(launch, {
        main,
        createRelayer: () => ({ connectorName: 'codex', relay: vi.fn() }),
        verifyLaunch: async () => {},
        environment: {},
      }),
    ).rejects.toThrow(/real directory/i);
    expect(main).not.toHaveBeenCalled();
  });

  it('detects an ancestor swap after binding and before calling the normal engine', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-worker-run-swap-')));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const privateRoot = join(root, 'private');
    await Promise.all([mkdir(workspace), mkdir(outside), mkdir(privateRoot, { mode: 0o700 })]);
    const workspaceInfo = await stat(workspace);
    const launch = parseMcpWorkerLaunch(
      startLaunch({
        workspace: {
          canonical_path: workspace,
          device: String(workspaceInfo.dev),
          inode: String(workspaceInfo.ino),
        },
        private_temp_root: privateRoot,
      }),
    );
    const main = vi.fn(async () => 0);

    await expect(
      runMcpWorkerLaunch(launch, {
        main,
        createRelayer: () => ({ connectorName: 'codex', relay: vi.fn() }),
        verifyLaunch: async () => {},
        prepareDirectories: async () => {
          await rename(join(workspace, '.circuit'), join(workspace, '.circuit-bound'));
          await symlink(outside, join(workspace, '.circuit'), 'dir');
          return {
            configHome: join(privateRoot, 'config-home'),
            configCwd: join(privateRoot, 'config-workspace'),
          };
        },
        environment: {},
      }),
    ).rejects.toThrow(/changed after Circuit bound it/i);
    expect(main).not.toHaveBeenCalled();
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('revalidates workspace identity and every sealed asset inside the worker', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-worker-pins-')));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const flowRoot = join(root, 'plugin', 'flows');
    const privateRoot = join(root, 'private');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(flowRoot, 'prototype'), { recursive: true }),
      mkdir(privateRoot, { recursive: true, mode: 0o700 }),
    ]);
    const node = join(root, 'node-install', 'bin', 'node');
    const codex = join(root, 'codex');
    const worker = join(root, 'worker.mjs');
    const git = join(root, 'git');
    const flow = join(flowRoot, 'prototype', 'circuit.json');
    await mkdir(dirname(node), { recursive: true });
    await Promise.all([
      writeFile(node, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(codex, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(worker, 'worker\n', { mode: 0o600 }),
      writeFile(git, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(flow, '{}\n', { mode: 0o600 }),
    ]);
    const runtimeAssets = await pinMcpRuntimeAssets({
      node,
      codex,
      plugin_runtimes: [{ id: 'worker', path: worker }],
      git_helper: git,
      packaged_flows: [{ id: 'prototype', path: flow }],
    });
    const workspaceInfo = await stat(workspace);
    const launch = parseMcpWorkerLaunch(
      startLaunch({
        workspace: {
          canonical_path: workspace,
          device: String(workspaceInfo.dev),
          inode: String(workspaceInfo.ino),
        },
        flow_root: flowRoot,
        private_temp_root: privateRoot,
        asset_digest_sha256: runtimeAssets.digest_sha256,
        runtime_assets: runtimeAssets,
        codex: {
          ...startLaunch().codex,
          executable: codex,
        },
        git: { executable: git },
      }),
    );

    await expect(verifyMcpWorkerLaunch(launch)).resolves.toBeUndefined();
    await expect(
      verifyMcpWorkerLaunch({
        ...launch,
        workspace: { ...launch.workspace, inode: String(workspaceInfo.ino + 1) },
      }),
    ).rejects.toThrow(/identity changed/);
    await writeFile(codex, '#!/bin/sh\n# replaced\n', { mode: 0o700 });
    await expect(verifyMcpWorkerLaunch(launch)).rejects.toThrow(/changed/);
  });

  it('blocks a nested relay when Codex changes after worker initialization', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-worker-relay-pin-')));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const flowRoot = join(root, 'plugin', 'flows');
    const privateRoot = join(root, 'private');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(flowRoot, 'prototype'), { recursive: true }),
      mkdir(privateRoot, { recursive: true, mode: 0o700 }),
    ]);
    const node = join(root, 'node-install', 'bin', 'node');
    const codex = join(root, 'codex');
    const worker = join(root, 'worker.mjs');
    const git = join(root, 'git');
    const flow = join(flowRoot, 'prototype', 'circuit.json');
    await mkdir(dirname(node), { recursive: true });
    await Promise.all([
      writeFile(node, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(codex, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(worker, 'worker\n', { mode: 0o600 }),
      writeFile(git, '#!/bin/sh\n', { mode: 0o700 }),
      writeFile(flow, '{}\n', { mode: 0o600 }),
    ]);
    const runtimeAssets = await pinMcpRuntimeAssets({
      node,
      codex,
      plugin_runtimes: [{ id: 'worker', path: worker }],
      git_helper: git,
      packaged_flows: [{ id: 'prototype', path: flow }],
    });
    const workspaceInfo = await stat(workspace);
    const launch = parseMcpWorkerLaunch(
      startLaunch({
        workspace: {
          canonical_path: workspace,
          device: String(workspaceInfo.dev),
          inode: String(workspaceInfo.ino),
        },
        flow_root: flowRoot,
        private_temp_root: privateRoot,
        asset_digest_sha256: runtimeAssets.digest_sha256,
        runtime_assets: runtimeAssets,
        codex: { ...startLaunch().codex, executable: codex },
        git: { executable: git },
      }),
    );
    const spawn = vi.fn();

    await expect(
      runMcpWorkerLaunch(launch, {
        main: async (_argv, options) => {
          const relayer = options.relayer;
          if (relayer === undefined) throw new Error('missing relayer');
          // Same inode, mode, and byte length. Only the sealed bytes differ.
          await writeFile(codex, '#!/bin/zs\n', { mode: 0o700 });
          await expect(relayer.relay({ prompt: 'do not spawn' })).rejects.toMatchObject({
            code: 'runtime_asset_changed',
          });
          return 0;
        },
        createRelayer: (policy, dependencies) =>
          createMcpCodexRelayer(policy, { ...dependencies, run: spawn }),
        environment: {},
      }),
    ).resolves.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });
});

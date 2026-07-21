import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pinMcpRuntimeAssets } from '../../src/hosts/codex-mcp/asset-pins.js';
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
    codex: {
      executable: '/opt/codex/bin/codex',
      version: 'codex-cli 0.144.3',
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
    const createRelayer = vi.fn(() => ({
      connectorName: 'codex',
      relay: vi.fn(),
    }));
    await expect(
      runMcpWorkerLaunch(parseMcpWorkerLaunch(startLaunch()), {
        main,
        createRelayer,
        verifyLaunch: async () => {},
        prepareDirectories: async () => ({
          configHome: '/private/state/run/config-home',
          configCwd: '/private/state/run/config-workspace',
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
      expect.objectContaining({ executable: '/opt/codex/bin/codex' }),
      expect.objectContaining({
        environment: {
          CIRCUIT_MCP_PROOF_RUNNER: '/tmp/ignored',
          CIRCUIT_MCP_ACTIVATE: '1',
          PATH: '/bin',
        },
      }),
    );
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
    const node = join(root, 'node');
    const codex = join(root, 'codex');
    const worker = join(root, 'worker.mjs');
    const git = join(root, 'git');
    const flow = join(flowRoot, 'prototype', 'circuit.json');
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
});

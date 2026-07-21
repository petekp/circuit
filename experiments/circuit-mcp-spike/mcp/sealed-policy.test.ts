import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CodexExecutablePin } from './host-discovery.mjs';
import {
  SEALED_PUBLIC_FLOWS,
  SEALED_RUNTIME_CAPABILITIES,
  assertMcpAssetsUnchanged,
  assertMcpResourcesOutsideWorkspace,
  assertPackagedAssetsUnchanged,
  assertSealedRuntimeCapabilities,
  createSealedEnvironment,
  createSealedRunPolicy,
  prepareSealedStateRoot,
  resolveWebSearchPolicy,
  snapshotMcpAssets,
  snapshotPackagedAssets,
} from './sealed-policy.mjs';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'circuit-mcp-sealed-')));
  tempRoots.push(root);
  return root;
}

async function packagedFixture(): Promise<{
  pluginRoot: string;
  runtimePath: string;
  gitStatePath: string;
  flowRoot: string;
}> {
  const pluginRoot = await tempRoot();
  const runtimePath = path.join(pluginRoot, 'runtime', 'circuit.js');
  const gitStatePath = path.join(pluginRoot, 'runtime', 'git-state.js');
  const flowRoot = path.join(pluginRoot, 'flows');
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, '#!/usr/bin/env node\n');
  await writeFile(gitStatePath, '#!/usr/bin/env node\n');
  for (const flow of SEALED_PUBLIC_FLOWS) {
    const flowDir = path.join(flowRoot, flow);
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'circuit.json'), `${JSON.stringify({ id: flow })}\n`);
  }
  return { pluginRoot, runtimePath, gitStatePath, flowRoot };
}

function runtimeCapabilities(): Record<string, boolean> {
  return Object.fromEntries(SEALED_RUNTIME_CAPABILITIES.map((key) => [key, true]));
}

function codexPin(executable: string): CodexExecutablePin {
  return {
    executable,
    source: 'test',
    version: 'codex-cli 1.2.3',
    identity: { device: '1', inode: '2', size: 3, modified_ms: 4 },
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('sealed MCP policy', () => {
  it('pins the plugin-owned runtime and every packaged public flow by digest', async () => {
    const fixture = await packagedFixture();
    const snapshot = await snapshotPackagedAssets(fixture);
    expect(snapshot).toMatchObject({
      plugin_root: fixture.pluginRoot,
      runtime_path: fixture.runtimePath,
      git_state_path: fixture.gitStatePath,
      flow_root: fixture.flowRoot,
      flow_ids: SEALED_PUBLIC_FLOWS,
      file_count: 7,
    });
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(assertPackagedAssetsUnchanged(snapshot)).resolves.toBeUndefined();
  });

  it('detects packaged flow mutation after the snapshot', async () => {
    const fixture = await packagedFixture();
    const snapshot = await snapshotPackagedAssets(fixture);
    await writeFile(
      path.join(fixture.flowRoot, 'review', 'circuit.json'),
      `${JSON.stringify({ id: 'review', changed: true })}\n`,
    );
    await expect(assertPackagedAssetsUnchanged(snapshot)).rejects.toThrow('changed after');
  });

  it('detects packaged git-state helper mutation after the snapshot', async () => {
    const fixture = await packagedFixture();
    const snapshot = await snapshotPackagedAssets(fixture);
    await writeFile(fixture.gitStatePath, '#!/usr/bin/env node\nprocess.stdout.write("changed")\n');
    await expect(assertPackagedAssetsUnchanged(snapshot)).rejects.toThrow('changed after');
  });

  it('pins the MCP worker files and detects later changes', async () => {
    const mcpRoot = await tempRoot();
    await mkdir(path.join(mcpRoot, 'nested'));
    await writeFile(path.join(mcpRoot, 'server.mjs'), 'export const version = 1;\n');
    await writeFile(path.join(mcpRoot, 'nested', 'worker.mjs'), 'export const worker = true;\n');
    const snapshot = await snapshotMcpAssets(mcpRoot);

    expect(snapshot).toMatchObject({ root: mcpRoot, file_count: 2 });
    await expect(assertMcpAssetsUnchanged(snapshot)).resolves.toBeUndefined();
    await writeFile(path.join(mcpRoot, 'nested', 'worker.mjs'), 'export const worker = false;\n');
    await expect(assertMcpAssetsUnchanged(snapshot)).rejects.toThrow('changed after');
  });

  it('keeps control-plane files outside the workspace while allowing Codex worktrees', async () => {
    const codexHome = path.join(await tempRoot(), 'codex-home');
    const workspace = path.join(codexHome, 'worktrees', '1234', 'project');
    const stateRoot = path.join(codexHome, 'circuit', 'mcp-spike');
    const pluginRoot = await tempRoot();
    const mcpRoot = path.join(pluginRoot, 'mcp');
    const runtime = path.join(pluginRoot, 'runtime', 'circuit.js');
    const proofRunner = path.join(mcpRoot, 'proof-sandbox-worker.mjs');
    const codexExecutable = path.join(codexHome, 'bin', 'codex');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
      mkdir(path.dirname(runtime), { recursive: true }),
      mkdir(mcpRoot, { recursive: true }),
      mkdir(path.dirname(codexExecutable), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(runtime, 'runtime\n'),
      writeFile(proofRunner, 'proof\n'),
      writeFile(codexExecutable, 'codex\n'),
    ]);
    const input = {
      workspace,
      stateRoot,
      pluginRoot,
      mcpRoot,
      codexHome,
      files: [
        { path: runtime, label: 'runtime' },
        { path: proofRunner, label: 'proof runner' },
        { path: codexExecutable, label: 'Codex' },
      ],
    };

    await expect(assertMcpResourcesOutsideWorkspace(input)).resolves.toMatchObject({
      workspace,
      stateRoot,
    });
    const workspaceState = path.join(workspace, '.circuit-state');
    await mkdir(workspaceState);
    await expect(
      assertMcpResourcesOutsideWorkspace({ ...input, stateRoot: workspaceState }),
    ).rejects.toThrow(/state.*must not overlap/i);
    await expect(
      assertMcpResourcesOutsideWorkspace({ ...input, pluginRoot: workspace }),
    ).rejects.toThrow(/plugin.*must not overlap/i);
  });

  it('rejects caller-selected runtime paths and symlinked packaged assets', async () => {
    const fixture = await packagedFixture();
    const otherRuntime = path.join(fixture.pluginRoot, 'runtime', 'other.js');
    await writeFile(otherRuntime, 'not Circuit');
    await expect(snapshotPackagedAssets({ ...fixture, runtimePath: otherRuntime })).rejects.toThrow(
      'plugin-owned runtime/circuit.js',
    );

    const reviewFlow = path.join(fixture.flowRoot, 'review', 'circuit.json');
    await rm(reviewFlow);
    await symlink(path.join(fixture.flowRoot, 'build', 'circuit.json'), reviewFlow);
    await expect(snapshotPackagedAssets(fixture)).rejects.toThrow('must not be a symbolic link');
  });

  it('keeps web search off unless the caller explicitly consents to cached search', () => {
    expect(resolveWebSearchPolicy(undefined)).toEqual({
      choice: 'off',
      consent: 'not-granted',
      sends_queries_off_machine: false,
      codex_mode: 'disabled',
      codex_config: 'web_search="disabled"',
    });
    expect(resolveWebSearchPolicy('cached')).toEqual({
      choice: 'cached',
      consent: 'explicit',
      sends_queries_off_machine: true,
      codex_mode: 'cached',
      codex_config: 'web_search="cached"',
    });
    expect(() => resolveWebSearchPolicy('live')).toThrow('off, cached');
    expect(() => resolveWebSearchPolicy(true)).toThrow('off, cached');
  });

  it('requires every runtime enforcement seam instead of treating policy text as enforcement', () => {
    expect(() => assertSealedRuntimeCapabilities(runtimeCapabilities())).not.toThrow();
    const incomplete = runtimeCapabilities();
    incomplete.disable_history_recall_and_writes = false;
    incomplete.force_codex_web_search_mode = false;
    expect(() => assertSealedRuntimeCapabilities(incomplete)).toThrow(
      'disable_history_recall_and_writes, force_codex_web_search_mode',
    );
  });

  it('builds a fixed policy that ignores ambient config, history, and hooks', async () => {
    const fixture = await packagedFixture();
    const assets = await snapshotPackagedAssets(fixture);
    const workspace = path.join(await tempRoot(), 'workspace');
    const codexHome = path.join(await tempRoot(), 'codex-home');
    await mkdir(workspace);
    await mkdir(codexHome);
    const policy = createSealedRunPolicy({
      flow: 'review',
      workspace,
      webSearch: 'off',
      assets,
      host: {
        codex: codexPin('/trusted/codex'),
        codexHome: { path: codexHome, source: 'test' },
      },
    });
    expect(policy).toMatchObject({
      schema: 'circuit.mcp.sealed-policy@v1',
      workspace,
      flow: { id: 'review', source: 'packaged', package_sha256: assets.sha256 },
      connector: { kind: 'builtin', name: 'codex', executable: '/trusted/codex' },
      config: { user: 'ignored', project: 'ignored', invocation: 'sealed-only' },
      history: { recall: 'disabled', project_reads: 'disabled', project_writes: 'disabled' },
      hooks: { host: 'disabled', skill: 'disabled', install_assurance: 'disabled' },
      web_search: { choice: 'off', codex_mode: 'disabled' },
    });
  });

  it('creates isolated homes and run storage outside the workspace', async () => {
    const stateRoot = await tempRoot();
    await expect(prepareSealedStateRoot(stateRoot)).resolves.toEqual({
      home: path.join(stateRoot, 'sealed-home'),
      xdg_config_home: path.join(stateRoot, 'sealed-xdg-config'),
      runs: path.join(stateRoot, 'runs'),
    });
  });

  it('emits only the sealed runtime inputs and keeps cancellation outside the workspace', async () => {
    const fixture = await packagedFixture();
    const assets = await snapshotPackagedAssets(fixture);
    const workspace = path.join(await tempRoot(), 'workspace');
    const codexHome = path.join(await tempRoot(), 'codex-home');
    const state = await prepareSealedStateRoot(await tempRoot());
    await mkdir(workspace);
    await mkdir(codexHome);
    const policy = createSealedRunPolicy({
      flow: 'review',
      workspace,
      webSearch: 'cached',
      assets,
      host: {
        codex: codexPin('/trusted/codex'),
        codexHome: { path: codexHome, source: 'test' },
      },
    });
    const proofRunner = path.join(fixture.pluginRoot, 'mcp', 'proof-sandbox-worker.mjs');
    const cancelFile = path.join(state.runs, 'run-1', 'cancel');
    expect(
      createSealedEnvironment({
        policy,
        state,
        proofRunner,
        gitStateHelper: assets.git_state_path,
        cancelFile,
      }),
    ).toEqual({
      HOME: state.home,
      XDG_CONFIG_HOME: state.xdg_config_home,
      CODEX_HOME: codexHome,
      CIRCUIT_HOST_KIND: 'codex',
      CIRCUIT_MCP_SEALED: '1',
      CIRCUIT_MCP_PROJECT_ROOT: workspace,
      CIRCUIT_MCP_CODEX_EXECUTABLE: '/trusted/codex',
      CIRCUIT_MCP_WEB_SEARCH_MODE: 'cached',
      CIRCUIT_MCP_PROOF_RUNNER: proofRunner,
      CIRCUIT_MCP_GIT_STATE_HELPER: assets.git_state_path,
      CIRCUIT_MCP_CANCEL_FILE: cancelFile,
    });
    expect(() =>
      createSealedEnvironment({
        policy,
        state,
        proofRunner,
        gitStateHelper: assets.git_state_path,
        cancelFile: path.join(workspace, 'model-controlled-cancel'),
      }),
    ).toThrow('inside the sealed runs root');
  });
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type McpRuntimeAssetPin,
  type McpRuntimeAssetPins,
  pinMcpRuntimeAssets,
  verifyMcpRuntimeAssets,
} from '../../src/hosts/codex-mcp/asset-pins.js';
import type { CircuitStartInputV1 } from '../../src/hosts/codex-mcp/contracts.js';
import type {
  LifecycleExecutableIdentity,
  LifecycleProcessIdentity,
  LifecycleProcessOwnerIdentity,
} from '../../src/hosts/codex-mcp/lifecycle-types.js';
import { collectPackagedFlowAssets } from '../../src/hosts/codex-mcp/production-paths.js';
import type { ProductionLaunchPreflight } from '../../src/hosts/codex-mcp/production-runtime.js';
import type {
  SupervisorLaunchSession,
  SupervisorLauncher,
} from '../../src/hosts/codex-mcp/supervisor-launcher.js';
import type {
  McpWorkerLaunch,
  McpWorkerRuntimeDependencies,
} from '../../src/hosts/codex-mcp/worker-runtime.js';
import type { RuntimeExecutionCapabilities } from '../../src/runtime/run/capabilities.js';
import type {
  RuntimeGitOperation,
  RuntimeGitPinnedTarget,
  RuntimeGitReader,
  RuntimeGitTarget,
} from '../../src/shared/runtime-git-reader.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';
import { initGitProjectRoot } from '../helpers/working-tree.js';
import { createPackagedFlowRelayer } from './helpers/packaged-flow-relayer.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const PACKAGED_PLUGIN = join(REPO_ROOT, 'plugins/codex');
const PRIVATE_TEST_ROOT = join(REPO_ROOT, '.mcp-host-tests');
const AUTHORIZATION_TOKEN = 'd'.repeat(64);
const STARTED_AT = '2026-07-21T00:00:00.000Z';

interface PackagedServerModule {
  readonly createPackagedCircuitMcpServer: (options: Record<string, unknown>) => Promise<McpServer>;
}

interface PackagedWorkerModule {
  readonly runPackagedMcpWorkerLaunch: (
    launch: McpWorkerLaunch,
    dependencies: Omit<McpWorkerRuntimeDependencies, 'main'>,
  ) => Promise<number>;
}

interface ToolResponse {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly run_id?: string;
  readonly state?: string;
  readonly checkpoint?: {
    readonly token: string;
    readonly choices: readonly { readonly id: string }[];
  };
  readonly final_report?: { readonly schema: string; readonly data: unknown };
  readonly error?: { readonly code: string; readonly message: string };
}

const dynamicImport = async (specifier: string): Promise<unknown> =>
  await import(/* @vite-ignore */ specifier);

function executableIdentity(asset: McpRuntimeAssetPin): LifecycleExecutableIdentity {
  return {
    real_path: asset.real_path,
    device: asset.device,
    inode: asset.inode,
    sha256: asset.sha256,
  };
}

function assetById(assets: McpRuntimeAssetPins, id: string): McpRuntimeAssetPin {
  const asset = assets.assets.find((candidate) => candidate.id === id);
  if (asset === undefined) throw new Error(`Missing acceptance asset ${id}`);
  return asset;
}

function processIdentity(
  pid: number,
  birthToken: string,
  executable: LifecycleExecutableIdentity,
): LifecycleProcessIdentity {
  return {
    pid,
    process_group_id: pid,
    birth_token: birthToken,
    started_at: STARTED_AT,
    executable,
  };
}

function preparedLaunch() {
  const efforts = new Set(['low', 'medium', 'high', 'xhigh'] as const);
  return {
    capabilities: {
      codex_version: '0.144.3',
      minimum_version: '0.144.3' as const,
      plugin_mcp: true as const,
      strict_config: true as const,
      workspace_metadata: true as const,
      nested_sandbox: true as const,
      shared_temp_isolation: 'exposed' as const,
    },
    roster: {
      default_model: 'fixture-default',
      allowed_models: ['fixture-default', 'fixture-a', 'fixture-b'],
      efforts_by_model: new Map([
        ['fixture-default', efforts],
        ['fixture-a', efforts],
        ['fixture-b', efforts],
      ]),
      cached_search_models: new Set<string>(),
    },
  };
}

function acceptancePreflight(): ProductionLaunchPreflight {
  return {
    validate: async ({ runtime_assets }) => {
      await verifyMcpRuntimeAssets(runtime_assets);
      let prepared: ReturnType<typeof preparedLaunch> | undefined = preparedLaunch();
      return Object.freeze({
        consume: () => {
          const current = prepared;
          if (current === undefined) {
            throw new Error('Acceptance launch preparation was already consumed.');
          }
          prepared = undefined;
          return current;
        },
      });
    },
  };
}

type StaticGitOperation = Exclude<
  RuntimeGitOperation,
  'remote_repositories' | 'resolve_target' | 'target_diff' | 'target_diff_stat'
>;

const STATIC_GIT_ARGUMENTS: Readonly<Record<StaticGitOperation, readonly string[]>> = {
  status: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
  staged_diff: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--cached',
    '--',
  ],
  unstaged_diff: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--',
  ],
  staged_diff_stat: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--stat',
    '--cached',
    '--',
  ],
  unstaged_diff_stat: [
    'diff',
    '--stat',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    '--',
  ],
  hidden_index_flags: ['ls-files', '-v', '-z', '--'],
  staged_changed_gitlinks: [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--cached',
    '--',
  ],
  unstaged_changed_gitlinks: [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--',
  ],
  untracked_files: ['ls-files', '--others', '--exclude-standard', '-z', '--'],
  tracked_files: ['ls-files', '--cached', '--exclude-standard', '-z', '--'],
};

function targetGitArguments(
  operation: 'target_diff' | 'target_diff_stat',
  target: RuntimeGitPinnedTarget,
  commitParent?: string | null,
): readonly string[] {
  const stat = operation === 'target_diff_stat' ? ['--stat'] : [];
  if (target.kind === 'commit') {
    if (commitParent === undefined) throw new Error('commit target requires inspected ancestry');
    if (commitParent !== null) {
      return [
        'diff',
        ...stat,
        '--no-ext-diff',
        '--no-textconv',
        '--submodule=short',
        '--ignore-submodules=none',
        `${commitParent}^{commit}`,
        `${target.commit}^{commit}`,
        '--',
      ];
    }
    return [
      'show',
      '--format=',
      ...stat,
      '--no-ext-diff',
      '--no-textconv',
      '--submodule=short',
      '--ignore-submodules=none',
      '--root',
      `${target.commit}^{commit}`,
      '--',
    ];
  }
  return [
    'diff',
    ...stat,
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=none',
    `${target.base_commit}${target.dots}${target.head_commit}`,
    '--',
  ];
}

function acceptanceCommitParent(projectRoot: string, commit: string): string | null {
  const result = spawnSync('/usr/bin/git', ['cat-file', 'commit', commit], {
    cwd: projectRoot,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  const header = (result.stdout ?? '').split('\n\n', 1)[0] ?? '';
  const parent = header
    .split('\n')
    .find((line) => line.startsWith('parent '))
    ?.slice('parent '.length);
  if (parent !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parent)) {
    throw new Error('invalid commit parent');
  }
  return parent ?? null;
}

function resolveGitArguments(target: RuntimeGitTarget): readonly string[] {
  if (target.kind === 'commit') {
    return ['rev-parse', '--verify', '--end-of-options', `${target.ref}^{commit}`];
  }
  return [
    'rev-parse',
    '--revs-only',
    '--end-of-options',
    `${target.base}^{commit}..${target.head}^{commit}`,
  ];
}

function isSymbolicTarget(
  target: RuntimeGitTarget | RuntimeGitPinnedTarget,
): target is RuntimeGitTarget {
  if (target.kind === 'commit') return 'ref' in target;
  return 'base' in target && 'head' in target;
}

function gitArguments(
  operation: RuntimeGitOperation,
  projectRoot: string,
  target?: RuntimeGitTarget | RuntimeGitPinnedTarget,
): readonly string[] {
  if (operation === 'resolve_target') {
    if (target === undefined || !isSymbolicTarget(target)) {
      throw new Error('resolve_target requires a symbolic target');
    }
    return resolveGitArguments(target);
  }
  if (operation === 'target_diff' || operation === 'target_diff_stat') {
    if (target === undefined || isSymbolicTarget(target)) {
      throw new Error(`${operation} requires a pinned target`);
    }
    return targetGitArguments(
      operation,
      target,
      target.kind === 'commit' ? acceptanceCommitParent(projectRoot, target.commit) : undefined,
    );
  }
  return STATIC_GIT_ARGUMENTS[operation];
}

interface AcceptanceObservation {
  readonly workspace: string;
  readonly operation: RuntimeGitOperation;
  readonly target?: RuntimeGitTarget | RuntimeGitPinnedTarget;
}

interface AcceptanceObservations {
  readonly gitReads: AcceptanceObservation[];
  readonly relayPrompts: Array<{ readonly workspace: string; readonly prompt: string }>;
  readonly launchErrors: string[];
}

function acceptanceResolvedTarget(
  target: RuntimeGitTarget,
  output: string,
): RuntimeGitPinnedTarget {
  const lines = output.trimEnd().split('\n');
  if (target.kind === 'commit') {
    const commit = lines[0];
    if (lines.length !== 1 || commit === undefined) throw new Error('invalid commit resolution');
    return { kind: 'commit', commit };
  }
  const headCommit = lines[0];
  const baseCommit = lines[1];
  if (lines.length !== 2 || headCommit === undefined || !baseCommit?.startsWith('^')) {
    throw new Error('invalid range resolution');
  }
  return {
    kind: 'range',
    base_commit: baseCommit.slice(1),
    head_commit: headCommit,
    dots: target.dots,
  };
}

function acceptanceSecurity(observations: AcceptanceObservations): {
  readonly proofCommandRunner: NonNullable<RuntimeExecutionCapabilities['proofCommandRunner']>;
  readonly gitReader: RuntimeGitReader;
} {
  const proofCommandRunner: NonNullable<
    RuntimeExecutionCapabilities['proofCommandRunner']
  > = async (command, projectRoot) => {
    const result = spawnSync(command.argv[0] ?? '', command.argv.slice(1), {
      cwd: resolve(projectRoot, command.cwd),
      env: { ...process.env, ...command.env },
      encoding: 'utf8',
      timeout: command.timeout_ms,
      maxBuffer: command.max_output_bytes,
    });
    const exitCode = result.status ?? 1;
    return {
      command,
      exit_code: exitCode,
      status: exitCode === 0 ? 'passed' : 'failed',
      duration_ms: 1,
      stdout_summary: result.stdout ?? '',
      stderr_summary: result.stderr ?? '',
      timed_out: result.error?.message.includes('ETIMEDOUT') === true,
    };
  };
  const gitReader: RuntimeGitReader = {
    read: async ({ operation, projectRoot, target }) => {
      observations.gitReads.push({
        workspace: projectRoot,
        operation,
        ...(target === undefined ? {} : { target }),
      });
      const result = spawnSync('/usr/bin/git', gitArguments(operation, projectRoot, target), {
        cwd: projectRoot,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      const exitCode = result.status ?? 1;
      const stdout = result.stdout ?? '';
      return {
        schema_version: 1,
        ok: exitCode === 0,
        operation,
        stdout,
        stderr: result.stderr ?? '',
        exit_code: exitCode,
        truncated: false,
        limit_bytes: 2 * 1024 * 1024,
        cleanup_confirmed: true,
        ...(operation === 'resolve_target' && target !== undefined && isSymbolicTarget(target)
          ? { resolved_target: acceptanceResolvedTarget(target, stdout) }
          : {}),
      };
    },
  };
  return { proofCommandRunner, gitReader };
}

function acceptanceLauncher(
  workerModule: PackagedWorkerModule,
  nodeExecutable: LifecycleExecutableIdentity,
  observations: AcceptanceObservations,
): SupervisorLauncher {
  let nextPid = 41_000;
  const authorizationSha256 = createHash('sha256').update(AUTHORIZATION_TOKEN).digest('hex');
  return {
    begin: async (): Promise<SupervisorLaunchSession> => {
      const supervisor = processIdentity(nextPid++, `supervisor-${nextPid}`, nodeExecutable);
      return {
        supervisor,
        authorization_token: AUTHORIZATION_TOKEN,
        authorization_sha256: authorizationSha256,
        authorize: async ({ worker }) => {
          const launch = worker.launch_payload as McpWorkerLaunch;
          const runFolder = join(
            launch.workspace.canonical_path,
            '.circuit',
            'runs',
            launch.run_id,
          );
          const captured = await captureStreams(async () => {
            const relayer = createPackagedFlowRelayer({
              workspace: launch.workspace.canonical_path,
              runFolder,
            });
            return await workerModule.runPackagedMcpWorkerLaunch(launch, {
              environment: { PATH: process.env.PATH ?? '' },
              createRelayer: () => ({
                ...relayer,
                relay: async (input) => {
                  observations.relayPrompts.push({
                    workspace: launch.workspace.canonical_path,
                    prompt: input.prompt,
                  });
                  return await relayer.relay(input);
                },
              }),
              createSecurity: () => acceptanceSecurity(observations),
            });
          });
          if (captured.result !== 0) {
            const message = `Relocated worker failed: ${captured.stderr || captured.stdout}`;
            observations.launchErrors.push(message);
            throw new Error(message);
          }
          expect(runFolder).toContain(launch.run_id);
          return processIdentity(nextPid++, authorizationSha256, nodeExecutable);
        },
        closeBeforeAuthorization: async () => true,
      };
    },
  };
}

async function call(
  client: Client,
  workspace: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const result = await client.callTool({
    name,
    arguments: args,
    _meta: { 'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(workspace).href } },
  });
  return result.structuredContent as unknown as ToolResponse;
}

interface AcceptanceCase {
  readonly name: string;
  readonly request: CircuitStartInputV1;
  readonly resumeChoice?: string;
}

const ACCEPTANCE_CASES: readonly AcceptanceCase[] = [
  {
    name: 'Review',
    request: {
      flow: 'review',
      goal: 'Review staged changes.',
      web_search: 'off',
    },
  },
  {
    name: 'Fix',
    request: {
      flow: 'fix',
      goal: 'Fix the missing marker; regression command is `node verify-fix.mjs`.',
      web_search: 'off',
    },
  },
  {
    name: 'Build',
    request: {
      flow: 'build',
      goal: 'Build one deterministic TypeScript marker file.',
      process: 'medium',
      web_search: 'off',
    },
  },
  {
    name: 'Explore',
    request: {
      flow: 'explore',
      goal: 'Explore how the packaged MCP boundary stays deterministic.',
      web_search: 'off',
    },
  },
  {
    name: 'Prototype',
    request: {
      flow: 'prototype',
      goal: 'Prototype a tiny local Circuit status page.',
      process: 'medium',
      web_search: 'off',
    },
  },
  {
    name: 'Explore tournament',
    request: {
      flow: 'explore',
      goal: 'Compare two deterministic approaches to the packaged MCP boundary.',
      tournament: 2,
      web_search: 'off',
    },
    resumeChoice: 'option-1',
  },
  {
    name: 'Prototype tournament',
    request: {
      flow: 'prototype',
      goal: 'Compare two deterministic local status page prototypes.',
      tournament: 2,
      variants: [
        { id: 'variant-a', label: 'Variant A', model: 'fixture-a', effort: 'low' },
        { id: 'variant-b', label: 'Variant B', model: 'fixture-b', effort: 'medium' },
      ],
      web_search: 'off',
    },
    resumeChoice: 'variant-a',
  },
];

async function acceptanceWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, `${name.toLowerCase().replaceAll(' ', '-')}-workspace`);
  await mkdir(workspace, { recursive: true });
  initGitProjectRoot(workspace);
  await Promise.all([
    writeFile(
      join(workspace, 'package.json'),
      `${JSON.stringify(
        {
          name: 'packaged-mcp-acceptance',
          private: true,
          scripts: { check: 'node -e "process.exit(0)"' },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(workspace, 'verify-fix.mjs'),
      "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('src/circuit-mcp-fix-fixture.ts') ? 0 : 1);\n",
    ),
  ]);
  const commit = spawnSync('/usr/bin/git', ['add', '-A'], { cwd: workspace, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(commit.stderr);
  const committed = spawnSync('/usr/bin/git', ['commit', '-q', '-m', 'acceptance fixture'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (committed.status !== 0) throw new Error(committed.stderr);
  return workspace;
}

function runGit(workspace: string, args: readonly string[]): string {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return (result.stdout ?? '').trim();
}

describe('relocated Codex MCP package lifecycle acceptance', () => {
  let tempRoot: string;
  let relocatedPlugin: string;
  let codexHome: string;
  let assets: McpRuntimeAssetPins;
  let server: McpServer;
  let client: Client;
  const observations: AcceptanceObservations = {
    gitReads: [],
    relayPrompts: [],
    launchErrors: [],
  };

  beforeAll(async () => {
    await mkdir(PRIVATE_TEST_ROOT, { recursive: true, mode: 0o700 });
    tempRoot = await realpath(await mkdtemp(join(PRIVATE_TEST_ROOT, 'package-acceptance-')));
    relocatedPlugin = join(tempRoot, 'installed-plugin');
    codexHome = join(tempRoot, 'codex-home');
    const fakeCodex = join(tempRoot, 'fixture-codex');
    await Promise.all([
      cp(PACKAGED_PLUGIN, relocatedPlugin, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      writeFile(fakeCodex, '#!/bin/sh\nexit 99\n', { mode: 0o700 }),
    ]);
    assets = await pinMcpRuntimeAssets({
      node: process.execPath,
      codex: fakeCodex,
      plugin_runtimes: [
        ['manifest', '.codex-plugin/plugin.json'],
        ['config', '.mcp.json'],
        ['server_shim', 'mcp/server.cjs'],
        ['server', 'mcp/server.mjs'],
        ['supervisor', 'mcp/supervisor.mjs'],
        ['worker', 'mcp/worker.mjs'],
        ['circuit', 'runtime/circuit.js'],
        ['git_state', 'runtime/git-state.js'],
      ].map(([id, path]) => ({ id: id ?? '', path: join(relocatedPlugin, path ?? '') })),
      git_helper: '/usr/bin/git',
      packaged_flows: collectPackagedFlowAssets(join(relocatedPlugin, 'flows')),
    });
    const serverModule = (await dynamicImport(
      `${pathToFileURL(join(relocatedPlugin, 'mcp/server.mjs')).href}?acceptance=server`,
    )) as PackagedServerModule;
    const workerModule = (await dynamicImport(
      `${pathToFileURL(join(relocatedPlugin, 'mcp/worker.mjs')).href}?acceptance=worker`,
    )) as PackagedWorkerModule;
    const nodeIdentity = executableIdentity(assetById(assets, 'node'));
    const owner: LifecycleProcessOwnerIdentity = {
      ...processIdentity(40_000, 'acceptance-owner', nodeIdentity),
      instance_id: 'acceptance-server',
    };
    const processProbe = {
      inspectProcessSync: (identity: LifecycleProcessIdentity) =>
        identity.birth_token === owner.birth_token ? ('alive' as const) : ('absent' as const),
      inspectProcessGroupSync: (identity: LifecycleProcessIdentity) =>
        identity.birth_token === owner.birth_token ? ('alive' as const) : ('absent' as const),
      inspectProcessTokenSync: () => 'absent' as const,
      inspectProcess: async (identity: LifecycleProcessIdentity) =>
        identity.birth_token === owner.birth_token ? ('alive' as const) : ('absent' as const),
      inspectProcessGroup: async (identity: LifecycleProcessIdentity) =>
        identity.birth_token === owner.birth_token ? ('alive' as const) : ('absent' as const),
      signalOwnedProcessGroup: async () => 'absent' as const,
    };
    server = await serverModule.createPackagedCircuitMcpServer({
      pluginRoot: relocatedPlugin,
      codexHome,
      environment: { PATH: process.env.PATH ?? '' },
      platform: 'darwin',
      owner,
      processProbe,
      dependencies: {
        loadRuntimeAssets: async () => assets,
        preflight: acceptancePreflight(),
        launcher: acceptanceLauncher(workerModule, nodeIdentity, observations),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'circuit-package-acceptance', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each(ACCEPTANCE_CASES)(
    'runs $name through relocated start/status lifecycle',
    async ({ name, request, resumeChoice }) => {
      const workspace = await acceptanceWorkspace(tempRoot, name);
      if (request.flow === 'review') {
        await writeFile(join(workspace, 'src', 'review.ts'), 'export const changed = true;\n');
        runGit(workspace, ['add', 'src/review.ts']);
      }

      const started = await call(client, workspace, 'circuit_start', request);
      expect(
        started,
        JSON.stringify({ started, launch_errors: observations.launchErrors }),
      ).toMatchObject({ ok: true, state: 'running' });
      let status = await call(client, workspace, 'circuit_status', {
        run_id: started.run_id,
      });
      if (resumeChoice !== undefined) {
        expect(status, JSON.stringify(status)).toMatchObject({
          ok: true,
          state: 'waiting_for_input',
          checkpoint: {
            choices: expect.arrayContaining([expect.objectContaining({ id: resumeChoice })]),
          },
        });
        if (status.checkpoint === undefined || started.run_id === undefined) {
          throw new Error(`${name} did not expose its resumable checkpoint.`);
        }
        const resumed = await call(client, workspace, 'circuit_resume', {
          run_id: started.run_id,
          checkpoint_token: status.checkpoint.token,
          choice_id: resumeChoice,
        });
        expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true, state: 'running' });
        status = await call(client, workspace, 'circuit_status', {
          run_id: started.run_id,
        });
      }
      expect(status, JSON.stringify(status)).toMatchObject({
        ok: true,
        state: 'complete',
        final_report: { schema: `circuit.${request.flow}.result` },
      });
    },
    120_000,
  );

  it('relays only an explicitly requested older commit through the relocated worker', async () => {
    const workspace = await acceptanceWorkspace(tempRoot, 'Review explicit older commit');
    const requestedMarker = 'requested-older-commit-marker';
    const newerCommitMarker = 'excluded-newer-head-marker';
    const workingTreeMarker = 'excluded-working-tree-marker';

    await writeFile(
      join(workspace, 'src', 'requested-commit.ts'),
      `export const requested = '${requestedMarker}';\n`,
    );
    runGit(workspace, ['add', 'src/requested-commit.ts']);
    runGit(workspace, ['commit', '-q', '-m', 'requested older commit']);
    const requestedCommit = runGit(workspace, ['rev-parse', 'HEAD']);

    await writeFile(
      join(workspace, 'src', 'newer-head.ts'),
      `export const newer = '${newerCommitMarker}';\n`,
    );
    runGit(workspace, ['add', 'src/newer-head.ts']);
    runGit(workspace, ['commit', '-q', '-m', 'newer head commit']);
    await writeFile(
      join(workspace, 'src', 'working-tree.ts'),
      `export const workingTree = '${workingTreeMarker}';\n`,
    );

    const started = await call(client, workspace, 'circuit_start', {
      flow: 'review',
      goal: `Review commit ${requestedCommit}.`,
      web_search: 'off',
    });
    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      state: 'running',
    });
    const status = await call(client, workspace, 'circuit_status', {
      run_id: started.run_id,
    });
    expect(status, JSON.stringify(status)).toMatchObject({
      ok: true,
      state: 'complete',
      final_report: { schema: 'circuit.review.result' },
    });

    const gitReads = observations.gitReads.filter(
      (observation) => observation.workspace === workspace,
    );
    expect(gitReads).toEqual([
      {
        workspace,
        operation: 'resolve_target',
        target: { kind: 'commit', ref: requestedCommit },
      },
      {
        workspace,
        operation: 'target_diff',
        target: { kind: 'commit', commit: requestedCommit },
      },
      {
        workspace,
        operation: 'target_diff_stat',
        target: { kind: 'commit', commit: requestedCommit },
      },
    ]);

    const auditPrompt = observations.relayPrompts.find(
      (observation) =>
        observation.workspace === workspace && observation.prompt.includes('Step: audit-step'),
    )?.prompt;
    expect(auditPrompt).toContain(requestedMarker);
    expect(auditPrompt).not.toContain(newerCommitMarker);
    expect(auditPrompt).not.toContain(workingTreeMarker);
    expect(auditPrompt).toContain('"kind": "git-target"');
  }, 120_000);
});

import { readFileSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import type { CliMainOptions } from '../../cli/circuit.js';
import { Config, type Config as ConfigValue } from '../../schemas/config.js';
import type { RelayFn } from '../../shared/relay-runtime-types.js';
import {
  type McpRuntimeAssetPin,
  McpRuntimeAssetPinsV1,
  verifyMcpRuntimeAsset,
  verifyMcpRuntimeAssets,
} from './asset-pins.js';
import { MINIMUM_CODEX_VERSION } from './capabilities.js';
import { CircuitStartInputV1 } from './contracts.js';
import { runMcpCodexSubprocess } from './nested-codex-subprocess.js';
import type { CreateMcpCodexRelayerDependencies, McpNestedCodexPolicy } from './nested-codex.js';
import { derivePinnedNodeInstallation } from './production-paths.js';
import { CODEX_MCP_ROOTS_SOURCE, CODEX_SANDBOX_METADATA_KEY } from './resources.js';
import { createMcpRuntimeContext } from './runtime-context.js';
import { type McpWorkerSecurity, createMcpWorkerSecurity } from './worker-security.js';
import {
  type McpRunDirectoryBinding,
  prepareMcpWorkspaceRunDirectory,
} from './workspace-run-directory.js';

const MAX_LAUNCH_BYTES = 1024 * 1024;
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const AbsolutePath = z.string().min(1).max(8_192).refine(isAbsolute, 'must be an absolute path');
const ChoiceId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const ModelName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/);

const McpWorkerOperationV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }).strict(),
  z.object({ kind: z.literal('resume'), choice_id: ChoiceId }).strict(),
]);

export const McpWorkerLaunchV1 = z
  .object({
    schema_version: z.literal(1),
    authorization: SHA256,
    run_id: z.guid(),
    operation: McpWorkerOperationV1,
    workspace: z
      .object({
        canonical_path: AbsolutePath,
        device: z.string().regex(/^\d+$/),
        inode: z.string().regex(/^\d+$/),
        identity_source: z.enum([CODEX_SANDBOX_METADATA_KEY, CODEX_MCP_ROOTS_SOURCE]),
      })
      .strict(),
    flow_root: AbsolutePath,
    private_temp_root: AbsolutePath,
    asset_digest_sha256: SHA256,
    runtime_assets: McpRuntimeAssetPinsV1,
    capabilities: z
      .object({
        codex_version: z.string().trim().min(1).max(128),
        minimum_version: z.literal(MINIMUM_CODEX_VERSION),
        plugin_mcp: z.literal(true),
        strict_config: z.literal(true),
        workspace_metadata: z.literal(true),
        nested_sandbox: z.literal(true),
        shared_temp_isolation: z.enum(['isolated', 'exposed']),
      })
      .strict(),
    codex: z
      .object({
        executable: AbsolutePath,
        version: z.string().trim().min(1).max(128),
        default_model: ModelName,
        allowed_models: z.array(ModelName).min(1).max(256),
      })
      .strict()
      .superRefine((codex, ctx) => {
        if (new Set(codex.allowed_models).size !== codex.allowed_models.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['allowed_models'],
            message: 'models must be unique',
          });
        }
        if (!codex.allowed_models.includes(codex.default_model)) {
          ctx.addIssue({
            code: 'custom',
            path: ['default_model'],
            message: 'default model must be in the allowed model roster',
          });
        }
      }),
    git: z
      .object({
        executable: AbsolutePath,
      })
      .strict(),
    request: CircuitStartInputV1,
  })
  .strict()
  .superRefine((launch, ctx) => {
    if (launch.codex.version !== launch.capabilities.codex_version) {
      ctx.addIssue({
        code: 'custom',
        path: ['codex', 'version'],
        message: 'must match the sealed Codex capability result',
      });
    }
  });
export type McpWorkerLaunch = z.infer<typeof McpWorkerLaunchV1>;

export function parseMcpWorkerLaunch(value: unknown): McpWorkerLaunch {
  return McpWorkerLaunchV1.parse(value);
}

export function readMcpWorkerLaunchFromFd(fd = 3): McpWorkerLaunch {
  const bytes = readFileSync(fd);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LAUNCH_BYTES) {
    throw new Error('The private Circuit launch message is empty or too large.');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('The private Circuit launch message is not valid JSON.');
  }
  return parseMcpWorkerLaunch(value);
}

function runFolder(launch: McpWorkerLaunch): string {
  return join(launch.workspace.canonical_path, '.circuit', 'runs', launch.run_id);
}

export function buildMcpWorkerArgv(launch: McpWorkerLaunch): string[] {
  const folder = runFolder(launch);
  if (launch.operation.kind === 'resume') {
    return [
      'resume',
      '--run-folder',
      folder,
      '--checkpoint-choice',
      launch.operation.choice_id,
      '--progress',
      'jsonl',
    ];
  }

  const request = launch.request;
  const argv = [
    'run',
    request.flow,
    '--goal',
    request.goal,
    '--run-folder',
    folder,
    '--flow-root',
    launch.flow_root,
  ];
  if (request.why !== undefined) argv.push('--why', request.why);
  if (request.power !== undefined) argv.push('--power', request.power);
  if (request.process !== undefined) argv.push('--process', request.process);
  if (request.tournament !== undefined) argv.push('--tournament', String(request.tournament));
  if (request.autonomous === true) argv.push('--autonomous');
  if (request.include_untracked_content === true) argv.push('--include-untracked-content');
  argv.push('--progress', 'jsonl');
  return argv;
}

export function buildMcpWorkerInvocationConfig(launch: McpWorkerLaunch): ConfigValue {
  const variants = launch.request.variants?.map((variant) => ({
    id: variant.id,
    label: variant.label,
    connector: { kind: 'builtin' as const, name: 'codex' as const },
    selection: {
      model: { provider: 'openai' as const, model: variant.model },
      effort: variant.effort,
    },
  }));
  return Config.parse({
    schema_version: 1,
    host: { kind: 'codex' },
    relay: { default: 'codex' },
    skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
    ...(variants === undefined ? {} : { flows: { prototype: { variant_models: variants } } }),
  });
}

export interface McpWorkerRuntimeDependencies {
  readonly main: (argv: readonly string[], options: CliMainOptions) => Promise<number>;
  readonly createRelayer: (
    policy: McpNestedCodexPolicy,
    dependencies: CreateMcpCodexRelayerDependencies,
  ) => RelayFn;
  readonly environment: NodeJS.ProcessEnv;
  readonly createRuntimeContext?: typeof createMcpRuntimeContext;
  readonly createSecurity?: (
    input: Parameters<typeof createMcpWorkerSecurity>[0],
  ) => McpWorkerSecurity;
  readonly verifyLaunch?: (launch: McpWorkerLaunch) => Promise<void>;
  readonly prepareRunDirectory?: (launch: McpWorkerLaunch) => Promise<McpRunDirectoryBinding>;
  readonly prepareDirectories?: (launch: McpWorkerLaunch) => Promise<{
    readonly configHome: string;
    readonly configCwd: string;
  }>;
}

function pathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function requireBoundAsset(
  launch: McpWorkerLaunch,
  role: 'codex' | 'git_helper',
  path: string,
): McpRuntimeAssetPin {
  const asset = launch.runtime_assets.assets.find(
    (candidate) => candidate.role === role && candidate.real_path === path,
  );
  if (asset === undefined) {
    throw new Error(`The sealed ${role === 'codex' ? 'Codex' : 'Git'} asset binding changed.`);
  }
  return asset;
}

export async function verifyMcpWorkerLaunch(launch: McpWorkerLaunch): Promise<void> {
  if (launch.asset_digest_sha256 !== launch.runtime_assets.digest_sha256) {
    throw new Error('The sealed runtime asset digest changed before the worker started.');
  }
  await verifyMcpRuntimeAssets(launch.runtime_assets);

  const workspace = await realpath(launch.workspace.canonical_path);
  if (workspace !== resolve(launch.workspace.canonical_path)) {
    throw new Error('The trusted workspace changed before the Circuit worker started.');
  }
  const workspaceInfo = await stat(workspace);
  if (
    !workspaceInfo.isDirectory() ||
    String(workspaceInfo.dev) !== launch.workspace.device ||
    String(workspaceInfo.ino) !== launch.workspace.inode
  ) {
    throw new Error('The trusted workspace identity changed before the Circuit worker started.');
  }

  const flowRoot = await realpath(launch.flow_root);
  const flowRootInfo = await stat(flowRoot);
  if (flowRoot !== resolve(launch.flow_root) || !flowRootInfo.isDirectory()) {
    throw new Error('The packaged flow root changed before the Circuit worker started.');
  }
  const packagedFlows = launch.runtime_assets.assets.filter(
    (asset) => asset.role === 'packaged_flow',
  );
  if (
    packagedFlows.length === 0 ||
    packagedFlows.some((asset) => !pathInside(flowRoot, asset.real_path))
  ) {
    throw new Error('The packaged flow assets are not sealed inside the flow root.');
  }
  requireBoundAsset(launch, 'codex', launch.codex.executable);
  requireBoundAsset(launch, 'git_helper', launch.git.executable);
}

async function preparePrivateDirectories(launch: McpWorkerLaunch): Promise<{
  readonly configHome: string;
  readonly configCwd: string;
}> {
  const workspace = await realpath(launch.workspace.canonical_path);
  if (workspace !== resolve(launch.workspace.canonical_path)) {
    throw new Error('The trusted workspace changed before the Circuit worker started.');
  }
  const tempRoot = await realpath(launch.private_temp_root);
  if (tempRoot !== resolve(launch.private_temp_root)) {
    throw new Error('The private Circuit run directory changed before the worker started.');
  }
  const configHome = join(tempRoot, 'config-home');
  const configCwd = join(tempRoot, 'config-workspace');
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await mkdir(configCwd, { recursive: true, mode: 0o700 });
  return { configHome, configCwd };
}

export async function runMcpWorkerLaunch(
  launch: McpWorkerLaunch,
  dependencies: McpWorkerRuntimeDependencies,
): Promise<number> {
  await (dependencies.verifyLaunch ?? verifyMcpWorkerLaunch)(launch);
  const codexAsset = requireBoundAsset(launch, 'codex', launch.codex.executable);
  const nodeAsset = launch.runtime_assets.assets.find(
    (asset) => asset.id === 'node' && asset.role === 'node',
  );
  if (nodeAsset === undefined) throw new Error('The sealed Node asset binding changed.');
  const nodeInstallation = derivePinnedNodeInstallation(nodeAsset.real_path);
  const runDirectory = await (dependencies.prepareRunDirectory ?? prepareMcpWorkspaceRunDirectory)(
    launch,
  );
  try {
    if (runDirectory.runFolder !== runFolder(launch)) {
      throw new Error('The bound MCP run directory does not match the sealed launch.');
    }
    const directories = await (dependencies.prepareDirectories ?? preparePrivateDirectories)(
      launch,
    );
    const security = (dependencies.createSecurity ?? createMcpWorkerSecurity)({
      workspace: launch.workspace.canonical_path,
      privateRoot: launch.private_temp_root,
      gitExecutable: launch.git.executable,
      environment: dependencies.environment,
    });
    const context = (dependencies.createRuntimeContext ?? createMcpRuntimeContext)({
      workspace: {
        identity_source: launch.workspace.identity_source,
        workspace: launch.workspace.canonical_path,
      },
      workspaceIdentity: {
        device: launch.workspace.device,
        inode: launch.workspace.inode,
      },
      capabilities: launch.capabilities,
      assets: launch.runtime_assets,
      search: {
        mode: launch.request.web_search,
        consented: launch.request.consent?.cached_web_search === true,
      },
      proofExecutor: security.proofCommandRunner,
      gitReader: security.gitReader,
      cancellation: {
        owner: 'supervisor',
        process_group_cleanup: 'observed',
        run_id: launch.run_id,
      },
    });
    const relayer = dependencies.createRelayer(
      {
        executable: context.codex.executable,
        cliVersion: context.codex.version,
        workspace: context.workspace.canonical_path,
        tempRoot: launch.private_temp_root,
        nodeExecutable: nodeInstallation.executable,
        nodeInstallationRoot: nodeInstallation.root,
        gitExecutable: launch.git.executable,
        searchMode: context.search.mode,
        defaultModel: launch.codex.default_model,
        allowedModels: new Set(launch.codex.allowed_models),
      },
      {
        run: runMcpCodexSubprocess,
        environment: dependencies.environment,
        verifyBeforeSpawn: async () => await verifyMcpRuntimeAsset(codexAsset),
      },
    );
    await runDirectory.validate();
    return await dependencies.main(buildMcpWorkerArgv(launch), {
      relayer,
      configHomeDir: directories.configHome,
      configCwd: directories.configCwd,
      projectRoot: context.workspace.canonical_path,
      runId: launch.run_id,
      hostKind: 'codex',
      historyRecall: context.history,
      codexInstallAssurance: 'disabled',
      invocationConfig: buildMcpWorkerInvocationConfig(launch),
      generatedFlowMirrorRoot: launch.flow_root,
      proofCommandRunner: context.proofExecutor,
      gitReader: context.gitReader,
    });
  } finally {
    await runDirectory.close();
  }
}

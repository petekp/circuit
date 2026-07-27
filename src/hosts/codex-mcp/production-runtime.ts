import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { validateFlowStartTarget } from '../../flows/registries/start-preflight.js';
import {
  type McpRuntimeAssetPin,
  type McpRuntimeAssetPins,
  pinMcpRuntimeAssets,
  verifyMcpRuntimeAssets,
} from './asset-pins.js';
import type { CodexHostCapabilities } from './capabilities.js';
import {
  type CodexModelRoster,
  loadCodexModelRoster,
  validateCachedSearchModels,
  validatePrototypeVariantModels,
} from './codex-model-roster.js';
import type { CircuitStartInputV1 } from './contracts.js';
import { McpFinalReportReader } from './final-report-reader.js';
import { probeCodexHostCapabilities } from './host-preflight.js';
import type {
  LifecycleProcessOwnerIdentity,
  LifecycleRunRecord,
  LifecycleWorkerFactory,
  LifecycleWorkspaceIdentity,
} from './lifecycle-types.js';
import { McpLifecycleError, createCircuitMcpLifecycleHandler } from './lifecycle.js';
import { ObservedCleanupController } from './process-cleanup.js';
import {
  type ObservedProcessProbe,
  createMacOsProcessProbe,
  readExecutableIdentity,
} from './process-probe.js';
import {
  codexMcpStateRoot,
  collectPackagedFlowAssets,
  derivePinnedNodeInstallation,
  resolveCodexExecutableOnPath,
  resolveGitExecutableOnPath,
} from './production-paths.js';
import { loadPublicFlowCatalog } from './public-flow-catalog.js';
import { resolveTrustedCodexWorkspaceFromSources } from './resources.js';
import { CanonicalRuntimeArtifactReconciler } from './runtime-artifacts.js';
import type { CircuitMcpToolHandler } from './server.js';
import { McpCheckpointAdapter, McpLifecycleStateAdapter } from './state-adapter.js';
import { McpStateStore, trustedWorkspaceIdentity } from './state-store.js';
import {
  ProcessSupervisorLauncher,
  type ProcessSupervisorLauncherOptions,
  type SupervisorLauncher,
} from './supervisor-launcher.js';

const PLUGIN_RUNTIME_FILES = [
  ['manifest', '.codex-plugin/plugin.json'],
  ['config', '.mcp.json'],
  ['server_shim', 'mcp/server.cjs'],
  ['server', 'mcp/server.mjs'],
  ['supervisor', 'mcp/supervisor.mjs'],
  ['worker', 'mcp/worker.mjs'],
  ['circuit', 'runtime/circuit.js'],
  ['git_state', 'runtime/git-state.js'],
] as const;

export interface ProductionMcpLayoutInput {
  readonly pluginRoot: string;
  readonly codexHome: string;
  readonly nodeExecutable: string;
  readonly gitExecutable?: string;
  readonly pathValue: string | undefined;
}

export interface ProductionMcpLayout {
  readonly pluginRoot: string;
  readonly flowsRoot: string;
  readonly stateRoot: string;
  readonly modelCache: string;
  readonly nodeExecutable: string;
  readonly codexExecutable: string;
  readonly gitExecutable: string;
  readonly pluginRuntimes: readonly { readonly id: string; readonly path: string }[];
  readonly packagedFlows: readonly { readonly id: string; readonly path: string }[];
}

export function resolveProductionCodexHome(environment: NodeJS.ProcessEnv): string {
  const candidate =
    environment.CODEX_HOME ??
    (environment.HOME === undefined ? undefined : join(environment.HOME, '.codex'));
  if (candidate === undefined) {
    throw new Error('Circuit MCP requires CODEX_HOME or an absolute HOME directory.');
  }
  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error('Circuit MCP requires an absolute CODEX_HOME directory.');
  }
  return resolve(candidate);
}

const SHARED_TEMP_ROOT_CANDIDATES = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
] as const;

async function canonicalSharedTempRoots(): Promise<ReadonlySet<string>> {
  const sharedRoots = new Set<string>();
  for (const root of [...SHARED_TEMP_ROOT_CANDIDATES, tmpdir()]) {
    if (!isAbsolute(root)) continue;
    try {
      const canonicalRoot = await realpath(resolve(root));
      if ((await stat(canonicalRoot)).isDirectory()) sharedRoots.add(canonicalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Circuit MCP could not validate the host temporary-directory boundary.');
    }
  }
  return sharedRoots;
}

/**
 * Pins CODEX_HOME before any durable MCP state is opened. Nested Codex may
 * retain access to host-managed temporary directories, so Circuit never puts
 * its own leases or launch records beneath one of those shared roots.
 */
export async function resolvePrivateProductionCodexHome(candidate: string): Promise<string> {
  if (!isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error('Circuit MCP requires an absolute CODEX_HOME directory.');
  }
  let canonicalHome: string;
  try {
    canonicalHome = await realpath(resolve(candidate));
    if (!(await stat(canonicalHome)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('Circuit MCP requires CODEX_HOME to name an existing directory.');
  }

  const sharedRoots = await canonicalSharedTempRoots();
  if ([...sharedRoots].some((root) => pathInside(root, canonicalHome))) {
    throw new Error(
      'Circuit MCP refuses CODEX_HOME inside a shared temporary directory. Move CODEX_HOME to your private home directory and retry.',
    );
  }
  return canonicalHome;
}

async function resolvePrivateProductionStateRoot(canonicalCodexHome: string): Promise<string> {
  let current = canonicalCodexHome;
  for (const segment of ['circuit', 'mcp', 'v1']) {
    const next = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(next, { mode: 0o700 });
      info = await lstat(next);
    }
    if (info.isSymbolicLink()) {
      throw new Error('Circuit MCP state directory chain cannot contain a symbolic link.');
    }
    if (!info.isDirectory()) {
      throw new Error('Circuit MCP state directory chain must contain only real directories.');
    }
    const canonicalNext = await realpath(next);
    if (!pathInside(canonicalCodexHome, canonicalNext)) {
      throw new Error('Circuit MCP state directory escaped the canonical CODEX_HOME.');
    }
    current = canonicalNext;
  }
  const sharedRoots = await canonicalSharedTempRoots();
  if ([...sharedRoots].some((root) => pathInside(root, current))) {
    throw new Error('Circuit MCP state directory cannot live inside shared temporary storage.');
  }
  return current;
}

export function productionMcpLayout(input: ProductionMcpLayoutInput): ProductionMcpLayout {
  if (!isAbsolute(input.pluginRoot)) throw new Error('The installed plugin root must be absolute.');
  if (!isAbsolute(input.nodeExecutable)) {
    throw new Error('The host Node executable must be absolute.');
  }
  const pluginRoot = resolve(input.pluginRoot);
  const flowsRoot = join(pluginRoot, 'flows');
  const gitExecutable = input.gitExecutable ?? resolveGitExecutableOnPath(input.pathValue);
  if (!isAbsolute(gitExecutable)) throw new Error('The Git helper must be absolute.');
  return Object.freeze({
    pluginRoot,
    flowsRoot,
    stateRoot: codexMcpStateRoot(input.codexHome),
    modelCache: join(input.codexHome, 'models_cache.json'),
    nodeExecutable: input.nodeExecutable,
    codexExecutable: resolveCodexExecutableOnPath(input.pathValue),
    gitExecutable,
    pluginRuntimes: Object.freeze(
      PLUGIN_RUNTIME_FILES.map(([id, relativePath]) => ({
        id,
        path: join(pluginRoot, relativePath),
      })),
    ),
    packagedFlows: collectPackagedFlowAssets(flowsRoot),
  });
}

export function createProductionAssetLoader(
  layout: ProductionMcpLayout,
): () => Promise<McpRuntimeAssetPins> {
  return async () =>
    await pinMcpRuntimeAssets({
      node: layout.nodeExecutable,
      codex: layout.codexExecutable,
      plugin_runtimes: layout.pluginRuntimes,
      git_helper: layout.gitExecutable,
      packaged_flows: layout.packagedFlows,
    });
}

function requiredAsset(
  assets: McpRuntimeAssetPins,
  id: string,
  role: McpRuntimeAssetPin['role'],
): McpRuntimeAssetPin {
  const found = assets.assets.find((asset) => asset.id === id && asset.role === role);
  if (found === undefined) throw new Error(`The sealed Circuit asset '${id}' is missing.`);
  return found;
}

export interface PreparedProductionLaunch {
  readonly consume: () => PreparedProductionLaunchData;
}

interface PreparedProductionLaunchData {
  readonly capabilities: CodexHostCapabilities;
  readonly roster: CodexModelRoster;
}

interface ProductionPreflightDependencies {
  readonly codexHome: string;
  readonly stateRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly verifyAssets?: typeof verifyMcpRuntimeAssets;
  readonly probeHost?: typeof probeCodexHostCapabilities;
  readonly loadRoster?: typeof loadCodexModelRoster;
  readonly loadCatalog?: typeof loadPublicFlowCatalog;
  readonly deriveNodeInstallation?: typeof derivePinnedNodeInstallation;
}

function pathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function preparedProductionLaunch(data: PreparedProductionLaunchData): PreparedProductionLaunch {
  let pending: PreparedProductionLaunchData | undefined = Object.freeze(data);
  const capsule = Object.create(null) as PreparedProductionLaunch;
  Object.defineProperty(capsule, 'consume', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (): PreparedProductionLaunchData => {
      const prepared = pending;
      if (prepared === undefined) {
        throw new Error('The sealed Circuit launch preparation was already consumed.');
      }
      // Clear the captured value before worker construction starts. A later
      // filesystem or payload failure must not make this preparation reusable.
      pending = undefined;
      return prepared;
    },
  });
  return Object.freeze(capsule);
}

export interface ProductionLaunchPreflight {
  readonly validate: (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly request: CircuitStartInputV1;
    readonly runtime_assets: McpRuntimeAssetPins;
  }) => Promise<PreparedProductionLaunch>;
}

export function createProductionLaunchPreflight(
  dependencies: ProductionPreflightDependencies,
): ProductionLaunchPreflight {
  if (!isAbsolute(dependencies.stateRoot)) {
    throw new Error('The canonical Circuit MCP state root must be absolute.');
  }
  const verifyAssets = dependencies.verifyAssets ?? verifyMcpRuntimeAssets;
  const probeHost = dependencies.probeHost ?? probeCodexHostCapabilities;
  const loadRoster = dependencies.loadRoster ?? loadCodexModelRoster;
  const loadCatalog = dependencies.loadCatalog ?? loadPublicFlowCatalog;
  const deriveNodeInstallation =
    dependencies.deriveNodeInstallation ?? derivePinnedNodeInstallation;

  const result: ProductionLaunchPreflight = {
    validate: async (input: Parameters<ProductionLaunchPreflight['validate']>[0]) => {
      await verifyAssets(input.runtime_assets);
      const codex = requiredAsset(input.runtime_assets, 'codex', 'codex');
      const node = requiredAsset(input.runtime_assets, 'node', 'node');
      const git = requiredAsset(input.runtime_assets, 'git_helper', 'git_helper');
      const catalog = requiredAsset(input.runtime_assets, 'flow:catalog', 'packaged_flow');
      const nodeInstallation = deriveNodeInstallation(node.real_path);
      const probeRoot = join(dependencies.stateRoot, 'preflight', randomUUID());
      if (pathInside(input.workspace.canonical_path, probeRoot)) {
        throw new Error('The private Codex capability probe must stay outside the workspace.');
      }
      let capabilities: CodexHostCapabilities;
      try {
        capabilities = await probeHost(codex.real_path, {
          workspaceMetadataValidated: true,
          environment: dependencies.environment,
          nested: {
            policy: {
              executable: codex.real_path,
              cliVersion: 'capability-probe',
              workspace: input.workspace.canonical_path,
              tempRoot: join(probeRoot, 'private'),
              nodeExecutable: nodeInstallation.executable,
              nodeInstallationRoot: nodeInstallation.root,
              gitExecutable: git.real_path,
              searchMode: input.request.web_search,
              defaultModel: 'gpt-5.4',
              allowedModels: new Set(['gpt-5.4']),
            },
            codexHome: join(probeRoot, 'codex-home'),
            environment: dependencies.environment,
          },
        });
        // Target selection is checked only after the host itself is proven
        // usable. A sandboxed session that cannot launch Codex at all should
        // hear about the sandbox, not about its Review target. Availability is
        // the worker's answer: it reads the evidence once, and an unreadable or
        // empty target aborts the run before any model is paid.
        try {
          validateFlowStartTarget(input.request.flow, input.request.goal, input.request.target);
        } catch (error) {
          throw new McpLifecycleError(
            'invalid_review_target',
            (error as Error).message,
            'Name one target: the working tree, the staged set, the unstaged set, a commit, or a range. Narrow it with paths if you want. To review a plan or report, include its actual text.',
          );
        }
      } finally {
        await rm(probeRoot, { recursive: true, force: true });
      }
      const roster = loadRoster(join(dependencies.codexHome, 'models_cache.json'));
      const publicFlows = loadCatalog(catalog.real_path);
      if (!publicFlows.has(input.request.flow)) {
        throw new Error('The selected flow is not present in the sealed public flow catalog.');
      }
      if (input.request.variants !== undefined) {
        validatePrototypeVariantModels(input.request.variants, roster);
      }
      validateCachedSearchModels(
        {
          web_search: input.request.web_search,
          ...(input.request.variants === undefined ? {} : { variants: input.request.variants }),
        },
        roster,
      );
      return preparedProductionLaunch({ capabilities, roster });
    },
  };
  return Object.freeze(result);
}

interface ProductionWorkerFactoryOptions {
  readonly pluginRoot: string;
  readonly controlDirectory: (
    workspace: LifecycleWorkspaceIdentity,
    runId: string,
  ) => string | Promise<string>;
}

async function privateGenerationDirectory(
  controlDirectory: string,
  generation: number,
): Promise<string> {
  const canonicalControl = await realpath(controlDirectory);
  if (canonicalControl !== resolve(controlDirectory)) {
    throw new Error('The Circuit control directory changed before worker launch.');
  }
  const privateRoot = join(canonicalControl, 'private');
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const generationRoot = join(privateRoot, `generation-${generation}`);
  await mkdir(generationRoot, { recursive: false, mode: 0o700 });
  return await realpath(generationRoot);
}

export function createProductionWorkerFactory(
  options: ProductionWorkerFactoryOptions,
): LifecycleWorkerFactory<PreparedProductionLaunch> {
  const pluginRoot = resolve(options.pluginRoot);

  const create = async (input: {
    readonly workspace: LifecycleWorkspaceIdentity;
    readonly run: LifecycleRunRecord;
    readonly authorization_token: string;
    readonly runtime_assets: McpRuntimeAssetPins;
    readonly prepared_launch: PreparedProductionLaunch;
    readonly operation:
      | { readonly kind: 'start' }
      | { readonly kind: 'resume'; readonly choice_id: string };
  }) => {
    const preparation = input.prepared_launch.consume();
    const worker = requiredAsset(input.runtime_assets, 'plugin_runtime:worker', 'plugin_runtime');
    const codex = requiredAsset(input.runtime_assets, 'codex', 'codex');
    const git = requiredAsset(input.runtime_assets, 'git_helper', 'git_helper');
    const controlDirectory = await options.controlDirectory(input.workspace, input.run.run_id);
    const privateTempRoot = await privateGenerationDirectory(
      controlDirectory,
      input.run.launch.generation,
    );
    return {
      worker_entrypoint: worker.real_path,
      launch_payload: {
        schema_version: 1,
        authorization: input.authorization_token,
        run_id: input.run.run_id,
        operation: input.operation,
        workspace: {
          canonical_path: input.workspace.canonical_path,
          device: input.workspace.device,
          inode: input.workspace.inode,
          identity_source: input.workspace.identity_source ?? 'codex/sandbox-state-meta',
        },
        flow_root: join(pluginRoot, 'flows'),
        private_temp_root: privateTempRoot,
        asset_digest_sha256: input.runtime_assets.digest_sha256,
        runtime_assets: input.runtime_assets,
        capabilities: preparation.capabilities,
        codex: {
          executable: codex.real_path,
          version: preparation.capabilities.codex_version,
          default_model: preparation.roster.default_model,
          allowed_models: preparation.roster.allowed_models,
        },
        git: { executable: git.real_path },
        request: input.run.request,
      },
    };
  };

  const factory: LifecycleWorkerFactory<PreparedProductionLaunch> = {
    createStart: async (
      input: Parameters<LifecycleWorkerFactory<PreparedProductionLaunch>['createStart']>[0],
    ) => await create({ ...input, operation: { kind: 'start' } }),
    createResume: async (
      input: Parameters<LifecycleWorkerFactory<PreparedProductionLaunch>['createResume']>[0],
    ) => await create({ ...input, operation: { kind: 'resume', choice_id: input.choice_id } }),
  };
  return Object.freeze(factory);
}

interface ProductionSupervisorLauncherOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly verifyAssets?: typeof verifyMcpRuntimeAssets;
  readonly createLauncher?: (options: ProcessSupervisorLauncherOptions) => SupervisorLauncher;
}

export function createProductionSupervisorLauncher(
  options: ProductionSupervisorLauncherOptions,
): SupervisorLauncher {
  const verifyAssets = options.verifyAssets ?? verifyMcpRuntimeAssets;
  const createLauncher =
    options.createLauncher ?? ((input) => new ProcessSupervisorLauncher(input));
  return Object.freeze({
    begin: async (input: Parameters<SupervisorLauncher['begin']>[0]) => {
      const node = requiredAsset(input.runtime_assets, 'node', 'node');
      const supervisor = requiredAsset(
        input.runtime_assets,
        'plugin_runtime:supervisor',
        'plugin_runtime',
      );
      const launcher = createLauncher({
        nodeExecutable: node.real_path,
        nodeIdentity: {
          real_path: node.real_path,
          device: node.device,
          inode: node.inode,
          sha256: node.sha256,
        },
        supervisorEntrypoint: supervisor.real_path,
        verifySupervisorEntrypoint: async () => await verifyAssets(input.runtime_assets),
        environment: options.environment,
      });
      return await launcher.begin(input);
    },
  });
}

interface ProductionProcessProbe {
  readonly inspectProcessSync: ObservedProcessProbe['inspectProcessSync'];
  readonly inspectProcessGroupSync: ObservedProcessProbe['inspectProcessGroupSync'];
  readonly inspectProcessTokenSync: ObservedProcessProbe['inspectProcessTokenSync'];
  readonly inspectProcess: ObservedProcessProbe['inspectProcess'];
  readonly inspectProcessGroup: ObservedProcessProbe['inspectProcessGroup'];
  readonly signalOwnedProcessGroup: ObservedProcessProbe['signalOwnedProcessGroup'];
}

export interface CreateProductionCircuitMcpHandlerOptions {
  readonly pluginRoot: string;
  readonly codexHome: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly owner?: LifecycleProcessOwnerIdentity;
  readonly processProbe?: ProductionProcessProbe;
  /** Explicit composition seams for deterministic package acceptance tests. */
  readonly dependencies?: {
    readonly loadRuntimeAssets?: () => Promise<McpRuntimeAssetPins>;
    readonly preflight?: ProductionLaunchPreflight;
    readonly launcher?: SupervisorLauncher;
    readonly now?: () => Date;
    readonly randomRunId?: () => string;
  };
}

export async function createProductionCircuitMcpHandler(
  options: CreateProductionCircuitMcpHandlerOptions,
): Promise<CircuitMcpToolHandler> {
  const environment = options.environment ?? process.env;
  const pluginRoot = resolve(options.pluginRoot);
  const codexHome = await resolvePrivateProductionCodexHome(options.codexHome);
  const stateRoot = await resolvePrivateProductionStateRoot(codexHome);
  const hostProbe = options.processProbe === undefined ? createMacOsProcessProbe() : undefined;
  const probe = options.processProbe ?? hostProbe;
  if (probe === undefined) throw new Error('Circuit MCP process inspection is unavailable.');
  let owner = options.owner;
  const resolveOwner = (): LifecycleProcessOwnerIdentity => {
    if (owner !== undefined) return owner;
    if (hostProbe === undefined) {
      throw new Error('An injected Circuit process probe also requires an owner identity.');
    }
    owner = hostProbe.observeOwner({
      executable: readExecutableIdentity(process.execPath),
      instance_id: randomUUID(),
    });
    return owner;
  };
  const stateStore = new McpStateStore({
    stateRoot,
    inspectProcess: (identity) => probe.inspectProcessSync(identity),
    inspectProcessGroup: (identity) => probe.inspectProcessGroupSync(identity),
    inspectProcessToken: (token) => probe.inspectProcessTokenSync(token),
  });
  const state = new McpLifecycleStateAdapter({
    store: stateStore,
    artifacts: new CanonicalRuntimeArtifactReconciler(),
    inspectProcess: (identity) => probe.inspectProcessSync(identity),
    inspectProcessGroup: (identity) => probe.inspectProcessGroupSync(identity),
    retainedTerminalRuns: 100,
  });
  const preflight =
    options.dependencies?.preflight ??
    createProductionLaunchPreflight({
      codexHome,
      stateRoot: stateStore.stateRoot,
      environment,
    });
  const loadRuntimeAssets =
    options.dependencies?.loadRuntimeAssets ??
    (async (): Promise<McpRuntimeAssetPins> => {
      const layout = productionMcpLayout({
        pluginRoot,
        codexHome,
        nodeExecutable: process.execPath,
        pathValue: environment.PATH,
      });
      return await createProductionAssetLoader(layout)();
    });

  return createCircuitMcpLifecycleHandler({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    loadRuntimeAssets,
    preflightLaunch: preflight.validate,
    resolveWorkspace: async (call) => {
      const trusted = await resolveTrustedCodexWorkspaceFromSources({
        metadata: call.metadata,
        listRoots: call.listRoots,
      });
      return trustedWorkspaceIdentity(trusted.workspace, trusted.identity_source);
    },
    owner: async () => resolveOwner(),
    store: state,
    launcher: options.dependencies?.launcher ?? createProductionSupervisorLauncher({ environment }),
    workerFactory: createProductionWorkerFactory({
      pluginRoot,
      controlDirectory: (workspace, runId) => state.controlDirectory(workspace, runId),
    }),
    checkpoints: new McpCheckpointAdapter(),
    reports: new McpFinalReportReader(),
    cleanup: new ObservedCleanupController({ probe }),
    ...(options.dependencies?.now === undefined ? {} : { now: options.dependencies.now }),
    ...(options.dependencies?.randomRunId === undefined
      ? {}
      : { randomRunId: options.dependencies.randomRunId }),
  });
}

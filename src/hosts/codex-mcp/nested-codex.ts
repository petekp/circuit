import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isCodexOutputSchemaCompatible, parseCodexStdout } from '../../connectors/codex.js';
import type { ConnectorSubprocessResult } from '../../connectors/subprocess.js';
import type { ResolvedSelection } from '../../schemas/selection-policy.js';
import type { RelayFn, RelayInput } from '../../shared/relay-runtime-types.js';
import {
  type RunMcpCodexSubprocessInput,
  runMcpCodexSubprocess,
} from './nested-codex-subprocess.js';
import { mcpTransientEnvironment } from './transient-environment.js';

export const MCP_CODEX_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;
export const MCP_CODEX_STDERR_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 3_600_000;
const SIGTERM_TO_SIGKILL_GRACE_MS = 2_000;

export const MCP_CODEX_STRICT_FLAGS = [
  '--ignore-user-config',
  '--ignore-rules',
  '--strict-config',
] as const;

export const MCP_CODEX_HARDENING_CONFIG_ARGS = [
  '-c',
  'approval_policy="never"',
  '-c',
  'history.persistence="none"',
  '-c',
  'allow_login_shell=false',
  '-c',
  'project_doc_max_bytes=0',
  ...[
    'apps',
    'auth_elicitation',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'computer_use',
    'hooks',
    'image_generation',
    'in_app_browser',
    'memories',
    'multi_agent',
    'plugin_sharing',
    'plugins',
    'remote_plugin',
    'shell_snapshot',
    'skill_mcp_dependency_install',
    'tool_call_mcp_elicitation',
    'workspace_dependencies',
  ].flatMap((feature) => ['-c', `features.${feature}=false`]),
  '-c',
  'features.shell_tool=true',
  '-c',
  'mcp_servers={}',
] as const;

const SUPPORTED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
export interface McpNestedCodexPolicy {
  readonly executable: string;
  readonly cliVersion: string;
  readonly workspace: string;
  readonly tempRoot: string;
  readonly nodeExecutable: string;
  readonly nodeInstallationRoot: string;
  readonly gitExecutable: string;
  readonly searchMode: 'off' | 'cached';
  readonly defaultModel: string;
  readonly allowedModels: ReadonlySet<string>;
}

export interface McpCodexProcessRunner {
  readonly run: (input: RunMcpCodexSubprocessInput) => Promise<ConnectorSubprocessResult>;
}

export interface CreateMcpCodexRelayerDependencies extends McpCodexProcessRunner {
  readonly environment: NodeJS.ProcessEnv;
  readonly verifyBeforeSpawn?: () => Promise<void>;
}

export function safeMcpCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return mcpTransientEnvironment(environment);
}

function selectedModel(
  selection: ResolvedSelection | undefined,
  policy: McpNestedCodexPolicy,
): string {
  const selected = selection?.model;
  if (selected !== undefined && selected.provider !== 'openai') {
    throw new Error(
      `The selected model provider '${selected.provider}' is not supported by the Codex worker. Choose an OpenAI model.`,
    );
  }
  const model = selected?.model ?? policy.defaultModel;
  if (!policy.allowedModels.has(model)) {
    throw new Error(
      `The selected model '${model}' is not in the current Codex model roster. Choose a listed model and retry.`,
    );
  }
  return model;
}

function selectedEffort(selection: ResolvedSelection | undefined): string | undefined {
  const effort = selection?.effort;
  if (effort === undefined) return undefined;
  if (!SUPPORTED_EFFORTS.has(effort)) {
    throw new Error(
      `The Codex worker cannot use effort '${effort}'. Remove the override or choose a supported effort: low, medium, high, or xhigh.`,
    );
  }
  return effort;
}

function assertPolicy(policy: McpNestedCodexPolicy): void {
  if (
    !isAbsolute(policy.executable) ||
    !isAbsolute(policy.workspace) ||
    !isAbsolute(policy.tempRoot) ||
    !isAbsolute(policy.nodeExecutable) ||
    !isAbsolute(policy.nodeInstallationRoot) ||
    !isAbsolute(policy.gitExecutable)
  ) {
    throw new Error('The sealed Codex worker paths must be absolute.');
  }
  for (const path of [
    policy.executable,
    policy.workspace,
    policy.tempRoot,
    policy.nodeExecutable,
    policy.nodeInstallationRoot,
    policy.gitExecutable,
  ]) {
    if (path.includes('\0')) throw new Error('The sealed Codex worker paths are invalid.');
  }
  if (!pathInside(policy.nodeInstallationRoot, policy.nodeExecutable)) {
    throw new Error('The pinned Node executable escaped its installation root.');
  }
  if (policy.cliVersion.trim().length === 0 || policy.defaultModel.trim().length === 0) {
    throw new Error('The sealed Codex worker version and default model are required.');
  }
}

/** TOML basic strings and quoted keys share this escaping grammar. */
export function tomlString(value: string): string {
  if (value.includes('\0')) throw new Error('Circuit refused a NUL byte in a Codex setting.');
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export interface McpCodexPrivateDirectories {
  readonly home: string;
  readonly temp: string;
}

export function mcpCodexPrivateDirectories(tempRoot: string): McpCodexPrivateDirectories {
  if (!isAbsolute(tempRoot) || tempRoot.includes('\0')) {
    throw new Error('The private Codex run directory must be absolute.');
  }
  return Object.freeze({
    home: join(tempRoot, 'nested-home'),
    temp: join(tempRoot, 'nested-tmp'),
  });
}

export function buildMcpCodexSandboxConfigArgs(policy: McpNestedCodexPolicy): string[] {
  assertPolicy(policy);
  const privateDirectories = mcpCodexPrivateDirectories(policy.tempRoot);
  const nodeBin = dirname(policy.nodeExecutable);
  if (resolve(dirname(nodeBin)) !== resolve(policy.nodeInstallationRoot)) {
    throw new Error('The pinned Node executable has an unreviewed installation layout.');
  }
  const shellPath = [nodeBin, '/usr/bin', '/bin'].join(delimiter);
  const filesystem = [
    [':minimal', 'read'],
    [':workspace_roots', 'write'],
    [':slash_tmp', 'deny'],
    [policy.tempRoot, 'write'],
    [policy.nodeInstallationRoot, 'read'],
    ['/System/Library/OpenSSL', 'read'],
    [policy.gitExecutable, 'read'],
  ] as const;
  const entries = [
    'default_permissions="circuit_mcp"',
    `permissions.circuit_mcp.filesystem={${filesystem
      .map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`)
      .join(',')}}`,
    'permissions.circuit_mcp.network.enabled=false',
    'shell_environment_policy.inherit="none"',
    `shell_environment_policy.set.PATH=${tomlString(shellPath)}`,
    `shell_environment_policy.set.HOME=${tomlString(privateDirectories.home)}`,
    `shell_environment_policy.set.TMPDIR=${tomlString(privateDirectories.temp)}`,
    `shell_environment_policy.set.TMP=${tomlString(privateDirectories.temp)}`,
    `shell_environment_policy.set.TEMP=${tomlString(privateDirectories.temp)}`,
    'shell_environment_policy.set.LANG="C"',
    'shell_environment_policy.set.LC_ALL="C"',
    'shell_environment_policy.set.TERM="dumb"',
  ];
  return entries.flatMap((entry) => ['-c', entry]);
}

export function buildMcpCodexArgs(
  input: Pick<RelayInput, 'prompt' | 'resolvedSelection'>,
  policy: McpNestedCodexPolicy,
  schemaPath?: string,
): string[] {
  assertPolicy(policy);
  const model = selectedModel(input.resolvedSelection, policy);
  const effort = selectedEffort(input.resolvedSelection);
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    ...MCP_CODEX_STRICT_FLAGS,
    '--cd',
    policy.workspace,
    ...MCP_CODEX_HARDENING_CONFIG_ARGS,
    ...buildMcpCodexSandboxConfigArgs(policy),
    '-c',
    `web_search=${JSON.stringify(policy.searchMode === 'cached' ? 'cached' : 'disabled')}`,
    '-m',
    model,
  ];
  if (effort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (schemaPath !== undefined) {
    if (!isAbsolute(schemaPath))
      throw new Error('The Codex response schema path must be absolute.');
    args.push('--output-schema', schemaPath);
  }
  args.push(input.prompt);
  return args;
}

function pathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function writeResponseSchema(
  policy: McpNestedCodexPolicy,
  schema: Record<string, unknown> | undefined,
): Promise<{ readonly path?: string; readonly cleanup: () => Promise<void> }> {
  if (schema === undefined || !isCodexOutputSchemaCompatible(schema)) {
    return { cleanup: async () => {} };
  }
  await mkdir(policy.tempRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(policy.tempRoot);
  const directory = await mkdtemp(join(canonicalRoot, 'codex-schema-'));
  if (!pathInside(canonicalRoot, directory)) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('The private Codex schema directory escaped its run directory.');
  }
  const path = join(directory, 'response-schema.json');
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(schema)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await handle.close();
  return {
    path,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function assertSuccessfulProcess(result: ConnectorSubprocessResult): void {
  if (result.timedOut) {
    throw new Error(
      `The Codex worker timed out (${result.timeoutKind ?? 'unknown'}); process cleanup was ${result.killGroupSucceeded ? 'requested' : 'not confirmed'}.`,
    );
  }
  if (result.stdoutCapped) {
    throw new Error(
      `The Codex worker output exceeded ${MCP_CODEX_STDOUT_LIMIT_BYTES} bytes, so Circuit refused to parse a partial protocol stream.`,
    );
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(0, 1_000);
    throw new Error(
      `The Codex worker exited with code ${result.code ?? 'unknown'}${detail.length === 0 ? '.' : `: ${detail}`}`,
    );
  }
}

export function createMcpCodexRelayer(
  policy: McpNestedCodexPolicy,
  dependencies: CreateMcpCodexRelayerDependencies = {
    run: runMcpCodexSubprocess,
    environment: process.env,
  },
): RelayFn {
  assertPolicy(policy);
  const privateDirectories = mcpCodexPrivateDirectories(policy.tempRoot);
  const environment = {
    ...safeMcpCodexEnvironment(dependencies.environment),
    // Parent Codex still needs its host authentication and transport values.
    // Its shell receives the separate inherit-none policy above, while parent
    // temporary files stay in this private run directory.
    TMPDIR: policy.tempRoot,
  };
  return {
    connectorName: 'codex',
    connector: { kind: 'builtin', name: 'codex' },
    relay: async (input) => {
      const model = selectedModel(input.resolvedSelection, policy);
      const schema = await writeResponseSchema(policy, input.responseSchema);
      try {
        await Promise.all([
          mkdir(privateDirectories.home, { recursive: true, mode: 0o700 }),
          mkdir(privateDirectories.temp, { recursive: true, mode: 0o700 }),
        ]);
        // The worker can live across several relays. Revalidate its sealed
        // Codex executable after preparation and immediately before each
        // spawn so accidental replacement cannot slip through startup checks.
        await dependencies.verifyBeforeSpawn?.();
        const result = await dependencies.run({
          executable: policy.executable,
          args: buildMcpCodexArgs(input, policy, schema.path),
          timeoutMs: input.timeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS,
          idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          stdoutMaxBytes: MCP_CODEX_STDOUT_LIMIT_BYTES,
          stderrMaxBytes: MCP_CODEX_STDERR_LIMIT_BYTES,
          sigtermToSigkillGraceMs: SIGTERM_TO_SIGKILL_GRACE_MS,
          env: environment,
          cwd: policy.workspace,
        });
        assertSuccessfulProcess(result);
        return {
          ...parseCodexStdout(result.stdout, input.prompt, result.durationMs, policy.cliVersion),
          model,
        };
      } finally {
        await schema.cleanup();
      }
    },
  };
}

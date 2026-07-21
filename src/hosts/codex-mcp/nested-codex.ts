import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { isCodexOutputSchemaCompatible, parseCodexStdout } from '../../connectors/codex.js';
import {
  type ConnectorSubprocessResult,
  type RunConnectorSubprocessInput,
  runConnectorSubprocess,
} from '../../connectors/subprocess.js';
import type { ResolvedSelection } from '../../schemas/selection-policy.js';
import type { RelayFn, RelayInput } from '../../shared/relay-runtime-types.js';

export const MCP_CODEX_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;
export const MCP_CODEX_STDERR_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 3_600_000;
const SIGTERM_TO_SIGKILL_GRACE_MS = 2_000;

const SUPPORTED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const TRANSIENT_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'CODEX_HOME',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'USER',
]);

export interface McpNestedCodexPolicy {
  readonly executable: string;
  readonly cliVersion: string;
  readonly workspace: string;
  readonly tempRoot: string;
  readonly searchMode: 'off' | 'cached';
  readonly defaultModel: string;
  readonly allowedModels: ReadonlySet<string>;
}

export interface McpCodexProcessRunner {
  readonly run: (input: RunConnectorSubprocessInput) => Promise<ConnectorSubprocessResult>;
}

export interface CreateMcpCodexRelayerDependencies extends McpCodexProcessRunner {
  readonly environment: NodeJS.ProcessEnv;
}

export function safeMcpCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && TRANSIENT_ENVIRONMENT_KEYS.has(key)) safe[key] = value;
  }
  return safe;
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
    !isAbsolute(policy.tempRoot)
  ) {
    throw new Error('The sealed Codex worker paths must be absolute.');
  }
  if (policy.cliVersion.trim().length === 0 || policy.defaultModel.trim().length === 0) {
    throw new Error('The sealed Codex worker version and default model are required.');
  }
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
    '-s',
    'workspace-write',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--cd',
    policy.workspace,
    '-c',
    'approval_policy="never"',
    '-c',
    'history.persistence="none"',
    '-c',
    'features.plugins=false',
    '-c',
    'features.hooks=false',
    '-c',
    'features.codex_hooks=false',
    '-c',
    'features.plugin_hooks=false',
    '-c',
    'mcp_servers={}',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=false',
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
    run: runConnectorSubprocess,
    environment: process.env,
  },
): RelayFn {
  assertPolicy(policy);
  const environment = {
    ...safeMcpCodexEnvironment(dependencies.environment),
    // Codex workspace-write normally grants both /tmp and the inherited
    // TMPDIR. The fixed config above removes /tmp; rebinding TMPDIR keeps the
    // remaining temporary write root inside this private run directory.
    TMPDIR: policy.tempRoot,
  };
  return {
    connectorName: 'codex',
    connector: { kind: 'builtin', name: 'codex' },
    relay: async (input) => {
      const model = selectedModel(input.resolvedSelection, policy);
      const schema = await writeResponseSchema(policy, input.responseSchema);
      try {
        const result = await dependencies.run({
          executable: policy.executable,
          args: buildMcpCodexArgs(input, policy, schema.path),
          timeoutMs: input.timeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS,
          idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          stdoutMaxBytes: MCP_CODEX_STDOUT_LIMIT_BYTES,
          stderrMaxBytes: MCP_CODEX_STDERR_LIMIT_BYTES,
          sigtermToSigkillGraceMs: SIGTERM_TO_SIGKILL_GRACE_MS,
          detached: false,
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

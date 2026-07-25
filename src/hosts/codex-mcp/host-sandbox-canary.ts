import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { ConnectorSubprocessResult } from '../../connectors/subprocess.js';
import type { CodexSharedTempIsolation } from './capabilities.js';
import {
  type RunMcpCodexSubprocessInput,
  runMcpCodexSubprocess,
} from './nested-codex-subprocess.js';
import {
  MCP_CODEX_HARDENING_CONFIG_ARGS,
  MCP_CODEX_STDERR_LIMIT_BYTES,
  type McpNestedCodexPolicy,
  buildMcpCodexArgs,
  buildMcpCodexSandboxConfigArgs,
  mcpCodexPrivateDirectories,
  tomlString,
} from './nested-codex.js';

// How long one nested-Codex probe may take before Circuit calls it unproven.
//
// Measured on the hosted CI matrix: arm64 macOS finishes all three probes in the
// live canary test in ~11s, while x64 cannot finish the first inside 20s and
// fails there on every Codex version, so the cause is the host and not a Codex
// change. The same x64 runner label has also cleared all three probes in 12s in
// another workflow, which says this is variance under load rather than a floor
// the host cannot beat. Starting a sandboxed Codex is process-heavy, so size the
// budget for the slowest host Circuit supports rather than the fastest.
//
// It is a fail-closed budget, not a latency target: it costs nothing on a
// healthy host and only delays the report when a probe is genuinely stuck. The
// error names the timeout and its length, so a host that needs more says so.
const CANARY_TIMEOUT_MS = 45_000;
const CANARY_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const EXPECTED_TOOL_NAMES = Object.freeze([
  'apply_patch',
  'exec_command',
  'request_user_input',
  'update_plan',
  'view_image',
  'write_stdin',
]);

const SHARED_TEMP_ROOT_CANDIDATES = Object.freeze([
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
]);

const SENSITIVE_SHELL_ENVIRONMENT_NAMES = Object.freeze([
  'CODEX_HOME',
  'CIRCUIT_CANARY_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

const REQUIRED_MARKERS = Object.freeze([
  'AUTH_READ_DENIED',
  'ENV_CLEAN',
  'GIT_EXEC',
  'NETWORK_DENIED',
  'NODE_EXEC',
  'PRIVATE_WRITE',
  'SIBLING_READ_DENIED',
  'SYMLINK_READ_DENIED',
  'WORKSPACE_WRITE',
]);

const SHARED_TEMP_MARKERS = Object.freeze(['SHARED_TEMP_READ_DENIED', 'SHARED_TEMP_WRITE_DENIED']);

const MARKERS = Object.freeze([...REQUIRED_MARKERS, ...SHARED_TEMP_MARKERS]);

export interface CodexNestedHostProbeInput {
  readonly policy: McpNestedCodexPolicy;
  readonly codexHome: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CodexNestedHostProbeDependencies {
  readonly run?: (input: RunMcpCodexSubprocessInput) => Promise<ConnectorSubprocessResult>;
  readonly sharedTempRootCandidates?: readonly string[];
}

export interface CodexNestedSandboxCanaryResult {
  readonly shared_temp_isolation: CodexSharedTempIsolation;
}

function operatorCodexHomeCandidates(input: CodexNestedHostProbeInput): readonly string[] {
  const candidates: string[] = [];
  if (input.environment.CODEX_HOME !== undefined) {
    candidates.push(resolve(input.environment.CODEX_HOME));
  }
  if (input.environment.HOME !== undefined) {
    candidates.push(resolve(input.environment.HOME, '.codex'));
  }
  return candidates;
}

function assertIsolatedProbeCodexHome(input: CodexNestedHostProbeInput): void {
  const expected = resolve(dirname(input.policy.tempRoot), 'codex-home');
  const actual = resolve(input.codexHome);
  if (
    !isAbsolute(input.policy.tempRoot) ||
    !isAbsolute(input.codexHome) ||
    input.codexHome.includes('\0') ||
    actual !== expected ||
    actual === resolve(input.policy.tempRoot) ||
    operatorCodexHomeCandidates(input).includes(actual)
  ) {
    throw new Error(
      "Circuit refused a capability probe that could write to the operator's Codex home.",
    );
  }
}

async function assertProbeCodexHomeIsNotAnAlias(input: CodexNestedHostProbeInput): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(input.codexHome);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Circuit refused a linked or invalid capability-probe Codex home.');
  }
  const canonicalProbeHome = await realpath(input.codexHome);
  for (const candidate of operatorCodexHomeCandidates(input)) {
    try {
      if ((await realpath(candidate)) === canonicalProbeHome) {
        throw new Error(
          "Circuit refused a capability probe that aliases the operator's Codex home.",
        );
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function distinctExistingSharedTempRoots(candidates: readonly string[]): Promise<string[]> {
  if (candidates.length === 0 || candidates.length > SHARED_TEMP_ROOT_CANDIDATES.length) {
    throw new Error('Circuit received an invalid shared-temp sandbox probe set.');
  }
  const roots = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || candidate.includes('\0')) {
      throw new Error('Circuit received an invalid shared-temp sandbox probe path.');
    }
    try {
      const canonical = await realpath(candidate);
      if ((await lstat(canonical)).isDirectory()) roots.add(canonical);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  if (roots.size === 0) {
    throw new Error('Circuit could not find a shared temporary directory to probe.');
  }
  return [...roots].sort();
}

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Circuit refused an invalid sandbox canary path.');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function checkedResult(result: ConnectorSubprocessResult, name: string): void {
  if (result.timedOut || result.stdoutCapped || result.stderrCapped || result.code !== 0) {
    // Four different things reach this line, and which one it was decides what to
    // do about it: a timeout means the host needs longer, a capped stream means
    // the probe said too much, a nonzero exit means Codex refused. Name it, and
    // fall back to stdout when stderr is empty — a timed-out Codex often says
    // nothing on stderr at all, which is how this failure once reached CI twice
    // carrying no diagnosis.
    const cause = result.timedOut
      ? `timed out after ${CANARY_TIMEOUT_MS}ms`
      : result.stdoutCapped
        ? `produced more than ${CANARY_OUTPUT_LIMIT_BYTES} bytes on stdout`
        : result.stderrCapped
          ? `produced more than ${MCP_CODEX_STDERR_LIMIT_BYTES} bytes on stderr`
          : `exited ${result.code}`;
    const output = result.stderr.trim() || result.stdout.trim();
    const detail = output.slice(0, 500);
    throw new Error(
      `Circuit could not prove the Codex ${name}: it ${cause}${detail.length === 0 ? ' and wrote nothing.' : `. Output: ${detail}`}`,
    );
  }
}

async function listen(server: ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Circuit could not bind its local sandbox canary listener.');
  }
  return address.port;
}

async function closeServer(
  server: ReturnType<typeof createTcpServer> | ReturnType<typeof createHttpServer>,
): Promise<void> {
  if (!server.listening) return;
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function probeEnvironment(input: CodexNestedHostProbeInput): NodeJS.ProcessEnv {
  return {
    HOME: input.codexHome,
    CODEX_HOME: input.codexHome,
    TMPDIR: input.policy.tempRoot,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    TERM: 'dumb',
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function sandboxProbeScript(input: {
  readonly workspaceWrite: string;
  readonly privateWrite: string;
  readonly siblingSecret: string;
  readonly authSecret: string;
  readonly symlinkSecret: string;
  readonly sharedSecrets: readonly string[];
  readonly sharedWrites: readonly string[];
  readonly portFile: string;
  readonly nodeExecutable: string;
  readonly gitExecutable: string;
  readonly shellHome: string;
  readonly shellTemp: string;
}): string {
  const mark = (name: string, expression: string) =>
    `if ${expression}; then printf 'CIRCUIT_CANARY_${name}=pass\\n'; else printf 'CIRCUIT_CANARY_${name}=fail\\n'; fi`;
  const sharedReadsDenied = input.sharedSecrets
    .map((path) => `! ( IFS= read -r _ < ${shellQuote(path)} ) 2>/dev/null`)
    .join(' && ');
  const sharedWritesDenied = input.sharedWrites
    .map((path) => `! ( : > ${shellQuote(path)} ) 2>/dev/null`)
    .join(' && ');
  const sensitiveEnvironmentAbsent = SENSITIVE_SHELL_ENVIRONMENT_NAMES.map(
    (name) => `[ -z "\${${name}+x}" ]`,
  ).join(' && ');
  return `#!/bin/sh
${mark('WORKSPACE_WRITE', `: > ${shellQuote(input.workspaceWrite)}`)}
${mark('PRIVATE_WRITE', `: > ${shellQuote(input.privateWrite)}`)}
${mark('NODE_EXEC', `${shellQuote(input.nodeExecutable)} -e 'process.exit(0)'`)}
${mark('GIT_EXEC', `${shellQuote(input.gitExecutable)} --version >/dev/null 2>&1`)}
${mark('SIBLING_READ_DENIED', `! ( IFS= read -r _ < ${shellQuote(input.siblingSecret)} ) 2>/dev/null`)}
${mark('AUTH_READ_DENIED', `! ( IFS= read -r _ < ${shellQuote(input.authSecret)} ) 2>/dev/null`)}
${mark('SYMLINK_READ_DENIED', `! ( IFS= read -r _ < ${shellQuote(input.symlinkSecret)} ) 2>/dev/null`)}
${mark('SHARED_TEMP_READ_DENIED', sharedReadsDenied)}
${mark('SHARED_TEMP_WRITE_DENIED', sharedWritesDenied)}
${mark('ENV_CLEAN', `${sensitiveEnvironmentAbsent} && [ "$HOME" = ${shellQuote(input.shellHome)} ] && [ "$TMPDIR" = ${shellQuote(input.shellTemp)} ] && [ "$TMP" = ${shellQuote(input.shellTemp)} ] && [ "$TEMP" = ${shellQuote(input.shellTemp)} ]`)}
IFS= read -r CIRCUIT_CANARY_PORT < ${shellQuote(input.portFile)}
${mark('NETWORK_DENIED', `${shellQuote(input.nodeExecutable)} -e 'const net=require("node:net");const port=Number(process.argv[1]);const socket=net.connect(port,"127.0.0.1");let done=false;const finish=(code)=>{if(done)return;done=true;socket.destroy();process.exit(code)};socket.once("connect",()=>finish(1));socket.once("error",()=>finish(0));setTimeout(()=>finish(2),1000)' "$CIRCUIT_CANARY_PORT"`)}
`;
}

function markerResults(output: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^CIRCUIT_CANARY_([A-Z_]+)=(pass|fail)$/.exec(trimmed);
    if (match !== null) {
      const name = match[1] ?? '';
      if (found.has(name)) throw new Error(`The Codex sandbox repeated canary marker ${name}.`);
      found.set(name, match[2] ?? '');
    } else if (trimmed.startsWith('CIRCUIT_CANARY_')) {
      throw new Error('The Codex sandbox returned a malformed canary marker.');
    }
  }
  return found;
}

function failedRequiredMarkerSummary(
  markers: ReadonlyMap<string, string>,
  networkHit: boolean,
): string {
  const missing = MARKERS.filter((name) => !markers.has(name));
  const failed = REQUIRED_MARKERS.filter((name) => markers.get(name) === 'fail');
  const details = [
    ...(missing.length === 0 ? [] : [`missing ${missing.join(', ')}`]),
    ...(failed.length === 0 ? [] : [`failed ${failed.join(', ')}`]),
    ...(networkHit ? ['network listener was reached'] : []),
  ];
  return details.length === 0 ? 'unknown canary mismatch' : details.join('; ');
}

/**
 * Runs a fixed shell probe through Codex's real named permissions profile.
 * Shared host temporary directories are measured but do not strengthen the
 * practical boundary beyond what Codex provides for its own workspace tasks.
 */
export async function runCodexNestedSandboxCanary(
  input: CodexNestedHostProbeInput,
  dependencies: CodexNestedHostProbeDependencies = {},
): Promise<CodexNestedSandboxCanaryResult> {
  assertIsolatedProbeCodexHome(input);
  await assertProbeCodexHomeIsNotAnAlias(input);
  const run = dependencies.run ?? runMcpCodexSubprocess;
  const privateDirectories = mcpCodexPrivateDirectories(input.policy.tempRoot);
  const unique = randomUUID();
  const fixtureRoot = dirname(input.policy.tempRoot);
  const outside = join(fixtureRoot, 'outside');
  const workspaceWrite = join(input.policy.workspace, `.circuit-mcp-sandbox-canary-${unique}`);
  const privateWrite = join(input.policy.tempRoot, `private-write-${unique}`);
  const siblingSecret = join(outside, `sibling-secret-${unique}`);
  const authSecret = join(input.codexHome, 'auth.json');
  const symlinkSecret = join(input.policy.tempRoot, `linked-secret-${unique}`);
  const sharedTempRoots = await distinctExistingSharedTempRoots(
    dependencies.sharedTempRootCandidates ?? SHARED_TEMP_ROOT_CANDIDATES,
  );
  const sharedSecrets = sharedTempRoots.map((root) =>
    join(root, `.circuit-mcp-shared-read-${unique}`),
  );
  const sharedWrites = sharedTempRoots.map((root) =>
    join(root, `.circuit-mcp-shared-write-${unique}`),
  );
  const portFile = join(input.policy.tempRoot, `listener-port-${unique}`);
  const script = join(input.policy.tempRoot, `sandbox-canary-${unique}.sh`);
  let networkHit = false;
  const createdFixtures = new Set<string>();
  const writeFixture = async (path: string, data: string, mode: number): Promise<void> => {
    await writeFile(path, data, { mode, flag: 'wx' });
    createdFixtures.add(path);
  };
  const listener = createTcpServer((socket) => {
    networkHit = true;
    socket.destroy();
  });
  try {
    await Promise.all([
      mkdir(input.policy.tempRoot, { recursive: true, mode: 0o700 }),
      mkdir(input.codexHome, { recursive: true, mode: 0o700 }),
      mkdir(outside, { recursive: true, mode: 0o700 }),
      mkdir(privateDirectories.home, { recursive: true, mode: 0o700 }),
      mkdir(privateDirectories.temp, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFixture(siblingSecret, 'sibling-secret\n', 0o600),
      ...sharedSecrets.map(async (path) => await writeFixture(path, 'shared-secret\n', 0o600)),
    ]);
    await assertProbeCodexHomeIsNotAnAlias(input);
    await writeFixture(authSecret, '{"token":"canary-not-a-secret"}\n', 0o600);
    await symlink(siblingSecret, symlinkSecret);
    createdFixtures.add(symlinkSecret);
    const port = await listen(listener);
    await writeFixture(portFile, `${port}\n`, 0o600);
    await writeFixture(
      script,
      sandboxProbeScript({
        workspaceWrite,
        privateWrite,
        siblingSecret,
        authSecret,
        symlinkSecret,
        sharedSecrets,
        sharedWrites,
        portFile,
        nodeExecutable: input.policy.nodeExecutable,
        gitExecutable: input.policy.gitExecutable,
        shellHome: privateDirectories.home,
        shellTemp: privateDirectories.temp,
      }),
      0o700,
    );
    const result = await run({
      executable: input.policy.executable,
      args: [
        'sandbox',
        '-P',
        'circuit_mcp',
        '-C',
        input.policy.workspace,
        ...MCP_CODEX_HARDENING_CONFIG_ARGS,
        ...buildMcpCodexSandboxConfigArgs(input.policy),
        '/bin/sh',
        script,
      ],
      timeoutMs: CANARY_TIMEOUT_MS,
      idleTimeoutMs: CANARY_TIMEOUT_MS,
      stdoutMaxBytes: CANARY_OUTPUT_LIMIT_BYTES,
      stderrMaxBytes: MCP_CODEX_STDERR_LIMIT_BYTES,
      sigtermToSigkillGraceMs: 500,
      env: {
        ...probeEnvironment(input),
        CIRCUIT_CANARY_SECRET: 'canary-not-a-secret',
        OPENAI_API_KEY: 'canary-not-a-secret',
        OPENAI_BASE_URL: 'https://canary.invalid/v1',
        OPENAI_ORGANIZATION: 'canary-organization',
        OPENAI_PROJECT: 'canary-project',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
        http_proxy: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
        all_proxy: 'http://127.0.0.1:9',
        no_proxy: '127.0.0.1,localhost',
        SSL_CERT_FILE: '/outside/canary-cert',
        SSL_CERT_DIR: '/outside/canary-certs',
        NODE_EXTRA_CA_CERTS: '/outside/canary-node-cert',
      },
      cwd: input.policy.workspace,
    });
    checkedResult(result, 'nested sandbox canary');
    const markers = markerResults(result.stdout);
    if (
      networkHit ||
      markers.size !== MARKERS.length ||
      MARKERS.some((name) => !markers.has(name)) ||
      REQUIRED_MARKERS.some((name) => markers.get(name) !== 'pass')
    ) {
      throw new Error(
        `The installed Codex sandbox did not confine files, environment, and direct network access (${failedRequiredMarkerSummary(markers, networkHit)}).`,
      );
    }
    return Object.freeze({
      shared_temp_isolation: SHARED_TEMP_MARKERS.every((name) => markers.get(name) === 'pass')
        ? 'isolated'
        : 'exposed',
    });
  } finally {
    await closeServer(listener);
    await Promise.all(
      [workspaceWrite, privateWrite, ...sharedWrites, ...createdFixtures].map(
        async (path) => await rm(path, { force: true }),
      ),
    );
  }
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function isReviewedCachedSearchTool(tool: Record<string, unknown>): boolean {
  if (tool.type !== 'web_search' || tool.external_web_access !== false) return false;
  const keys = Object.keys(tool).sort();
  if (JSON.stringify(keys) === JSON.stringify(['external_web_access', 'type'])) return true;
  return (
    JSON.stringify(keys) ===
      JSON.stringify(['external_web_access', 'search_content_types', 'type']) &&
    JSON.stringify(tool.search_content_types) === JSON.stringify(['text', 'image'])
  );
}

/** Parses the exact final exec config and captures the tools sent to a local provider. */
export async function runCodexToolSurfaceCanary(
  input: CodexNestedHostProbeInput,
  dependencies: CodexNestedHostProbeDependencies = {},
): Promise<void> {
  assertIsolatedProbeCodexHome(input);
  await assertProbeCodexHomeIsNotAnAlias(input);
  const run = dependencies.run ?? runMcpCodexSubprocess;
  const unique = randomUUID();
  const canaryWorkspace = join(input.policy.workspace, `.circuit-mcp-host-input-${unique}`);
  const projectDocSecret = `CIRCUIT_OUTSIDE_PROJECT_DOC_${unique}`;
  const projectDocSecretPath = join(
    dirname(input.policy.tempRoot),
    `outside-project-doc-${unique}`,
  );
  const shellSnapshotSentinel = join(canaryWorkspace, `.circuit-mcp-shell-snapshot-${unique}`);
  const shellSnapshotDirectory = join(input.codexHome, 'shell_snapshots');
  const shellStartupFiles = [join(input.codexHome, '.zshrc'), join(input.codexHome, '.bashrc')];
  const createdStartupFiles = new Set<string>();
  let canaryWorkspaceCreated = false;
  let projectDocSecretCreated = false;
  let projectDocLeaked = false;
  let capturedTools: readonly Record<string, unknown>[] | undefined;
  let responsesRequests = 0;
  const unexpectedRequests: string[] = [];
  const server = createHttpServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > CANARY_OUTPUT_LIMIT_BYTES) request.destroy();
    });
    request.on('end', () => {
      if (body.includes(projectDocSecret)) projectDocLeaked = true;
      const url = request.url ?? '';
      if (url.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      if (!url.startsWith('/v1/responses')) {
        unexpectedRequests.push(url);
        response.writeHead(404).end();
        return;
      }
      responsesRequests += 1;
      let value: unknown;
      try {
        value = JSON.parse(body || '{}');
      } catch {
        response.writeHead(400).end();
        return;
      }
      const tools: unknown[] =
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { tools?: unknown }).tools)
          ? (value as { tools: unknown[] }).tools
          : [];
      capturedTools = tools.every(
        (tool): tool is Record<string, unknown> =>
          typeof tool === 'object' && tool !== null && !Array.isArray(tool),
      )
        ? tools
        : undefined;
      const events = [
        { type: 'response.created', response: { id: 'resp_circuit_probe' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: 'msg_circuit_probe',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_circuit_probe',
            usage: {
              input_tokens: 0,
              input_tokens_details: null,
              output_tokens: 0,
              output_tokens_details: null,
              total_tokens: 0,
            },
          },
        },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(events));
    });
  });
  try {
    await mkdir(canaryWorkspace, { mode: 0o700 });
    canaryWorkspaceCreated = true;
    await mkdir(join(canaryWorkspace, '.git'), { mode: 0o700 });
    await writeFile(projectDocSecretPath, `${projectDocSecret}\n`, { mode: 0o600, flag: 'wx' });
    projectDocSecretCreated = true;
    await symlink(projectDocSecretPath, join(canaryWorkspace, 'AGENTS.md'));
    await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
    await assertProbeCodexHomeIsNotAnAlias(input);
    const startupBody = `printf 'shell snapshot ran\\n' > ${shellQuote(shellSnapshotSentinel)}\n`;
    for (const path of shellStartupFiles) {
      await writeFile(path, startupBody, { mode: 0o600, flag: 'wx' });
      createdStartupFiles.add(path);
    }
    const port = await listen(server);
    const baseArgs = buildMcpCodexArgs(
      { prompt: 'Reply with ok. Do not call tools.' },
      {
        ...input.policy,
        workspace: canaryWorkspace,
        defaultModel: 'gpt-5.4',
        allowedModels: new Set(['gpt-5.4']),
      },
    );
    const prompt = baseArgs.pop();
    if (prompt === undefined) throw new Error('Circuit could not construct the Codex tool canary.');
    const provider = `model_providers.circuit_probe={name="Circuit Probe",base_url=${tomlString(
      `http://127.0.0.1:${port}/v1`,
    )},env_key="CIRCUIT_PROBE_API_KEY",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`;
    const result = await run({
      executable: input.policy.executable,
      args: [
        ...baseArgs,
        '-c',
        'model_provider="circuit_probe"',
        '-c',
        provider,
        '-c',
        'analytics.enabled=false',
        '-c',
        'check_for_update_on_startup=false',
        prompt,
      ],
      timeoutMs: CANARY_TIMEOUT_MS,
      idleTimeoutMs: CANARY_TIMEOUT_MS,
      stdoutMaxBytes: CANARY_OUTPUT_LIMIT_BYTES,
      stderrMaxBytes: MCP_CODEX_STDERR_LIMIT_BYTES,
      sigtermToSigkillGraceMs: 500,
      env: {
        ...probeEnvironment(input),
        CIRCUIT_PROBE_API_KEY: 'canary-not-a-secret',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      cwd: canaryWorkspace,
    });
    checkedResult(result, 'strict startup and tool-surface canary');
    if (projectDocLeaked) {
      throw new Error('Codex read project instructions outside the trusted workspace.');
    }
    if ((await pathExists(shellSnapshotSentinel)) || (await pathExists(shellSnapshotDirectory))) {
      throw new Error('Codex activated its shell-snapshot feature during the hardened probe.');
    }
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    if (
      /chatgpt\.com\/backend-api\/ps\/mcp|codex_apps|apps mcp|mcp startup failed/i.test(diagnostics)
    ) {
      throw new Error('Codex attempted to initialize an Apps or remote MCP surface.');
    }
    const expectedToolNames =
      input.policy.searchMode === 'cached'
        ? [...EXPECTED_TOOL_NAMES, 'web_search'].sort()
        : EXPECTED_TOOL_NAMES;
    const actualToolNames = capturedTools
      ?.map((tool) =>
        typeof tool.name === 'string' ? tool.name : typeof tool.type === 'string' ? tool.type : '?',
      )
      .sort();
    const webSearchTools = capturedTools?.filter((tool) => tool.type === 'web_search') ?? [];
    const cachedSearchIsConstrained =
      input.policy.searchMode === 'cached'
        ? webSearchTools.length === 1 && isReviewedCachedSearchTool(webSearchTools[0] ?? {})
        : webSearchTools.length === 0;
    if (
      responsesRequests !== 1 ||
      unexpectedRequests.length !== 0 ||
      !cachedSearchIsConstrained ||
      JSON.stringify(actualToolNames) !== JSON.stringify(expectedToolNames)
    ) {
      throw new Error("The Codex tool surface changed from Circuit's reviewed allowlist.");
    }
  } finally {
    await closeServer(server);
    await Promise.all([
      ...[...createdStartupFiles].map(async (path) => await rm(path, { force: true })),
      rm(shellSnapshotSentinel, { force: true }),
      rm(shellSnapshotDirectory, { recursive: true, force: true }),
      ...(projectDocSecretCreated ? [rm(projectDocSecretPath, { force: true })] : []),
      ...(canaryWorkspaceCreated ? [rm(canaryWorkspace, { recursive: true, force: true })] : []),
    ]);
  }
}

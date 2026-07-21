#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  CODEX_SANDBOX_METADATA_KEY,
  trustedWorkspaceFromCodexMetadata,
} from './codex-metadata.mjs';
import {
  assertTrustedCodexExecutableUnchanged,
  discoverTrustedCodexHost,
} from './host-discovery.mjs';
import { CircuitLifecycle } from './lifecycle.mjs';
import { interruptObservedProcessTree, observeDescendants } from './proof-sandbox.mjs';
import {
  SEALED_PUBLIC_FLOWS,
  SEALED_RUNTIME_CAPABILITIES,
  WEB_SEARCH_CHOICES,
  assertMcpAssetsUnchanged,
  assertMcpResourcesOutsideWorkspace,
  assertPackagedAssetsUnchanged,
  prepareSealedStateRoot,
  snapshotMcpAssets,
  snapshotPackagedAssets,
} from './sealed-policy.mjs';

const SERVER_NAME = 'Circuit sandbox spike';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-06-18';
const PROBE_TOOL_NAME = 'circuit_sandbox_probe';
const START_TOOL_NAME = 'circuit_start';
const STATUS_TOOL_NAME = 'circuit_status';
const RESUME_TOOL_NAME = 'circuit_resume';
const CANCEL_TOOL_NAME = 'circuit_cancel';
const SANDBOX_META_KEY = CODEX_SANDBOX_METADATA_KEY;
const CURL_PROBE_COMMAND = '/usr/bin/curl -I --max-time 5 https://example.com';
const RECORDED_CURL_COMMAND = `/bin/zsh -lc '${CURL_PROBE_COMMAND}'`;
const WEB_SEARCH_QUERY = 'site:learn.chatgpt.com Codex web search official documentation';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 180_000;
const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INSTALLED_RUNTIME = path.join(PLUGIN_ROOT, 'runtime/circuit.js');
const INSTALLED_FLOW_ROOT = path.join(PLUGIN_ROOT, 'flows');
const DEV_PLUGIN_ROOT = path.join(REPOSITORY_ROOT, 'plugins/codex');
const PROOF_RUNNER = fileURLToPath(new URL('./proof-sandbox-worker.mjs', import.meta.url));
const MCP_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function resolvePackagedLayout(options = {}) {
  const explicitPluginRoot = options.pluginRoot ?? options.env?.CIRCUIT_MCP_PLUGIN_ROOT;
  if (explicitPluginRoot !== undefined) {
    if (typeof explicitPluginRoot !== 'string' || !path.isAbsolute(explicitPluginRoot)) {
      throw new Error('CIRCUIT_MCP_PLUGIN_ROOT must be an absolute path.');
    }
    const pluginRoot = path.resolve(explicitPluginRoot);
    return {
      pluginRoot,
      runtimePath: path.join(pluginRoot, 'runtime/circuit.js'),
      flowRoot: path.join(pluginRoot, 'flows'),
    };
  }
  if (existsSync(INSTALLED_RUNTIME) && existsSync(INSTALLED_FLOW_ROOT)) {
    return {
      pluginRoot: PLUGIN_ROOT,
      runtimePath: INSTALLED_RUNTIME,
      flowRoot: INSTALLED_FLOW_ROOT,
    };
  }
  return {
    pluginRoot: DEV_PLUGIN_ROOT,
    runtimePath: path.join(DEV_PLUGIN_ROOT, 'runtime/circuit.js'),
    flowRoot: path.join(DEV_PLUGIN_ROOT, 'flows'),
  };
}

const PACKAGED_LAYOUT = resolvePackagedLayout({ env: process.env });

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const PROBE_TOOL = {
  name: PROBE_TOOL_NAME,
  title: "Probe Circuit's Codex sandbox boundary",
  description:
    'Development-only probe. Checks Codex workspace metadata, the pinned host and packaged Circuit files, then runs a fixed sandbox test. It accepts no arguments.',
  inputSchema: EMPTY_INPUT_SCHEMA,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const START_TOOL = {
  name: START_TOOL_NAME,
  title: 'Start a Circuit run',
  description:
    'Starts one packaged Circuit flow in the trusted Codex workspace and returns immediately. Web search is off unless cached search is explicitly requested.',
  inputSchema: {
    type: 'object',
    properties: {
      flow: { type: 'string', enum: SEALED_PUBLIC_FLOWS },
      goal: { type: 'string', minLength: 1, maxLength: 8_000 },
      why: { type: 'string', minLength: 1, maxLength: 2_000 },
      power: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
      process: { type: 'string', enum: ['low', 'medium', 'high'] },
      tournament: {
        type: 'integer',
        minimum: 2,
        maximum: 4,
        description:
          'Explore tournament branch count. Prototype tournament is intentionally unavailable in this sealed spike.',
      },
      autonomous: { type: 'boolean' },
      include_untracked_content: { type: 'boolean' },
      web_search: {
        type: 'string',
        enum: WEB_SEARCH_CHOICES,
        default: 'off',
        description: 'Cached search may send the search query off this machine.',
      },
    },
    required: ['flow', 'goal'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const STATUS_TOOL = {
  name: STATUS_TOOL_NAME,
  title: 'Check a Circuit run',
  description:
    'Returns bounded progress, checkpoint prompts, labeled choices, hash-bound decision reports, and the final result for one MCP-started run.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 64 },
      after_cursor: { type: 'integer', minimum: 0 },
      max_events: { type: 'integer', minimum: 1, maximum: 100 },
      wait_ms: { type: 'integer', minimum: 0, maximum: 10_000 },
    },
    required: ['run_id'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const RESUME_TOOL = {
  name: RESUME_TOOL_NAME,
  title: 'Resume a Circuit checkpoint',
  description:
    'Resumes an MCP-started run using one exact choice advertised by its waiting checkpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 64 },
      checkpoint_choice: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['run_id', 'checkpoint_choice'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const CANCEL_TOOL = {
  name: CANCEL_TOOL_NAME,
  title: 'Cancel a Circuit run',
  description:
    'Cancels a running Circuit process or abandons a run waiting at a checkpoint, and reports whether cleanup was confirmed.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 64 },
    },
    required: ['run_id'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const TOOLS = [PROBE_TOOL, START_TOOL, STATUS_TOOL, RESUME_TOOL, CANCEL_TOOL];

const CHILD_ENV_ALLOWLIST = new Set([
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertEmptyArguments(value) {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new Error(`${PROBE_TOOL_NAME} does not accept arguments.`);
  }
}

function safeChildEnvironment(extra = {}) {
  const entries = Object.entries(process.env).filter(
    ([key, value]) => CHILD_ENV_ALLOWLIST.has(key) && value !== undefined,
  );
  return { ...Object.fromEntries(entries), ...extra };
}

function appendCapped(chunks, chunk, currentBytes, maxOutputBytes) {
  if (currentBytes >= maxOutputBytes) {
    return { bytes: currentBytes, capped: true };
  }
  const remaining = maxOutputBytes - currentBytes;
  const kept = chunk.subarray(0, remaining);
  chunks.push(kept);
  return {
    bytes: currentBytes + kept.length,
    capped: chunk.length > remaining,
  };
}

function pidIsPossiblyAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function observedCleanup(observation) {
  const remainingPids = observation.pids.filter(pidIsPossiblyAlive);
  return {
    scope: 'observed_process_tree',
    descendantPids: observation.pids,
    enumerationSucceeded: observation.enumerationSucceeded,
    ...(observation.enumerationError === undefined
      ? {}
      : { enumerationError: observation.enumerationError }),
    remainingPids,
    confirmed: observation.enumerationSucceeded && remainingPids.length === 0,
    required: false,
  };
}

function processResult(input) {
  return {
    code: input.code,
    signal: input.signal,
    stdout: Buffer.concat(input.stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(input.stderrChunks).toString('utf8'),
    timedOut: input.timedOut,
    stdoutCapped: input.stdoutCapped,
    stderrCapped: input.stderrCapped,
    backgroundDescendants: input.backgroundDescendants,
    cleanup: input.cleanup,
  };
}

export async function runProcess(executable, args, options) {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const child = spawn(executable, args, {
    argv0: options.argv0,
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rootPid = child.pid;
  const observer =
    typeof rootPid === 'number'
      ? observeDescendants(rootPid, {
          enumerate: options.enumerate,
          enumerateGroup: options.enumerateGroup,
        })
      : undefined;
  let observation;
  const stopObserver = async () => {
    if (observation === undefined) {
      observation =
        observer === undefined
          ? {
              pids: [],
              enumerationSucceeded: false,
              enumerationError: 'The subprocess had no pid.',
            }
          : await observer.stop();
    }
    return observation;
  };

  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutCapped = false;
  let stderrCapped = false;
  let stopReason;
  let resolveStop;
  const stopPromise = new Promise((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const requestStop = (reason) => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    resolveStop(reason);
  };

  child.stdout.on('data', (chunk) => {
    const next = appendCapped(stdoutChunks, chunk, stdoutBytes, maxOutputBytes);
    stdoutBytes = next.bytes;
    stdoutCapped ||= next.capped;
    if (next.capped) requestStop('output_limit');
  });
  child.stderr.on('data', (chunk) => {
    const next = appendCapped(stderrChunks, chunk, stderrBytes, maxOutputBytes);
    stderrBytes = next.bytes;
    stderrCapped ||= next.capped;
    if (next.capped) requestStop('output_limit');
  });

  const completionPromise = new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ kind: 'error', error }));
    child.once('close', (code, signal) => resolvePromise({ kind: 'close', code, signal }));
  });
  const timer = setTimeout(() => requestStop('timeout'), options.timeoutMs);

  try {
    const winner = await Promise.race([
      completionPromise.then((completion) => ({ type: 'completion', completion })),
      stopPromise.then((reason) => ({ type: 'stop', reason })),
    ]);

    if (winner.type === 'stop') {
      const observed = await stopObserver();
      const cleanup =
        typeof rootPid === 'number'
          ? {
              ...(await interruptObservedProcessTree(rootPid, {
                graceMs: options.interruptGraceMs,
                enumerate: options.enumerate,
                enumerateGroup: options.enumerateGroup,
                knownPids: observed.pids,
              })),
              required: true,
            }
          : {
              scope: 'observed_process_tree',
              descendantPids: [],
              enumerationSucceeded: false,
              enumerationError: 'The subprocess had no pid.',
              remainingPids: [],
              confirmed: false,
              required: true,
            };
      const completion = await Promise.race([
        completionPromise,
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(undefined), 1_000)),
      ]);
      if (completion === undefined || !cleanup.confirmed) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      return processResult({
        code: completion?.kind === 'close' ? completion.code : null,
        signal: completion?.kind === 'close' ? completion.signal : null,
        stdoutChunks,
        stderrChunks,
        timedOut: winner.reason === 'timeout',
        stdoutCapped,
        stderrCapped,
        backgroundDescendants: false,
        cleanup,
      });
    }

    if (winner.completion.kind === 'error') {
      await stopObserver();
      throw winner.completion.error;
    }

    const observed = await stopObserver();
    const initialCleanup = observedCleanup(observed);
    const backgroundDescendants = initialCleanup.remainingPids.length > 0;
    const cleanup =
      typeof rootPid === 'number' && backgroundDescendants
        ? {
            ...(await interruptObservedProcessTree(rootPid, {
              graceMs: options.interruptGraceMs,
              enumerate: options.enumerate,
              enumerateGroup: options.enumerateGroup,
              knownPids: observed.pids,
            })),
            required: true,
          }
        : initialCleanup;
    const safetyFailure =
      stdoutCapped || stderrCapped || backgroundDescendants || !cleanup.confirmed;
    return processResult({
      code: winner.completion.code === 0 && safetyFailure ? 1 : winner.completion.code,
      signal: winner.completion.signal,
      stdoutChunks,
      stderrChunks,
      timedOut: false,
      stdoutCapped,
      stderrCapped,
      backgroundDescendants,
      cleanup,
    });
  } finally {
    clearTimeout(timer);
    await stopObserver();
  }
}

export async function workspaceFromSandboxCwd(sandboxCwd) {
  const trusted = await trustedWorkspaceFromCodexMetadata({
    _meta: { [SANDBOX_META_KEY]: { sandboxCwd } },
  });
  return trusted.workspace;
}

export async function workspaceFromToolCall(params) {
  const trusted = await trustedWorkspaceFromCodexMetadata(params);
  return trusted.workspace;
}

export function buildWorkerArgs(workspace) {
  const prompt = [
    'This is a sandbox-boundary probe.',
    `Use web_search exactly once with this exact query: ${JSON.stringify(WEB_SEARCH_QUERY)}.`,
    'Then run this exact shell command once: /usr/bin/curl -I --max-time 5 https://example.com',
    'The curl command is expected to fail because shell network access is blocked.',
    'Do not run any other shell command.',
    'Do not modify files.',
    'Finish with CIRCUIT_MCP_WORKER_OK on its own line.',
  ].join(' ');

  return [
    'exec',
    '--json',
    '-s',
    'workspace-write',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '-c',
    'web_search="cached"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'shell_environment_policy.inherit="core"',
    '-c',
    'shell_environment_policy.ignore_default_excludes=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.remote_plugin=false',
    '-c',
    'features.plugin_sharing=false',
    '-c',
    'features.skill_mcp_dependency_install=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
    '--cd',
    workspace,
    '-c',
    'model_reasoning_effort="low"',
    prompt,
  ];
}

export function parseWorkerEvents(stdout) {
  const events = stdout
    .split('\n')
    .filter((line) => line.trim().length !== 0)
    .map((line) => JSON.parse(line));
  const completedItems = events
    .filter((event) => event.type === 'item.completed')
    .map((event) => event.item)
    .filter(isRecord);
  const commandItems = completedItems.filter((item) => item.type === 'command_execution');
  const completedSearches = completedItems.filter(
    (item) =>
      item.type === 'web_search' &&
      isRecord(item.action) &&
      item.action.type === 'search' &&
      typeof item.action.query === 'string' &&
      item.action.query.trim().length !== 0,
  );
  const finalMessages = completedItems
    .filter((item) => item.type === 'agent_message')
    .map((item) => item.text)
    .filter((text) => typeof text === 'string');
  const commandExitCodes = commandItems
    .map((item) => item.exit_code)
    .filter((exitCode) => typeof exitCode === 'number');
  const curlItems = commandItems.filter(
    (item) => typeof item.command === 'string' && item.command.trim() === RECORDED_CURL_COMMAND,
  );
  const curlItem = curlItems[0];
  const curlOutput =
    typeof curlItem?.aggregated_output === 'string'
      ? curlItem.aggregated_output
      : typeof curlItem?.output === 'string'
        ? curlItem.output
        : '';
  const curlExitCode = typeof curlItem?.exit_code === 'number' ? curlItem.exit_code : null;
  const networkFailureSeen = /curl:\s*\(6\)\s*Could not resolve host:\s*example\.com/i.test(
    curlOutput,
  );
  const webSearchCount = completedSearches.length;
  const webSearchQuery = completedSearches.length === 1 ? completedSearches[0].action.query : null;
  const commandCount = commandItems.length;
  const turnCompleted = events.some((event) => event.type === 'turn.completed');
  const markerSeen = finalMessages.some((message) => message.includes('CIRCUIT_MCP_WORKER_OK'));
  const shellNetworkBlocked =
    commandCount === 1 && curlItems.length === 1 && curlExitCode === 6 && networkFailureSeen;

  return {
    passed:
      turnCompleted &&
      webSearchCount === 1 &&
      webSearchQuery === WEB_SEARCH_QUERY &&
      shellNetworkBlocked &&
      markerSeen,
    turnCompleted,
    webSearchCount,
    webSearchQuery,
    commandCount,
    commandExitCodes,
    curlCommandCount: curlItems.length,
    curlExitCode,
    networkFailureSeen,
    shellNetworkBlocked,
    markerSeen,
  };
}

async function probeWorker(workspace, host) {
  const result = await runProcess(host.codex.executable, buildWorkerArgs(workspace), {
    argv0: 'codex',
    cwd: workspace,
    env: safeChildEnvironment({ CODEX_HOME: host.codexHome.path }),
    timeoutMs: WORKER_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new Error('The nested Codex worker timed out.');
  }
  if (result.code !== 0) {
    throw new Error(
      `The nested Codex worker failed (${result.code ?? result.signal ?? 'unknown'}): ${result.stderr.trim()}`,
    );
  }
  if (result.stdoutCapped || result.stderrCapped) {
    throw new Error('The nested Codex worker exceeded the probe output limit.');
  }
  return parseWorkerEvents(result.stdout);
}

function toolResult(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function runProbe(params) {
  assertEmptyArguments(params?.arguments);
  const trustedWorkspace = await trustedWorkspaceFromCodexMetadata(params);
  const resources = await serverResources();
  await assertServerResourcesUnchanged(resources);
  await assertWorkspaceResourceBoundary(trustedWorkspace.workspace, resources);
  const worker = await probeWorker(trustedWorkspace.workspace, resources.host);
  return {
    status: worker.passed ? 'passed' : 'failed',
    workspace: trustedWorkspace.workspace,
    workspaceSource: SANDBOX_META_KEY,
    mcpProcessCwd: process.cwd(),
    pluginRoot: resources.assets.plugin_root,
    compatibility: {
      sandbox_metadata: trustedWorkspace.canary,
      public_flows: resources.assets.flow_ids,
      web_search: WEB_SEARCH_CHOICES,
      trusted_codex: {
        source: resources.host.codex.source,
        version: resources.host.codex.version,
      },
      packaged_assets: {
        sha256: resources.assets.sha256,
        file_count: resources.assets.file_count,
      },
      state_root: resources.stateRoot,
      required_runtime_capabilities: SEALED_RUNTIME_CAPABILITIES,
    },
    worker,
  };
}

function resolvedStateRoot(env, host) {
  const explicit = env.CIRCUIT_MCP_STATE_ROOT;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit)) {
      throw new Error('CIRCUIT_MCP_STATE_ROOT must be an absolute path.');
    }
    return path.resolve(explicit);
  }
  return path.join(host.codexHome.path, 'circuit', 'mcp-spike');
}

async function pinProofRunner() {
  if (!path.isAbsolute(PROOF_RUNNER)) throw new Error('The MCP proof runner must be absolute.');
  const runnerStat = await lstat(PROOF_RUNNER);
  if (runnerStat.isSymbolicLink() || !runnerStat.isFile()) {
    throw new Error('The MCP proof runner must be a regular plugin-owned file.');
  }
  return await realpath(PROOF_RUNNER);
}

let serverResourcesPromise;

async function serverResources() {
  if (serverResourcesPromise !== undefined) return await serverResourcesPromise;
  serverResourcesPromise = (async () => {
    const [host, assets, proofRunner, mcpAssets] = await Promise.all([
      discoverTrustedCodexHost({ env: process.env }),
      snapshotPackagedAssets(PACKAGED_LAYOUT),
      pinProofRunner(),
      snapshotMcpAssets(MCP_ROOT),
    ]);
    const stateRoot = resolvedStateRoot(process.env, host);
    const sealedState = await prepareSealedStateRoot(stateRoot);
    return { host, assets, proofRunner, mcpAssets, stateRoot, sealedState };
  })();
  return await serverResourcesPromise;
}

async function assertServerResourcesUnchanged(resources) {
  await Promise.all([
    assertTrustedCodexExecutableUnchanged(resources.host.codex),
    assertPackagedAssetsUnchanged(resources.assets),
    assertMcpAssetsUnchanged(resources.mcpAssets),
  ]);
}

async function assertWorkspaceResourceBoundary(workspace, resources) {
  await assertMcpResourcesOutsideWorkspace({
    workspace,
    stateRoot: resources.stateRoot,
    pluginRoot: resources.assets.plugin_root,
    mcpRoot: resources.mcpAssets.root,
    codexHome: resources.host.codexHome.path,
    files: [
      { path: resources.assets.runtime_path, label: 'Packaged Circuit runtime' },
      { path: resources.assets.git_state_path, label: 'Packaged git-state helper' },
      { path: resources.proofRunner, label: 'Circuit proof runner' },
      { path: resources.host.codex.executable, label: 'Trusted Codex executable' },
    ],
  });
}

let lifecyclePromise;

async function lifecycle() {
  if (lifecyclePromise !== undefined) return await lifecyclePromise;
  lifecyclePromise = (async () => {
    const resources = await serverResources();
    return new CircuitLifecycle({
      runtimePath: resources.assets.runtime_path,
      flowRoot: resources.assets.flow_root,
      pluginRoot: resources.assets.plugin_root,
      stateRoot: resources.stateRoot,
      baseEnv: process.env,
      codexExecutable: resources.host.codex.executable,
      host: resources.host,
      assets: resources.assets,
      sealedState: resources.sealedState,
      proofRunner: resources.proofRunner,
      verifyAssets: () => assertServerResourcesUnchanged(resources),
      verifyBoundary: (workspace) => assertWorkspaceResourceBoundary(workspace, resources),
    });
  })();
  return await lifecyclePromise;
}

async function runLifecycleTool(name, params) {
  const workspace = await workspaceFromToolCall(params);
  const args = params?.arguments;
  const manager = await lifecycle();
  if (name === STATUS_TOOL_NAME) return await manager.status(workspace, args);
  if (name === CANCEL_TOOL_NAME) return await manager.cancel(workspace, args);
  const resources = await serverResources();
  await assertServerResourcesUnchanged(resources);
  await assertWorkspaceResourceBoundary(workspace, resources);
  if (name === START_TOOL_NAME) return await manager.start(workspace, args);
  if (name === RESUME_TOOL_NAME) {
    return await manager.resume(workspace, args);
  }
  throw new Error(`Unknown tool: ${name ?? ''}`);
}

function startServer() {
  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function sendResult(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function handleRequest(message) {
    const { id, method, params } = message;

    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          experimental: { [SANDBOX_META_KEY]: {} },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'This is a development-only Circuit MCP spike. It can probe the sandbox boundary and run all five packaged flows through start, status, resume, and cancel tools.',
      });
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ''}`);
        return;
      }
      try {
        const result =
          toolName === PROBE_TOOL_NAME
            ? await runProbe(params)
            : await runLifecycleTool(toolName, params);
        sendResult(id, toolResult(result));
      } catch (error) {
        sendResult(
          id,
          toolResult(
            {
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
            true,
          ),
        );
      }
      return;
    }

    if (id !== undefined) {
      sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  lines.on('line', (line) => {
    if (line.trim().length === 0) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    void handleRequest(message).catch((error) => {
      if (message.id !== undefined) {
        sendError(
          message.id,
          JsonRpcError.INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  });

  let stopping = false;
  async function stopServer(exitWhenDone) {
    if (stopping) return;
    stopping = true;
    lines.close();
    if (lifecyclePromise !== undefined) {
      try {
        const manager = await lifecyclePromise;
        await manager.shutdown();
      } catch {
        // The server is already stopping. There is nowhere safe to report this error.
      }
    }
    if (exitWhenDone) process.exit(0);
  }

  lines.once('close', () => {
    void stopServer(false);
  });
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void stopServer(true);
    });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startServer();
}

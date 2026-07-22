#!/usr/bin/env node

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { MCP_TOOL_NAMES } from '../../../src/hosts/codex-mcp/contracts.ts';
import { resolveCodexExecutableOnPath } from '../../../src/hosts/codex-mcp/production-paths.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/codex');
const PRIVATE_TEST_ROOT = resolve(REPO_ROOT, '.mcp-host-tests');
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MARKETPLACE = 'circuit-fresh-host-probe';
export const SENTINEL_RUN_ID = '019f64f5-1f4d-7d91-8cda-a309cc72c301';
const DIAGNOSTIC_SENTINELS = [
  ['scratch-root', '019f64f5-1f4d-7d91-8cda-a309cc72c310'],
  ['isolated-home', '019f64f5-1f4d-7d91-8cda-a309cc72c311'],
  ['isolated-codex-home', '019f64f5-1f4d-7d91-8cda-a309cc72c312'],
  ['marketplace-root', '019f64f5-1f4d-7d91-8cda-a309cc72c313'],
  ['marketplace-plugin-source', '019f64f5-1f4d-7d91-8cda-a309cc72c314'],
] as const;

type SmokeStatus = 'pass' | 'fail' | 'skip';

interface Evidence {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

interface SmokeOutcome {
  readonly schema_version: 1;
  readonly host: 'codex';
  readonly surface: 'mcp';
  readonly status: SmokeStatus;
  readonly reason: string;
  readonly evidence: readonly Evidence[];
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly cleanup_confirmed: boolean;
}

function processGroupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function terminateProcessGroup(pid: number): Promise<boolean> {
  if (processGroupAbsent(pid)) return true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return processGroupAbsent(pid);
  }
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
  if (processGroupAbsent(pid)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    if (processGroupAbsent(pid)) return true;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    if (processGroupAbsent(pid)) return true;
  }
  return false;
}

interface ProbeServer {
  readonly port: number;
  readonly requests: () => number;
  readonly discoveredTools: () => readonly string[];
  readonly protocolError: () => string | undefined;
  readonly close: () => Promise<void>;
}

function outcome(status: SmokeStatus, reason: string, evidence: readonly Evidence[]): SmokeOutcome {
  return { schema_version: 1, host: 'codex', surface: 'mcp', status, reason, evidence };
}

function runSync(
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    ...(environment === undefined ? {} : { env: environment }),
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(0, 2_000);
    throw new Error(detail.length === 0 ? `${command} ${args[0] ?? ''} failed` : detail);
  }
  return result.stdout;
}

async function runAsync(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    let child: ChildProcess | undefined;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current: string, chunk: Buffer | string): string => {
      if (Buffer.byteLength(current, 'utf8') >= MAX_OUTPUT_BYTES) return current;
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8');
      return current + Buffer.from(chunk).subarray(0, remaining).toString('utf8');
    };
    try {
      child = spawn(command, [...args], {
        env: environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectRun(error);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        forceTimer = setTimeout(() => {
          if (child?.pid === undefined) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, 1_000);
      }
    }, TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      rejectRun(error);
    });
    child.once('close', async (status) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      const cleanupConfirmed =
        child?.pid === undefined ? true : await terminateProcessGroup(child.pid);
      resolveRun({
        status,
        stdout,
        stderr,
        timed_out: timedOut,
        cleanup_confirmed: cleanupConfirmed,
      });
    });
  });
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function completedResponse(id: string, output: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: output },
    {
      type: 'response.completed',
      response: {
        id,
        output: [output],
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
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

async function startProbeServer(): Promise<ProbeServer> {
  let requestCount = 0;
  let discoveredTools: readonly string[] = [];
  let protocolError: string | undefined;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_OUTPUT_BYTES) request.destroy();
    });
    request.on('end', () => {
      if ((request.url ?? '').startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      if (!(request.url ?? '').startsWith('/v1/responses')) {
        response.writeHead(404).end();
        return;
      }
      requestCount += 1;
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(body || '{}') as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('request is not an object');
        }
        payload = parsed as Record<string, unknown>;
      } catch (error) {
        protocolError = `request ${requestCount} was not valid JSON: ${String(error)}`;
        response.writeHead(400).end();
        return;
      }

      let events: readonly Record<string, unknown>[];
      if (requestCount === 1) {
        const item = {
          type: 'tool_search_call',
          id: 'ts_tool_search',
          call_id: 'call_tool_search',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'Circuit circuit_list recent runs', limit: 8 },
        };
        events = completedResponse('resp_probe_1', item);
      } else if (requestCount === 2) {
        const searchOutput = records(payload.input).find(
          (item) => item.type === 'tool_search_output' && item.call_id === 'call_tool_search',
        );
        const namespace = records(searchOutput?.tools).find(
          (item) => item.type === 'namespace' && item.name === 'mcp__circuit',
        );
        discoveredTools = records(namespace?.tools)
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === 'string')
          .sort();
        if (JSON.stringify(discoveredTools) !== JSON.stringify([...MCP_TOOL_NAMES].sort())) {
          protocolError = `tool_search returned unexpected Circuit tools: ${discoveredTools.join(', ')}`;
          response.writeHead(500).end();
          return;
        }
        const item = {
          type: 'function_call',
          id: 'fc_circuit_list',
          call_id: 'call_circuit_list',
          namespace: 'mcp__circuit',
          name: 'circuit_list',
          arguments: '{}',
        };
        events = completedResponse('resp_probe_2', item);
      } else if (requestCount === 3) {
        const functionOutput = records(payload.input).find(
          (item) => item.type === 'function_call_output' && item.call_id === 'call_circuit_list',
        );
        if (functionOutput === undefined) {
          protocolError = 'Codex did not return the circuit_list function output to the provider.';
          response.writeHead(500).end();
          return;
        }
        const item = {
          type: 'message',
          role: 'assistant',
          id: 'msg_probe_complete',
          content: [{ type: 'output_text', text: 'NO_SPEND_PROBE_COMPLETE' }],
        };
        events = completedResponse('resp_probe_3', item);
      } else {
        protocolError = 'Codex sent an unexpected fourth provider request.';
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(events));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not bind the fresh-host loopback provider.');
  }
  return {
    port: address.port,
    requests: () => requestCount,
    discoveredTools: () => discoveredTools,
    protocolError: () => protocolError,
    close: async () => {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}

function parseMcpResult(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== 'item.completed') continue;
    const item =
      typeof event.item === 'object' && event.item !== null && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : undefined;
    if (
      item?.type !== 'mcp_tool_call' ||
      item.server !== 'circuit' ||
      item.tool !== 'circuit_list'
    ) {
      continue;
    }
    const result =
      typeof item.result === 'object' && item.result !== null && !Array.isArray(item.result)
        ? (item.result as Record<string, unknown>)
        : undefined;
    const structured = result?.structured_content;
    if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
      return structured as Record<string, unknown>;
    }
  }
  return undefined;
}

function privateDirectory(path: string): boolean {
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700;
}

function pluginCacheDirectories(codexHome: string): readonly string[] {
  const pluginsRoot = join(codexHome, 'plugins');
  if (!existsSync(pluginsRoot)) return [];
  const directories: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 5) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(child);
      } catch {
        continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (existsSync(join(child, '.codex-plugin', 'plugin.json'))) directories.push(child);
      visit(child, depth + 1);
    }
  };
  visit(pluginsRoot, 0);
  return directories;
}

export function seedWorkspaceSentinel(
  codexHome: string,
  workspace: string,
  runId = SENTINEL_RUN_ID,
  summary = 'Fresh-host workspace identity sentinel.',
): void {
  const canonicalWorkspace = realpathSync.native(workspace);
  const workspaceInfo = statSync(canonicalWorkspace);
  const workspaceKey = createHash('sha256').update(canonicalWorkspace, 'utf8').digest('hex');
  const executablePath = realpathSync.native(process.execPath);
  const executableInfo = statSync(executablePath);
  const now = new Date().toISOString();
  const owner = {
    pid: process.pid,
    process_group_id: process.pid,
    started_at: now,
    birth_token: 'fresh-host-workspace-sentinel',
    executable: {
      real_path: executablePath,
      device: String(executableInfo.dev),
      inode: String(executableInfo.ino),
      sha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex'),
    },
    instance_id: 'fresh-host-workspace-sentinel',
  } as const;
  const stateRoot = join(codexHome, 'circuit', 'mcp', 'v1');
  const runsRoot = join(stateRoot, 'runs');
  const runDirectory = join(runsRoot, workspaceKey, runId);
  for (const directory of [stateRoot, runsRoot, join(stateRoot, 'leases'), runDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const record = {
    schema_version: 1,
    record_kind: 'circuit.mcp.run-state',
    revision: 2,
    run_id: runId,
    lease_id: '019f64f5-1f4d-7d91-8cda-a309cc72c303',
    workspace: {
      key: workspaceKey,
      canonical_path: canonicalWorkspace,
      device: String(workspaceInfo.dev),
      inode: String(workspaceInfo.ino),
    },
    request: {
      flow: 'review',
      goal: 'Verify the exact fresh-host workspace identity.',
      web_search: 'off',
    },
    state: 'interrupted',
    summary,
    runtime_assets_sha256: 'a'.repeat(64),
    run_relative_path: `.circuit/runs/${runId}`,
    created_at: now,
    updated_at: now,
    finished_at: now,
    allocation: { owner, created_at: now },
    launch: {
      generation: 1,
      phase: 'exited',
      allocation_owner: owner,
      exit: {
        observed_at: now,
        exit_code: 0,
        process_group_cleanup: 'confirmed',
      },
    },
    progress: { next_cursor: 0, retained_from_cursor: 0, dropped_count: 0, events: [] },
  } as const;
  writeFileSync(join(runDirectory, 'state.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function marketplaceManifest(): string {
  return `${JSON.stringify(
    {
      name: MARKETPLACE,
      interface: { displayName: 'Circuit Fresh Host Probe' },
      plugins: [
        {
          name: 'circuit',
          source: { source: 'local', path: './plugins/circuit' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Coding',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

async function runLiveProbe(): Promise<SmokeOutcome> {
  const evidence: Evidence[] = [];
  mkdirSync(PRIVATE_TEST_ROOT, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(PRIVATE_TEST_ROOT, 'fresh-host-'));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const privateTemp = join(home, 'tmp');
  const workspace = join(root, 'workspace');
  const marketplace = join(root, 'marketplace');
  const marketplacePlugin = join(marketplace, 'plugins', 'circuit');
  const archive = join(root, 'circuit-codex-plugin.tar');
  let server: ProbeServer | undefined;
  try {
    const codex = resolveCodexExecutableOnPath(process.env.PATH);
    const safePath = `${dirname(process.execPath)}:/usr/bin:/bin`;
    for (const directory of [home, codexHome, privateTemp, workspace, marketplacePlugin]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    runSync('/usr/bin/git', ['init', '-q', workspace]);
    mkdirSync(join(marketplace, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(marketplace, '.agents', 'plugins', 'marketplace.json'),
      marketplaceManifest(),
      { mode: 0o600, flag: 'wx' },
    );
    runSync('tar', ['-cf', archive, '-C', PLUGIN_ROOT, '.']);
    runSync('tar', ['-xf', archive, '-C', marketplacePlugin]);

    const environment: NodeJS.ProcessEnv = {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: safePath,
      TMPDIR: privateTemp,
      LANG: 'C',
      LC_ALL: 'C',
    };
    runSync(codex, ['plugin', 'marketplace', 'add', marketplace, '--json'], environment);
    runSync(codex, ['plugin', 'add', `circuit@${MARKETPLACE}`, '--json'], environment);
    evidence.push({ name: 'packed_plugin_installed', ok: true });
    const diagnosticSentinels = new Map<string, string>();
    seedWorkspaceSentinel(codexHome, workspace);
    for (const [label, runId] of DIAGNOSTIC_SENTINELS) {
      const candidate =
        label === 'scratch-root'
          ? root
          : label === 'isolated-home'
            ? home
            : label === 'isolated-codex-home'
              ? codexHome
              : label === 'marketplace-root'
                ? marketplace
                : marketplacePlugin;
      seedWorkspaceSentinel(
        codexHome,
        candidate,
        runId,
        `Fresh-host diagnostic sentinel: ${label}.`,
      );
      diagnosticSentinels.set(runId, label);
    }
    let pluginCacheIndex = 0;
    for (const directory of pluginCacheDirectories(codexHome)) {
      pluginCacheIndex += 1;
      const runId = `019f64f5-1f4d-7d91-8cda-a309cc72c4${String(pluginCacheIndex).padStart(
        2,
        '0',
      )}`;
      seedWorkspaceSentinel(
        codexHome,
        directory,
        runId,
        `Fresh-host diagnostic sentinel: installed-plugin-${pluginCacheIndex}.`,
      );
      diagnosticSentinels.set(runId, `installed-plugin-${pluginCacheIndex}`);
    }

    server = await startProbeServer();
    const provider = `model_providers.circuit_probe={name="Circuit Probe",base_url="http://127.0.0.1:${server.port}/v1",env_key="CIRCUIT_PROBE_API_KEY",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`;
    const run = await runAsync(
      codex,
      [
        'exec',
        '--strict-config',
        '-C',
        workspace,
        '--ephemeral',
        '--sandbox',
        'read-only',
        '-c',
        'approval_policy="never"',
        '-c',
        'model="gpt-5.4"',
        '-c',
        'model_provider="circuit_probe"',
        '-c',
        provider,
        '-c',
        'analytics.enabled=false',
        '-c',
        'check_for_update_on_startup=false',
        '--json',
        'Use Circuit to list recent runs for this workspace. You must call circuit_list. If it is deferred, call tool_search first to load it. Do not call shell or any other tool. Then report whether the fresh-host workspace sentinel was present.',
      ],
      {
        ...environment,
        CIRCUIT_PROBE_API_KEY: 'canary-not-a-secret',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    );
    evidence.push({
      name: 'real_plugin_loader_completed',
      ok: run.status === 0 && !run.timed_out && run.cleanup_confirmed,
      ...(run.status === 0 ? {} : { detail: run.stderr.slice(0, 500) }),
    });
    evidence.push({ name: 'owned_process_cleanup', ok: run.cleanup_confirmed });
    evidence.push({
      name: 'tool_search_discovered_six_tools',
      ok: server.discoveredTools().length === MCP_TOOL_NAMES.length,
      detail: server.discoveredTools().join(', '),
    });
    evidence.push({
      name: 'circuit_list_invoked',
      ok: server.requests() === 3,
      detail: `${server.requests()} provider requests`,
    });
    if (server.protocolError() !== undefined) {
      throw new Error(server.protocolError());
    }
    if (run.timed_out || run.status !== 0 || !run.cleanup_confirmed) {
      throw new Error(run.stderr.trim().slice(0, 2_000) || 'The real Codex probe failed.');
    }

    const stateRoot = join(codexHome, 'circuit', 'mcp', 'v1');
    const statePrivate = privateDirectory(stateRoot);
    evidence.push({ name: 'private_control_state', ok: statePrivate });
    if (!statePrivate) throw new Error('Circuit did not create a private MCP state directory.');

    const structured = parseMcpResult(run.stdout);
    const workspaceMetadataPassed = structured?.ok === true;
    const error =
      typeof structured?.error === 'object' && structured.error !== null
        ? (structured.error as Record<string, unknown>)
        : undefined;
    evidence.push({
      name: 'trusted_workspace_metadata',
      ok: workspaceMetadataPassed,
      detail: workspaceMetadataPassed
        ? 'circuit_list accepted codex/sandbox-state-meta'
        : typeof error?.code === 'string'
          ? error.code
          : 'no structured circuit_list result',
    });
    if (!workspaceMetadataPassed) {
      return outcome(
        'fail',
        typeof error?.message === 'string'
          ? error.message
          : 'The real Codex plugin loader did not provide trusted workspace metadata.',
        evidence,
      );
    }
    const listedRuns = records(structured.runs);
    const exactWorkspacePassed =
      listedRuns.length === 1 && listedRuns[0]?.run_id === SENTINEL_RUN_ID;
    evidence.push({
      name: 'exact_workspace_identity',
      ok: exactWorkspacePassed,
      detail: listedRuns
        .map((run) => run.run_id)
        .filter((runId): runId is string => typeof runId === 'string')
        .map(
          (runId) =>
            `${runId}${diagnosticSentinels.has(runId) ? ` (${diagnosticSentinels.get(runId)})` : ''}`,
        )
        .join(', '),
    });
    if (!exactWorkspacePassed) {
      return outcome(
        'fail',
        'Circuit accepted workspace metadata, but it did not identify the exact fresh-host worktree.',
        evidence,
      );
    }
    return outcome(
      'pass',
      'The packed plugin loaded, discovered Circuit, and identified the exact fresh-host worktree.',
      evidence,
    );
  } catch (error) {
    return outcome('fail', error instanceof Error ? error.message : String(error), evidence);
  } finally {
    await server?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

function usage(): string {
  return [
    'Usage: npm run smoke:host:codex:mcp -- --live',
    '',
    'Installs the packed Codex plugin into an isolated home and uses a local',
    'no-spend Responses provider to invoke circuit_list through the real loader.',
  ].join('\n');
}

async function main(): Promise<number> {
  const program = new Command('codex-mcp-host-smoke').option('-h, --help').option('--live');
  program.parse(process.argv.slice(2), { from: 'user' });
  const options = program.opts<{ help?: boolean; live?: boolean }>();
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (process.platform !== 'darwin') {
    process.stdout.write(
      `${JSON.stringify(outcome('skip', 'The Codex MCP host smoke currently supports macOS only.', []), null, 2)}\n`,
    );
    return 0;
  }
  if (options.live !== true) {
    process.stdout.write(
      `${JSON.stringify(outcome('skip', 'Safe preflight passed. Re-run with --live to start the isolated no-spend host probe.', []), null, 2)}\n`,
    );
    return 0;
  }
  const result = await runLiveProbe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'pass' ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCodexArgs } from '../../../src/connectors/codex.js';
import {
  buildWorkerArgs,
  parseWorkerEvents,
  runProcess,
  workspaceFromToolCall,
} from './server.mjs';

const EXPERIMENT_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(EXPERIMENT_ROOT, 'mcp/server.mjs');
const PROCESS_FIXTURE = fileURLToPath(new URL('./fixtures/proof-command.mjs', import.meta.url));
const REPOSITORY_ROOT = path.resolve(EXPERIMENT_ROOT, '../..');
const SEARCH_QUERY = 'site:learn.chatgpt.com Codex web search official documentation';
const CURL_COMMAND = "/bin/zsh -lc '/usr/bin/curl -I --max-time 5 https://example.com'";
const PUBLIC_FLOWS = ['build', 'explore', 'fix', 'prototype', 'review'];
const tempRoots: string[] = [];

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function processFixtureRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `${label}-`)));
  tempRoots.push(root);
  return root;
}

function workerJsonl(
  options: {
    query?: string;
    commands?: Record<string, unknown>[];
  } = {},
) {
  const commands = options.commands ?? [
    {
      type: 'command_execution',
      command: CURL_COMMAND,
      aggregated_output: 'curl: (6) Could not resolve host: example.com',
      exit_code: 6,
    },
  ];
  const events = [
    { type: 'thread.started', thread_id: 'probe' },
    {
      type: 'item.completed',
      item: {
        type: 'web_search',
        action: { type: 'search', query: options.query ?? SEARCH_QUERY },
      },
    },
    ...commands.map((item) => ({ type: 'item.completed', item })),
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'CIRCUIT_MCP_WORKER_OK' },
    },
    { type: 'turn.completed' },
  ];
  return events.map((event) => JSON.stringify(event)).join('\n');
}

class McpTestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  nextId = 1;

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd: EXPERIMENT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id;
      if (typeof id !== 'number') return;
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      pending.resolve(message);
    });
    this.child.once('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  request(method: string, params?: Record<string, unknown>) {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM');
        resolvePromise();
      }, 2_000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

const clients: McpTestClient[] = [];

function startClient(env: NodeJS.ProcessEnv = {}) {
  const client = new McpTestClient(env);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => await client.stop()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeServerEnvironment(): Promise<{
  env: NodeJS.ProcessEnv;
  workspace: string;
  stateRoot: string;
  pluginRoot: string;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'circuit-mcp-server-')));
  tempRoots.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const runtimePath = path.join(pluginRoot, 'runtime', 'circuit.js');
  const gitStatePath = path.join(pluginRoot, 'runtime', 'git-state.js');
  const flowRoot = path.join(pluginRoot, 'flows');
  const codexExecutable = path.join(root, 'codex');
  const codexHome = path.join(root, 'codex-home');
  const stateRoot = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await Promise.all([mkdir(codexHome), mkdir(workspace)]);
  for (const flow of PUBLIC_FLOWS) {
    const flowDir = path.join(flowRoot, flow);
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'circuit.json'), `${JSON.stringify({ id: flow })}\n`);
  }
  await writeFile(
    runtimePath,
    [
      'const args = process.argv.slice(2);',
      "if (args[0] === 'preview') {",
      "  process.stdout.write(JSON.stringify({ flowId: args[1], process: 'medium', relaySteps: [] }));",
      "} else if (args[0] === 'config') {",
      "  process.stdout.write(JSON.stringify({ layers: [{ layer: 'defaults', config: { relay: { default: 'auto', roles: {}, flows: {}, connectors: {} }, flows: {} } }] }));",
      '} else {',
      "  setTimeout(() => process.stdout.write(JSON.stringify({ outcome: 'stopped' })), 100);",
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(gitStatePath, 'process.stdout.write("{}")\n');
  await writeFile(
    codexExecutable,
    [
      '#!/usr/bin/env node',
      "if (process.argv[2] === '--version') { process.stdout.write('codex-cli 9.9.9\\n'); process.exit(0); }",
      `const events = ${JSON.stringify(workerJsonl().split('\n'))};`,
      "for (const event of events) process.stdout.write(event + '\\n');",
      '',
    ].join('\n'),
  );
  await chmod(codexExecutable, 0o755);
  return {
    pluginRoot,
    workspace,
    stateRoot,
    env: {
      CIRCUIT_MCP_PLUGIN_ROOT: pluginRoot,
      CIRCUIT_MCP_CODEX_EXECUTABLE: codexExecutable,
      CIRCUIT_MCP_STATE_ROOT: stateRoot,
      CODEX_HOME: codexHome,
    },
  };
}

describe('Circuit MCP sandbox spike', () => {
  it('cleans the observed process tree when its subprocess times out', async () => {
    const root = await processFixtureRoot('circuit-mcp-server-timeout');
    const pidFile = path.join(root, 'pids.json');
    const result = await runProcess(process.execPath, [PROCESS_FIXTURE, 'tree', pidFile], {
      cwd: root,
      env: process.env,
      timeoutMs: 200,
      maxOutputBytes: 20_000,
      interruptGraceMs: 50,
    });
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { root: number; leaf: number };

    expect(result).toMatchObject({
      timedOut: true,
      cleanup: { required: true, confirmed: true, remainingPids: [] },
    });
    expect(result.code).not.toBe(0);
    expect(processIsAbsent(pids.root)).toBe(true);
    expect(processIsAbsent(pids.leaf)).toBe(true);
  }, 10_000);

  it('stops and cleans a subprocess as soon as it exceeds the output cap', async () => {
    const root = await processFixtureRoot('circuit-mcp-server-output-cap');
    const result = await runProcess(process.execPath, [PROCESS_FIXTURE, 'output', '10000'], {
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 64,
      interruptGraceMs: 50,
    });

    expect(result).toMatchObject({
      stdoutCapped: true,
      timedOut: false,
      cleanup: { required: true, confirmed: true, remainingPids: [] },
    });
    expect(result.code).not.toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64);
  }, 10_000);

  it('fails and cleans when a normally exiting subprocess leaves a background child', async () => {
    const root = await processFixtureRoot('circuit-mcp-server-background');
    const pidFile = path.join(root, 'pids.json');
    const result = await runProcess(process.execPath, [PROCESS_FIXTURE, 'background', pidFile], {
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 20_000,
      interruptGraceMs: 50,
    });
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { root: number; leaf: number };

    expect(result).toMatchObject({
      code: 1,
      backgroundDescendants: true,
      cleanup: { required: true, confirmed: true, remainingPids: [] },
    });
    expect(processIsAbsent(pids.root)).toBe(true);
    expect(processIsAbsent(pids.leaf)).toBe(true);
  }, 10_000);

  it('advertises the probe and bounded run lifecycle with trusted Codex metadata', async () => {
    const client = startClient();
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialized.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: {},
        experimental: { 'codex/sandbox-state-meta': {} },
      },
    });

    const listed = await client.request('tools/list');
    const tools = (listed.result as { tools: Record<string, unknown>[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'circuit_sandbox_probe',
      'circuit_start',
      'circuit_status',
      'circuit_resume',
      'circuit_cancel',
    ]);
    expect(tools[0]).toMatchObject({
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
    expect(tools[1]).toMatchObject({
      inputSchema: {
        properties: {
          flow: { enum: PUBLIC_FLOWS },
          why: { type: 'string' },
          power: { enum: ['auto', 'low', 'medium', 'high'] },
          process: { enum: ['low', 'medium', 'high'] },
          tournament: { minimum: 2, maximum: 4 },
          autonomous: { type: 'boolean' },
          include_untracked_content: { type: 'boolean' },
          web_search: { enum: ['off', 'cached'], default: 'off' },
        },
        required: ['flow', 'goal'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    });
    expect(tools[2]).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });
  });

  it('reports the MCP version it actually supports', async () => {
    const client = startClient();
    const initialized = await client.request('initialize', {
      protocolVersion: 'made-up-version',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initialized.result).toMatchObject({ protocolVersion: '2025-06-18' });
  });

  it('fails closed when Codex does not provide sandbox metadata', async () => {
    const client = startClient();
    const response = await client.request('tools/call', {
      name: 'circuit_sandbox_probe',
      arguments: {},
    });
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        status: 'error',
        message: expect.stringContaining('missing codex/sandbox-state-meta'),
      },
    });
  });

  it('starts Build with injected host, package, and stable state paths', async () => {
    const fixture = await fakeServerEnvironment();
    const client = startClient(fixture.env);
    const response = await client.request('tools/call', {
      name: 'circuit_start',
      arguments: {
        flow: 'build',
        goal: 'Build something',
        process: 'low',
        web_search: 'off',
      },
      _meta: {
        'codex/sandbox-state-meta': {
          sandboxCwd: pathToFileURL(fixture.workspace).href,
        },
      },
    });
    expect(response.result).toMatchObject({
      structuredContent: {
        run_id: expect.any(String),
        state: 'running',
      },
    });
    expect(response.result).not.toHaveProperty('isError');
    const runId = (response.result as { structuredContent: { run_id: string } }).structuredContent
      .run_id;
    let state = 'running';
    for (let attempt = 0; attempt < 20 && state === 'running'; attempt += 1) {
      const status = await client.request('tools/call', {
        name: 'circuit_status',
        arguments: { run_id: runId, wait_ms: 250 },
        _meta: {
          'codex/sandbox-state-meta': {
            sandboxCwd: pathToFileURL(fixture.workspace).href,
          },
        },
      });
      state =
        (status.result as { structuredContent?: { state?: string } }).structuredContent?.state ??
        'running';
    }
    expect(state).not.toBe('running');
    await expect(realpath(path.join(fixture.stateRoot, 'runs'))).resolves.toBe(
      path.join(fixture.stateRoot, 'runs'),
    );
  });

  it('keeps status and cancellation available after a pinned plugin asset changes', async () => {
    const fixture = await fakeServerEnvironment();
    const client = startClient(fixture.env);
    const metadata = {
      'codex/sandbox-state-meta': {
        sandboxCwd: pathToFileURL(fixture.workspace).href,
      },
    };
    const started = await client.request('tools/call', {
      name: 'circuit_start',
      arguments: { flow: 'build', goal: 'Keep running until cancelled', process: 'low' },
      _meta: metadata,
    });
    const runId = (started.result as { structuredContent: { run_id: string } }).structuredContent
      .run_id;
    await writeFile(
      path.join(fixture.pluginRoot, 'flows', 'review', 'circuit.json'),
      `${JSON.stringify({ id: 'review', changed: true })}\n`,
    );

    const status = await client.request('tools/call', {
      name: 'circuit_status',
      arguments: { run_id: runId },
      _meta: metadata,
    });
    expect(status.result).not.toHaveProperty('isError');
    const cancelled = await client.request('tools/call', {
      name: 'circuit_cancel',
      arguments: { run_id: runId },
      _meta: metadata,
    });
    expect(cancelled.result).not.toHaveProperty('isError');
  });

  it('reports the private metadata canary and pinned capabilities', async () => {
    const fixture = await fakeServerEnvironment();
    const client = startClient(fixture.env);
    const response = await client.request('tools/call', {
      name: 'circuit_sandbox_probe',
      arguments: {},
      _meta: {
        'codex/sandbox-state-meta': {
          sandboxCwd: pathToFileURL(fixture.workspace).href,
          futureField: true,
        },
      },
    });
    expect(response.result).toMatchObject({
      structuredContent: {
        status: 'passed',
        workspace: fixture.workspace,
        compatibility: {
          sandbox_metadata: {
            compatible: true,
            contract: 'sandbox-cwd-v1',
            observed_fields: ['futureField', 'sandboxCwd'],
          },
          public_flows: PUBLIC_FLOWS,
          web_search: ['off', 'cached'],
          trusted_codex: { source: 'CIRCUIT_MCP_CODEX_EXECUTABLE' },
          packaged_assets: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          state_root: fixture.stateRoot,
        },
      },
    });
    expect(response.result).not.toHaveProperty('isError');
  });

  it('rejects caller-supplied workspace and command fields', async () => {
    const client = startClient();
    const response = await client.request('tools/call', {
      name: 'circuit_sandbox_probe',
      arguments: {
        workspace: '/tmp',
        command: 'whoami',
      },
    });
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        status: 'error',
        message: 'circuit_sandbox_probe does not accept arguments.',
      },
    });
  });

  it('resolves the workspace only from Codex call metadata', async () => {
    const expected = await realpath(REPOSITORY_ROOT);
    await expect(
      workspaceFromToolCall({
        _meta: {
          'codex/sandbox-state-meta': {
            sandboxCwd: pathToFileURL(REPOSITORY_ROOT).href,
          },
        },
      }),
    ).resolves.toBe(expected);
    await expect(
      workspaceFromToolCall({
        _meta: {
          'codex/sandbox-state-meta': { sandboxCwd: 'https://example.com' },
        },
      }),
    ).rejects.toThrow('must use the file: protocol');
  });

  it('recognizes cached search plus blocked shell networking in Codex JSONL', () => {
    expect(parseWorkerEvents(workerJsonl())).toEqual({
      passed: true,
      turnCompleted: true,
      webSearchCount: 1,
      webSearchQuery: SEARCH_QUERY,
      commandCount: 1,
      commandExitCodes: [6],
      curlCommandCount: 1,
      curlExitCode: 6,
      networkFailureSeen: true,
      shellNetworkBlocked: true,
      markerSeen: true,
    });
  });

  it('probes with the exact sealed policy used by real Circuit relays', () => {
    const workspace = '/tmp/circuit-probe-policy';
    const probeArgs = buildWorkerArgs(workspace);
    const relayArgs = buildCodexArgs(
      {
        cwd: workspace,
        prompt: 'placeholder',
        resolvedSelection: { effort: 'low', skills: [], invocation_options: {} },
      },
      undefined,
      undefined,
      'cached',
      true,
    );

    expect(probeArgs.slice(0, -1)).toEqual(relayArgs.slice(0, -1));
  });

  it('does not confuse a different query, extra command, or local curl failure with success', () => {
    expect(parseWorkerEvents(workerJsonl({ query: 'secret workspace contents' })).passed).toBe(
      false,
    );
    expect(
      parseWorkerEvents(
        workerJsonl({
          commands: [
            {
              type: 'command_execution',
              command: '/bin/pwd',
              aggregated_output: `${REPOSITORY_ROOT}\n`,
              exit_code: 0,
            },
            {
              type: 'command_execution',
              command: CURL_COMMAND,
              aggregated_output: 'curl: (6) Could not resolve host: example.com',
              exit_code: 6,
            },
          ],
        }),
      ).passed,
    ).toBe(false);
    expect(
      parseWorkerEvents(
        workerJsonl({
          commands: [
            {
              type: 'command_execution',
              command: CURL_COMMAND,
              aggregated_output: 'zsh: permission denied: /usr/bin/curl',
              exit_code: 126,
            },
          ],
        }),
      ).passed,
    ).toBe(false);
  });
});

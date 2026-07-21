import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const EXPERIMENT_ROOT = path.resolve(import.meta.dirname, '..');
const REPOSITORY_ROOT = path.resolve(EXPERIMENT_ROOT, '../..');
const SOURCE_MCP_ROOT = path.join(EXPERIMENT_ROOT, 'mcp');
const SOURCE_PLUGIN_ROOT = path.join(REPOSITORY_ROOT, 'plugins/codex');
const FAKE_RUNTIME = path.join(SOURCE_MCP_ROOT, 'fixtures/fake-runtime.mjs');
const PUBLIC_FLOWS = ['build', 'explore', 'fix', 'prototype', 'review'] as const;
const TERMINAL_STATES = new Set([
  'cancelled',
  'complete',
  'failed',
  'interrupted',
  'needs_attention',
  'recovery_required',
]);
const LIVE_ALL_FLOWS =
  process.platform === 'darwin' && process.env.CIRCUIT_MCP_LIVE_ALL_FLOWS === '1';

type JsonRecord = Record<string, unknown>;
type PublicFlow = (typeof PUBLIC_FLOWS)[number];

interface InstalledPackage {
  pluginRoot: string;
  serverPath: string;
}

interface SmokeFixture extends InstalledPackage {
  root: string;
  stateRoot: string;
  codexHome: string;
  codexExecutable: string;
  modelTurnMarker: string;
  poisonPath?: string;
  pathCodexMarker?: string;
}

const cleanupRoots: string[] = [];
const clients: McpClient[] = [];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function temporaryDirectory(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `${label}-`)));
  cleanupRoots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'pipe' });
}

async function copyMcpRuntime(pluginRoot: string): Promise<void> {
  const target = path.join(pluginRoot, 'mcp');
  await mkdir(target, { recursive: true });
  const entries = await readdir(SOURCE_MCP_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    await cp(path.join(SOURCE_MCP_ROOT, entry.name), path.join(target, entry.name));
  }
}

async function installExperimentPackage(
  root: string,
  runtime: 'fixture' | 'real',
): Promise<InstalledPackage> {
  const pluginRoot = path.join(root, 'plugin-cache', 'circuit-mcp-spike', '0.1.0');
  await mkdir(pluginRoot, { recursive: true });
  await Promise.all([
    cp(path.join(EXPERIMENT_ROOT, '.codex-plugin'), path.join(pluginRoot, '.codex-plugin'), {
      recursive: true,
    }),
    cp(path.join(EXPERIMENT_ROOT, '.mcp.json'), path.join(pluginRoot, '.mcp.json')),
    cp(path.join(SOURCE_PLUGIN_ROOT, 'flows'), path.join(pluginRoot, 'flows'), {
      recursive: true,
    }),
    copyMcpRuntime(pluginRoot),
  ]);
  if (runtime === 'real') {
    await cp(path.join(SOURCE_PLUGIN_ROOT, 'runtime'), path.join(pluginRoot, 'runtime'), {
      recursive: true,
    });
  } else {
    await mkdir(path.join(pluginRoot, 'runtime'), { recursive: true });
    await Promise.all([
      cp(FAKE_RUNTIME, path.join(pluginRoot, 'runtime', 'circuit.js')),
      cp(
        path.join(SOURCE_PLUGIN_ROOT, 'runtime', 'git-state.js'),
        path.join(pluginRoot, 'runtime', 'git-state.js'),
      ),
    ]);
  }
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  ) as JsonRecord;
  const config = JSON.parse(
    await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'),
  ) as JsonRecord;
  const servers = isRecord(config.mcpServers) ? config.mcpServers : undefined;
  const server = isRecord(servers?.['circuit-spike']) ? servers['circuit-spike'] : undefined;
  const forwardedEnvironment = [
    'ALL_PROXY',
    'CIRCUIT_MCP_CODEX_EXECUTABLE',
    'CODEX_CLI_PATH',
    'CODEX_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
  ];
  if (
    manifest.mcpServers !== './.mcp.json' ||
    server?.command !== 'node' ||
    server.cwd !== '.' ||
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    server.args[0] !== './mcp/server.mjs' ||
    !Array.isArray(server.env_vars) ||
    JSON.stringify(server.env_vars) !== JSON.stringify(forwardedEnvironment)
  ) {
    throw new Error(
      'The installed Circuit plugin does not point to its packaged MCP server with the required environment forwarding.',
    );
  }
  return { pluginRoot, serverPath: path.resolve(pluginRoot, server.args[0]) };
}

async function writeFakeCodex(executable: string, modelTurnMarker: string): Promise<void> {
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      "import { writeFileSync } from 'node:fs';",
      "if (process.argv[2] === '--version') {",
      "  process.stdout.write('codex-cli 9.9.9\\n');",
      '  process.exit(0);',
      '}',
      `writeFileSync(${JSON.stringify(modelTurnMarker)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stderr.write('The installed-package smoke intentionally blocked a model turn.\\n');",
      'process.exit(97);',
      '',
    ].join('\n'),
  );
  await chmod(executable, 0o755);
}

async function writePoisonCodex(executable: string, marker: string): Promise<void> {
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join('\\n'));`,
      "process.stderr.write('Circuit used the PATH codex instead of its pinned executable.\\n');",
      'process.exit(98);',
      '',
    ].join('\n'),
  );
  await chmod(executable, 0o755);
}

async function smokeFixture(runtime: 'fixture' | 'real'): Promise<SmokeFixture> {
  const root = await temporaryDirectory(`circuit-mcp-installed-${runtime}`);
  const installed = await installExperimentPackage(root, runtime);
  const stateRoot = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const codexExecutable = path.join(root, 'codex');
  const modelTurnMarker = path.join(root, 'model-turn-attempted');
  const poisonPath = path.join(root, 'poison-path');
  const pathCodexMarker = path.join(root, 'path-codex-used');
  await Promise.all([
    mkdir(stateRoot),
    mkdir(codexHome),
    mkdir(poisonPath),
    writeFakeCodex(codexExecutable, modelTurnMarker),
  ]);
  await writePoisonCodex(path.join(poisonPath, 'codex'), pathCodexMarker);
  await writeFile(
    path.join(codexHome, 'models_cache.json'),
    `${JSON.stringify({
      models: [
        {
          slug: 'gpt-installed-smoke',
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
        },
      ],
    })}\n`,
  );
  return {
    ...installed,
    root,
    stateRoot,
    codexHome,
    codexExecutable,
    modelTurnMarker,
    poisonPath,
    pathCodexMarker,
  };
}

function childEnvironment(fixture: SmokeFixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCUIT_MCP_CODEX_EXECUTABLE: fixture.codexExecutable,
    CIRCUIT_MCP_STATE_ROOT: fixture.stateRoot,
    CODEX_HOME: fixture.codexHome,
    CIRCUIT_MCP_PLUGIN_ROOT: undefined,
    // A bare `codex` lookup reaches a poison executable. The smoke therefore
    // proves the installed runtime uses CIRCUIT_MCP_CODEX_EXECUTABLE directly.
    PATH:
      fixture.poisonPath === undefined
        ? process.env.PATH
        : `${fixture.poisonPath}:${process.env.PATH ?? ''}`,
  };
  return env;
}

class McpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly stderr: string[] = [];
  nextId = 1;

  constructor(serverPath: string, pluginRoot: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [serverPath], {
      cwd: pluginRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as JsonRecord;
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    this.child.once('error', (error) => this.rejectPending(error));
    this.child.once('close', (code, signal) => {
      this.rejectPending(
        new Error(
          `Installed MCP server stopped (${code ?? signal ?? 'unknown'}): ${this.stderr.join('').trim()}`,
        ),
      );
    });
  }

  request(method: string, params?: JsonRecord, timeoutMs = 30_000): Promise<JsonRecord> {
    const id = this.nextId++;
    const response = new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(
          new Error(
            `Timed out waiting for ${method} from installed MCP server: ${this.stderr.join('').trim()}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  async initialize(): Promise<void> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'installed-smoke', version: '1' },
    });
    expect(response.result).toMatchObject({ protocolVersion: '2025-06-18' });
  }

  async tool(workspace: string, name: string, args: JsonRecord): Promise<JsonRecord> {
    const response = await this.request(
      'tools/call',
      {
        name,
        arguments: args,
        _meta: {
          'codex/sandbox-state-meta': {
            sandboxCwd: pathToFileURL(workspace).href,
          },
        },
      },
      45_000,
    );
    if (!isRecord(response.result)) throw new Error(`${name} returned no MCP result.`);
    if (response.result.isError === true) {
      const structured = response.result.structuredContent;
      const message = isRecord(structured) ? structured.message : undefined;
      throw new Error(typeof message === 'string' ? message : `${name} failed.`);
    }
    if (!isRecord(response.result.structuredContent)) {
      throw new Error(`${name} returned no structured content.`);
    }
    return response.result.structuredContent;
  }

  async stop(): Promise<void> {
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

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function startClient(fixture: SmokeFixture): McpClient {
  const client = new McpClient(fixture.serverPath, fixture.pluginRoot, childEnvironment(fixture));
  clients.push(client);
  return client;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} was not a string.`);
  return value;
}

function checkpointChoice(status: JsonRecord): string {
  if (!isRecord(status.checkpoint) || !Array.isArray(status.checkpoint.allowed_choices)) {
    throw new Error('MCP status did not include checkpoint choices.');
  }
  const choices = status.checkpoint.allowed_choices.filter(
    (choice): choice is string => typeof choice === 'string',
  );
  for (const preferred of ['continue', 'keep-prototype']) {
    if (choices.includes(preferred)) return preferred;
  }
  const first = choices[0];
  if (first === undefined) throw new Error('MCP checkpoint did not offer a choice.');
  return first;
}

async function runToTerminal(
  client: McpClient,
  workspace: string,
  flow: PublicFlow,
  goal: string,
  timeoutMs: number,
): Promise<{ runId: string; status: JsonRecord; checkpoints: string[] }> {
  const started = await client.tool(workspace, 'circuit_start', {
    flow,
    goal,
    process: 'medium',
    power: 'low',
    web_search: 'off',
  });
  const runId = requiredString(started.run_id, 'run_id');
  const checkpoints: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let latest: JsonRecord = started;
  while (Date.now() < deadline) {
    latest = await client.tool(workspace, 'circuit_status', {
      run_id: runId,
      wait_ms: Math.min(10_000, Math.max(0, deadline - Date.now())),
      max_events: 100,
    });
    const state = requiredString(latest.state, 'status.state');
    if (state === 'waiting_for_input') {
      const choice = checkpointChoice(latest);
      checkpoints.push(choice);
      latest = await client.tool(workspace, 'circuit_resume', {
        run_id: runId,
        checkpoint_choice: choice,
      });
      continue;
    }
    if (TERMINAL_STATES.has(state)) return { runId, status: latest, checkpoints };
  }
  throw new Error(
    `${flow} did not finish through installed MCP; latest=${JSON.stringify(latest)} stderr=${client.stderr.join('').trim()}`,
  );
}

async function createGitWorkspace(root: string, flow: PublicFlow): Promise<string> {
  const workspace = path.join(root, `workspace-${flow}`);
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'README.md'), `# ${flow} MCP smoke\n\nSmall fixture.\n`);
  if (flow === 'build') {
    await writeFile(path.join(workspace, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  }
  if (flow === 'fix') {
    await mkdir(path.join(workspace, 'src'));
    await mkdir(path.join(workspace, 'test'));
    await writeFile(path.join(workspace, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
    await writeFile(path.join(workspace, 'src/answer.mjs'), 'export const answer = 41;\n');
    await writeFile(
      path.join(workspace, 'test/answer.test.mjs'),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { answer } from '../src/answer.mjs';\ntest('answer', () => assert.equal(answer, 42));\n",
    );
  }
  git(workspace, ['init', '--quiet']);
  git(workspace, ['config', 'user.email', 'circuit@example.test']);
  git(workspace, ['config', 'user.name', 'Circuit Smoke']);
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '--quiet', '-m', 'fixture']);
  if (flow === 'review') {
    await writeFile(path.join(workspace, 'README.md'), '# review MCP smoke\n\nDraft change.\n');
  }
  return await realpath(workspace);
}

function liveGoal(flow: PublicFlow): string {
  const goals: Record<PublicFlow, string> = {
    build:
      'Create BUILD_SMOKE.md containing one line: Circuit Build reached the installed MCP package.',
    explore:
      'Explain what this tiny fixture contains. Do not change project files. Keep the report short.',
    fix: 'Make npm test pass by correcting the intentionally wrong answer value. Keep the fix narrow.',
    prototype:
      'Create a tiny disposable text prototype for a status card. Keep it inside the Prototype flow artifact boundary.',
    review:
      'Review the current uncommitted README change and report any concrete issue. Do not edit it.',
  };
  return goals[flow];
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => await client.stop()));
  await Promise.all(
    cleanupRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe('installed Circuit MCP package smoke', () => {
  it('relocates the package and completes all five MCP flows with a deterministic runtime fixture', async () => {
    const fixture = await smokeFixture('fixture');
    const workspace = path.join(fixture.root, 'workspace');
    await mkdir(workspace);
    const client = startClient(fixture);
    await client.initialize();

    for (const flow of PUBLIC_FLOWS) {
      const terminal = await runToTerminal(
        client,
        workspace,
        flow,
        `Complete installed fixture ${flow}`,
        15_000,
      );
      expect(terminal.status).toMatchObject({
        state: 'complete',
        flow,
        result: {
          flow,
          report: { assessment: `Fixture ${flow} completed.` },
        },
      });
      const policy = JSON.parse(
        await readFile(
          path.join(
            fixture.stateRoot,
            'mcp-jobs-v1',
            'artifacts',
            terminal.runId,
            'sealed-policy.json',
          ),
          'utf8',
        ),
      ) as JsonRecord;
      expect(policy).toMatchObject({
        flow: {
          id: flow,
          source: 'packaged',
          root: path.join(fixture.pluginRoot, 'flows'),
        },
      });
    }
  }, 60_000);

  it('crosses a real packaged Build checkpoint before any model turn', async () => {
    const fixture = await smokeFixture('real');
    const workspace = await createGitWorkspace(fixture.root, 'build');
    const pathCodexMarker = requiredString(fixture.pathCodexMarker, 'pathCodexMarker');
    const client = startClient(fixture);
    await client.initialize();
    await expect(readFile(pathCodexMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const started = await client.tool(workspace, 'circuit_start', {
      flow: 'build',
      goal: 'Prove the installed MCP checkpoint and resume lifecycle.',
      process: 'high',
      power: 'low',
      web_search: 'off',
    });
    const runId = requiredString(started.run_id, 'run_id');
    const deadline = Date.now() + 20_000;
    let waiting: JsonRecord | undefined;
    while (Date.now() < deadline) {
      const status = await client.tool(workspace, 'circuit_status', {
        run_id: runId,
        wait_ms: 250,
      });
      if (status.state === 'waiting_for_input') {
        waiting = status;
        break;
      }
      if (typeof status.state === 'string' && TERMINAL_STATES.has(status.state)) {
        throw new Error(`Build stopped before its checkpoint: ${JSON.stringify(status)}`);
      }
    }
    expect(waiting).toMatchObject({
      checkpoint: {
        step_id: 'frame-step',
        prompt: 'Confirm the Build brief before implementation starts.',
        request_path: 'reports/checkpoints/frame-step-request.json',
        allowed_choices: ['continue'],
        choices: [
          {
            id: 'continue',
            label: 'Continue',
            description: 'Proceed on the recommended executable route.',
          },
        ],
        review_material: [
          {
            path: 'reports/build/brief.json',
            content: {
              objective: 'Prove the installed MCP checkpoint and resume lifecycle.',
              scope: 'Make the smallest safe change that satisfies the requested goal.',
            },
          },
        ],
      },
    });
    const waitingEvents = isRecord(waiting?.progress) ? waiting.progress.events : undefined;
    expect(waitingEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'relay.started' })]),
    );
    await expect(readFile(fixture.modelTurnMarker, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await client.tool(workspace, 'circuit_resume', {
      run_id: runId,
      checkpoint_choice: 'continue',
    });

    const terminalDeadline = Date.now() + 20_000;
    let terminal: JsonRecord | undefined;
    while (Date.now() < terminalDeadline) {
      const status = await client.tool(workspace, 'circuit_status', {
        run_id: runId,
        wait_ms: 250,
      });
      if (typeof status.state === 'string' && TERMINAL_STATES.has(status.state)) {
        terminal = status;
        break;
      }
    }
    if (terminal === undefined) throw new Error('Build did not stop after the blocked model turn.');
    expect(terminal?.state).not.toBe('complete');
    const modelTurnArgv = JSON.parse(await readFile(fixture.modelTurnMarker, 'utf8')) as unknown;
    if (!Array.isArray(modelTurnArgv) || !modelTurnArgv.every((arg) => typeof arg === 'string')) {
      throw new Error(`Pinned Codex received invalid argv: ${JSON.stringify(modelTurnArgv)}`);
    }
    expect(modelTurnArgv[0], JSON.stringify(terminal)).toBe('exec');
    expect(modelTurnArgv[modelTurnArgv.indexOf('-s') + 1]).toBe('workspace-write');
    expect(modelTurnArgv[modelTurnArgv.indexOf('--cd') + 1]).toBe(workspace);

    const configValues: string[] = [];
    for (let index = 0; index < modelTurnArgv.length; index += 1) {
      if (modelTurnArgv[index] !== '-c') continue;
      const value = modelTurnArgv[index + 1];
      if (typeof value !== 'string') throw new Error('Pinned Codex received a bare -c argument.');
      configValues.push(value);
      index += 1;
    }
    expect(configValues.filter((value) => value.startsWith('web_search='))).toEqual([
      'web_search="disabled"',
    ]);
    const sealedConfigValues = [
      'approval_policy="never"',
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.writable_roots=[]',
      'shell_environment_policy.inherit="core"',
      'shell_environment_policy.ignore_default_excludes=false',
      'features.plugins=false',
      'features.remote_plugin=false',
      'features.plugin_sharing=false',
      'features.skill_mcp_dependency_install=false',
      'features.multi_agent=false',
      `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
    ];
    const sealedConfigKeys = new Set(sealedConfigValues.map((value) => value.split('=', 1)[0]));
    expect(
      configValues.filter((value) => sealedConfigKeys.has(value.split('=', 1)[0] ?? '')),
    ).toEqual(sealedConfigValues);
    await expect(readFile(pathCodexMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const trace = (
      await readFile(path.join(fixture.stateRoot, 'runs', runId, 'trace.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JsonRecord);
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'checkpoint.resolved',
        step_id: 'frame-step',
        selection: 'continue',
      }),
    );
  }, 30_000);
});

describe.runIf(LIVE_ALL_FLOWS)('live installed Circuit MCP package smoke', () => {
  it.each(PUBLIC_FLOWS)(
    'completes real %s through the pinned Codex host',
    async (flow) => {
      const codexExecutable = process.env.CIRCUIT_MCP_CODEX_EXECUTABLE;
      const codexHome = process.env.CODEX_HOME;
      if (codexExecutable === undefined || !path.isAbsolute(codexExecutable)) {
        throw new Error('Set CIRCUIT_MCP_CODEX_EXECUTABLE to the absolute Codex executable path.');
      }
      if (codexHome === undefined || !path.isAbsolute(codexHome)) {
        throw new Error('Set CODEX_HOME to the absolute authenticated Codex home.');
      }

      const root = await temporaryDirectory(`circuit-mcp-live-installed-${flow}`);
      const installed = await installExperimentPackage(root, 'real');
      const fixture: SmokeFixture = {
        ...installed,
        root,
        stateRoot: path.join(root, 'state'),
        codexHome,
        codexExecutable,
        modelTurnMarker: path.join(root, 'model-turn-attempted'),
      };
      await mkdir(fixture.stateRoot);
      const client = startClient(fixture);
      await client.initialize();
      const workspace = await createGitWorkspace(root, flow);
      const terminal = await runToTerminal(client, workspace, flow, liveGoal(flow), 15 * 60_000);
      expect(terminal.status, `${flow}: ${JSON.stringify(terminal.status)}`).toMatchObject({
        state: 'complete',
        flow,
        result: { flow, report: expect.any(Object) },
      });
    },
    20 * 60_000,
  );
});

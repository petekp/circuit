import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pinMcpRuntimeAssets } from '../../src/hosts/codex-mcp/asset-pins.js';
import type { LifecycleExecutableIdentity } from '../../src/hosts/codex-mcp/lifecycle-types.js';
import { ProcessSupervisorLauncher } from '../../src/hosts/codex-mcp/supervisor-launcher.js';
import { readSupervisorProgress } from '../../src/hosts/codex-mcp/supervisor-progress.js';
import {
  ExitJournalV1,
  RuntimeJournalV1,
  SupervisorAuthorizationV1,
  decodeSupervisorMessage,
  encodeSupervisorMessage,
} from '../../src/hosts/codex-mcp/supervisor-protocol.js';
import { BoundedLineReader } from '../../src/hosts/codex-mcp/supervisor-runtime.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

async function waitFor<T>(read: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for supervisor evidence');
}

function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function processGroupAbsent(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function makeFixture(): Promise<{
  readonly root: string;
  readonly control: string;
  readonly supervisor: string;
  readonly worker: string;
  readonly flow: string;
  readonly launcher: ProcessSupervisorLauncher;
  readonly digest: string;
  readonly pins: Awaited<ReturnType<typeof pinMcpRuntimeAssets>>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-supervisor-')));
  roots.push(root);
  const control = join(root, 'control');
  await mkdir(control, { mode: 0o700 });
  await chmod(control, 0o700);
  const supervisor = join(root, 'supervisor.mjs');
  await build({
    stdin: {
      contents: `import { runSupervisor } from ${JSON.stringify(resolve('src/hosts/codex-mcp/supervisor-runtime.ts'))};
void runSupervisor({
  observeProcess: async (pid, processGroupId, birthToken) => ({
    pid,
    process_group_id: processGroupId,
    birth_token: birthToken,
    started_at: new Date().toISOString(),
  }),
}).catch((error) => {
  process.stderr.write(\`Circuit MCP supervisor stopped: \${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
});`,
      resolveDir: process.cwd(),
      sourcefile: 'test-supervisor-entrypoint.ts',
      loader: 'ts',
    },
    outfile: supervisor,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.18',
    sourcemap: false,
  });
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const launch = JSON.parse(readFileSync(3, 'utf8'));
writeFileSync(new URL('./worker-observed.json', import.meta.url), JSON.stringify({
  launch,
  circuitEnv: process.env.CIRCUIT_SECRET,
  nodeOptions: process.env.NODE_OPTIONS,
  codexHome: process.env.CODEX_HOME,
  apiKey: process.env.OPENAI_API_KEY,
  httpsProxy: process.env.HTTPS_PROXY,
  certificate: process.env.SSL_CERT_FILE,
}));
process.stderr.write(JSON.stringify({
  schema_version: 1,
  type: 'run.started',
  run_id: '${RUN_ID}',
  flow_id: 'review',
  recorded_at: new Date().toISOString(),
  label: 'Review started',
  display: { text: 'Circuit started Review.', importance: 'major', tone: 'info' },
  run_folder: '/tmp/workspace/.circuit/runs/${RUN_ID}',
}) + '\\n');
if (launch.mode === 'overflow') {
  process.on('SIGTERM', () => {});
  process.stdout.write('x'.repeat(16_384));
  setInterval(() => {}, 1_000);
} else if (launch.mode === 'background') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(new URL('./background.pid', import.meta.url), String(child.pid));
  child.unref();
} else {
  process.exitCode = launch.exit_code ?? 0;
}
`,
    { mode: 0o600 },
  );
  const codex = join(root, 'codex');
  await writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(codex, 0o700);
  const gitHelper = join(root, 'git-helper.mjs');
  const flow = join(root, 'review-flow.json');
  await writeFile(gitHelper, 'export {};\n', { mode: 0o600 });
  await writeFile(flow, '{}\n', { mode: 0o600 });
  const pins = await pinMcpRuntimeAssets({
    node: process.execPath,
    codex,
    plugin_runtime: worker,
    git_helper: gitHelper,
    packaged_flows: [{ id: 'review', path: flow }],
  });
  const nodePin = pins.assets.find((asset) => asset.role === 'node');
  if (nodePin === undefined) throw new Error('missing Node pin');
  const nodeIdentity: LifecycleExecutableIdentity = {
    real_path: nodePin.real_path,
    device: nodePin.device,
    inode: nodePin.inode,
    sha256: nodePin.sha256,
  };
  const supervisorSha256 = createHash('sha256')
    .update(await readFile(supervisor))
    .digest('hex');
  return {
    root,
    control,
    supervisor,
    worker,
    flow,
    digest: pins.digest_sha256,
    pins,
    launcher: new ProcessSupervisorLauncher({
      nodeExecutable: nodePin.real_path,
      nodeIdentity,
      supervisorEntrypoint: supervisor,
      verifySupervisorEntrypoint: async () => {
        const observed = createHash('sha256')
          .update(await readFile(supervisor))
          .digest('hex');
        if (observed !== supervisorSha256) throw new Error('supervisor asset changed');
      },
      runtimeAssets: pins,
      environment: {
        ...process.env,
        CIRCUIT_SECRET: 'must-not-reach-worker',
        NODE_OPTIONS: '--inspect',
        CODEX_HOME: '/tmp/test-codex-home',
        OPENAI_API_KEY: 'test-api-key',
        HTTPS_PROXY: 'https://proxy.invalid',
        SSL_CERT_FILE: '/tmp/test-ca.pem',
      },
      helloTimeoutMs: 5_000,
      workerStartMs: 5_000,
      terminateMs: 1_000,
      killMs: 1_000,
      stdoutBytes: 1_024,
      stderrBytes: 1_024,
    }),
  };
}

function readJournal<T>(path: string, parse: (value: unknown) => T): T | undefined {
  if (!existsSync(path)) return undefined;
  return parse(JSON.parse(readFileSync(path, 'utf8')));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Codex MCP supervisor protocol', () => {
  it('can wait for parent-owned authorization without an autonomous timeout', async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const pending = new BoundedLineReader(stream).read();
      await vi.advanceTimersByTimeAsync(60_000);
      stream.end('authorized\n');
      await expect(pending).resolves.toEqual(Buffer.from('authorized'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unknown authorization fields and oversized messages', () => {
    const valid = {
      schema_version: 1,
      kind: 'launch_authorization',
      authorization_token: 'a'.repeat(64),
      run_id: RUN_ID,
      generation: 1,
      control_directory: '/tmp/control',
      runtime_assets: { schema_version: 1, digest_sha256: 'b'.repeat(64), assets: [] },
      worker: {
        node_executable: '/usr/bin/node',
        entrypoint: '/tmp/worker.mjs',
        launch_payload: {},
      },
      limits: {
        worker_start_ms: 1_000,
        terminate_ms: 1_000,
        kill_ms: 1_000,
        stdout_bytes: 1_024,
        stderr_bytes: 1_024,
      },
    };
    expect(
      SupervisorAuthorizationV1.safeParse({ ...valid, environment: { TOKEN: 'x' } }).success,
    ).toBe(false);
    expect(() => encodeSupervisorMessage({ value: 'x'.repeat(1_048_576) })).toThrow(
      /protocol limit/,
    );
    expect(() => decodeSupervisorMessage(Buffer.from('{bad'), SupervisorAuthorizationV1)).toThrow(
      /not valid JSON/,
    );
  });

  it('launches through inherited pipes and writes durable runtime and exit evidence', async () => {
    const fixture = await makeFixture();
    const session = await fixture.launcher.begin({
      run_id: RUN_ID,
      generation: 1,
      control_directory: fixture.control,
    });
    const runtime = await session.authorize({
      worker: {
        worker_entrypoint: fixture.worker,
        launch_payload: {
          authorization: session.authorization_token,
          asset_digest_sha256: fixture.digest,
          runtime_assets: fixture.pins,
          exit_code: 0,
        },
      },
    });
    expect(runtime.pid).toBe(runtime.process_group_id);
    expect(runtime.started_at).toBeTruthy();
    expect(runtime.executable.sha256).toMatch(/^[a-f0-9]{64}$/);

    const runtimePath = join(fixture.control, 'launch-1-runtime.json');
    const exitPath = join(fixture.control, 'launch-1-exit.json');
    const runtimeJournal = await waitFor(() =>
      readJournal(runtimePath, (value) => RuntimeJournalV1.parse(value)),
    );
    const exitJournal = await waitFor(() =>
      readJournal(exitPath, (value) => ExitJournalV1.parse(value)),
    );
    expect(runtimeJournal.runtime.pid).toBe(runtime.pid);
    expect(exitJournal).toMatchObject({ exit_code: 0, process_group_cleanup: 'confirmed' });
    expect(
      readSupervisorProgress({
        control_directory: fixture.control,
        run_id: RUN_ID,
        generations: 1,
      }),
    ).toMatchObject([{ event: { type: 'run.started', flow_id: 'review' } }]);
    expect(readFileSync(runtimePath, 'utf8')).not.toContain(session.authorization_token);
    expect(readFileSync(exitPath, 'utf8')).not.toContain(session.authorization_token);

    const observed = JSON.parse(
      await readFile(join(fixture.root, 'worker-observed.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(observed.circuitEnv).toBeUndefined();
    expect(observed.nodeOptions).toBeUndefined();
    expect(observed).toMatchObject({
      codexHome: '/tmp/test-codex-home',
      apiKey: 'test-api-key',
      httpsProxy: 'https://proxy.invalid',
      certificate: '/tmp/test-ca.pem',
    });
    expect((observed.launch as Record<string, unknown>).authorization).toBe(
      session.authorization_token,
    );
    expect(readFileSync(runtimePath, 'utf8')).not.toContain('test-api-key');
    expect(readFileSync(exitPath, 'utf8')).not.toContain('test-api-key');
  });

  it('revalidates sealed assets in the supervisor before worker spawn', async () => {
    const fixture = await makeFixture();
    const session = await fixture.launcher.begin({
      run_id: RUN_ID,
      generation: 1,
      control_directory: fixture.control,
    });
    writeFileSync(fixture.flow, '{"changed":true}\n', { flag: 'w' });
    await expect(
      session.authorize({
        worker: {
          worker_entrypoint: fixture.worker,
          launch_payload: {
            authorization: session.authorization_token,
            asset_digest_sha256: fixture.digest,
            runtime_assets: fixture.pins,
          },
        },
      }),
    ).rejects.toThrow(/asset changed/i);
    await waitFor(() =>
      processGroupAbsent(session.supervisor.process_group_id) ? true : undefined,
    );
    expect(existsSync(join(fixture.control, 'launch-1-runtime.json'))).toBe(false);
    expect(existsSync(join(fixture.root, 'worker-observed.json'))).toBe(false);
  });

  it('refuses a replaced supervisor before it is spawned', async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.supervisor, 'throw new Error("replaced");\n');
    await expect(
      fixture.launcher.begin({
        run_id: RUN_ID,
        generation: 1,
        control_directory: fixture.control,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/supervisor asset changed/i),
      cleanup_confirmed: true,
    });
  });

  it('rejects worker payloads that omit or replace the sealed asset pins', async () => {
    const fixture = await makeFixture();
    const session = await fixture.launcher.begin({
      run_id: RUN_ID,
      generation: 1,
      control_directory: fixture.control,
    });
    await expect(
      session.authorize({
        worker: {
          worker_entrypoint: fixture.worker,
          launch_payload: {
            authorization: session.authorization_token,
            asset_digest_sha256: fixture.digest,
            runtime_assets: { ...fixture.pins, assets: [] },
          },
        },
      }),
    ).rejects.toThrow(/does not contain the sealed runtime asset pins/i);
    expect(existsSync(join(fixture.control, 'launch-1-runtime.json'))).toBe(false);
    expect(existsSync(join(fixture.root, 'worker-observed.json'))).toBe(false);
  });

  it('kills output-flooding workers and records the enforced limit', async () => {
    const fixture = await makeFixture();
    const session = await fixture.launcher.begin({
      run_id: RUN_ID,
      generation: 1,
      control_directory: fixture.control,
    });
    await session.authorize({
      worker: {
        worker_entrypoint: fixture.worker,
        launch_payload: {
          authorization: session.authorization_token,
          asset_digest_sha256: fixture.digest,
          runtime_assets: fixture.pins,
          mode: 'overflow',
        },
      },
    });
    const exitJournal = await waitFor(() =>
      readJournal(join(fixture.control, 'launch-1-exit.json'), (value) =>
        ExitJournalV1.parse(value),
      ),
    );
    expect(exitJournal.output_limit_exceeded).toBe('stdout');
    expect(exitJournal.process_group_cleanup).toBe('confirmed');
  });

  it('observes cleanup of background children in the worker process group', async () => {
    const fixture = await makeFixture();
    const session = await fixture.launcher.begin({
      run_id: RUN_ID,
      generation: 1,
      control_directory: fixture.control,
    });
    await session.authorize({
      worker: {
        worker_entrypoint: fixture.worker,
        launch_payload: {
          authorization: session.authorization_token,
          asset_digest_sha256: fixture.digest,
          runtime_assets: fixture.pins,
          mode: 'background',
        },
      },
    });
    const childPid = await waitFor(() => {
      const path = join(fixture.root, 'background.pid');
      return existsSync(path) ? Number.parseInt(readFileSync(path, 'utf8'), 10) : undefined;
    });
    const exitJournal = await waitFor(() =>
      readJournal(join(fixture.control, 'launch-1-exit.json'), (value) =>
        ExitJournalV1.parse(value),
      ),
    );
    expect(exitJournal.process_group_cleanup).toBe('confirmed');
    await waitFor(() => (processAbsent(childPid) ? true : undefined));
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RUNTIME_STDERR_LIMIT_BYTES,
  RUNTIME_STDOUT_LIMIT_BYTES,
  parseRuntimeLaunchRequest,
  readRuntimeChildRecord,
  runRuntimeSupervisor,
  runtimeSupervisorPaths,
  splitRuntimeLaunchEnvironment,
  writeRuntimeLaunchRequest,
} from './runtime-supervisor.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/runtime-supervisor-fixture.mjs');
const PARENT_FIXTURE = path.join(import.meta.dirname, 'fixtures/runtime-supervisor-parent.mjs');
const SUPERVISOR = path.join(import.meta.dirname, 'runtime-supervisor.mjs');
const cleanupRoots: string[] = [];

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('Timed out waiting for the runtime supervisor fixture.');
}

async function harness(runId = 'run-1') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'circuit-runtime-supervisor-'));
  cleanupRoots.push(temporary);
  const root = await realpath(temporary);
  const stateRoot = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const paths = runtimeSupervisorPaths(stateRoot, runId);
  await mkdir(paths.artifactRoot, { recursive: true });
  await mkdir(path.join(stateRoot, 'runs'), { recursive: true });
  await mkdir(workspace);
  await writeFile(paths.stdoutPath, '');
  await writeFile(paths.stderrPath, '');
  return { root, stateRoot, workspace: await realpath(workspace), paths, runId };
}

async function createRequest(
  fixture: Awaited<ReturnType<typeof harness>>,
  argv: string[],
  timeoutMs = 10_000,
) {
  return await writeRuntimeLaunchRequest({
    runId: fixture.runId,
    stateRoot: fixture.stateRoot,
    runtimePath: FIXTURE,
    cwd: fixture.workspace,
    argv,
    env: {
      CIRCUIT_MCP_SEALED: '1',
      CIRCUIT_MCP_CANCEL_FILE: fixture.paths.cancelPath,
      CIRCUIT_RUNTIME_SOURCE: 'mcp-spike',
    },
    timeoutMs,
  });
}

function processIsAbsent(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Circuit MCP runtime supervisor spike', () => {
  it('accepts exactly one absolute request path on its process boundary', () => {
    for (const argv of [[], ['relative-request.json'], ['/tmp/one.json', '/tmp/two.json']]) {
      const result = spawnSync(process.execPath, [SUPERVISOR, ...argv], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exactly one absolute launch-request JSON path');
    }
  });

  it('writes and parses only the fixed, strict launch-request shape', async () => {
    const fixture = await harness();
    const written = await createRequest(fixture, ['complete', '10']);
    expect(written.requestPath).toBe(fixture.paths.requestPath);
    await expect(parseRuntimeLaunchRequest(written.requestPath)).resolves.toMatchObject({
      schema: 'circuit.mcp-runtime-launch@v1',
      run_id: fixture.runId,
      state_root: fixture.stateRoot,
      runtime_path: await realpath(FIXTURE),
      paths: {
        stdout: fixture.paths.stdoutPath,
        stderr: fixture.paths.stderrPath,
        exit: fixture.paths.exitPath,
        cancel: fixture.paths.cancelPath,
      },
    });

    const request = JSON.parse(await readFile(written.requestPath, 'utf8'));
    request.command = '/tmp/model-controlled-command';
    await writeFile(written.requestPath, JSON.stringify(request));
    await expect(parseRuntimeLaunchRequest(written.requestPath)).rejects.toThrow(
      'unsupported field: command',
    );
  });

  it('keeps connector credentials out of the durable request but passes them to the child', async () => {
    const fixture = await harness('transient-secret');
    const secret = 'must-stay-out-of-launch-request';
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const environment = splitRuntimeLaunchEnvironment({
        CIRCUIT_MCP_SEALED: '1',
        CIRCUIT_MCP_CANCEL_FILE: fixture.paths.cancelPath,
        CIRCUIT_RUNTIME_SOURCE: 'mcp-spike',
        OPENAI_API_KEY: secret,
      });
      expect(environment.transient).toEqual({ OPENAI_API_KEY: secret });
      const written = await writeRuntimeLaunchRequest({
        runId: fixture.runId,
        stateRoot: fixture.stateRoot,
        runtimePath: FIXTURE,
        cwd: fixture.workspace,
        argv: ['report-api-key'],
        env: environment.durable,
        timeoutMs: 10_000,
      });
      expect(await readFile(written.requestPath, 'utf8')).not.toContain(secret);
      const exit = await runRuntimeSupervisor(written.requestPath);
      expect(exit.code).toBe(0);
      expect(await readFile(fixture.paths.stdoutPath, 'utf8')).toContain(secret);

      const rejectedFixture = await harness('transient-secret-reject');
      await expect(
        writeRuntimeLaunchRequest({
          runId: rejectedFixture.runId,
          stateRoot: rejectedFixture.stateRoot,
          runtimePath: FIXTURE,
          cwd: rejectedFixture.workspace,
          argv: ['complete'],
          env: {
            CIRCUIT_MCP_SEALED: '1',
            CIRCUIT_MCP_CANCEL_FILE: rejectedFixture.paths.cancelPath,
            OPENAI_API_KEY: secret,
          },
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow(/transient.*must not be persisted/i);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('rejects path escapes, symlinked runtimes, noncanonical cwd, and injected Node options', async () => {
    const fixture = await harness('strict');
    const linkedRuntime = path.join(fixture.root, 'linked-runtime.mjs');
    await symlink(FIXTURE, linkedRuntime);
    await expect(
      writeRuntimeLaunchRequest({
        runId: fixture.runId,
        stateRoot: fixture.stateRoot,
        runtimePath: linkedRuntime,
        cwd: fixture.workspace,
        argv: ['complete'],
        env: {
          CIRCUIT_MCP_SEALED: '1',
          CIRCUIT_MCP_CANCEL_FILE: fixture.paths.cancelPath,
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow('runtime_path must be a regular, non-symbolic-link file');

    await expect(
      writeRuntimeLaunchRequest({
        runId: fixture.runId,
        stateRoot: fixture.stateRoot,
        runtimePath: FIXTURE,
        cwd: `${fixture.workspace}/..`,
        argv: ['complete'],
        env: {
          CIRCUIT_MCP_SEALED: '1',
          CIRCUIT_MCP_CANCEL_FILE: fixture.paths.cancelPath,
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow('cwd must be an absolute, normalized path');

    await expect(
      writeRuntimeLaunchRequest({
        runId: fixture.runId,
        stateRoot: fixture.stateRoot,
        runtimePath: FIXTURE,
        cwd: fixture.workspace,
        argv: ['complete'],
        env: {
          CIRCUIT_MCP_SEALED: '1',
          CIRCUIT_MCP_CANCEL_FILE: fixture.paths.cancelPath,
          NODE_OPTIONS: '--require=/tmp/injected.cjs',
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow('NODE_OPTIONS is not allowed');

    const requestPathOutsideFixedArea = path.join(fixture.stateRoot, 'launch-request.json');
    await writeFile(requestPathOutsideFixedArea, '{}');
    await expect(parseRuntimeLaunchRequest(requestPathOutsideFixedArea)).rejects.toThrow(
      'fixed artifact location',
    );
  });

  it('sends stdout and stderr directly to fixed files and records an ordinary exit atomically', async () => {
    const fixture = await harness('ordinary');
    const { requestPath } = await createRequest(fixture, ['complete', '20']);
    const exit = await runRuntimeSupervisor(requestPath);
    expect(exit.cleanup.confirmed, JSON.stringify(exit.cleanup)).toBe(true);
    expect(exit).toMatchObject({
      schema: 'circuit.mcp-runtime-exit@v1',
      run_id: fixture.runId,
      reason: 'exit',
      code: 0,
      signal: null,
      cleanup: { required: false, confirmed: true },
    });
    expect(await readFile(fixture.paths.stdoutPath, 'utf8')).toContain(
      'runtime-supervisor-fixture',
    );
    expect(await readFile(fixture.paths.stderrPath, 'utf8')).toContain('fixture.progress');
    await expect(readFile(fixture.paths.exitPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(exit)}\n`,
    );
    expect(existsSync(requestPath)).toBe(false);
  });

  it('persists the runtime child identity before the child exits', async () => {
    const fixture = await harness('child-identity');
    const { requestPath } = await createRequest(fixture, ['hang'], 5_000);
    const running = runRuntimeSupervisor(requestPath);
    const child = await waitFor(
      async () => {
        if (!existsSync(fixture.paths.childPath)) return undefined;
        return await readRuntimeChildRecord(fixture.stateRoot, fixture.runId);
      },
      (value) => value !== undefined,
    );

    expect(existsSync(fixture.paths.exitPath)).toBe(false);
    expect(child).toMatchObject({
      schema: 'circuit.mcp-runtime-child@v1',
      run_id: fixture.runId,
      child_pid: expect.any(Number),
      process_group_id: expect.any(Number),
      supervisor_pid: process.pid,
      launch_id: expect.any(String),
      started_at: expect.any(String),
    });
    expect(child?.process_group_id).toBe(child?.child_pid);

    await mkdir(path.dirname(fixture.paths.cancelPath), { recursive: true });
    await writeFile(fixture.paths.cancelPath, 'cancel\n', { flag: 'wx' });
    await running;
    await expect(readRuntimeChildRecord(fixture.stateRoot, fixture.runId)).resolves.toEqual(child);

    await unlink(fixture.paths.childPath);
    await symlink(fixture.paths.exitPath, fixture.paths.childPath);
    await expect(readRuntimeChildRecord(fixture.stateRoot, fixture.runId)).rejects.toThrow(
      'must not be a symbolic link',
    );
  });

  it('preserves ENOENT when the state root disappears during shutdown', async () => {
    const fixture = await harness('missing-state-root');
    await rm(fixture.stateRoot, { recursive: true, force: true });

    await expect(readRuntimeChildRecord(fixture.stateRoot, fixture.runId)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['stdout', RUNTIME_STDOUT_LIMIT_BYTES],
    ['stderr', RUNTIME_STDERR_LIMIT_BYTES],
  ] as const)(
    'caps %s without a status poll, stops the tree, and records confirmed cleanup',
    async (stream, limit) => {
      const fixture = await harness(`limit-${stream}`);
      const { requestPath } = await createRequest(fixture, [`flood-${stream}`], 5_000);
      const exit = await runRuntimeSupervisor(requestPath);
      const stdoutBytes = Buffer.byteLength(await readFile(fixture.paths.stdoutPath));
      const stderrBytes = Buffer.byteLength(await readFile(fixture.paths.stderrPath));

      expect(exit.cleanup.confirmed, JSON.stringify(exit.cleanup)).toBe(true);
      expect(exit).toMatchObject({
        reason: 'output_limit',
        cleanup: { required: true, confirmed: true },
        output: {
          stdout_limit_bytes: RUNTIME_STDOUT_LIMIT_BYTES,
          stderr_limit_bytes: RUNTIME_STDERR_LIMIT_BYTES,
          limit_exceeded: stream,
        },
      });
      expect(stdoutBytes).toBeLessThanOrEqual(RUNTIME_STDOUT_LIMIT_BYTES);
      expect(stderrBytes).toBeLessThanOrEqual(RUNTIME_STDERR_LIMIT_BYTES);
      expect(stream === 'stdout' ? stdoutBytes : stderrBytes).toBe(limit);
      expect(await readFile(fixture.paths.cancelPath, 'utf8')).toBe('output_limit\n');
    },
  );

  it('gives cancellation a cooperative grace, then confirms observed process-tree cleanup', async () => {
    const fixture = await harness('cancel');
    const { requestPath } = await createRequest(fixture, ['hang-tree'], 5_000);
    const running = runRuntimeSupervisor(requestPath);
    const identities = await waitFor(
      async () => {
        const text = await readFile(fixture.paths.stdoutPath, 'utf8');
        try {
          return JSON.parse(text.trim()) as { root_pid: number; child_pid: number };
        } catch {
          return undefined;
        }
      },
      (value) => value !== undefined,
    );
    await mkdir(path.dirname(fixture.paths.cancelPath), { recursive: true });
    await writeFile(fixture.paths.cancelPath, 'cancel\n', { flag: 'wx' });
    const exit = await running;
    expect(exit.cleanup.confirmed, JSON.stringify(exit.cleanup)).toBe(true);
    expect(exit).toMatchObject({
      reason: 'cancel',
      child_pid: identities?.root_pid,
      cleanup: { required: true },
    });
    expect(processIsAbsent(identities?.root_pid ?? 0)).toBe(true);
    expect(processIsAbsent(identities?.child_pid ?? 0), JSON.stringify(exit.cleanup)).toBe(true);
  });

  it('cleans up a background child even when the runtime exits cooperatively', async () => {
    const fixture = await harness('cooperative-orphan');
    const { requestPath } = await createRequest(fixture, ['cooperative-orphan'], 5_000);
    const running = runRuntimeSupervisor(requestPath);
    const identities = await waitFor(
      async () => {
        const text = await readFile(fixture.paths.stdoutPath, 'utf8');
        try {
          return JSON.parse(text.trim()) as { root_pid: number; child_pid: number };
        } catch {
          return undefined;
        }
      },
      (value) => value !== undefined,
    );
    await mkdir(path.dirname(fixture.paths.cancelPath), { recursive: true });
    await writeFile(fixture.paths.cancelPath, 'cancel\n', { flag: 'wx' });

    const exit = await running;
    expect(exit).toMatchObject({
      reason: 'cancel',
      code: 0,
      cleanup: { required: true, confirmed: true },
    });
    expect(processIsAbsent(identities?.root_pid ?? 0)).toBe(true);
    expect(processIsAbsent(identities?.child_pid ?? 0), JSON.stringify(exit.cleanup)).toBe(true);
  });

  it('treats a detached child left after an ordinary exit as a failed run and removes it', async () => {
    const fixture = await harness('ordinary-orphan');
    const { requestPath } = await createRequest(fixture, ['orphan-on-exit'], 5_000);
    const exit = await runRuntimeSupervisor(requestPath);
    const identities = JSON.parse(await readFile(fixture.paths.stdoutPath, 'utf8')) as {
      root_pid: number;
      child_pid: number;
    };

    expect(exit).toMatchObject({
      reason: 'exit',
      code: 1,
      cleanup: { required: true, confirmed: true },
      error: expect.stringContaining('child process was still running'),
    });
    expect(processIsAbsent(identities.root_pid)).toBe(true);
    expect(processIsAbsent(identities.child_pid)).toBe(true);
  });

  it('enforces the hard timeout, writes the cooperative marker, and records timeout', async () => {
    const fixture = await harness('timeout');
    const { requestPath } = await createRequest(fixture, ['hang'], 40);
    const exit = await runRuntimeSupervisor(requestPath);
    expect(exit.cleanup.confirmed, JSON.stringify(exit.cleanup)).toBe(true);
    expect(exit).toMatchObject({
      reason: 'timeout',
      code: null,
      cleanup: { required: true },
    });
    expect(await readFile(fixture.paths.cancelPath, 'utf8')).toBe('timeout\n');
  });

  it('keeps supervising after the process that launched it has exited', async () => {
    const fixture = await harness('survives');
    const { requestPath } = await createRequest(fixture, ['complete', '150']);
    const parent = spawnSync(process.execPath, [PARENT_FIXTURE, SUPERVISOR, requestPath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(parent.status, parent.stderr).toBe(0);
    const exit = await waitFor(
      async () => {
        if (!existsSync(fixture.paths.exitPath)) return undefined;
        return JSON.parse(await readFile(fixture.paths.exitPath, 'utf8'));
      },
      (value) => value?.reason === 'exit',
    );
    expect(exit).toMatchObject({ reason: 'exit', code: 0, cleanup: { confirmed: true } });
  });

  it.each(['claim-only', 'exit-only', 'neither'] as const)(
    'repairs the stale %s relaunch combination when the old supervisor is absent',
    async (combination) => {
      const fixture = await harness(`repair-${combination}`);
      const first = await createRequest(fixture, ['complete', '10']);
      await runRuntimeSupervisor(first.requestPath);

      if (combination !== 'exit-only') {
        await writeFile(
          fixture.paths.claimPath,
          `${JSON.stringify({
            schema: 'circuit.mcp-runtime-claim@v1',
            supervisor_pid: 2_147_483_647,
            started_at: new Date(0).toISOString(),
          })}\n`,
        );
      } else {
        await unlink(fixture.paths.claimPath);
      }
      if (combination !== 'exit-only') await unlink(fixture.paths.exitPath);
      if (combination === 'neither') await unlink(fixture.paths.claimPath);

      const next = await createRequest(fixture, ['complete', '20']);
      expect(next.argv).toEqual(['complete', '20']);
      expect(existsSync(fixture.paths.claimPath)).toBe(false);
      expect(existsSync(fixture.paths.exitPath)).toBe(false);
      expect(existsSync(fixture.paths.childPath)).toBe(false);
    },
  );

  it('does not repair a relaunch while the claimed supervisor may still be alive', async () => {
    const fixture = await harness('live-claim');
    await createRequest(fixture, ['complete', '10']);
    await writeFile(
      fixture.paths.claimPath,
      `${JSON.stringify({
        schema: 'circuit.mcp-runtime-claim@v1',
        supervisor_pid: process.pid,
        started_at: new Date().toISOString(),
      })}\n`,
    );

    await expect(createRequest(fixture, ['complete', '20'])).rejects.toThrow(
      'previous supervisor may still be running',
    );
  });
});

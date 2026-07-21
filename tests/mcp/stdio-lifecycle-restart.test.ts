import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CircuitListResponseV1,
  CircuitResumeResponseV1,
  CircuitStartResponseV1,
  CircuitStatusResponseV1,
} from '../../src/hosts/codex-mcp/contracts.js';
import { McpStateStore, trustedWorkspaceIdentity } from '../../src/hosts/codex-mcp/state-store.js';

const FIRST_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_RUN_ID = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

interface StdioFixtureServer {
  readonly client: Client;
  readonly instanceId: string;
  readonly pid: number;
  readonly stderr: () => string;
  readonly close: () => Promise<void>;
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`MCP fixture process ${pid} did not exit`);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForAnyPath(paths: readonly string[]): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const path of paths) {
      try {
        await access(path);
        return path;
      } catch {
        // Keep waiting for one process to publish its side of the race.
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Timed out waiting for one of: ${paths.join(', ')}`);
}

async function startFixtureServer(input: {
  readonly bundle: string;
  readonly stateRoot: string;
  readonly workspace: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly startBarrier?: string;
}): Promise<StdioFixtureServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      input.bundle,
      '--state-root',
      input.stateRoot,
      '--workspace',
      input.workspace,
      '--instance-id',
      input.instanceId,
      '--run-id',
      input.runId,
      ...(input.startBarrier === undefined ? [] : ['--start-barrier', input.startBarrier]),
    ],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: `${input.instanceId}-client`, version: '1.0.0' });
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error('The stdio fixture did not expose its server PID.');
  let closed = false;
  return {
    client,
    instanceId: input.instanceId,
    pid,
    stderr: () => stderr,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await waitForPidExit(pid);
    },
  };
}

function structuredContent(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  if (result.structuredContent === undefined) {
    throw new Error(`MCP response had no structured content: ${JSON.stringify(result)}`);
  }
  return result.structuredContent;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Circuit MCP stdio lifecycle restart', () => {
  it('allows exactly one same-instant start across two stdio server processes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-stdio-race-')));
    roots.push(root);
    const stateRoot = join(root, 'state');
    const workspace = join(root, 'workspace');
    const barrier = join(root, 'start-barrier');
    const bundle = join(root, 'stdio-lifecycle-server.mjs');
    await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(barrier, { mode: 0o700 })]);
    await build({
      entryPoints: [resolve('tests/mcp/fixtures/stdio-lifecycle-server.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.18',
      sourcemap: false,
    });

    const servers = await Promise.all([
      startFixtureServer({
        bundle,
        stateRoot,
        workspace,
        instanceId: 'server-a',
        runId: FIRST_RUN_ID,
        startBarrier: barrier,
      }),
      startFixtureServer({
        bundle,
        stateRoot,
        workspace,
        instanceId: 'server-b',
        runId: SECOND_RUN_ID,
        startBarrier: barrier,
      }),
    ]);
    expect(servers[0]?.pid).not.toBe(servers[1]?.pid);

    try {
      const responses = Promise.all(
        servers.map(async (server) =>
          CircuitStartResponseV1.parse(
            structuredContent(
              await server.client.callTool({
                name: 'circuit_start',
                arguments: {
                  flow: 'prototype',
                  goal: `Race a Prototype start from ${server.instanceId}.`,
                  web_search: 'off',
                },
              }),
            ),
          ),
        ),
      );
      await Promise.all([
        waitForPath(join(barrier, 'ready-server-a')),
        waitForPath(join(barrier, 'ready-server-b')),
      ]);
      await writeFile(join(barrier, 'release-start'), 'go\n', { mode: 0o600 });
      const heldPath = await waitForAnyPath([
        join(barrier, 'guard-held-server-a'),
        join(barrier, 'guard-held-server-b'),
      ]);
      const refusedPath = await waitForAnyPath([
        join(barrier, 'refused-server-a.json'),
        join(barrier, 'refused-server-b.json'),
      ]);
      expect(heldPath.includes('server-a')).not.toBe(refusedPath.includes('server-a'));
      await writeFile(join(barrier, 'release-owner'), 'go\n', { mode: 0o600 });

      const results = await responses;
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.filter((result) => !result.ok && result.error.code === 'workspace_guard_busy'),
      ).toHaveLength(1);
      const winner = results.find((result) => result.ok);
      if (winner === undefined || !winner.ok) {
        throw new Error(`The same-instant start race had no winner: ${JSON.stringify(results)}`);
      }
      const listed = CircuitListResponseV1.parse(
        structuredContent(
          await servers[0]?.client.callTool({ name: 'circuit_list', arguments: {} }),
        ),
      );
      expect(listed).toMatchObject({
        ok: true,
        runs: [{ run_id: winner.run_id, flow: 'prototype', state: 'running' }],
      });
    } finally {
      await writeFile(join(barrier, 'release-start'), 'go\n', { mode: 0o600 }).catch(() => {});
      await writeFile(join(barrier, 'release-owner'), 'go\n', { mode: 0o600 }).catch(() => {});
      await Promise.all(servers.map(async (server) => await server.close()));
    }
  }, 20_000);

  it('keeps one workspace lease and resumes a persisted Prototype checkpoint from another server process', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-stdio-restart-')));
    roots.push(root);
    const stateRoot = join(root, 'state');
    const workspace = join(root, 'workspace');
    const bundle = join(root, 'stdio-lifecycle-server.mjs');
    await mkdir(workspace, { mode: 0o700 });
    await build({
      entryPoints: [resolve('tests/mcp/fixtures/stdio-lifecycle-server.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.18',
      sourcemap: false,
    });

    const original = await startFixtureServer({
      bundle,
      stateRoot,
      workspace,
      instanceId: 'server-a',
      runId: FIRST_RUN_ID,
    });
    let replacement: StdioFixtureServer | undefined;

    try {
      const started = CircuitStartResponseV1.parse(
        structuredContent(
          await original.client.callTool({
            name: 'circuit_start',
            arguments: {
              flow: 'prototype',
              goal: 'Build a durable Prototype checkpoint.',
              web_search: 'off',
            },
          }),
        ),
      );
      if (!started.ok) throw new Error(`The original server could not start: ${original.stderr()}`);

      // Start a second complete server only after the first server has written
      // durable state. This proves the replacement does not rely on any object
      // or cache held by the original process.
      replacement = await startFixtureServer({
        bundle,
        stateRoot,
        workspace,
        instanceId: 'server-b',
        runId: SECOND_RUN_ID,
      });
      expect(replacement.pid).not.toBe(original.pid);
      const heldLease = CircuitStartResponseV1.parse(
        structuredContent(
          await replacement.client.callTool({
            name: 'circuit_start',
            arguments: {
              flow: 'prototype',
              goal: 'Try to open a second run in the same workspace.',
              web_search: 'off',
            },
          }),
        ),
      );
      expect(heldLease).toMatchObject({
        ok: false,
        error: { code: 'workspace_busy' },
      });
      const originalServerPid = original.pid;
      await original.close();
      await waitForPidExit(originalServerPid);

      const listed = CircuitListResponseV1.parse(
        structuredContent(
          await replacement.client.callTool({ name: 'circuit_list', arguments: {} }),
        ),
      );
      if (!listed.ok)
        throw new Error(`The replacement server could not list: ${replacement.stderr()}`);
      expect(listed.runs).toEqual([
        expect.objectContaining({
          run_id: started.run_id,
          flow: 'prototype',
          state: 'running',
          checkpoint_available: false,
        }),
      ]);
      const recoveredRunId = listed.runs[0]?.run_id;
      if (recoveredRunId === undefined) throw new Error('circuit_list did not recover the run ID.');

      const status = CircuitStatusResponseV1.parse(
        structuredContent(
          await replacement.client.callTool({
            name: 'circuit_status',
            arguments: { run_id: recoveredRunId },
          }),
        ),
      );
      if (!status.ok || status.checkpoint === undefined) {
        throw new Error(
          `The replacement server could not recover the checkpoint: ${JSON.stringify(status)} ${replacement.stderr()}`,
        );
      }
      expect(status).toMatchObject({
        state: 'waiting_for_input',
        checkpoint: {
          prompt: 'Choose the Prototype to continue.',
          choices: [{ id: 'continue', label: 'Continue' }],
        },
      });

      const resumed = CircuitResumeResponseV1.parse(
        structuredContent(
          await replacement.client.callTool({
            name: 'circuit_resume',
            arguments: {
              run_id: recoveredRunId,
              checkpoint_token: status.checkpoint.token,
              choice_id: status.checkpoint.choices[0]?.id,
            },
          }),
        ),
      );
      expect(resumed).toMatchObject({ ok: true, run_id: recoveredRunId, state: 'running' });

      const state = new McpStateStore({ stateRoot });
      const record = state.readRun(trustedWorkspaceIdentity(workspace), recoveredRunId);
      expect(record).toMatchObject({
        state: 'running',
        launch: {
          generation: 2,
          phase: 'runtime_recorded',
          allocation_owner: { instance_id: replacement.instanceId, pid: replacement.pid },
        },
      });
      expect(record.checkpoint).toBeUndefined();
    } finally {
      await Promise.all([original.close(), replacement?.close()]);
    }
  }, 20_000);
});

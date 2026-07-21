import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { executeProofSandboxRequest, parseProofSandboxRequest } from './proof-sandbox-worker.mjs';
import {
  buildMacosProofSandboxProfile,
  observeDescendants,
  resolveGitMetadataReadRoots,
  runSandboxedProofCommand,
} from './proof-sandbox.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/proof-command.mjs', import.meta.url));
const WORKER = fileURLToPath(new URL('./proof-sandbox-worker.mjs', import.meta.url));
const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function directTestLaunch(input: { argv: readonly string[] }) {
  return {
    executable: input.argv[0] as string,
    args: [...input.argv.slice(1)],
    provider: 'test-only-unsandboxed',
    network: 'not_enforced_test_only' as const,
  };
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function input(
  workspace: string,
  argv: readonly string[],
  overrides: Partial<Parameters<typeof runSandboxedProofCommand>[0]> = {},
) {
  return {
    workspace,
    cwd: '.',
    argv,
    env: {},
    timeoutMs: 5_000,
    maxOutputBytes: 20_000,
    ...overrides,
  };
}

const testOptions = {
  allowUnsafeTestLaunch: true,
  testOnlyLaunch: directTestLaunch,
  interruptGraceMs: 50,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP proof command sandbox', () => {
  it('keeps process observation single-flight and stops without draining a backlog', async () => {
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolvePromise) => {
      releasePoll = resolvePromise;
    });
    let polls = 0;
    let activePolls = 0;
    let maximumActivePolls = 0;
    const observer = observeDescendants(123, {
      pollMs: 5,
      startupSettleMs: 0,
      enumerate: async () => {
        polls += 1;
        activePolls += 1;
        maximumActivePolls = Math.max(maximumActivePolls, activePolls);
        await pollGate;
        activePolls -= 1;
        return [456];
      },
      enumerateGroup: async () => [],
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(polls).toBe(1);
    expect(maximumActivePolls).toBe(1);

    let stopFinished = false;
    const stopping = observer.stop().then((result) => {
      stopFinished = true;
      return result;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(stopFinished).toBe(false);

    releasePoll();
    const result = await stopping;
    expect(result).toMatchObject({
      pids: [456],
      enumerationSucceeded: true,
    });
    expect(polls).toBe(1);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(polls).toBe(1);
  });

  it('builds a default-deny macOS profile with only the workspace writable', () => {
    const profile = buildMacosProofSandboxProfile('/tmp/example workspace');

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(subpath "/tmp/example workspace")');
    expect(profile).not.toContain('(allow network');
  });

  it('rejects arbitrary Git-dir pointers but accepts the fixed linked-worktree shape', async () => {
    const arbitraryWorkspace = tempRoot('circuit-proof-arbitrary-git-pointer');
    const arbitraryGitDir = tempRoot('circuit-proof-unrelated-git-dir');
    writeFileSync(path.join(arbitraryWorkspace, '.git'), `gitdir: ${arbitraryGitDir}\n`);
    await expect(resolveGitMetadataReadRoots(arbitraryWorkspace)).rejects.toThrow(
      /linked worktree|commondir|backlink/i,
    );

    const workspace = tempRoot('circuit-proof-linked-worktree');
    const commonDir = tempRoot('circuit-proof-common-git-dir');
    const gitDir = path.join(commonDir, 'worktrees', 'fixture');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(workspace, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(workspace, '.git')}\n`);

    await expect(resolveGitMetadataReadRoots(workspace)).resolves.toEqual([
      realpathSync(workspace),
      realpathSync(gitDir),
      realpathSync(commonDir),
    ]);
  });

  it('rejects cwd escapes and unapproved environment keys before launch', async () => {
    const workspace = tempRoot('circuit-proof-boundary');

    await expect(
      runSandboxedProofCommand(
        input(workspace, [process.execPath, FIXTURE, 'environment'], { cwd: '..' }),
        testOptions,
      ),
    ).rejects.toThrow(/escapes the workspace/);
    await expect(
      runSandboxedProofCommand(
        input(workspace, [process.execPath, FIXTURE, 'environment'], {
          env: { OPENAI_API_KEY: 'must-not-cross' },
        }),
        testOptions,
      ),
    ).rejects.toThrow(/OPENAI_API_KEY.*not allowed/);
  });

  it('uses a bounded environment and puts HOME and temp storage in a private sibling', async () => {
    const workspace = tempRoot('circuit-proof-env');
    const canonicalWorkspace = realpathSync(workspace);
    const result = await runSandboxedProofCommand(
      input(workspace, [process.execPath, FIXTURE, 'environment'], { env: { CI: '1' } }),
      { ...testOptions, baseEnv: { PATH: process.env.PATH, PROOF_TEST_SECRET: 'hidden' } },
    );

    expect(result.status).toBe('passed');
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({ cwd: canonicalWorkspace, marker: '1' });
    expect(body.secret).toBeUndefined();
    expect(String(body.home).startsWith(canonicalWorkspace)).toBe(false);
    expect(String(body.temp).startsWith(canonicalWorkspace)).toBe(false);
    expect(result.sandbox.writableRoots).toContain(canonicalWorkspace);
    expect(result.sandbox.writableRoots).toContain(String(body.temp));
    expect(result.sandbox.network).toBe('not_enforced_test_only');
  });

  it('times out a process tree and reports whether observed cleanup was confirmed', async () => {
    const workspace = tempRoot('circuit-proof-timeout');
    const pidFile = path.join(workspace, 'pids.json');
    const result = await runSandboxedProofCommand(
      input(workspace, [process.execPath, FIXTURE, 'tree', pidFile], { timeoutMs: 200 }),
      testOptions,
    );

    expect(result.status).toBe('timed_out');
    expect(result.cleanup).toMatchObject({
      scope: 'observed_process_tree',
      enumerationSucceeded: true,
      confirmed: true,
      remainingPids: [],
    });
    expect(JSON.parse(readFileSync(pidFile, 'utf8'))).toMatchObject({
      root: expect.any(Number),
      leaf: expect.any(Number),
    });
    expect(result.stderr).toContain('cleanup confirmed');
  }, 10_000);

  it('fails a proof that leaves a detached child and confirms its cleanup', async () => {
    const workspace = tempRoot('circuit-proof-background');
    const pidFile = path.join(workspace, 'pids.json');
    const result = await runSandboxedProofCommand(
      input(workspace, [process.execPath, FIXTURE, 'background', pidFile]),
      testOptions,
    );
    const identities = JSON.parse(readFileSync(pidFile, 'utf8')) as {
      root: number;
      leaf: number;
    };

    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      cleanup: { required: true, confirmed: true },
    });
    expect(result.stderr).toContain('left a background process');
    expect(processIsAbsent(identities.root)).toBe(true);
    expect(processIsAbsent(identities.leaf)).toBe(true);
  }, 10_000);

  it('supports explicit cancellation and bounds output', async () => {
    const workspace = tempRoot('circuit-proof-cancel');
    const pidFile = path.join(workspace, 'pids.json');
    const controller = new AbortController();
    const running = runSandboxedProofCommand(
      input(workspace, [process.execPath, FIXTURE, 'tree', pidFile], {
        signal: controller.signal,
      }),
      testOptions,
    );
    while (!existsSync(pidFile)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    controller.abort();
    const cancelled = await running;

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cleanup.confirmed).toBe(true);

    const outputLimited = await runSandboxedProofCommand(
      input(workspace, [process.execPath, FIXTURE, 'output', '10000'], {
        maxOutputBytes: 64,
      }),
      testOptions,
    );
    expect(outputLimited.status).toBe('output_limit');
    expect(Buffer.byteLength(outputLimited.stdout)).toBeLessThanOrEqual(64);
    expect(outputLimited.outputCapped).toBe(true);
    expect(outputLimited.cleanup.confirmed).toBe(true);
  }, 15_000);

  it('validates and returns the stdin/stdout proof runner protocol', async () => {
    const workspace = tempRoot('circuit-proof-protocol');
    const canonicalWorkspace = realpathSync(workspace);
    const cancelRoot = tempRoot('circuit-proof-protocol-state');
    const cancelFile = path.join(cancelRoot, 'cancel');
    const command = {
      id: 'environment-proof',
      cwd: '.',
      argv: [process.execPath, FIXTURE, 'environment'],
      timeout_ms: 5_000,
      max_output_bytes: 20_000,
      env: {},
    };
    const request = {
      schema: 'circuit.mcp-proof-request@v1' as const,
      access: 'workspace-write' as const,
      projectRoot: workspace,
      cwd: workspace,
      command,
      cancelFile,
    };

    expect(parseProofSandboxRequest(request)).toEqual(request);
    const response = await executeProofSandboxRequest(request, { runnerOptions: testOptions });

    expect(response).toMatchObject({
      schema: 'circuit.mcp-proof-response@v1',
      observation: {
        command,
        exit_code: 0,
        status: 'passed',
        timed_out: false,
      },
      execution: {
        status: 'passed',
        cleanup: { confirmed: true },
        sandbox: {
          network: 'not_enforced_test_only',
          writable_roots: expect.arrayContaining([canonicalWorkspace]),
        },
      },
    });
  });

  it('accepts only the pinned helper shape for fixed git-state reads', () => {
    const workspace = tempRoot('circuit-proof-git-state-shape');
    const helperRoot = tempRoot('circuit-proof-git-state-helper');
    const helper = path.join(helperRoot, 'git-state.js');
    writeFileSync(helper, 'process.stdout.write("{}")\n');
    const previous = process.env.CIRCUIT_MCP_GIT_STATE_HELPER;
    process.env.CIRCUIT_MCP_GIT_STATE_HELPER = helper;
    const cancelRoot = tempRoot('circuit-proof-git-state-cancel');
    const request = {
      schema: 'circuit.mcp-proof-request@v1' as const,
      access: 'git-read-only' as const,
      projectRoot: workspace,
      cwd: workspace,
      command: {
        id: 'build-baseline-snapshot-git-state',
        cwd: '.',
        argv: [process.execPath, helper],
        timeout_ms: 60_000,
        max_output_bytes: 5_000_000,
        env: {},
      },
      cancelFile: path.join(cancelRoot, 'cancel'),
    };

    try {
      expect(parseProofSandboxRequest(request)).toEqual(request);
      expect(() =>
        parseProofSandboxRequest({
          ...request,
          command: { ...request.command, argv: [process.execPath, `${helper}.lookalike`] },
        }),
      ).toThrow(/pinned git-state helper/);
      expect(() =>
        parseProofSandboxRequest({
          ...request,
          command: { ...request.command, id: 'custom-git-state' },
        }),
      ).toThrow(/fixed Circuit Git read operations/);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, 'CIRCUIT_MCP_GIT_STATE_HELPER');
      else process.env.CIRCUIT_MCP_GIT_STATE_HELPER = previous;
    }
  });
});

const liveMacos =
  process.platform === 'darwin' && process.env.CIRCUIT_MCP_LIVE_PROOF_SANDBOX === '1';

describe.runIf(liveMacos)('live macOS proof sandbox', () => {
  it('allows workspace writes but blocks outside writes and loopback network', async () => {
    const workspace = tempRoot('circuit-proof-live-workspace');
    const canonicalWorkspace = realpathSync(workspace);
    const outside = tempRoot('circuit-proof-live-outside');
    const workspaceFile = path.join(workspace, 'allowed.txt');
    const outsideFile = path.join(outside, 'blocked.txt');
    const server = net.createServer(() => undefined);
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP port');
    try {
      const result = await runSandboxedProofCommand(
        input(workspace, [
          process.execPath,
          FIXTURE,
          'sandbox-probe',
          workspaceFile,
          outsideFile,
          String(address.port),
        ]),
      );
      expect(result.status).toBe('passed');
      expect(JSON.parse(result.stdout)).toMatchObject({
        workspaceWrite: true,
        outsideWrite: false,
        connected: false,
      });
      expect(readFileSync(workspaceFile, 'utf8')).toContain('allowed');
      expect(existsSync(outsideFile)).toBe(false);
      expect(result.sandbox).toMatchObject({
        provider: 'macos-seatbelt',
        network: 'denied',
        writableRoots: expect.arrayContaining([canonicalWorkspace]),
      });
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }, 15_000);

  it('runs the real stdin/stdout worker protocol through Seatbelt', () => {
    const workspace = tempRoot('circuit-proof-live-protocol');
    const canonicalWorkspace = realpathSync(workspace);
    const cancelRoot = tempRoot('circuit-proof-live-protocol-state');
    const request = {
      schema: 'circuit.mcp-proof-request@v1',
      access: 'workspace-write',
      projectRoot: canonicalWorkspace,
      cwd: canonicalWorkspace,
      command: {
        id: 'live-protocol-proof',
        cwd: '.',
        argv: [process.execPath, FIXTURE, 'environment'],
        timeout_ms: 5_000,
        max_output_bytes: 20_000,
        env: {},
      },
      cancelFile: path.join(cancelRoot, 'cancel'),
    };
    const worker = spawnSync(process.execPath, [WORKER], {
      cwd: canonicalWorkspace,
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(worker.status, worker.stderr).toBe(0);
    expect(JSON.parse(worker.stdout)).toMatchObject({
      schema: 'circuit.mcp-proof-response@v1',
      observation: { status: 'passed', exit_code: 0, timed_out: false },
      execution: {
        status: 'passed',
        cleanup: { confirmed: true },
        sandbox: {
          provider: 'macos-seatbelt',
          network: 'denied',
          writable_roots: expect.arrayContaining([canonicalWorkspace]),
        },
      },
    });
  }, 15_000);
});

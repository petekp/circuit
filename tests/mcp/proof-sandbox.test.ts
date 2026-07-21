import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type ProofSandboxLaunch,
  buildMacosSeatbeltProfile,
  createMacosProofSandbox,
} from '../../src/hosts/codex-mcp/proof-sandbox.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'proof-command.mjs');
const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  const canonical = realpathSync(root);
  roots.push(canonical);
  return canonical;
}

function fixture() {
  return {
    id: 'fixture',
    cwd: '.',
    argv: [process.execPath, FIXTURE, 'environment'],
    env: {},
    timeout_ms: 5_000,
    max_output_bytes: 20_000,
  } as const;
}

function unsafeDirectLaunch(input: { readonly argv: readonly string[] }): ProofSandboxLaunch {
  const executable = input.argv[0];
  if (executable === undefined) throw new Error('missing executable');
  return {
    executable,
    args: input.argv.slice(1),
    provider: 'test-only-unsandboxed',
    network: 'not_enforced_test_only',
  };
}

function sandbox(workspace: string, overrides: Record<string, unknown> = {}) {
  const privateRoot = temporaryDirectory('circuit-mcp-proof-private');
  return createMacosProofSandbox({
    workspace,
    privateRoot,
    pathEntries: [path.dirname(process.execPath), '/usr/bin', '/bin'],
    platform: 'darwin',
    allowUnsafeTestLaunch: true,
    testOnlyLaunch: unsafeDirectLaunch,
    interruptGraceMs: 20,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex MCP proof sandbox', () => {
  it('uses default-deny Seatbelt with no Mach-service allowances', () => {
    const profile = buildMacosSeatbeltProfile({
      workspace: '/tmp/example workspace',
      privateDirectory: '/tmp/circuit-private',
      access: 'workspace-write',
      readRoots: ['/tmp/example workspace'],
    });

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny mach-lookup)');
    expect(profile).not.toContain('(allow mach-lookup');
    expect(profile).toContain('(subpath "/tmp/example workspace")');
    expect(profile).toContain('(subpath "/tmp/circuit-private")');
  });

  it('rejects unsupported platforms before creating run state', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-platform');
    const privateRoot = temporaryDirectory('circuit-mcp-proof-platform-private');
    const before = await readdir(privateRoot);
    const proof = createMacosProofSandbox({
      workspace,
      privateRoot,
      pathEntries: ['/usr/bin', '/bin'],
      platform: 'linux',
    });

    await expect(proof.run(fixture())).rejects.toMatchObject({
      code: 'unsupported_platform',
    });
    expect(await readdir(privateRoot)).toEqual(before);
  });

  it('rejects cwd escapes, symlink cwd traversal, unknown fields, and hostile env', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-boundary');
    const outside = temporaryDirectory('circuit-mcp-proof-outside');
    const linked = path.join(workspace, 'linked');
    symlinkSync(outside, linked);
    const proof = sandbox(workspace);

    await expect(proof.run({ ...fixture(), cwd: '..' })).rejects.toThrow(/escapes/i);
    await expect(proof.run({ ...fixture(), cwd: 'linked' })).rejects.toThrow(/symbolic/i);
    await expect(proof.run({ ...fixture(), surprise: true })).rejects.toThrow(/unknown field/i);
    await expect(
      proof.run({ ...fixture(), env: { OPENAI_API_KEY: 'do-not-pass' } }),
    ).rejects.toThrow(/OPENAI_API_KEY.*not allowed/i);
  });

  it('replaces the host environment and routes home, temp, and cache to private storage', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-env');
    const originalPath = process.env.PATH;
    const originalKey = process.env.OPENAI_API_KEY;
    const originalProxy = process.env.HTTPS_PROXY;
    process.env.PATH = '/hostile/path';
    process.env.OPENAI_API_KEY = 'must-not-cross';
    process.env.HTTPS_PROXY = 'http://must-not-cross';
    try {
      const result = await sandbox(workspace).run({ ...fixture(), env: { CI: '1' } });
      const body = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(result.status).toBe('passed');
      expect(body).toMatchObject({ cwd: realpathSync(workspace), marker: '1' });
      expect(body.secret).toBeUndefined();
      expect(body.proxy).toBeUndefined();
      expect(String(body.home).startsWith(realpathSync(workspace))).toBe(false);
      expect(String(body.temp)).toContain('circuit-proof-');
      expect(String(body.cache)).toContain('circuit-proof-');
      expect(result.sandbox.writable_roots).toContain(realpathSync(workspace));
      expect(result.sandbox.mach_services).toEqual([]);
    } finally {
      if (originalPath === undefined) Reflect.deleteProperty(process.env, 'PATH');
      else process.env.PATH = originalPath;
      if (originalKey === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalProxy === undefined) Reflect.deleteProperty(process.env, 'HTTPS_PROXY');
      else process.env.HTTPS_PROXY = originalProxy;
    }
  });

  it('bounds output and times out commands after cleaning the observed process group', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-limits');
    // A long cleanup budget makes this a regression test for the ordering:
    // timeout must trigger cleanup immediately, not wait out that budget first.
    const proof = sandbox(workspace, { cleanupWaitMs: 10_000 });
    const output = await proof.run({
      ...fixture(),
      argv: [process.execPath, FIXTURE, 'output', '10000'],
      max_output_bytes: 64,
    });

    expect(output).toMatchObject({
      status: 'output_limit',
      truncated: true,
      cleanup: { confirmed: true },
    });
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(
      64,
    );

    const timeoutStartedAt = performance.now();
    const timedOut = await proof.run({
      ...fixture(),
      argv: [process.execPath, FIXTURE, 'sleep'],
      timeout_ms: 100,
    });
    expect(timedOut).toMatchObject({
      status: 'timed_out',
      cleanup: { confirmed: true, remaining_pids: [] },
    });
    expect(performance.now() - timeoutStartedAt).toBeLessThan(7_500);
  }, 20_000);

  it('allows foreground child processes that have exited before cleanup', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-foreground');
    const result = await sandbox(workspace).run({
      ...fixture(),
      argv: [process.execPath, FIXTURE, 'foreground-child'],
    });

    expect(result).toMatchObject({
      status: 'passed',
      stdout: 'child',
      cleanup: { confirmed: true, required: false },
    });
  });

  it('supports cancellation and confirms cleanup before returning', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-cancel');
    const controller = new AbortController();
    const running = sandbox(workspace).execute(
      {
        ...fixture(),
        argv: [process.execPath, FIXTURE, 'sleep'],
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await expect(running).resolves.toMatchObject({
      status: 'cancelled',
      cleanup: { confirmed: true, required: true, remaining_pids: [] },
    });
  });

  it('fails a command that leaves a background child and cleans the observed child', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-background');
    const pidFile = path.join(workspace, 'pids.json');
    const result = await sandbox(workspace).run({
      ...fixture(),
      argv: [process.execPath, FIXTURE, 'background', pidFile],
    });
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { parent: number; child: number };

    expect(result).toMatchObject({ status: 'failed', cleanup: { confirmed: true } });
    expect(result.stderr).toContain('background process');
    for (const pid of [pids.parent, pids.child]) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 10_000);

  it('fails closed when process inspection cannot confirm cleanup', async () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-uncertain');
    const proof = sandbox(workspace, {
      inspectProcesses: async () => {
        throw new Error('ps unavailable');
      },
    });

    const result = await proof.run(fixture());
    expect(result).toMatchObject({
      status: 'cleanup_unconfirmed',
      cleanup: { confirmed: false, inspection_error: 'ps unavailable' },
    });
  });

  it('does not allow an unsafe test launcher without an explicit test opt-in', () => {
    const workspace = temporaryDirectory('circuit-mcp-proof-test-launcher');
    const privateRoot = temporaryDirectory('circuit-mcp-proof-test-launcher-private');
    expect(() =>
      createMacosProofSandbox({
        workspace,
        privateRoot,
        pathEntries: ['/usr/bin'],
        platform: 'darwin',
        testOnlyLaunch: unsafeDirectLaunch,
      }),
    ).toThrow(/test-only/i);
  });
});

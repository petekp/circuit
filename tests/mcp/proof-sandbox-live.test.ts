import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMacosProofSandbox } from '../../src/hosts/codex-mcp/proof-sandbox.js';
import { createMcpWorkerSecurity } from '../../src/hosts/codex-mcp/worker-security.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'proof-command.mjs');
const PATH_ENTRIES = [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `${label}-`)));
  roots.push(root);
  return root;
}

function proof(workspace: string) {
  const workspaceFixture = path.join(workspace, 'proof-command.mjs');
  if (!existsSync(workspaceFixture)) copyFileSync(FIXTURE, workspaceFixture);
  return createMacosProofSandbox({
    workspace,
    privateRoot: temporaryDirectory('circuit-mcp-live-private'),
    pathEntries: PATH_ENTRIES,
  });
}

function fixture(workspace: string): string {
  return path.join(workspace, 'proof-command.mjs');
}

function request(argv: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'live-proof',
    cwd: '.',
    argv,
    env: {},
    timeout_ms: 3_000,
    max_output_bytes: 100_000,
    ...overrides,
  };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForFile(pathname: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(pathname)) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${pathname}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('live macOS Codex MCP proof sandbox', () => {
  it('keeps proof commands inside the caller process group', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-group-workspace');
    const parentGroup = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    });
    const pidFile = path.join(workspace, 'proof.pid');
    const controller = new AbortController();
    const running = proof(workspace).execute(
      request([process.execPath, fixture(workspace), 'identity', pidFile]),
      { signal: controller.signal },
    );
    await waitForFile(pidFile);
    const proofPid = readFileSync(pidFile, 'utf8').trim();
    const proofGroup = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', proofPid], {
      encoding: 'utf8',
    });
    if (proofGroup.status !== 0) {
      throw new Error(`could not inspect proof process ${proofPid}: ${proofGroup.stderr}`);
    }
    controller.abort();
    const result = await running;

    expect(result.status, result.stderr).toBe('cancelled');
    expect(Number(proofGroup.stdout.trim())).toBe(Number(parentGroup.stdout.trim()));
  }, 15_000);

  it('blocks arbitrary reads outside the explicit workspace, private, and tool roots', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-read-workspace');
    const fakeHome = temporaryDirectory('circuit-mcp-live-read-home');
    const codexHome = path.join(fakeHome, '.codex');
    const sshHome = path.join(fakeHome, '.ssh');
    const otherRun = temporaryDirectory('circuit-mcp-live-read-other-run');
    for (const directory of [codexHome, sshHome]) {
      spawnSync('/bin/mkdir', ['-p', directory]);
    }
    const arbitraryReadable = path.join(otherRun, 'ordinary-readable-file.txt');
    const secrets = [
      path.join(codexHome, 'auth.json'),
      path.join(sshHome, 'id_ed25519'),
      path.join(otherRun, 'launch.json'),
      arbitraryReadable,
    ];
    for (const secret of secrets) writeFileSync(secret, 'not-for-proof-commands\n');

    const result = await proof(workspace).run(
      request([process.execPath, fixture(workspace), 'reads', ...secrets]),
    );

    expect(result.status, result.stderr).toBe('passed');
    expect(JSON.parse(result.stdout)).toEqual({ 0: false, 1: false, 2: false, 3: false });
  }, 15_000);

  it('runs host Node and npm while denying adjacent manager configuration', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-toolchain-workspace');
    const ambientNpm = spawnSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).stdout.trim();
    const npmExecutable = realpathSync(ambientNpm);
    const installedManagerConfig = path.join(path.dirname(path.dirname(npmExecutable)), '.npmrc');
    const fallbackManager = temporaryDirectory('circuit-mcp-live-adjacent-manager');
    const managerConfig =
      /\/\.vite-plus\/[^/]+\/bin\/vp$/u.test(npmExecutable) && existsSync(installedManagerConfig)
        ? installedManagerConfig
        : path.join(fallbackManager, '.npmrc');
    if (!existsSync(managerConfig))
      writeFileSync(managerConfig, 'registry=https://example.invalid\n');
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          'read-manager-config': `node proof-command.mjs reads ${JSON.stringify(managerConfig)}`,
          'nested-npm-read': 'npm run read-manager-config --silent',
        },
      }),
    );
    const sandbox = proof(workspace);
    const runner = createMcpWorkerSecurity(
      {
        workspace,
        privateRoot: temporaryDirectory('circuit-mcp-live-worker-private'),
        gitExecutable: '/usr/bin/git',
        environment: { PATH: PATH_ENTRIES.join(path.delimiter) },
      },
      {
        createSandbox: () => sandbox,
        createGitReader: () => ({
          read: async () => {
            throw new Error('Git is not part of this proof test.');
          },
        }),
      },
    ).proofCommandRunner;
    const nodeVersion = await runner(request(['node', '--version']), workspace);
    const npmVersion = await runner(request(['npm', '--version']), workspace);
    const managerRead = await runner(
      request(['npm', 'run', 'read-manager-config', '--silent'], { timeout_ms: 10_000 }),
      workspace,
    );
    const nestedManagerRead = await runner(
      request(['npm', 'run', 'nested-npm-read', '--silent'], { timeout_ms: 10_000 }),
      workspace,
    );

    expect(nodeVersion.status, nodeVersion.stderr_summary).toBe('passed');
    expect(nodeVersion.stdout_summary.trim()).toMatch(/^v\d+\.\d+\.\d+/);
    expect(npmVersion.status, npmVersion.stderr_summary).toBe('passed');
    expect(npmVersion.stdout_summary.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(managerRead.status, managerRead.stderr_summary).toBe('passed');
    expect(JSON.parse(managerRead.stdout_summary)).toEqual({ 0: false });
    expect(nestedManagerRead.status, nestedManagerRead.stderr_summary).toBe('passed');
    expect(JSON.parse(nestedManagerRead.stdout_summary)).toEqual({ 0: false });
  }, 60_000);

  it('allows only workspace and private-temp writes', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-write-workspace');
    const outside = temporaryDirectory('circuit-mcp-live-write-outside');
    const workspaceFile = path.join(workspace, 'allowed.txt');
    const outsideFile = path.join(outside, 'blocked.txt');
    const result = await proof(workspace).run(
      request([process.execPath, fixture(workspace), 'writes', workspaceFile, outsideFile]),
    );

    expect(result.status, result.stderr).toBe('passed');
    expect(JSON.parse(result.stdout)).toEqual({ workspace: true, outside: false, temp: true });
    expect(readFileSync(workspaceFile, 'utf8')).toBe('workspace\n');
    expect(existsSync(outsideFile)).toBe(false);
    expect(result.sandbox).toMatchObject({
      provider: 'macos-seatbelt',
      network: 'denied',
      mach_services: [],
    });
  }, 15_000);

  it('blocks sockets, DNS, curl, native URLSession, and background URLSession XPC', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-network-workspace');
    const sandbox = proof(workspace);
    let tcpConnections = 0;
    let udpPackets = 0;
    const tcpServer = net.createServer((socket) => {
      tcpConnections += 1;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    });
    await new Promise<void>((resolvePromise) => tcpServer.listen(0, '127.0.0.1', resolvePromise));
    const tcpAddress = tcpServer.address();
    if (tcpAddress === null || typeof tcpAddress === 'string') throw new Error('missing TCP port');
    const udpServer = dgram.createSocket('udp4');
    udpServer.on('message', () => {
      udpPackets += 1;
    });
    await new Promise<void>((resolvePromise) => udpServer.bind(0, '127.0.0.1', resolvePromise));
    const udpAddress = udpServer.address();
    const url = `http://127.0.0.1:${tcpAddress.port}/proof`;

    try {
      const attempts = [
        [process.execPath, fixture(workspace), 'tcp', String(tcpAddress.port)],
        [
          '/usr/bin/dig',
          '@127.0.0.1',
          '-p',
          String(udpAddress.port),
          'circuit.test',
          '+time=1',
          '+tries=1',
        ],
        ['/usr/bin/curl', '--fail', '--max-time', '1', url],
        ['/usr/bin/nscurl', url],
        ['/usr/bin/nscurl', '--background', url],
      ] as const;
      const results = [];
      for (const argv of attempts) results.push(await sandbox.run(request(argv)));
      await wait(500);

      expect(results.slice(0, 3).map((result) => result.status)).toEqual([
        'failed',
        'failed',
        'failed',
      ]);
      // nscurl reports transport failure on stderr but exits zero. The direct
      // URLSession path returns EPERM. Its background mode cannot hand a
      // working request to the XPC service, and no connection reaches the
      // controlled loopback server.
      expect(results[3]?.stderr).toMatch(/Operation not permitted/i);
      expect(results[4]?.stderr).toMatch(/Load failed with error/i);
      expect(results.every((result) => result.cleanup.confirmed)).toBe(true);
      expect(results.every((result) => result.sandbox.network === 'denied')).toBe(true);
      expect(tcpConnections).toBe(0);
      expect(udpPackets).toBe(0);
    } finally {
      await new Promise<void>((resolvePromise) => tcpServer.close(() => resolvePromise()));
      udpServer.close();
    }
  }, 30_000);

  it('kills timed-out and background children with observed cleanup', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-process-workspace');
    const sandbox = proof(workspace);
    const timedOut = await sandbox.run(
      request([process.execPath, fixture(workspace), 'sleep'], { timeout_ms: 100 }),
    );
    expect(timedOut).toMatchObject({
      status: 'timed_out',
      cleanup: { confirmed: true, remaining_pids: [] },
    });

    const pidFile = path.join(workspace, 'pids.json');
    const background = await sandbox.run(
      request([process.execPath, fixture(workspace), 'background', pidFile], {
        timeout_ms: 10_000,
      }),
    );
    expect(background).toMatchObject({
      status: 'failed',
      cleanup: { confirmed: true, remaining_pids: [] },
    });
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { parent: number; child: number };
    for (const pid of [pids.parent, pids.child]) {
      const observed = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], {
        encoding: 'utf8',
      });
      expect(observed.stdout.trim()).toBe('');
    }
  }, 20_000);

  it('detects and cleans a deliberately detached child during the observation window', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-detached-workspace');
    const pidFile = path.join(workspace, 'detached-pids.json');
    const result = await proof(workspace).run(
      request([process.execPath, fixture(workspace), 'detached-background', pidFile], {
        timeout_ms: 10_000,
      }),
    );
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { parent: number; child: number };

    expect(result).toMatchObject({
      status: 'failed',
      cleanup: { confirmed: true, remaining_pids: [] },
    });
    expect(result.cleanup.observed_pids).toContain(pids.child);
    for (const pid of [pids.parent, pids.child]) {
      const observed = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], {
        encoding: 'utf8',
      });
      expect(observed.stdout.trim()).toBe('');
    }
  }, 20_000);
});

import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMacosProofSandbox } from '../../src/hosts/codex-mcp/proof-sandbox.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'proof-command.mjs');
const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `${label}-`)));
  roots.push(root);
  return root;
}

function proof(workspace: string) {
  return createMacosProofSandbox({
    workspace,
    privateRoot: temporaryDirectory('circuit-mcp-live-private'),
    pathEntries: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  });
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('live macOS Codex MCP proof sandbox', () => {
  it('allows only workspace and private-temp writes', async () => {
    const workspace = temporaryDirectory('circuit-mcp-live-write-workspace');
    const outside = temporaryDirectory('circuit-mcp-live-write-outside');
    const workspaceFile = path.join(workspace, 'allowed.txt');
    const outsideFile = path.join(outside, 'blocked.txt');
    const result = await proof(workspace).run(
      request([process.execPath, FIXTURE, 'writes', workspaceFile, outsideFile]),
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
        [process.execPath, FIXTURE, 'tcp', String(tcpAddress.port)],
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
      request([process.execPath, FIXTURE, 'sleep'], { timeout_ms: 100 }),
    );
    expect(timedOut).toMatchObject({
      status: 'timed_out',
      cleanup: { confirmed: true, remaining_pids: [] },
    });

    const pidFile = path.join(workspace, 'pids.json');
    const background = await sandbox.run(
      request([process.execPath, FIXTURE, 'background', pidFile]),
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
});

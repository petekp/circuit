import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runConnectorSubprocess } from '../../src/connectors/subprocess.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-connector-subprocess-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('connector subprocess lifecycle boundary', () => {
  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  it('cooperatively stops a connector when the sealed cancellation marker appears', async () => {
    const cancelFile = join(tempDir, 'cancel.requested');
    const stopping = runConnectorSubprocess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      timeoutMs: 20_000,
      stdoutMaxBytes: 1_000,
      stderrMaxBytes: 1_000,
      sigtermToSigkillGraceMs: 50,
      cancelFile,
      cancelPollMs: 20,
      cwd: tempDir,
    });
    setTimeout(() => writeFileSync(cancelFile, 'cancel\n'), 100);

    const result = await stopping;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.killGroupSucceeded).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('returns bounded stdout and stderr when a detached subprocess times out', async () => {
    const result = await runConnectorSubprocess({
      executable: process.execPath,
      args: [
        '-e',
        [
          "process.stdout.write('stdout before timeout');",
          "process.stderr.write('stderr before timeout');",
          'setInterval(() => {}, 1000);',
        ].join(' '),
      ],
      // Full-suite fork load can delay child startup. This test is checking
      // buffered output on timeout, not a precise three-second wall clock.
      timeoutMs: 10_000,
      stdoutMaxBytes: 1_000,
      stderrMaxBytes: 1_000,
      sigtermToSigkillGraceMs: 50,
      cwd: tempDir,
    });

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('stdout before timeout');
    expect(result.stderr).toContain('stderr before timeout');
  });

  it('kills a connector child that survives after the direct CLI closes during cancellation', async () => {
    const cancelFile = join(tempDir, 'cancel.requested');
    const readyFile = join(tempDir, 'leaf.ready');
    const source = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const leaf = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
      `leaf.stdout.once('data', () => { writeFileSync(${JSON.stringify(readyFile)}, String(leaf.pid)); process.on('SIGTERM', () => process.exit(0)); });`,
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const stopping = runConnectorSubprocess({
      executable: process.execPath,
      args: ['-e', source],
      timeoutMs: 20_000,
      stdoutMaxBytes: 1_000,
      stderrMaxBytes: 1_000,
      sigtermToSigkillGraceMs: 2_000,
      cancelFile,
      cancelPollMs: 20,
      cwd: tempDir,
    });
    for (let attempt = 0; attempt < 500 && !existsSync(readyFile); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(existsSync(readyFile)).toBe(true);
    const leafPid = Number(readFileSync(readyFile, 'utf8'));
    writeFileSync(cancelFile, 'cancel\n');

    const result = await stopping;
    expect(result).toMatchObject({ cancelled: true, killGroupSucceeded: true });
    expect(Number.isInteger(leafPid)).toBe(true);
    for (let attempt = 0; attempt < 40 && processAlive(leafPid); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(processAlive(leafPid)).toBe(false);
  });

  it('cleans a background child before accepting a successful sealed MCP connector', async () => {
    const pidFile = join(tempDir, 'background-leaf.pid');
    const source = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const leaf = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      'leaf.unref();',
      `writeFileSync(${JSON.stringify(pidFile)}, String(leaf.pid));`,
      "process.stdout.write('connector complete');",
    ].join(' ');
    let leafPid: number | undefined;

    try {
      const result = await runConnectorSubprocess({
        executable: process.execPath,
        args: ['-e', source],
        timeoutMs: 10_000,
        stdoutMaxBytes: 1_000,
        stderrMaxBytes: 1_000,
        sigtermToSigkillGraceMs: 50,
        requireEmptyProcessGroupOnExit: true,
        env: {
          ...process.env,
          CIRCUIT_MCP_SEALED: '1',
          CIRCUIT_RUNTIME_SOURCE: 'mcp-spike',
        },
        cwd: tempDir,
      });
      leafPid = Number(readFileSync(pidFile, 'utf8'));

      expect(result).toMatchObject({ code: 0, timedOut: false, cancelled: false });
      expect(Number.isInteger(leafPid)).toBe(true);
      expect(processAlive(leafPid)).toBe(false);
    } finally {
      if (leafPid !== undefined && processAlive(leafPid)) {
        try {
          process.kill(leafPid, 'SIGKILL');
        } catch {
          // The child may exit between the liveness check and the cleanup signal.
        }
      }
    }
  });

  it('rejects a sealed MCP connector result when process-group cleanup cannot be confirmed', async () => {
    const pidFile = join(tempDir, 'uncleanable-leaf.pid');
    const source = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'leaf.unref();',
      `writeFileSync(${JSON.stringify(pidFile)}, String(leaf.pid));`,
    ].join(' ');
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0) {
        const error = new Error(
          'simulated process-group permission failure',
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realKill(pid, signal);
    });
    let leafPid: number | undefined;

    try {
      await expect(
        runConnectorSubprocess({
          executable: process.execPath,
          args: ['-e', source],
          timeoutMs: 10_000,
          stdoutMaxBytes: 1_000,
          stderrMaxBytes: 1_000,
          sigtermToSigkillGraceMs: 25,
          requireEmptyProcessGroupOnExit: true,
          cwd: tempDir,
        }),
      ).rejects.toThrow('could not confirm that all of its background processes stopped');
      leafPid = Number(readFileSync(pidFile, 'utf8'));
      expect(processAlive(leafPid)).toBe(true);
    } finally {
      killSpy.mockRestore();
      if (leafPid === undefined && existsSync(pidFile)) {
        leafPid = Number(readFileSync(pidFile, 'utf8'));
      }
      if (leafPid !== undefined && processAlive(leafPid)) {
        try {
          realKill(leafPid, 'SIGKILL');
        } catch {
          // The child may exit between the liveness check and the cleanup signal.
        }
      }
    }
  });

  it('kills a silent subprocess on the inactivity bound and reports timeoutKind idle', async () => {
    const result = await runConnectorSubprocess({
      executable: process.execPath,
      // Spawns and then goes silent forever without producing any output.
      args: ['-e', 'setInterval(() => {}, 1000);'],
      // Absolute backstop set far away — the inactivity bound is what must fire.
      timeoutMs: 20_000,
      idleTimeoutMs: 1_000,
      stdoutMaxBytes: 1_000,
      stderrMaxBytes: 1_000,
      sigtermToSigkillGraceMs: 50,
      cwd: tempDir,
    });

    expect(result.timedOut).toBe(true);
    expect(result.timeoutKind).toBe('idle');
    // Died from the 1s inactivity bound, nowhere near the 20s absolute ceiling.
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it(
    'lets a continuously streaming subprocess reset the inactivity bound and die on the absolute backstop',
    { retry: 2 },
    async () => {
      const result = await runConnectorSubprocess({
        executable: process.execPath,
        // Writes immediately, then keeps streaming every 100ms. Each write must
        // reset the inactivity bound, so the process survives past a single idle
        // window and is only stopped by the absolute ceiling.
        args: [
          '-e',
          [
            "process.stdout.write('start ');",
            "setInterval(() => process.stdout.write('. '), 100);",
          ].join(' '),
        ],
        // Full-suite fork load can briefly starve the child process. Keep the
        // idle window below the absolute ceiling, but wide enough that this test
        // fails only when streaming truly stops resetting the inactivity bound.
        timeoutMs: 6_000,
        idleTimeoutMs: 4_000,
        stdoutMaxBytes: 64 * 1024,
        stderrMaxBytes: 1_000,
        sigtermToSigkillGraceMs: 50,
        cwd: tempDir,
      });

      expect(result.timedOut).toBe(true);
      // Would be 'idle' at ~4s if streaming did not reset the bound; getting
      // 'absolute' proves the stream kept the process alive until the ceiling.
      expect(result.timeoutKind).toBe('absolute');
      expect(result.durationMs).toBeGreaterThan(4_000);
    },
  );

  it('caps stdout and stderr without letting connector children grow memory unbounded', async () => {
    const result = await runConnectorSubprocess({
      executable: process.execPath,
      args: [
        '-e',
        ["process.stdout.write('x'.repeat(100));", "process.stderr.write('y'.repeat(100));"].join(
          ' ',
        ),
      ],
      // Hang backstop only — the assertions are about output capping. Under
      // full-suite fork load a node child can take over a second just to
      // start, so a 1s budget false-failed this test on loaded machines.
      timeoutMs: 10_000,
      stdoutMaxBytes: 12,
      stderrMaxBytes: 9,
      sigtermToSigkillGraceMs: 10,
      cwd: tempDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('x'.repeat(12));
    expect(result.stderr).toBe('y'.repeat(9));
    expect(result.stdoutCapped).toBe(true);
    expect(result.stderrCapped).toBe(true);
  });
});

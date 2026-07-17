import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runConnectorSubprocess } from '../../src/connectors/subprocess.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-connector-subprocess-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('connector subprocess lifecycle boundary', () => {
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

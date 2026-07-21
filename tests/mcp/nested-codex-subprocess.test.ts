import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMcpCodexSubprocess } from '../../src/hosts/codex-mcp/nested-codex-subprocess.js';

let tempDir = '';
const descendants = new Set<number>();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-mcp-subprocess-'));
});

afterEach(() => {
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process already stopped.
    }
  }
  descendants.clear();
  rmSync(tempDir, { recursive: true, force: true });
});

function input(args: readonly string[]) {
  return {
    executable: process.execPath,
    args,
    timeoutMs: 10_000,
    stdoutMaxBytes: 1_000,
    stderrMaxBytes: 1_000,
    sigtermToSigkillGraceMs: 50,
    env: process.env,
    cwd: tempDir,
  };
}

describe('MCP nested Codex subprocess', () => {
  it('runs the native executable inside the existing supervisor process group', async () => {
    const result = await runMcpCodexSubprocess(
      input([
        '-e',
        "try { process.kill(-process.pid, 0); process.stdout.write('new-group'); } catch { process.stdout.write('shared-group'); }",
      ]),
    );

    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: 'shared-group' });
  });

  it('caps both captured streams without changing the ordinary connector runner', async () => {
    const result = await runMcpCodexSubprocess({
      ...input([
        '-e',
        "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))",
      ]),
      stdoutMaxBytes: 12,
      stderrMaxBytes: 9,
    });

    expect(result).toMatchObject({
      code: 0,
      stdout: 'a'.repeat(12),
      stderr: 'b'.repeat(9),
      stdoutCapped: true,
      stderrCapped: true,
    });
  });

  it('enforces the inactivity bound', async () => {
    const result = await runMcpCodexSubprocess({
      ...input(['-e', 'setInterval(() => {}, 1000)']),
      timeoutMs: 5_000,
      idleTimeoutMs: 100,
    });

    expect(result).toMatchObject({
      timedOut: true,
      timeoutKind: 'idle',
      killGroupSucceeded: true,
    });
  });

  it('settles at the absolute bound when a descendant keeps inherited pipes open', async () => {
    const descendantPath = join(tempDir, 'descendant.pid');
    const run = runMcpCodexSubprocess({
      ...input([
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: ['ignore', 'inherit', 'inherit'] });",
          `writeFileSync(${JSON.stringify(descendantPath)}, String(descendant.pid));`,
          'setInterval(() => {}, 1000);',
        ].join(' '),
      ]),
      // Leave enough room for a new Node process to start while the full test
      // suite is running in parallel. The assertion below still proves that
      // inherited pipes cannot keep the call open past the absolute bound.
      timeoutMs: 2_000,
    });

    const readyDeadline = Date.now() + 5_000;
    while (!existsSync(descendantPath) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(descendantPath)).toBe(true);
    descendants.add(Number.parseInt(readFileSync(descendantPath, 'utf8'), 10));

    const settled = await Promise.race([
      run.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 4_000)),
    ]);
    expect(settled).toBe(true);
    await expect(run).resolves.toMatchObject({
      timedOut: true,
      timeoutKind: 'absolute',
      killGroupSucceeded: true,
    });
  }, 10_000);
});

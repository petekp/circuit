import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../../src/cli/circuit.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

// `circuit doctor` — proactive connector health. The live incident this
// encodes: a tournament died mid-flight (after real spend on the healthy
// branch) because the codex CLI was broken and cursor-agent was signed out.
// Doctor probes the same binaries a run would relay through, before any
// spend, and answers in plain English with a fix per connector.

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stubBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'circuit-doctor-stub-'));
  tempRoots.push(dir);
  return dir;
}

function writeStub(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

function healthyClaude(dir: string): void {
  writeStub(dir, 'claude', 'echo "9.9.9 (Claude Code stub)"');
}

function healthyCodex(dir: string): void {
  writeStub(
    dir,
    'codex',
    [
      'if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      'exit 1',
    ].join('\n'),
  );
}

function healthyCursorAgent(dir: string): void {
  writeStub(
    dir,
    'cursor-agent',
    [
      'if [ "$1" = "--version" ]; then echo "2099.01.01-stub"; exit 0; fi',
      'if [ "$1" = "status" ]; then echo "Logged in as stub@example.com"; exit 0; fi',
      'exit 1',
    ].join('\n'),
  );
}

describe('circuit doctor', () => {
  it('reports every connector healthy and exits 0', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(0);
    expect(stdout).toContain('claude-code');
    expect(stdout).toContain('9.9.9 (Claude Code stub)');
    expect(stdout).toContain('codex-cli 9.9.9');
    expect(stdout).toContain('2099.01.01-stub');
    expect(stdout.toLowerCase()).toContain('healthy');
  });

  it('names a missing connector, gives the fix, and exits 1', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    // No cursor-agent stub: spawning it fails the way a broken install does.

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(1);
    expect(stdout).toContain('cursor-agent');
    expect(stdout).toContain('needs attention');
    expect(stdout).toContain('Fix:');
  });

  it('emits machine-readable results with --json', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor', '--json'])),
    );

    expect(result).toBe(1);
    const parsed = JSON.parse(stdout) as {
      schema_version: number;
      connectors: Array<{ connector: string; state: string; remediation?: string }>;
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.connectors).toHaveLength(3);
    const cursor = parsed.connectors.find((entry) => entry.connector === 'cursor-agent');
    expect(cursor?.state).toBe('needs_attention');
    expect(cursor?.remediation).toBeTruthy();
    const codex = parsed.connectors.find((entry) => entry.connector === 'codex');
    expect(codex?.state).toBe('ok');
  });
});

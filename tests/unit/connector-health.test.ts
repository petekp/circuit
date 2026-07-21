import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyConnectorHealth,
  probeBuiltinConnector,
  probeBuiltinConnectorPresence,
} from '../../src/connectors/health.js';
import { connectorRemediation } from '../../src/connectors/remediation.js';

// Connector health classification (proactive remediation surfacing). A run
// that relays through a broken or signed-out connector CLI dies mid-flight
// after real spend; `circuit doctor` probes the same binaries first and turns
// what it finds into plain English with a fix. The classifier is pure so the
// probe matrix is testable without spawning anything.

const ran = (input: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}) => ({
  kind: 'ran' as const,
  code: input.code ?? 0,
  stdout: input.stdout ?? '',
  stderr: input.stderr ?? '',
  timedOut: input.timedOut ?? false,
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe('classifyConnectorHealth', () => {
  it('reports ok with the version line when the binary answers', () => {
    const check = classifyConnectorHealth({
      connector: 'claude-code',
      executable: 'claude',
      presence: ran({ stdout: '2.1.201 (Claude Code)\n' }),
    });
    expect(check.state).toBe('ok');
    expect(check.detail).toContain('2.1.201 (Claude Code)');
    expect(check.remediation).toBeUndefined();
  });

  it('reports a missing binary as needs_attention with a fix', () => {
    const check = classifyConnectorHealth({
      connector: 'codex',
      executable: 'codex',
      presence: { kind: 'spawn_error', message: 'spawn codex ENOENT' },
    });
    expect(check.state).toBe('needs_attention');
    expect(check.detail.toLowerCase()).toContain('not found');
    expect(check.remediation).toBe(connectorRemediation('codex'));
  });

  it('reports a failing version probe as needs_attention with the output line', () => {
    const check = classifyConnectorHealth({
      connector: 'codex',
      executable: 'codex',
      presence: ran({ code: 1, stderr: 'dyld: missing native binary\n' }),
    });
    expect(check.state).toBe('needs_attention');
    expect(check.detail).toContain('dyld: missing native binary');
    expect(check.remediation).toBe(connectorRemediation('codex'));
  });

  it('treats a signed-in auth probe as ok and carries both lines', () => {
    const check = classifyConnectorHealth({
      connector: 'cursor-agent',
      executable: 'cursor-agent',
      presence: ran({ stdout: '2026.05.20-2b5dd59\n' }),
      auth: ran({ stdout: '✓ Logged in as pete@example.com\n' }),
    });
    expect(check.state).toBe('ok');
    expect(check.detail).toContain('2026.05.20-2b5dd59');
    expect(check.detail).toContain('Logged in as pete@example.com');
  });

  it('flags a signed-out connector even when the auth probe exits 0', () => {
    const check = classifyConnectorHealth({
      connector: 'cursor-agent',
      executable: 'cursor-agent',
      presence: ran({ stdout: '2026.05.20-2b5dd59\n' }),
      auth: ran({ stdout: 'Not logged in. Run cursor-agent login.\n' }),
    });
    expect(check.state).toBe('needs_attention');
    expect(check.detail.toLowerCase()).toContain('sign');
    expect(check.remediation).toBe(connectorRemediation('cursor-agent'));
  });

  it('flags a non-zero auth probe as needs_attention', () => {
    const check = classifyConnectorHealth({
      connector: 'codex',
      executable: 'codex',
      presence: ran({ stdout: 'codex-cli 0.142.5\n' }),
      auth: ran({ code: 1, stderr: 'You are not logged in\n' }),
    });
    expect(check.state).toBe('needs_attention');
    expect(check.remediation).toBe(connectorRemediation('codex'));
  });

  it('answers honestly with unknown when a probe times out', () => {
    const check = classifyConnectorHealth({
      connector: 'claude-code',
      executable: 'claude',
      presence: ran({ code: null, timedOut: true }),
    });
    expect(check.state).toBe('unknown');
    expect(check.detail.toLowerCase()).toContain('timed out');
  });
});

describe('Codex health executable selection', () => {
  it('probes the host-pinned absolute executable in sealed MCP runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-codex-health-'));
    tempDirs.push(root);
    const executable = join(root, 'trusted-codex');
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "trusted-codex 1.0.0"',
        'elif [ "$1" = "login" ] && [ "$2" = "status" ]; then',
        '  echo "Logged in through trusted codex"',
        'else',
        '  exit 2',
        'fi',
      ].join('\n'),
    );
    chmodSync(executable, 0o755);
    const env = {
      ...process.env,
      CIRCUIT_RUNTIME_SOURCE: 'mcp-spike',
      CIRCUIT_MCP_CODEX_EXECUTABLE: executable,
    };

    const presence = await probeBuiltinConnectorPresence('codex', { env });
    expect(presence).toMatchObject({
      kind: 'ran',
      code: 0,
      stdout: 'trusted-codex 1.0.0\n',
    });

    const health = await probeBuiltinConnector('codex', { env });
    expect(health).toMatchObject({
      connector: 'codex',
      executable,
      state: 'ok',
    });
    expect(health.detail).toContain('Logged in through trusted codex');
  });
});

describe('connectorRemediation', () => {
  it('gives each builtin connector a plain-English fix', () => {
    for (const name of ['claude-code', 'codex', 'cursor-agent'] as const) {
      const fix = connectorRemediation(name);
      expect(fix.length).toBeGreaterThan(20);
      expect(fix).not.toContain('undefined');
    }
    expect(connectorRemediation('codex')).toContain('@openai/codex');
    expect(connectorRemediation('cursor-agent')).toContain('cursor-agent login');
  });
});

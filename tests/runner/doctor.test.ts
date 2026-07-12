import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../../src/cli/circuit.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

// `circuit doctor` — a readiness report for the connectors your runs actually
// route through. The live incident this encodes: a tournament died mid-flight
// (after real spend on the healthy branch) because the codex CLI was broken
// and cursor-agent was signed out. Doctor probes the same binaries a run
// would relay through, before any spend, and answers in plain English with a
// fix per connector — but it only grades readiness (and the exit code) on the
// connectors this machine's flows actually route through, so a healthy
// machine with only claude-code installed is not a false alarm about codex
// and cursor-agent it never dispatches to.
//
// This repo's own `.circuit/config.yaml` sets `relay: { default: auto }` with
// no role/flow overrides, so under the real config discovery these tests run
// against, the routed set is exactly `{claude-code}` unless a test overrides
// `CIRCUIT_HOST_KIND`.

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

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

describe('circuit doctor: readiness on the routed set', () => {
  it('reports the routed claude-code healthy, verdict Ready first, and exits 0', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(0);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Ready.');
    // The verdict line comes before the per-connector detail.
    expect(plain.indexOf('Ready.')).toBeLessThan(plain.indexOf('claude-code'));
    expect(plain).toContain('9.9.9 (Claude Code stub)');
  });

  it('a broken routed connector (claude-code) names it, gives the fix, and exits 1', async () => {
    const bin = stubBinDir();
    // No claude stub: spawning it fails the way a broken install does.
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(1);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Not ready');
    expect(plain).toContain('claude-code');
    expect(plain).toContain('needs attention');
    expect(plain).toContain('Fix:');
  });

  it('a broken but unrouted connector (cursor-agent) is reported informationally and exits 0', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    // No cursor-agent stub, but cursor-agent is not in the routed set on this
    // repo's config, so it must not sink the exit code.

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(0);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Ready.');
    expect(plain).toContain('cursor-agent');
    expect(plain).toContain('needs attention');
  });

  it('renders one table: ROUTED VIA names the resolution source, unrouted rows show -', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    const plain = stripAnsi(stdout);
    // One table, one header.
    expect(plain.match(/CONNECTOR/g)).toHaveLength(1);
    expect(plain).toContain('ROUTED VIA');
    const rows = plain.split('\n').filter((line) => /^\S/.test(line));
    const claudeRow = rows.find((line) => line.startsWith('claude-code'));
    const codexRow = rows.find((line) => line.startsWith('codex'));
    const cursorRow = rows.find((line) => line.startsWith('cursor-agent'));
    // The routed connector names its resolution source; unrouted rows show -.
    expect(claudeRow).toContain('auto');
    expect(codexRow).toMatch(/codex\s+-\s/);
    expect(cursorRow).toMatch(/cursor-agent\s+-\s/);
    // Routed rows sort first.
    expect(plain.indexOf('claude-code')).toBeLessThan(plain.indexOf('codex'));
    // The footer teaches the routing lever.
    expect(plain).toContain('circuit config set relay.default');
  });

  it('CIRCUIT_HOST_KIND=codex routes codex instead of claude-code', async () => {
    const bin = stubBinDir();
    // No claude stub at all: codex is the routed connector under this host
    // kind, so a missing claude-code must not affect readiness.
    healthyCodex(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin, CIRCUIT_HOST_KIND: 'codex' }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(0);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Ready.');
    expect(plain.indexOf('routed connectors')).toBeLessThan(plain.indexOf('codex'));
  });

  it('CIRCUIT_HOST_KIND=codex with a broken codex exits 1', async () => {
    const bin = stubBinDir();
    // No codex stub: codex is routed under this host kind and broken.

    const { result, stdout } = await withScopedEnv({ PATH: bin, CIRCUIT_HOST_KIND: 'codex' }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(1);
    expect(stripAnsi(stdout)).toContain('Not ready');
  });

  it('degrades to identical plain characters with NO_COLOR set', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { stdout } = await withScopedEnv({ PATH: bin, NO_COLOR: '1' }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(stdout).not.toContain(String.fromCharCode(27));
    expect(stdout).toBe(stripAnsi(stdout));
  });

  it('emits machine-readable results with --json: schema_version 2, ready, routed_connectors, per-entry routed', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    // No cursor-agent stub (unrouted and broken; must not affect `ready`).

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor', '--json'])),
    );

    expect(result).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schema_version: number;
      ready: boolean;
      routed_connectors: string[];
      connectors: Array<{
        connector: string;
        state: string;
        remediation?: string;
        routed: boolean;
        routed_via: string[];
      }>;
    };
    expect(parsed.schema_version).toBe(2);
    expect(parsed.ready).toBe(true);
    expect(parsed.routed_connectors).toEqual(['claude-code']);
    expect(parsed.connectors).toHaveLength(3);

    const claude = parsed.connectors.find((entry) => entry.connector === 'claude-code');
    expect(claude?.state).toBe('ok');
    expect(claude?.routed).toBe(true);
    expect(claude?.routed_via).toEqual(['auto']);

    const cursor = parsed.connectors.find((entry) => entry.connector === 'cursor-agent');
    expect(cursor?.state).toBe('needs_attention');
    expect(cursor?.remediation).toBeTruthy();
    expect(cursor?.routed).toBe(false);
    expect(cursor?.routed_via).toEqual([]);

    const codex = parsed.connectors.find((entry) => entry.connector === 'codex');
    expect(codex?.state).toBe('ok');
    expect(codex?.routed).toBe(false);
  });

  it('--json reports ready=false and exits 1 when the routed connector is broken', async () => {
    const bin = stubBinDir();
    // No claude stub: the routed connector is broken.
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor', '--json'])),
    );

    expect(result).toBe(1);
    const parsed = JSON.parse(stdout) as { ready: boolean; routed_connectors: string[] };
    expect(parsed.ready).toBe(false);
    expect(parsed.routed_connectors).toEqual(['claude-code']);
  });
});

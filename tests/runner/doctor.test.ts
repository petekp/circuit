import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../../src/cli/circuit.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';
import { type EnvValue, setEnv, withScopedEnv } from '../helpers/scoped-env.js';

// `circuit doctor` — a readiness report for the connectors your runs would
// actually use. The live incident this encodes: a tournament died mid-flight
// (after real spend on the healthy branch) because the codex CLI was broken
// and cursor-agent was signed out. Doctor probes the same binaries a run
// would relay through, before any spend, and answers in plain English with a
// fix per connector — but it only grades readiness (and the exit code) on the
// connectors this machine's flows would actually choose, so a healthy
// machine with only claude-code installed is not a false alarm about codex
// and cursor-agent it never dispatches to.
//
// Each test runs from a throwaway project root holding one line of config:
// `relay: { default: auto }`, no role or flow overrides, so the chosen set is
// exactly `{claude-code}` unless a test overrides `CIRCUIT_HOST_KIND`.
//
// It used to run from the repo itself and inherit whatever was in the repo's
// own gitignored `.circuit/config.yaml`. That made the outcome depend on an
// untracked file: doctor now also grades flow readiness, and a local
// `flows.build.selection.effort` pin — a real one, sitting in this checkout —
// turned every "exits 0" case red on one machine and green on CI. A readiness
// test has to state the config it grades.

const tempRoots: string[] = [];
let previousCwd: string | undefined;

function isolatedProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-doctor-project-'));
  tempRoots.push(root);
  mkdirSync(join(root, '.circuit'), { recursive: true });
  writeFileSync(
    join(root, '.circuit', 'config.yaml'),
    'schema_version: 1\nrelay:\n  default: auto\n',
  );
  return root;
}

let previousHome: EnvValue;

beforeEach(() => {
  const root = isolatedProjectRoot();
  previousCwd = process.cwd();
  process.chdir(root);
  // The user-global layer is the same hazard one directory up. Nobody has
  // `~/.circuit/config.yaml` today, which is exactly why an inherited one
  // would be a mystery when it appears.
  previousHome = process.env.HOME;
  setEnv('HOME', join(root, 'home'));
  mkdirSync(join(root, 'home'), { recursive: true });
});

afterEach(() => {
  setEnv('HOME', previousHome);
  if (previousCwd !== undefined) process.chdir(previousCwd);
  previousCwd = undefined;
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

describe('circuit doctor: readiness on the chosen set', () => {
  it('reports the chosen claude-code healthy, verdict Ready first, and exits 0', async () => {
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

  it('a broken chosen connector (claude-code) names it, gives the fix, and exits 1', async () => {
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

  it('a broken but unchosen connector (cursor-agent) is reported informationally and exits 0', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    // No cursor-agent stub, but cursor-agent is not in the chosen set on this
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

  it('renders one table: CHOSEN BY names the resolution source, unchosen rows show -', async () => {
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
    expect(plain).toContain('CHOSEN BY');
    const rows = plain.split('\n').filter((line) => /^\S/.test(line));
    const claudeRow = rows.find((line) => line.startsWith('claude-code'));
    const codexRow = rows.find((line) => line.startsWith('codex'));
    const cursorRow = rows.find((line) => line.startsWith('cursor-agent'));
    // The chosen connector names its resolution source; unchosen rows show -.
    expect(claudeRow).toContain('auto');
    expect(codexRow).toMatch(/codex\s+-\s/);
    expect(cursorRow).toMatch(/cursor-agent\s+-\s/);
    // Chosen rows sort first.
    expect(plain.indexOf('claude-code')).toBeLessThan(plain.indexOf('codex'));
    // The footer teaches the config lever behind the choice.
    expect(plain).toContain('circuit config set relay.default');
  });

  // M1 — the footer's remedies must work when pasted. relay.roles.* and
  // relay.flows.* take connector reference objects, so a bare-name suggestion
  // like `relay.roles.reviewer codex` would be rejected by `config set`.
  it('footer remedies work as pasted: object-typed keys show the object form', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor'])),
    );

    const plain = stripAnsi(stdout);
    // The bare-name form fails when pasted; it must not be suggested.
    expect(plain).not.toMatch(/relay\.roles\.reviewer codex/);
    expect(plain).not.toMatch(/relay\.flows\.fix[^ ]* codex/);
    // Whatever role/flow lever the footer teaches must carry the object form.
    expect(plain).toContain("'{kind: builtin, name: codex}'");
  });

  it('CIRCUIT_HOST_KIND=codex chooses codex instead of claude-code', async () => {
    const bin = stubBinDir();
    // No claude stub at all: codex is the chosen connector under this host
    // kind, so a missing claude-code must not affect readiness.
    healthyCodex(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin, CIRCUIT_HOST_KIND: 'codex' }, () =>
      captureStreams(() => main(['doctor'])),
    );

    expect(result).toBe(0);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Ready.');
    const rows = plain.split('\n').filter((line) => /^\S/.test(line));
    const codexRow = rows.find((line) => line.startsWith('codex'));
    const claudeRow = rows.find((line) => line.startsWith('claude-code'));
    // Codex carries the resolution source; claude-code is unchosen here.
    expect(codexRow).toContain('auto');
    expect(claudeRow).toMatch(/claude-code\s+-\s/);
    // The chosen row sorts first.
    expect(plain.indexOf('codex')).toBeLessThan(plain.indexOf('claude-code'));
  });

  it('CIRCUIT_HOST_KIND=codex with a broken codex exits 1', async () => {
    const bin = stubBinDir();
    // No codex stub: codex is chosen under this host kind and broken.

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

  it('emits machine-readable results with --json: schema_version 2, ready, chosen_connectors, per-entry chosen', async () => {
    const bin = stubBinDir();
    healthyClaude(bin);
    healthyCodex(bin);
    // No cursor-agent stub (unchosen and broken; must not affect `ready`).

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor', '--json'])),
    );

    expect(result).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schema_version: number;
      ready: boolean;
      chosen_connectors: string[];
      connectors: Array<{
        connector: string;
        state: string;
        remediation?: string;
        chosen: boolean;
        chosen_by: string[];
      }>;
    };
    expect(parsed.schema_version).toBe(2);
    expect(parsed.ready).toBe(true);
    expect(parsed.chosen_connectors).toEqual(['claude-code']);
    expect(parsed.connectors).toHaveLength(3);

    const claude = parsed.connectors.find((entry) => entry.connector === 'claude-code');
    expect(claude?.state).toBe('ok');
    expect(claude?.chosen).toBe(true);
    expect(claude?.chosen_by).toEqual(['auto']);

    const cursor = parsed.connectors.find((entry) => entry.connector === 'cursor-agent');
    expect(cursor?.state).toBe('needs_attention');
    expect(cursor?.remediation).toBeTruthy();
    expect(cursor?.chosen).toBe(false);
    expect(cursor?.chosen_by).toEqual([]);

    const codex = parsed.connectors.find((entry) => entry.connector === 'codex');
    expect(codex?.state).toBe('ok');
    expect(codex?.chosen).toBe(false);
  });

  it('--json reports ready=false and exits 1 when the chosen connector is broken', async () => {
    const bin = stubBinDir();
    // No claude stub: the chosen connector is broken.
    healthyCodex(bin);
    healthyCursorAgent(bin);

    const { result, stdout } = await withScopedEnv({ PATH: bin }, () =>
      captureStreams(() => main(['doctor', '--json'])),
    );

    expect(result).toBe(1);
    const parsed = JSON.parse(stdout) as { ready: boolean; chosen_connectors: string[] };
    expect(parsed.ready).toBe(false);
    expect(parsed.chosen_connectors).toEqual(['claude-code']);
  });
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  codexStateDir,
  probeStateDirWritable,
  stateDirUnwritableSummary,
} from '../../src/connectors/state-dir.js';

// The state-directory probe backs run-intake preflight and `circuit doctor`.
// It must prove writability with a REAL write (sandboxes pass stat-based
// checks and deny the write itself) and leave the machine exactly as found.

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-state-dir-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('codexStateDir', () => {
  it('honors CODEX_HOME when set', () => {
    expect(codexStateDir({ CODEX_HOME: '/custom/codex-home' })).toBe('/custom/codex-home');
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or blank', () => {
    expect(codexStateDir({})).toMatch(/\/\.codex$/);
    expect(codexStateDir({ CODEX_HOME: '  ' })).toMatch(/\/\.codex$/);
  });
});

describe('probeStateDirWritable', () => {
  it('reports writable for a writable directory and leaves no probe file behind', () => {
    const dir = join(tempRoot(), 'state');
    mkdirSync(dir);
    const probe = probeStateDirWritable(dir);
    expect(probe.writable).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports unwritable with the failure detail for a read-only directory', () => {
    const dir = join(tempRoot(), 'readonly-state');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    cleanups.push(() => chmodSync(dir, 0o700));
    const probe = probeStateDirWritable(dir);
    expect(probe.writable).toBe(false);
    if (!probe.writable) {
      expect(probe.dir).toBe(dir);
      expect(probe.detail.length).toBeGreaterThan(0);
    }
  });

  it('creates and removes a missing directory, leaving the machine as found', () => {
    const parent = join(tempRoot(), 'never-ran-codex');
    mkdirSync(parent);
    const missing = join(parent, '.codex');
    const probe = probeStateDirWritable(missing);
    expect(probe.writable).toBe(true);
    expect(existsSync(missing)).toBe(false);
  });

  it('reports unwritable when the missing directory cannot be created', () => {
    const parent = join(tempRoot(), 'sealed');
    mkdirSync(parent);
    chmodSync(parent, 0o500);
    cleanups.push(() => chmodSync(parent, 0o700));
    const probe = probeStateDirWritable(join(parent, '.codex'));
    expect(probe.writable).toBe(false);
  });
});

describe('stateDirUnwritableSummary', () => {
  it('names the directory, the setup fault, and the next step', () => {
    const summary = stateDirUnwritableSummary('codex', '/Users/op/.codex');
    expect(summary).toContain(
      'The codex CLI could not write its state directory (/Users/op/.codex).',
    );
    expect(summary).toContain('setup problem, not a task failure');
    expect(summary).toContain('sandboxed session');
    expect(summary).toContain('Rerun Circuit outside the sandbox');
  });

  it('stays grammatical when the directory is unknown', () => {
    const summary = stateDirUnwritableSummary('codex', undefined);
    expect(summary).toContain('The codex CLI could not write its state directory.');
  });
});

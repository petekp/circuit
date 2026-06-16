import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultProcessAlive,
  isRunLiveByOwnerLock,
  ownerLockPath,
  removeOwnerLock,
  writeOwnerLock,
} from '../../src/runtime/fanout/run-owner-lock.js';

describe('run owner lock', () => {
  let worktreesRoot: string;

  beforeEach(async () => {
    worktreesRoot = await mkdtemp(join(tmpdir(), 'owner-lock-'));
  });

  afterEach(async () => {
    await rm(worktreesRoot, { recursive: true, force: true });
  });

  it('writes a lock recording the current pid and reads it back as live', () => {
    writeOwnerLock(worktreesRoot, 'run-1', '2026-06-16T00:00:00.000Z');
    const raw = JSON.parse(readFileSync(ownerLockPath(worktreesRoot, 'run-1'), 'utf8'));
    expect(raw.pid).toBe(process.pid);
    expect(raw.started_at).toBe('2026-06-16T00:00:00.000Z');
    // The current process is, by definition, alive.
    expect(isRunLiveByOwnerLock(worktreesRoot, 'run-1')).toBe(true);
  });

  it('treats a missing lock as not live (falls back to the trace verdict)', () => {
    expect(isRunLiveByOwnerLock(worktreesRoot, 'never-written')).toBe(false);
  });

  it('treats a lock whose pid is gone as not live', () => {
    writeOwnerLock(worktreesRoot, 'run-2', '2026-06-16T00:00:00.000Z');
    // Inject a dead-pid check so the test is hermetic (no real pid required).
    expect(isRunLiveByOwnerLock(worktreesRoot, 'run-2', () => false)).toBe(false);
  });

  it('treats an unparseable lock as not live', () => {
    writeOwnerLock(worktreesRoot, 'run-3', '2026-06-16T00:00:00.000Z');
    // Overwrite with garbage; a corrupt lock must never read as proof of life.
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(ownerLockPath(worktreesRoot, 'run-3'), 'not json', 'utf8');
    expect(isRunLiveByOwnerLock(worktreesRoot, 'run-3')).toBe(false);
  });

  it('removeOwnerLock is idempotent', () => {
    writeOwnerLock(worktreesRoot, 'run-4', '2026-06-16T00:00:00.000Z');
    expect(existsSync(ownerLockPath(worktreesRoot, 'run-4'))).toBe(true);
    removeOwnerLock(worktreesRoot, 'run-4');
    expect(existsSync(ownerLockPath(worktreesRoot, 'run-4'))).toBe(false);
    // Second removal of an already-absent lock must not throw.
    expect(() => removeOwnerLock(worktreesRoot, 'run-4')).not.toThrow();
  });

  it('defaultProcessAlive reports the current process alive and rejects bad pids', () => {
    expect(defaultProcessAlive(process.pid)).toBe(true);
    expect(defaultProcessAlive(0)).toBe(false);
    expect(defaultProcessAlive(-1)).toBe(false);
  });
});

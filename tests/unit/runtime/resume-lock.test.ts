import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessAliveCheck } from '../../../src/runtime/fanout/run-owner-lock.js';
import {
  RESUME_IN_PROGRESS_MESSAGE,
  acquireResumeLock,
  resumeLockPath,
} from '../../../src/runtime/run/resume-lock.js';

// H5 — two concurrent `circuit resume` calls against the same run both compute
// the same nextSequence and both append trace entries stamped with it. Duplicate
// sequences make every later trace-store load() throw forever: the durable run
// is bricked. The resume owner lock is the exclusive guard that must let exactly
// one resume proceed. These tests pin the guard directly.

const DEAD_PID = 2147483646; // never a live pid in the test process
const aliveOnlyThisProcess: ProcessAliveCheck = (pid) => pid === process.pid;

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'circuit-resume-lock-'));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function readLockPid(): number {
  return JSON.parse(readFileSync(resumeLockPath(runDir), 'utf8')).pid;
}

describe('resume owner lock', () => {
  it('acquires when no lock exists and records the current pid', () => {
    const result = acquireResumeLock(runDir);
    expect(result.ok).toBe(true);
    expect(existsSync(resumeLockPath(runDir))).toBe(true);
    expect(readLockPid()).toBe(process.pid);
  });

  it('refuses a second acquire while the first is held by a live owner', () => {
    const first = acquireResumeLock(runDir);
    expect(first.ok).toBe(true);

    const second = acquireResumeLock(runDir);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.message).toBe(RESUME_IN_PROGRESS_MESSAGE);
  });

  it('lets a fresh acquire succeed after the first releases', () => {
    const first = acquireResumeLock(runDir);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    first.handle.release();
    expect(existsSync(resumeLockPath(runDir))).toBe(false);

    const second = acquireResumeLock(runDir);
    expect(second.ok).toBe(true);
  });

  it('reclaims a stale lock whose recorded owner pid is dead', () => {
    // A previous resume crashed holding the lock: the file survives with a pid
    // that is no longer running. A later legitimate resume MUST reclaim it, or
    // every crash becomes a permanent brick — trading one brick for another.
    writeFileSync(
      resumeLockPath(runDir),
      JSON.stringify({ schema_version: 1, pid: DEAD_PID, acquired_at: '2026-07-09T00:00:00.000Z' }),
      'utf8',
    );

    const result = acquireResumeLock(runDir, { processAlive: aliveOnlyThisProcess });
    expect(result.ok).toBe(true);
    // The reclaimed lock now records the new owner (this process).
    expect(readLockPid()).toBe(process.pid);
  });

  it('does NOT reclaim a lock whose recorded owner pid is still alive', () => {
    // Owner is alive (defaultProcessAlive would report our own pid alive) — the
    // second attempt must refuse, never steal a live owner's lock.
    const first = acquireResumeLock(runDir);
    expect(first.ok).toBe(true);
    const second = acquireResumeLock(runDir, { processAlive: aliveOnlyThisProcess });
    expect(second.ok).toBe(false);
  });

  it('refuses while another reclaim of the same stale lock is already in progress', () => {
    // The stale-reclaim path is itself serialized behind an internal O_EXCL
    // intent file so two racing reclaimers cannot both rm-and-recreate the
    // primary and both believe they own it — that double acquire is the exact
    // duplicate-sequence brick the lock exists to prevent. Here the primary is
    // stale (dead owner) but a live reclaimer already holds the intent, so a
    // new acquire must refuse rather than barge in.
    const intentPath = join(runDir, 'resume.lock.reclaiming'); // internal intent file
    writeFileSync(
      resumeLockPath(runDir),
      JSON.stringify({ schema_version: 1, pid: DEAD_PID, acquired_at: '2026-07-09T00:00:00.000Z' }),
      'utf8',
    );
    writeFileSync(
      intentPath,
      JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        acquired_at: '2026-07-09T00:00:00.000Z',
      }),
      'utf8',
    );
    const result = acquireResumeLock(runDir, { processAlive: aliveOnlyThisProcess });
    expect(result.ok).toBe(false);
  });

  it('release is idempotent (a second release does not throw)', () => {
    const first = acquireResumeLock(runDir);
    if (!first.ok) throw new Error('unreachable');
    first.handle.release();
    expect(() => first.handle.release()).not.toThrow();
  });
});

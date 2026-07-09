// Resume owner lock — the exclusive guard that lets exactly one `circuit resume`
// touch a run folder at a time.
//
// The hazard (audit H5): resume has no cross-process guard. Two concurrent
// resumes both load the trace, both compute the SAME nextSequence, and both
// append entries stamped with it. TraceStore.load() enforces contiguous
// sequences, so once a duplicate sequence is on disk EVERY later load() throws —
// forever. The durable run record is unrecoverable.
//
// The fix mirrors the only exclusive-create primitive already in the codebase:
// manifest-snapshot.ts opens its snapshot with `flag: 'wx'` (O_EXCL) to guard a
// FRESH run start. O_EXCL is the filesystem's one atomic mutual-exclusion
// primitive: exactly one racing create wins, every other gets EEXIST. Resume
// takes the same lock at its entrypoint.
//
// A plain O_EXCL lock has one failure mode: a resume that crashes while holding
// it leaves the file behind, and a naive lock would then refuse every future
// resume — trading the concurrency brick for a crash brick. So the lock records
// its owner's pid and reclaims a stale lock whose owner is provably gone, reusing
// the same pid-liveness check the worktree reaper uses (`defaultProcessAlive`,
// `process.kill(pid, 0)`). The reclaim itself is serialized behind a second
// O_EXCL intent file so two racing reclaimers cannot both rm-and-recreate the
// primary and both believe they own it — that double acquire is the very
// duplicate-sequence brick this lock exists to prevent.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProcessAliveCheck, defaultProcessAlive } from '../fanout/run-owner-lock.js';

const RESUME_LOCK_FILENAME = 'resume.lock';
const RESUME_RECLAIM_FILENAME = 'resume.lock.reclaiming';
// Each pass makes definite progress (acquire, refuse, or clear one stale file),
// so this bound only guards against pathological churn from relentless racers.
const MAX_ACQUIRE_ATTEMPTS = 8;

/** Plain-English refusal shown when another resume already owns this run. */
export const RESUME_IN_PROGRESS_MESSAGE =
  'Another resume is already running for this run. Wait for it to finish before resuming again.';

interface ResumeLockRecord {
  readonly schema_version: 1;
  readonly pid: number;
  readonly acquired_at: string;
}

/** Absolute path to a run's resume lock. */
export function resumeLockPath(runDir: string): string {
  return join(runDir, RESUME_LOCK_FILENAME);
}

function reclaimIntentPath(runDir: string): string {
  return join(runDir, RESUME_RECLAIM_FILENAME);
}

export interface ResumeLockHandle {
  /** Release the lock. Best-effort and idempotent — safe to call more than once. */
  release(): void;
}

export type AcquireResumeLockResult =
  | { readonly ok: true; readonly handle: ResumeLockHandle }
  | { readonly ok: false; readonly message: string };

export interface AcquireResumeLockOptions {
  readonly now?: () => Date;
  /** Injected so tests can drive the stale-reclaim path without real pids. */
  readonly processAlive?: ProcessAliveCheck;
}

/**
 * O_EXCL create. Returns true if we created the file, false on EEXIST. Any other
 * error (a broken run dir, permissions) is a real failure and rethrows — a lock
 * we cannot reason about must never masquerade as acquired.
 */
function createExclusive(path: string, payload: string): boolean {
  try {
    writeFileSync(path, payload, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** The recorded owner pid, or undefined if the lock is missing or unparseable. */
function recordedPid(path: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    return undefined;
  }
  return typeof pid === 'number' ? pid : undefined;
}

/**
 * True when the lock at `path` is held by a process that is still alive. A
 * missing or corrupt lock is NOT proof of life (returns false), so a crashed
 * owner's lock is always reclaimable — the fail-safe direction here, since a
 * false "dead" only costs a reclaimed lock while a false "alive" would wedge
 * every future resume.
 */
function heldByLiveOwner(path: string, processAlive: ProcessAliveCheck): boolean {
  const pid = recordedPid(path);
  return pid === undefined ? false : processAlive(pid);
}

/**
 * Acquire the resume lock for `runDir`, or refuse. On success the returned
 * handle must be released when the resume completes (or the process exits). On
 * refusal the caller surfaces `message` to the operator and does NOT touch the
 * trace.
 */
export function acquireResumeLock(
  runDir: string,
  options: AcquireResumeLockOptions = {},
): AcquireResumeLockResult {
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const now = options.now ?? (() => new Date());
  const primary = resumeLockPath(runDir);
  const intent = reclaimIntentPath(runDir);

  const payload = (): string => {
    const record: ResumeLockRecord = {
      schema_version: 1,
      pid: process.pid,
      acquired_at: now().toISOString(),
    };
    return JSON.stringify(record);
  };

  const handle: ResumeLockHandle = {
    release() {
      try {
        rmSync(primary, { force: true });
      } catch {
        // A leftover lock records this now-exiting pid, so the next resume reads
        // it as dead and reclaims it — a failed remove is never a brick. Cleanup
        // must never throw.
      }
    },
  };

  // The run dir exists for a real resume (it holds the trace), but be defensive
  // so a missing dir surfaces as a normal create error, not a phantom lock.
  mkdirSync(runDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    // Fast path — the whole common case. Two resumes of a not-crashed run race
    // here and exactly one create wins.
    if (createExclusive(primary, payload())) {
      return { ok: true, handle };
    }
    // A lock already exists. If its owner is alive, refuse — never steal a live
    // resume's lock.
    if (heldByLiveOwner(primary, processAlive)) {
      return { ok: false, message: RESUME_IN_PROGRESS_MESSAGE };
    }
    // The primary is stale (owner crashed). Reclaim it under an O_EXCL intent
    // lock so at most one reclaimer performs the rm-and-recreate below.
    if (!createExclusive(intent, payload())) {
      // Another reclaimer is mid-flight. If it is alive it wins — refuse. If its
      // intent is itself stale (it crashed inside the tiny reclaim window), clear
      // it and retry so the reclaim can complete.
      if (heldByLiveOwner(intent, processAlive)) {
        return { ok: false, message: RESUME_IN_PROGRESS_MESSAGE };
      }
      rmSync(intent, { force: true });
      continue;
    }
    try {
      // We alone may touch the primary now. Re-check under the intent lock: a
      // fresh live resume takes the primary directly (not this reclaim path), so
      // it may have replaced the stale file since our liveness check above.
      if (heldByLiveOwner(primary, processAlive)) {
        return { ok: false, message: RESUME_IN_PROGRESS_MESSAGE };
      }
      rmSync(primary, { force: true });
      if (createExclusive(primary, payload())) {
        return { ok: true, handle };
      }
      // A fresh resume grabbed the primary in the gap after our rm. Loop: the
      // next pass reads it and refuses (alive) or reclaims it (dead).
    } finally {
      rmSync(intent, { force: true });
    }
  }

  // Exhausted retries against relentless churn: refuse rather than risk a double
  // acquire. From the operator's view another resume is effectively in progress.
  return { ok: false, message: RESUME_IN_PROGRESS_MESSAGE };
}

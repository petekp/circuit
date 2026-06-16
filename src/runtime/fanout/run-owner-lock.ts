// Run owner lock — a liveness signal for the worktree reaper.
//
// The reaper's hard problem: a run that is *still running* mid-fanout leaves a
// trace that is byte-for-byte the same shape as a run that crashed between
// checkpoints (a `run.bootstrapped`, a `fanout.started`, and nothing closing —
// no `run.closed`, no parked `checkpoint.requested`). The trace alone cannot
// tell "running now" from "crashed", so reaping on the trace verdict alone
// would force-remove a live run's worktree and destroy its uncommitted work.
//
// The fix is an out-of-band liveness signal. While a fanout step holds
// worktrees, the owning process writes this lock next to them, recording its
// own pid. A live process's pid stays alive; a SIGKILL leaves the lock behind
// with a pid that is no longer running. The reaper keeps any worktree whose
// owner pid is still alive and only considers the trace verdict once the owner
// is provably gone. This also gives self-exclusion for free: a process never
// reaps a run whose owner — possibly itself — is still alive.
//
// The lock lives at `<worktreesRoot>/<runId>/.owner.json`, a sibling of the
// per-step worktree directories. The reaper's directory walk only descends into
// subdirectories, so the lock file is never mistaken for a step directory.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OWNER_LOCK_FILENAME = '.owner.json';

interface OwnerLock {
  readonly schema_version: 1;
  readonly pid: number;
  readonly started_at: string;
}

/** Whether a process id is currently alive. Injected so tests stay hermetic. */
export type ProcessAliveCheck = (pid: number) => boolean;

/** Absolute path to a run's owner lock under the worktrees root. */
export function ownerLockPath(worktreesRoot: string, runId: string): string {
  return join(worktreesRoot, runId, OWNER_LOCK_FILENAME);
}

/**
 * Record the current process as the owner of `runId`'s worktrees. Synchronous
 * so the lock is durable before any worktree is added (a live process always
 * has its lock present by the time a worktree exists on disk). Best-effort: a
 * write failure must not abort the fanout it guards.
 */
export function writeOwnerLock(worktreesRoot: string, runId: string, startedAt: string): void {
  const lock: OwnerLock = { schema_version: 1, pid: process.pid, started_at: startedAt };
  try {
    mkdirSync(join(worktreesRoot, runId), { recursive: true });
    writeFileSync(ownerLockPath(worktreesRoot, runId), JSON.stringify(lock), 'utf8');
  } catch {
    // The lock is an optimization, not a correctness requirement on the write
    // side: a missing lock simply makes the reaper fall back to the trace
    // verdict. Never let a lock-write failure break the run it guards.
  }
}

/** Remove a run's owner lock. Best-effort and idempotent (missing is fine). */
export function removeOwnerLock(worktreesRoot: string, runId: string): void {
  try {
    rmSync(ownerLockPath(worktreesRoot, runId), { force: true });
  } catch {
    // A leftover lock is harmless: it points at a dead pid, so the reaper still
    // treats the run as not-live. Swallow so cleanup never throws.
  }
}

/**
 * Default liveness check: `process.kill(pid, 0)` signals nothing but probes
 * existence. ESRCH means the process is gone; EPERM means it exists but we may
 * not signal it (still alive). Any other outcome is treated as alive — the
 * fail-safe direction, since the cost of a false "alive" is a kept orphan
 * (reclaimable later) while a false "dead" destroys live work.
 */
export const defaultProcessAlive: ProcessAliveCheck = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/**
 * True when `runId` has an owner lock whose recorded pid is still alive. A
 * missing or unparseable lock is NOT proof of life, so it returns false and the
 * reaper falls back to classifying the run from its trace.
 */
export function isRunLiveByOwnerLock(
  worktreesRoot: string,
  runId: string,
  processAlive: ProcessAliveCheck = defaultProcessAlive,
): boolean {
  let raw: string;
  try {
    raw = readFileSync(ownerLockPath(worktreesRoot, runId), 'utf8');
  } catch {
    return false;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    return false;
  }
  if (typeof pid !== 'number') return false;
  return processAlive(pid);
}

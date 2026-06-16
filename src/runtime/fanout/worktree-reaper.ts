// Worktree reaper — reclaims per-branch fanout worktrees a crash orphaned.
//
// A fanout step provisions one git worktree per branch under
// `<projectRoot>/.circuit/worktrees/<runId>/<stepId>/<branchId>` and removes
// them in a `finally` block (`fanout.ts`). A `finally` does not run under
// SIGKILL, so a process killed mid-fanout leaves those worktrees on disk with
// nothing to reclaim them. This reaper is the reclaimer: it runs *after* the
// crash, on a later invocation, walks the deterministic worktree layout, and
// removes the worktrees whose owning run is closed or dead — while leaving the
// worktrees of a live, parked run (one waiting at an unresolved operator
// checkpoint) untouched.
//
// The module is pure and fully injectable so it can be tested with a fake
// worktree runner and a stubbed status reader. The defaults wire it to the real
// filesystem layout and the real trace store.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceEntry } from '../domain/trace.js';
import type { WorktreeRunner } from '../run/child-runner.js';
import { TraceStore } from '../trace/trace-store.js';
import { gitWorktreeRunner } from './worktree.js';

/**
 * Status of the run that owns a worktree, as the reaper needs to decide.
 *
 * - `closed`      — the run finished cleanly (its trace has a `run.closed`
 *                   entry). Its worktrees are safe to reclaim.
 * - `dead`        — the run has no `run.closed` and is not parked at an
 *                   unresolved checkpoint. This is the audit's dead-folder
 *                   shape: a crash landed between checkpoints, or the run
 *                   folder is gone entirely. Its worktrees are safe to reclaim.
 * - `live-parked` — the run is paused at an unresolved operator checkpoint and
 *                   may still resume forward. Its worktrees must be LEFT ALONE.
 * - `unknown`     — the owning run's status could not be determined (its trace
 *                   is unreadable or fails to parse). The reaper cannot prove
 *                   the run is dead, so it must LEAVE THE WORKTREE ALONE rather
 *                   than risk destroying a live run's work. Fail safe.
 *
 * The reaper removes a worktree only when its owning run is `closed` or `dead`.
 * Both `live-parked` and `unknown` are kept.
 */
export type OwningRunStatus = 'closed' | 'dead' | 'live-parked' | 'unknown';

/** Resolve the owning run's status from its id. Injected so tests can stub it. */
export type ResolveRunStatus = (runId: string) => OwningRunStatus | Promise<OwningRunStatus>;

/**
 * Lists the worktree leaf directories under a worktrees root, returning, for
 * each, the absolute path plus the `runId` that owns it. Injected so tests can
 * stub the filesystem walk; the default reads the real on-disk layout.
 */
export type WorktreeLister = (worktreesRoot: string) => Promise<readonly WorktreeEntry[]>;

export interface WorktreeEntry {
  /** Absolute path to the `worktrees/<runId>/<stepId>/<branchId>` directory. */
  readonly path: string;
  /** The id of the run that provisioned this worktree. */
  readonly runId: string;
}

export interface ReapWorktreesOptions {
  /** Absolute path to `<projectRoot>/.circuit/worktrees`. */
  readonly worktreesRoot: string;
  /** Resolves the owning run's status by run id. */
  readonly resolveRunStatus: ResolveRunStatus;
  /** Worktree runner whose `remove` reclaims a worktree. Defaults to git. */
  readonly worktreeRunner?: WorktreeRunner;
  /** Lists worktree leaf dirs. Defaults to a real filesystem walk. */
  readonly listWorktrees?: WorktreeLister;
}

export interface ReapWorktreesSummary {
  /** Worktree paths that were removed. */
  readonly removed: string[];
  /** Worktree paths left in place because the owning run is live-parked. */
  readonly kept: string[];
  /** Per-worktree failures. The reaper records and continues; it never throws. */
  readonly errors: { readonly path: string; readonly message: string }[];
}

/**
 * Default lister: walk `worktrees/<runId>/<stepId>/<branchId>` and return one
 * entry per branch leaf directory. A missing worktrees root is not an error —
 * there is simply nothing to reap.
 */
export const listWorktreesFromDisk: WorktreeLister = async (worktreesRoot) => {
  const entries: WorktreeEntry[] = [];
  const runDirs = await listSubdirectories(worktreesRoot);
  for (const runId of runDirs) {
    const stepDirs = await listSubdirectories(join(worktreesRoot, runId));
    for (const stepId of stepDirs) {
      const branchDirs = await listSubdirectories(join(worktreesRoot, runId, stepId));
      for (const branchId of branchDirs) {
        entries.push({ path: join(worktreesRoot, runId, stepId, branchId), runId });
      }
    }
  }
  return entries;
};

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    return dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  } catch (error) {
    // A missing directory means there is nothing to reap; treat any read
    // failure as "no children" so the reaper stays best-effort.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

/**
 * Resolve a run's status by loading its trace and classifying the ending.
 *
 * This mirrors the canonical unresolved-checkpoint logic in
 * `checkpoint-resume.ts`: a run is live-parked when its trace contains a
 * `checkpoint.requested` whose `(step_id, attempt)` pair has no matching
 * `checkpoint.resolved`. A run is closed when its trace has a `run.closed`
 * entry. An empty or absent run folder is dead (a genuine orphan). A trace
 * that exists but cannot be parsed is `unknown` — we cannot prove the run is
 * dead, so the reaper keeps its worktrees rather than risk destroying live
 * work.
 *
 * `runsRoot` is the absolute `<projectRoot>/.circuit/runs` directory.
 */
export function makeTraceRunStatusResolver(runsRoot: string): ResolveRunStatus {
  return async (runId) => {
    let entries: readonly TraceEntry[];
    try {
      const trace = new TraceStore(join(runsRoot, runId));
      entries = await trace.load();
    } catch {
      // The trace exists but is unreadable or fails strict parse. We cannot
      // classify the run, so we must NOT treat it as removable. Fail safe.
      return 'unknown';
    }
    // An absent or empty run folder is a genuine orphan: its worktrees are
    // reclaimable. (TraceStore.load returns [] for a missing trace file.)
    if (entries.length === 0) return 'dead';
    if (entries.some((entry) => entry.kind === 'run.closed')) return 'closed';
    return hasUnresolvedCheckpoint(entries) ? 'live-parked' : 'dead';
  };
}

function hasUnresolvedCheckpoint(entries: readonly TraceEntry[]): boolean {
  const resolved = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'checkpoint.resolved') continue;
    if (entry.step_id === undefined || entry.attempt === undefined) continue;
    resolved.add(`${entry.step_id}:${entry.attempt}`);
  }
  for (const entry of entries) {
    if (entry.kind !== 'checkpoint.requested') continue;
    if (entry.step_id === undefined || entry.attempt === undefined) continue;
    if (!resolved.has(`${entry.step_id}:${entry.attempt}`)) return true;
  }
  return false;
}

/**
 * Reap orphaned worktrees. For each worktree leaf directory, resolve the owning
 * run's status; remove the worktree if the run is closed or dead; leave it in
 * place if the run is live-parked. Every removal is wrapped so a single failure
 * is recorded and the reaper keeps going. This function never throws.
 */
export async function reapWorktrees(options: ReapWorktreesOptions): Promise<ReapWorktreesSummary> {
  const worktreeRunner = options.worktreeRunner ?? gitWorktreeRunner;
  const listWorktrees = options.listWorktrees ?? listWorktreesFromDisk;
  const summary: ReapWorktreesSummary = { removed: [], kept: [], errors: [] };

  let entries: readonly WorktreeEntry[];
  try {
    entries = await listWorktrees(options.worktreesRoot);
  } catch (error) {
    // Listing should not throw, but if a custom lister does, surface it as a
    // single error against the root rather than crashing the caller.
    summary.errors.push({
      path: options.worktreesRoot,
      message: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }

  for (const entry of entries) {
    let status: OwningRunStatus;
    try {
      status = await Promise.resolve(options.resolveRunStatus(entry.runId));
    } catch (error) {
      summary.errors.push({
        path: entry.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Only reclaim a worktree whose owning run is provably finished or dead.
    // A live-parked run may resume; an unknown run cannot be proven dead. Both
    // are kept — the reaper never removes a worktree it cannot justify.
    if (status !== 'closed' && status !== 'dead') {
      summary.kept.push(entry.path);
      continue;
    }

    try {
      await Promise.resolve(worktreeRunner.remove(entry.path));
      summary.removed.push(entry.path);
    } catch (error) {
      summary.errors.push({
        path: entry.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type OwningRunStatus,
  makeTraceRunStatusResolver,
  reapWorktrees,
} from '../../src/runtime/fanout/worktree-reaper.js';
import type { WorktreeRunner } from '../../src/runtime/run/child-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';

// A fake worktree runner that records every remove() call and never touches git.
function makeRecordingRunner(): {
  readonly runner: WorktreeRunner;
  readonly removed: string[];
} {
  const removed: string[] = [];
  const runner: WorktreeRunner = {
    add() {
      throw new Error('add not expected in reaper tests');
    },
    remove(worktreePath: string) {
      removed.push(worktreePath);
    },
  };
  return { runner, removed };
}

describe('worktree reaper', () => {
  let worktreesRoot: string;

  beforeEach(async () => {
    worktreesRoot = await mkdtemp(join(tmpdir(), 'reaper-worktrees-'));
  });

  afterEach(async () => {
    await rm(worktreesRoot, { recursive: true, force: true });
  });

  // Provision a worktrees/<runId>/<stepId>/<branchId> directory on disk so the
  // default lister has something real to walk.
  async function provisionWorktree(
    runId: string,
    stepId: string,
    branchId: string,
  ): Promise<string> {
    const path = join(worktreesRoot, runId, stepId, branchId);
    await mkdir(path, { recursive: true });
    return path;
  }

  it('removes the worktree of a run that ended mid-fanout (no run.closed, no checkpoint)', async () => {
    const path = await provisionWorktree('run-dead', 'fanout-step', 'branch-a');
    const { runner, removed } = makeRecordingRunner();

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      resolveRunStatus: (runId): OwningRunStatus => {
        expect(runId).toBe('run-dead');
        return 'dead';
      },
    });

    expect(removed).toEqual([path]);
    expect(summary.removed).toEqual([path]);
    expect(summary.kept).toEqual([]);
    expect(summary.errors).toEqual([]);
  });

  // The critical safety case the audit names: a run that is *still running*
  // mid-fanout has the exact same trace shape as a run that crashed between
  // checkpoints (bootstrapped, no run.closed, no parked checkpoint), so the
  // trace resolver returns 'dead' for both. The reaper must NOT remove the live
  // run's worktree. The owning process advertises its liveness with an owner
  // lock (its pid) written next to its worktrees; while that pid is alive the
  // worktree is kept regardless of what the trace says.
  it('keeps the worktree of a live run whose owner lock holds a live pid', async () => {
    const path = await provisionWorktree('run-live', 'fanout-step', 'branch-a');
    // The live process records itself as the owner. process.pid is, by
    // definition, alive for the duration of this test.
    await writeFile(
      join(worktreesRoot, 'run-live', '.owner.json'),
      JSON.stringify({ schema_version: 1, pid: process.pid }),
      'utf8',
    );
    const { runner, removed } = makeRecordingRunner();

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      // The trace looks definitively dead — yet the owner is alive.
      resolveRunStatus: (): OwningRunStatus => 'dead',
    });

    expect(removed).toEqual([]);
    expect(summary.removed).toEqual([]);
    expect(summary.kept).toEqual([path]);
    expect(summary.errors).toEqual([]);
  });

  it('reaps a not-live run and removes its now-stale owner lock', async () => {
    const path = await provisionWorktree('run-crashed', 'fanout-step', 'branch-a');
    const lockPath = join(worktreesRoot, 'run-crashed', '.owner.json');
    await writeFile(lockPath, JSON.stringify({ schema_version: 1, pid: 424242 }), 'utf8');
    const { runner, removed } = makeRecordingRunner();

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      // The crashed owner's pid is not alive, so the trace verdict governs.
      isRunLive: () => false,
      resolveRunStatus: (): OwningRunStatus => 'dead',
    });

    expect(removed).toEqual([path]);
    expect(summary.removed).toEqual([path]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps a worktree whenever isRunLive reports the owner alive, ignoring trace status', async () => {
    const path = await provisionWorktree('run-busy', 'fanout-step', 'branch-a');
    const { runner, removed } = makeRecordingRunner();

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      isRunLive: () => true,
      resolveRunStatus: (): OwningRunStatus => 'dead',
    });

    expect(removed).toEqual([]);
    expect(summary.kept).toEqual([path]);
  });

  it('removes the worktree of a closed run', async () => {
    const path = await provisionWorktree('run-closed', 'fanout-step', 'branch-a');
    const { runner, removed } = makeRecordingRunner();

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      resolveRunStatus: (): OwningRunStatus => 'closed',
    });

    expect(removed).toEqual([path]);
    expect(summary.removed).toEqual([path]);
    expect(summary.kept).toEqual([]);
  });

  it('leaves a live parked run (unresolved checkpoint) alone', async () => {
    const path = await provisionWorktree('run-parked', 'fanout-step', 'branch-a');
    const { runner, removed } = makeRecordingRunner();

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      resolveRunStatus: (): OwningRunStatus => 'live-parked',
    });

    expect(removed).toEqual([]);
    expect(summary.removed).toEqual([]);
    expect(summary.kept).toEqual([path]);
    expect(summary.errors).toEqual([]);
  });

  it('records a per-removal error without throwing and keeps reaping the rest', async () => {
    const failPath = await provisionWorktree('run-a', 'step', 'branch-fail');
    const okPath = await provisionWorktree('run-b', 'step', 'branch-ok');
    const removed: string[] = [];
    const runner: WorktreeRunner = {
      add() {
        throw new Error('add not expected');
      },
      remove(worktreePath: string) {
        if (worktreePath === failPath) throw new Error('git worktree remove failed (exit 1)');
        removed.push(worktreePath);
      },
    };

    const summary = await reapWorktrees({
      worktreesRoot,
      worktreeRunner: runner,
      resolveRunStatus: (): OwningRunStatus => 'closed',
    });

    expect(removed).toEqual([okPath]);
    expect(summary.removed).toEqual([okPath]);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.path).toBe(failPath);
    expect(summary.errors[0]?.message).toContain('git worktree remove failed');
  });

  it('returns an empty summary when the worktrees root does not exist', async () => {
    const { runner, removed } = makeRecordingRunner();
    const summary = await reapWorktrees({
      worktreesRoot: join(worktreesRoot, 'does-not-exist'),
      worktreeRunner: runner,
      resolveRunStatus: (): OwningRunStatus => 'dead',
    });
    expect(removed).toEqual([]);
    expect(summary.removed).toEqual([]);
    expect(summary.kept).toEqual([]);
    expect(summary.errors).toEqual([]);
  });
});

// These exercise the real trace-backed status resolver the CLI uses, against
// on-disk run folders, so the classification is proven end to end (not stubbed).
describe('makeTraceRunStatusResolver', () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'reaper-runs-'));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const RUN_UUID = '11111111-1111-4111-8111-111111111111';

  // Build a real trace by appending through TraceStore so every entry is
  // schema-valid, exactly as the engine would have written it. The trace is
  // keyed on disk by `dirName`; the in-trace run_id is a real UUID as the
  // schema requires.
  async function appendTrace(
    dirName: string,
    inputs: readonly Record<string, unknown>[],
  ): Promise<string> {
    const runDir = join(runsRoot, dirName);
    await mkdir(runDir, { recursive: true });
    const store = new TraceStore(runDir);
    for (const input of inputs) {
      // biome-ignore lint/suspicious/noExplicitAny: test fixtures supply raw trace inputs.
      await store.append({ run_id: RUN_UUID, ...input } as any);
    }
    return runDir;
  }

  it('classifies an empty/absent run folder as dead (a reclaimable orphan)', async () => {
    const resolve = makeTraceRunStatusResolver(runsRoot);
    expect(await resolve('never-existed')).toBe('dead');
  });

  it('classifies a closed run as closed', async () => {
    await appendTrace('closed', [{ kind: 'run.closed', outcome: 'complete' }]);
    const resolve = makeTraceRunStatusResolver(runsRoot);
    expect(await resolve('closed')).toBe('closed');
  });

  it('classifies a run with an unresolved checkpoint as live-parked', async () => {
    const boundaryHash = 'a'.repeat(64);
    await appendTrace('parked', [
      {
        kind: 'checkpoint.requested',
        step_id: 'cp',
        attempt: 1,
        options: ['continue'],
        request_path: 'reports/checkpoint.request.json',
        request_report_hash: 'b'.repeat(64),
        boundary_ref: {
          kind: 'work_contract',
          ref: 'reports/checkpoint.boundary.json',
          flow_id: 'build',
          step_id: 'cp',
          sha256: boundaryHash,
        },
        boundary_hash: boundaryHash,
      },
    ]);
    const resolve = makeTraceRunStatusResolver(runsRoot);
    expect(await resolve('parked')).toBe('live-parked');
  });

  // A checkpoint that was requested AND resolved at the same (step_id, attempt)
  // is no longer parked, so the run is dead (no run.closed, nothing pending).
  // This exercises the resolved-set membership the live-parked test never
  // reaches — a regression in the (step_id, attempt) pairing key would wrongly
  // keep a finished run's worktrees as if it were still parked.
  it('classifies a resolved checkpoint as dead, not live-parked', async () => {
    const boundaryHash = 'a'.repeat(64);
    await appendTrace('resolved', [
      {
        kind: 'checkpoint.requested',
        step_id: 'cp',
        attempt: 1,
        options: ['continue'],
        request_path: 'reports/checkpoint.request.json',
        request_report_hash: 'b'.repeat(64),
        boundary_ref: {
          kind: 'work_contract',
          ref: 'reports/checkpoint.boundary.json',
          flow_id: 'build',
          step_id: 'cp',
          sha256: boundaryHash,
        },
        boundary_hash: boundaryHash,
      },
      {
        kind: 'checkpoint.resolved',
        step_id: 'cp',
        attempt: 1,
        selection: 'continue',
        route_id: 'advance',
        auto_resolved: false,
        resolution_source: 'operator',
        response_path: 'reports/checkpoint.response.json',
      },
    ]);
    const resolve = makeTraceRunStatusResolver(runsRoot);
    expect(await resolve('resolved')).toBe('dead');
  });

  // The sharp safety case: a run whose trace cannot be classified (unreadable /
  // corrupt) must NOT be reported as removable. Reaping a worktree we cannot
  // prove is dead would destroy a live run's work. Fail safe: keep it.
  //
  // TraceStore.load tolerates a torn FINAL line (the only line a crash can tear)
  // but throws on INTERIOR corruption. A bad line followed by a valid-looking
  // trailing line is therefore an interior-corruption throw — a faithful stand
  // in for any unreadable owning trace.
  it('keeps a run whose trace cannot be parsed (fails safe, not dead)', async () => {
    const runDir = join(runsRoot, 'corrupt');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'trace.ndjson'),
      'this is not json\n{"trailing":"line keeps the bad line interior"}\n',
      'utf8',
    );
    const resolve = makeTraceRunStatusResolver(runsRoot);
    const status = await resolve('corrupt');
    expect(status).not.toBe('dead');
    expect(status).not.toBe('closed');
    expect(status).toBe('unknown');
  });

  it('a reaper backed by the real resolver leaves an unclassifiable run untouched', async () => {
    const runDir = join(runsRoot, 'corrupt');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'trace.ndjson'),
      'not-json-interior\n{"trailing":"line"}\n',
      'utf8',
    );

    const worktreesRoot = await mkdtemp(join(tmpdir(), 'reaper-keep-wt-'));
    const path = join(worktreesRoot, 'corrupt', 'step', 'branch');
    await mkdir(path, { recursive: true });

    const { runner, removed } = makeRecordingRunner();
    try {
      const summary = await reapWorktrees({
        worktreesRoot,
        worktreeRunner: runner,
        resolveRunStatus: makeTraceRunStatusResolver(runsRoot),
      });
      expect(removed).toEqual([]);
      expect(summary.removed).toEqual([]);
      expect(summary.kept).toEqual([path]);
    } finally {
      await rm(worktreesRoot, { recursive: true, force: true });
    }
  });
});

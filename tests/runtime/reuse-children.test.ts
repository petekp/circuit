import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import type { CompiledFlowRunOptions, WorktreeRunner } from '../../src/runtime/run/child-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlowId } from '../../src/schemas/ids.js';
import { RunResult } from '../../src/schemas/result.js';

// Restart-cheapness slice — `circuit run --reuse-children-from <dead-run-folder>`.
//
// A fresh run that reuses a prior crashed run's finished sub-run fanout
// branches instead of re-running the expensive child flow. It addresses the
// prior child by its structural address (step_id, branch_id), which is stable
// across restarts, reads the prior child's terminal result, and re-collects the
// branch's real file effect from the prior worktree still on disk. It never
// resumes the dead run; it only reads it. The safety floor: only a child that
// ran in its own isolating worktree is reusable.

const CHILD_FLOW_ID = 'reuse-child';

function subRunFanoutFlow(): ExecutableFlow {
  return {
    id: 'reuse-fanout-test',
    version: '0.1.0',
    entry: 'fanout',
    stages: [{ id: 'act', stepIds: ['fanout'] }],
    steps: [
      {
        id: 'fanout',
        kind: 'fanout',
        title: 'Fanout',
        protocol: 'fanout@v1',
        routes: { pass: { kind: 'terminal', target: '@complete' } },
        writes: {
          branches_dir: { path: 'reports/branches' },
          aggregate: { path: 'reports/aggregate.json' },
        },
        branches: {
          kind: 'static',
          branches: [
            {
              branch_id: 'one',
              flow_ref: { flow_id: CompiledFlowId.parse(CHILD_FLOW_ID), entry_mode: 'default' },
              goal: 'child one',
              depth: 'medium',
            },
            {
              branch_id: 'two',
              flow_ref: { flow_id: CompiledFlowId.parse(CHILD_FLOW_ID), entry_mode: 'default' },
              goal: 'child two',
              depth: 'medium',
            },
          ],
        },
        concurrency: { kind: 'bounded', max: 2 },
        onChildFailure: 'continue-others',
        check: {
          kind: 'fanout_aggregate',
          source: { kind: 'fanout_results', ref: 'aggregate' },
          join: { policy: 'disjoint-merge' },
          verdicts: { admit: ['accept'] },
        },
      },
    ],
  };
}

function childFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: CHILD_FLOW_ID,
      version: '0.1.0',
      purpose: 'reuse fanout child',
      axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow reuse fanout child fixture',
      },
      steps: [
        {
          id: 'close',
          title: 'Close',
          protocol: 'child-close@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'compose',
          writes: { report: { path: 'reports/child.json', schema: 'child.result@v1' } },
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['summary'],
          },
        },
      ],
    }),
  );
}

// A childRunner that records every invocation. The whole point of reuse is that
// this never runs for a reused branch — invocations are the cost reuse avoids.
function countingChildRunner(invoked: { goals: string[] }) {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    invoked.goals.push(options.goal);
    const resultPath = join(options.runDir, 'reports', 'result.json');
    mkdirSync(dirname(resultPath), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: CHILD_FLOW_ID,
      goal: options.goal,
      outcome: 'complete',
      summary: 'freshly run child',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      verdict: 'accept',
    });
    writeFileSync(resultPath, `${JSON.stringify(body, null, 2)}\n`);
    return {
      schema_version: 1,
      run_id: body.run_id,
      flow_id: body.flow_id,
      goal: body.goal,
      outcome: body.outcome,
      summary: body.summary,
      closed_at: body.closed_at,
      trace_entries_observed: body.trace_entries_observed,
      manifest_hash: body.manifest_hash,
      verdict: 'accept',
      resultPath,
    };
  };
}

function trackingWorktreeRunner(): {
  runner: WorktreeRunner;
  added: Set<string>;
  changedFilesFor: string[];
} {
  const added = new Set<string>();
  const changedFilesFor: string[] = [];
  const runner: WorktreeRunner = {
    add({ worktreePath }) {
      added.add(worktreePath);
    },
    remove() {
      // no-op; cleanup is best-effort and irrelevant to reuse assertions
    },
    changedFiles(worktreePath: string) {
      changedFilesFor.push(worktreePath);
      return [worktreePath.endsWith('/one') ? 'one.ts' : 'two.ts'];
    },
  };
  return { runner, added, changedFilesFor };
}

// Build a prior, crashed run folder whose two sub-run fanout branches finished
// (admissible results on disk, worktrees still on disk) but whose parent never
// joined — the mid-fanout crash shape. Returns the folder a fresh run points at.
async function buildPriorDeadRun(options: {
  readonly baseDir: string;
  readonly priorRunId: string;
  readonly worktreeDir: string;
  // Override the child flow id recorded in each branch result.json (default the
  // real child flow). Drives the flow-identity refusal test.
  readonly childFlowId?: string;
  // Whether each worktree dir gets a `.git` marker (default true = a real git
  // worktree). Drives the bare-directory refusal test.
  readonly writeGitMarker?: boolean;
}): Promise<string> {
  const childFlowId = options.childFlowId ?? CHILD_FLOW_ID;
  const writeGitMarker = options.writeGitMarker ?? true;
  const priorFolder = join(options.baseDir, options.priorRunId);
  mkdirSync(priorFolder, { recursive: true });
  const store = new TraceStore(priorFolder, { now: () => new Date('2026-05-01T00:00:00.000Z') });
  await store.append({
    run_id: options.priorRunId,
    kind: 'fanout.started',
    step_id: 'fanout',
    attempt: 1,
    branch_ids: ['one', 'two'],
    on_child_failure: 'continue-others',
  });
  for (const branchId of ['one', 'two'] as const) {
    const worktreePath = join(options.worktreeDir, branchId);
    mkdirSync(worktreePath, { recursive: true });
    // A real `git worktree add` leaves a `.git` gitlink file; the lookup's
    // safety gate requires it, so reproduce it for a reusable worktree.
    if (writeGitMarker) {
      writeFileSync(join(worktreePath, '.git'), 'gitdir: /dev/null/worktrees/fixture\n');
    }
    const childRunId =
      branchId === 'one'
        ? '00000000-0000-4000-8000-0000000000a1'
        : '00000000-0000-4000-8000-0000000000a2';
    const resultRel = `reports/branches/${branchId}/result.json`;
    const resultAbs = join(priorFolder, resultRel);
    mkdirSync(dirname(resultAbs), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: childRunId,
      flow_id: childFlowId,
      goal: `child ${branchId}`,
      outcome: 'complete',
      summary: `prior child ${branchId}`,
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      verdict: 'accept',
    });
    writeFileSync(resultAbs, `${JSON.stringify(body, null, 2)}\n`);
    await store.append({
      run_id: options.priorRunId,
      kind: 'fanout.branch_started',
      step_id: 'fanout',
      attempt: 1,
      branch_id: branchId,
      branch_kind: 'sub-run',
      child_run_id: childRunId,
      worktree_path: worktreePath,
    });
    await store.append({
      run_id: options.priorRunId,
      kind: 'fanout.branch_completed',
      step_id: 'fanout',
      attempt: 1,
      branch_id: branchId,
      branch_kind: 'sub-run',
      child_run_id: childRunId,
      child_outcome: 'complete',
      verdict: 'accept',
      duration_ms: 5,
      result_path: resultRel,
    });
  }
  // No fanout.joined, no run.closed: the parent crashed mid-fanout.
  return priorFolder;
}

async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-reuse-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('reuse-children-from (restart cheapness)', () => {
  it('reuses finished sub-run branches from a dead run instead of re-running them', async () => {
    const priorWorktreeDir = join(baseDir, 'prior-worktrees', 'fanout');
    const priorFolder = await buildPriorDeadRun({
      baseDir,
      priorRunId: '11111111-1111-4111-8111-111111111111',
      worktreeDir: priorWorktreeDir,
    });

    const invoked = { goals: [] as string[] };
    const { runner, changedFilesFor } = trackingWorktreeRunner();
    const runDir = join(baseDir, 'fresh-run');

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: '22222222-2222-4222-8222-222222222222',
      goal: 'fanout restart',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: runner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: countingChildRunner(invoked),
      reuseChildrenFrom: priorFolder,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    // The cheapness win: neither branch's child flow was re-run.
    expect(invoked.goals).toEqual([]);

    // The disjoint-merge collected each branch's real file effect from the prior
    // worktree (still on disk), not from a never-provisioned fresh one.
    expect(changedFilesFor.some((p) => p.startsWith(priorWorktreeDir))).toBe(true);

    // The trace is honest about provenance: each reused branch names the prior child.
    const entries = await trace(runDir);
    const completed = entries.filter((e) => e.kind === 'fanout.branch_completed');
    expect(completed).toHaveLength(2);
    for (const entry of completed) {
      if (entry.kind !== 'fanout.branch_completed') throw new Error('unreachable');
      expect(entry.reused_from).toMatch(/^00000000-0000-4000-8000-0000000000a[12]$/);
      expect(entry.child_outcome).toBe('complete');
      expect(entry.verdict).toBe('accept');
    }
    expect(entries.find((e) => e.kind === 'fanout.joined')?.policy).toBe('disjoint-merge');
  });

  it('runs the child fresh when the prior worktree is gone (reaped): no false success', async () => {
    const priorWorktreeDir = join(baseDir, 'prior-worktrees-gone', 'fanout');
    const priorFolder = await buildPriorDeadRun({
      baseDir,
      priorRunId: '33333333-3333-4333-8333-333333333333',
      worktreeDir: priorWorktreeDir,
    });
    // Simulate the reaper having removed the prior worktrees: the recorded
    // result.json survives but the worktree (where the branch effect lives) is gone.
    await rm(priorWorktreeDir, { recursive: true, force: true });
    expect(existsSync(priorWorktreeDir)).toBe(false);

    const invoked = { goals: [] as string[] };
    const { runner } = trackingWorktreeRunner();
    const runDir = join(baseDir, 'fresh-run-gone');

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: '44444444-4444-4444-8444-444444444444',
      goal: 'fanout restart worktree gone',
      projectRoot: join(baseDir, 'project-gone'),
      worktreeRunner: runner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: countingChildRunner(invoked),
      reuseChildrenFrom: priorFolder,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    // The worktree (effect) is gone, so reuse refuses and both children run fresh.
    expect(invoked.goals.sort()).toEqual(['child one', 'child two']);
    const entries = await trace(runDir);
    const completed = entries.filter((e) => e.kind === 'fanout.branch_completed');
    for (const entry of completed) {
      if (entry.kind !== 'fanout.branch_completed') throw new Error('unreachable');
      expect(entry.reused_from).toBeUndefined();
    }
  });

  it('runs the child fresh when the prior worktree is a bare directory (no .git): no false success', async () => {
    const priorWorktreeDir = join(baseDir, 'prior-worktrees-bare', 'fanout');
    const priorFolder = await buildPriorDeadRun({
      baseDir,
      priorRunId: '66666666-6666-4666-8666-666666666666',
      worktreeDir: priorWorktreeDir,
      // The worktree dirs exist but carry no `.git` marker: a half-cleaned
      // leftover, not a usable git worktree.
      writeGitMarker: false,
    });
    expect(existsSync(join(priorWorktreeDir, 'one'))).toBe(true);

    const invoked = { goals: [] as string[] };
    const { runner } = trackingWorktreeRunner();
    const runDir = join(baseDir, 'fresh-run-bare');

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: '77777777-7777-4777-8777-777777777777',
      goal: 'fanout restart bare worktree',
      projectRoot: join(baseDir, 'project-bare'),
      worktreeRunner: runner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: countingChildRunner(invoked),
      reuseChildrenFrom: priorFolder,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    expect(invoked.goals.sort()).toEqual(['child one', 'child two']);
    const entries = await trace(runDir);
    for (const entry of entries.filter((e) => e.kind === 'fanout.branch_completed')) {
      if (entry.kind !== 'fanout.branch_completed') throw new Error('unreachable');
      expect(entry.reused_from).toBeUndefined();
    }
  });

  it('runs the child fresh when the prior child ran a different flow at the same address', async () => {
    const priorWorktreeDir = join(baseDir, 'prior-worktrees-otherflow', 'fanout');
    const priorFolder = await buildPriorDeadRun({
      baseDir,
      priorRunId: '88888888-8888-4888-8888-888888888888',
      worktreeDir: priorWorktreeDir,
      // The structural address (step_id, branch_id) matches, but the prior child
      // ran a DIFFERENT flow. Its result must not be admitted for this branch.
      childFlowId: 'some-other-flow',
    });

    const invoked = { goals: [] as string[] };
    const { runner } = trackingWorktreeRunner();
    const runDir = join(baseDir, 'fresh-run-otherflow');

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: '99999999-9999-4999-8999-999999999999',
      goal: 'fanout restart different flow',
      projectRoot: join(baseDir, 'project-otherflow'),
      worktreeRunner: runner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: countingChildRunner(invoked),
      reuseChildrenFrom: priorFolder,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    // Flow identity mismatch => no reuse; both children run fresh.
    expect(invoked.goals.sort()).toEqual(['child one', 'child two']);
    const entries = await trace(runDir);
    for (const entry of entries.filter((e) => e.kind === 'fanout.branch_completed')) {
      if (entry.kind !== 'fanout.branch_completed') throw new Error('unreachable');
      expect(entry.reused_from).toBeUndefined();
    }
  });

  it('is inert by default: no pointer means every child runs fresh', async () => {
    const invoked = { goals: [] as string[] };
    const { runner } = trackingWorktreeRunner();
    const runDir = join(baseDir, 'fresh-no-pointer');

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: '55555555-5555-4555-8555-555555555555',
      goal: 'fanout no pointer',
      projectRoot: join(baseDir, 'project-none'),
      worktreeRunner: runner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: countingChildRunner(invoked),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    expect(invoked.goals.sort()).toEqual(['child one', 'child two']);
  });
});

// Recursion-bound executor tests.
//
// The sub-run executor is the only place a run begets another run. Left
// unbounded, a flow that sub-runs into a chain that re-enters itself, or that
// simply nests deeper and deeper, has no stopping condition: the runner would
// descend until the process dies. These tests pin the two guards that bound it,
// at the executor level where the decision is made, with an injected recursion
// state rather than real nesting (the real-recursion sister test proves the
// state actually accumulates across run boundaries):
//
//   * depth cap   — refuse to start a child once the next level would exceed the
//                   cap, before any child run folder or sub_run.started exists.
//   * cycle guard — refuse to start a child whose flow id already sits in the
//                   ancestor chain, on the first repeat.
//
// Both refusals are legible: they record a check.evaluated fail with a reason
// that names the cause, and they never emit sub_run.started for the refused
// child. They also forward the incremented depth and the extended ancestor set
// into the child run options, which the propagation tests pin directly.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECURSION_DEPTH_CAP } from '../../src/runtime/executors/sub-run.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import type { CompiledFlowRunOptions } from '../../src/runtime/run/child-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-recursion-bound-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function parentFlow(): ExecutableFlow {
  return {
    id: 'parent-test',
    version: '0.1.0',
    entry: 'child-step',
    stages: [{ id: 'act', stepIds: ['child-step'] }],
    steps: [
      {
        id: 'child-step',
        kind: 'sub-run',
        title: 'Run child',
        protocol: 'sub-run-test@v1',
        routes: { pass: { kind: 'terminal', target: '@complete' } },
        flowRef: 'child-test',
        entryMode: 'default',
        goal: 'child goal',
        depth: 'medium',
        writes: { result: { path: 'reports/child-result.json' } },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: ['accept'],
        },
      },
    ],
  };
}

function childFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: 'child-test',
      version: '0.1.0',
      purpose: 'runtime sub-run child',
      axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow runtime child fixture',
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

function stubChildRunner(verdict: string) {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const resultPath = join(options.runDir, 'reports', 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: 'child-test',
      goal: options.goal,
      outcome: 'complete',
      summary: 'child summary',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      verdict,
    });
    await writeFile(resultPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
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
      verdict,
      resultPath,
    };
  };
}

async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

describe('recursion bound — depth cap', () => {
  it('refuses to start a child when the next level would exceed the cap', async () => {
    const runDir = join(baseDir, 'cap-exceed-run');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      // The parent already sits at the cap, so the child would be cap + 1.
      recursionDepth: RECURSION_DEPTH_CAP,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: async (options) => {
        childRunnerCalls += 1;
        return await stubChildRunner('accept')(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(`exceed the recursion depth cap of ${RECURSION_DEPTH_CAP}`);
    expect(childRunnerCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('recursion depth cap'),
      }),
    );
    // The refused child never started: no run folder, no started trace entry.
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('allows the child at exactly the cap (the boundary is exceed, not reach)', async () => {
    const runDir = join(baseDir, 'cap-boundary-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      // Parent at cap - 1, so the child lands exactly on the cap and is allowed.
      recursionDepth: RECURSION_DEPTH_CAP - 1,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner('accept'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('accept');
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });
});

describe('recursion bound — cycle guard', () => {
  it('refuses to start a child whose flow id is already an ancestor', async () => {
    const runDir = join(baseDir, 'cycle-run');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      // 'child-test' already ran upstream, so re-entering it is a cycle.
      recursionAncestors: new Set(['root-flow', 'child-test']),
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: async (options) => {
        childRunnerCalls += 1;
        return await stubChildRunner('accept')(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('already in the recursion ancestor chain');
    expect(result.reason).toContain('child-test');
    // The chain is rendered so an operator can see how the cycle was reached.
    expect(result.reason).toContain('root-flow -> child-test');
    expect(childRunnerCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('recursion ancestor chain'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });
});

describe('recursion bound — state propagation', () => {
  it('forwards depth + 1 and the extended ancestor set into the child (top-level defaults)', async () => {
    const runDir = join(baseDir, 'propagation-default-run');
    let observed: CompiledFlowRunOptions | undefined;
    await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: async (options) => {
        observed = options;
        return await stubChildRunner('accept')(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    // A top-level run seeds depth 0 and ancestors { parent flow id }, so the
    // child sees depth 1 and an ancestor set that also includes its own id.
    expect(observed?.recursionDepth).toBe(1);
    expect(observed?.recursionAncestors).toBeDefined();
    expect([...(observed?.recursionAncestors ?? [])].sort()).toEqual(['child-test', 'parent-test']);
  });

  it('forwards depth + 1 and adds the child id to whatever the current ancestors are', async () => {
    const runDir = join(baseDir, 'propagation-injected-run');
    let observed: CompiledFlowRunOptions | undefined;
    await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      recursionDepth: 3,
      recursionAncestors: new Set(['a-flow', 'b-flow']),
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: async (options) => {
        observed = options;
        return await stubChildRunner('accept')(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(observed?.recursionDepth).toBe(4);
    expect([...(observed?.recursionAncestors ?? [])].sort()).toEqual([
      'a-flow',
      'b-flow',
      'child-test',
    ]);
  });
});

// Flow-shape composition (experimental, default-OFF): the static fanout shape.
//
// The sub-run taught the composer to cross a flow boundary for ONE child. The
// fanout is the first shape that crosses it for MANY children AT ONCE: one step
// launches a fixed set of child flows in parallel and admits the survivors
// through an `aggregate-survivors` join. The composer could never emit it —
// `buildExecution` had no fanout case, and a fanout step carries a sibling
// `fanout` descriptor (branch set, concurrency, failure policy, join) that no
// composed step ever produced.
//
// These tests lock the shape with the same proof discipline as the sub-run:
//   - VALID  — the real assemble+compile+catalog gate accepts the composed fanout.
//   - BOUNDED — the runtime recursion cap refuses EVERY branch before any child
//     runs, so the join collapses (0 survivors) and the step aborts.
//   - LIVE — the compiled fanout RUNS: both children are really invoked, the
//     aggregate write validates each survivor's RunResult body against the GENERIC
//     fanout aggregate contract the composer now binds for a sub-run fanout
//     (`fanout.aggregate@v1`, a typed envelope that leaves result_body open), and the
//     `aggregate-survivors` join admits the two survivors. The earlier rung bound the
//     fanout step to a donor's RELAY aggregate (`prototype.variant-aggregate@v1`),
//     which types result_body as a relay variant artifact a sub-run RunResult is not;
//     minting and binding the generic aggregate contract lifted that wall. This is the
//     first GENUINE multi-child LIVE pass for a composed flow.
//
// They never assert SENSIBLE — whether a parallel-build fanout is a GOOD process is
// an efficacy question only a scored live run can answer — so this file imports
// neither evaluateSensibility nor blockIntent.
//
// They also lock the measurement contrast: a fanout adds the (act, fanout) cell no
// linear flow's research-then-build band has, so novelty SEES it.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  FANOUT_PARALLEL_BUILD,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateNovelty,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { RECURSION_DEPTH_CAP } from '../../src/runtime/executors/sub-run.js';
import type { ExecutableFlow, FanoutStep } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import type { ChildFlowRef, CompiledFlowRunOptions } from '../../src/runtime/run/child-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';

const composed = composeFlow(FANOUT_PARALLEL_BUILD, { definitions: flowDefinitions });

function composedFanoutStep(): FanoutStep {
  if (!composed.ok) throw new Error('compose failed');
  const validity = evaluateValidity(composed.spec);
  if (!validity.schematic) throw new Error('no schematic');
  const compiled = compileSchematicToCompiledFlow(validity.schematic);
  const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
  if (!flow) throw new Error('no compiled flow');
  const executable = fromCompiledFlow(flow);
  const step = executable.steps.find((s): s is FanoutStep => s.kind === 'fanout');
  if (!step) throw new Error('no fanout step in compiled flow');
  return step;
}

// A standalone 1-step flow whose entry IS the composer's emitted fanout step, with
// its routes rewritten to terminate (so it stands alone, off the 4-step spine).
// Everything else — the static branch set, concurrency, failure policy, and the
// aggregate-survivors check — is the composer's own output, so what runs here is
// exactly what the composer emits, not a hand-authored stand-in.
function isolatedFanoutFlow(): ExecutableFlow {
  const step = composedFanoutStep();
  return {
    id: 'fanout-parallel-build-probe',
    version: '0.1.0',
    entry: step.id,
    stages: [{ id: 'act', stepIds: [step.id] }],
    steps: [
      {
        ...step,
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          stop: { kind: 'terminal', target: '@stop' },
        },
      },
    ],
  };
}

// A minimal compiled child flow whose id matches the branch's flow_ref (the
// executor refuses a child whose resolved id does not equal the branch's flow_ref).
function childFlowBytes(flowId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: flowId,
      version: '0.1.0',
      purpose: `fanout child stand-in for ${flowId}`,
      axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow fanout child fixture',
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
      flow_id: options.goal.includes('repairing') ? 'fix' : 'build',
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

// A worktree runner stub: fanout branches each run in a worktree, so the executor
// needs add/remove/changedFiles even when the children are stubbed.
function stubWorktreeRunner() {
  return {
    add() {},
    remove() {},
    changedFiles(worktreePath: string) {
      return [worktreePath.endsWith('/fix-path') ? 'fix.ts' : 'build.ts'];
    },
  };
}

let baseDir: string;
beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-fanout-compose-'));
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});
async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

describe('flow-shape composition — static fanout', () => {
  it('composes the frame-plan-fanout role set without a wall', () => {
    if (!composed.ok) {
      throw new Error(
        `composer walled: ${composed.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(composed.ok).toBe(true);
  });

  it('emits a static fanout descriptor with two parallel sub-run branches', () => {
    if (!composed.ok) throw new Error('compose failed');
    const act = composed.spec.items.find((it) => String(it.block) === 'act');
    if (!act) throw new Error('no act step');
    expect((act.execution as Record<string, unknown> | undefined)?.kind).toBe('fanout');
    const fanout = act.fanout as Record<string, unknown> | undefined;
    expect(fanout).toBeDefined();
    const branches = fanout?.branches as Record<string, unknown> | undefined;
    expect(branches?.kind).toBe('static');
    const list = branches?.branches as Array<Record<string, unknown>> | undefined;
    expect(list?.length).toBe(2);
    // Each branch is a sub-run leaf: a flow_ref + goal + depth + kebab branch_id.
    for (const branch of list ?? []) {
      expect(typeof branch.branch_id).toBe('string');
      const ref = branch.flow_ref as Record<string, unknown> | undefined;
      expect(typeof ref?.flow_id).toBe('string');
      expect(typeof branch.goal).toBe('string');
      expect((branch.goal as string).length).toBeGreaterThan(0);
    }
    expect((list?.[0]?.flow_ref as Record<string, unknown>)?.flow_id).toBe('fix');
    expect((list?.[1]?.flow_ref as Record<string, unknown>)?.flow_id).toBe('build');
    // aggregate-survivors join, continue-others so one branch failing keeps the
    // others, and the fanout step writes a branches dir + an aggregate report.
    expect((fanout?.join as Record<string, unknown>)?.policy).toBe('aggregate-survivors');
    expect(fanout?.on_child_failure).toBe('continue-others');
    expect(act.writes?.report_path).toBeDefined();
    expect(act.writes?.branches_dir_path).toBeDefined();
  });

  it('the composed spec is VALID by the real engine gates', () => {
    if (!composed.ok) throw new Error('compose failed');
    const validity = evaluateValidity(composed.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
    expect(validity.boundPrimaryResult).toBe(true);
  });

  it('a fanout role with fewer than two branches walls honestly', () => {
    const oneBranch = {
      ...FANOUT_PARALLEL_BUILD,
      id: 'fanout-one-branch',
      roles: FANOUT_PARALLEL_BUILD.roles.map((r) =>
        r.block === 'act' && r.fanoutBranches
          ? { ...r, fanoutBranches: r.fanoutBranches.slice(0, 1) }
          : r,
      ),
    };
    const outcome = composeFlow(oneBranch, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.walls.some((w) => /at least two branches/i.test(w.reason))).toBe(true);
    }
  });

  it('a fanout branch without a goal walls honestly', () => {
    const noGoal = {
      ...FANOUT_PARALLEL_BUILD,
      id: 'fanout-branch-nogoal',
      roles: FANOUT_PARALLEL_BUILD.roles.map((r) => {
        if (r.block !== 'act' || !r.fanoutBranches) return r;
        return {
          ...r,
          fanoutBranches: r.fanoutBranches.map((b, i) => (i === 0 ? { ...b, goalText: '' } : b)),
        };
      }),
    };
    const outcome = composeFlow(noGoal, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.walls.some((w) => /goalText/i.test(w.reason))).toBe(true);
    }
  });

  it('LIVE: the fanout runs both children and the aggregate-survivors join admits the RunResult survivors', async () => {
    // Validity proves the step COMPILES; this proves the composer emits a RUNNABLE
    // fanout that PASSES live: both child flows are really invoked, the aggregate
    // write validates each survivor's RunResult against the generic fanout aggregate
    // contract the composer binds (fanout.aggregate@v1, result_body left open), and the
    // aggregate-survivors join admits the two survivors. The first genuine multi-child
    // LIVE pass for a composed flow.
    const runDir = join(baseDir, 'live');
    let childRunnerCalls = 0;
    const childIds = new Set<string>();
    const result = await executeExecutableFlow(isolatedFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: stubWorktreeRunner(),
      childCompiledFlowResolver: (ref: ChildFlowRef) => ({ flowBytes: childFlowBytes(ref.flowId) }),
      childRunner: async (options) => {
        childRunnerCalls += 1;
        const r = await stubChildRunner('accept')(options);
        childIds.add(r.flow_id);
        return r;
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });
    // Both children REALLY ran — the composer's fanout machinery is complete.
    expect(childRunnerCalls).toBe(2);
    expect([...childIds].sort()).toEqual(['build', 'fix']);
    // The step completes: the aggregate validated and the join admitted two survivors.
    expect(result.outcome).toBe('complete');
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'fanout.branch_started', branch_id: 'fix-path' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'fanout.branch_started', branch_id: 'build-path' }),
    );
    // The fanout_aggregate check evaluated PASS — the survivors were admitted, not
    // rejected against a relay-coupled donor schema.
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        check_kind: 'fanout_aggregate',
        outcome: 'pass',
      }),
    );
  });

  it('the compiled fanout step is BOUNDED: the recursion cap refuses every branch before any child runs', async () => {
    // A lone sub-run is bounded by the recursion cap; a fanout of sub-runs is bounded
    // PER BRANCH. Started one level past the cap, every branch refuses before spawning,
    // the join collapses with zero survivors, and no child ever runs — the bound binds
    // the composed fanout, not just a hand-authored fixture.
    const runDir = join(baseDir, 'bounded');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(isolatedFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      recursionDepth: RECURSION_DEPTH_CAP,
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: stubWorktreeRunner(),
      childCompiledFlowResolver: (ref: ChildFlowRef) => ({ flowBytes: childFlowBytes(ref.flowId) }),
      childRunner: async (options) => {
        childRunnerCalls += 1;
        return await stubChildRunner('accept')(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(`recursion depth cap of ${RECURSION_DEPTH_CAP}`);
    expect(childRunnerCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries).not.toContainEqual(expect.objectContaining({ kind: 'sub_run.started' }));
  });

  it('evaluateNovelty SEES the act:fanout cell', () => {
    if (!composed.ok) throw new Error('compose failed');
    const fanoutSchem = evaluateValidity(composed.spec).schematic;
    const linear = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!linear.ok) throw new Error('linear compose failed');
    const linSchem = evaluateValidity(linear.spec).schematic;
    if (!fanoutSchem || !linSchem) throw new Error('no schematic');
    const fanoutNov = evaluateNovelty(fanoutSchem, flowDefinitions);
    const linNov = evaluateNovelty(linSchem, flowDefinitions);
    // The new (block, kind) cell shows up in the sequence — RESEARCH_THEN_BUILD runs
    // act as a relay, this runs it as a fanout.
    expect(fanoutNov.sequence).toContain('act:fanout');
    expect(fanoutNov.sequence).not.toBe(linNov.sequence);
  });
});

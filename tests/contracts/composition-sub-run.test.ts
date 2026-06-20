// Flow-shape composition (experimental, default-OFF): the sub-run shape.
//
// The loop taught the composer its first NON-LINEAR edge, but it stayed INLINE —
// a back-edge between steps of one flow. The sub-run is the first shape that
// crosses a FLOW BOUNDARY: one step runs a whole child flow and is admitted back
// only through the child's RunResult verdict. The composer could never emit it —
// `buildExecution` threw on `sub-run`, the goal family's contract producer was
// unselectable (its only actual is a raw generic the candidate filter excluded),
// and the single-kind `goal-child-run` block had its execution omitted.
//
// These tests lock the shape end to end on the offline floor, with the SAME
// proof discipline as the loop: VALID (the real assemble+compile+catalog gate),
// LIVE (the compiled step actually runs the child and gates on its verdict), and
// BOUNDED (the runtime recursion cap refuses it past the depth limit). They never
// assert SENSIBLE — whether a frame-then-delegate flow is a GOOD process is an
// efficacy question only a scored live run can answer, so this file imports
// neither evaluateSensibility nor blockIntent.
//
// They also lock the measurement contrast with the loop: a loop adds no block, so
// the locked novelty rubric was blind to it; a sub-run adds the (goal-child-run,
// sub-run) cell no linear flow's investigate-change-prove band has, so novelty
// SEES it.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  GOAL_THEN_FIX,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateNovelty,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { RECURSION_DEPTH_CAP } from '../../src/runtime/executors/sub-run.js';
import type { ExecutableFlow, SubRunStep } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import type { CompiledFlowRunOptions } from '../../src/runtime/run/child-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';

const composed = composeFlow(GOAL_THEN_FIX, { definitions: flowDefinitions });

function composedSubRunStep(): SubRunStep {
  if (!composed.ok) throw new Error('compose failed');
  const validity = evaluateValidity(composed.spec);
  if (!validity.schematic) throw new Error('no schematic');
  const compiled = compileSchematicToCompiledFlow(validity.schematic);
  const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
  if (!flow) throw new Error('no compiled flow');
  const executable = fromCompiledFlow(flow);
  const step = executable.steps.find((s): s is SubRunStep => s.kind === 'sub-run');
  if (!step) throw new Error('no sub-run step in compiled flow');
  return step;
}

// A standalone 1-step flow whose entry IS the composer's emitted sub-run step,
// with its routes rewritten to terminate (so it stands alone, off the 3-step
// spine). Everything else — flowRef, goal, depth, the result-verdict check — is
// the composer's own output, so what runs here is exactly what the composer
// emits, not a hand-authored stand-in.
function isolatedSubRunFlow(): ExecutableFlow {
  const step = composedSubRunStep();
  return {
    id: 'goal-then-fix-subrun-probe',
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

// A minimal compiled child flow whose id is `fix` (the executor refuses a child
// whose resolved id does not equal the step's flow_ref).
function childFixFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: 'fix',
      version: '0.1.0',
      purpose: 'sub-run child stand-in for fix',
      axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow sub-run child fixture',
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
      flow_id: 'fix',
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

let baseDir: string;
beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-subrun-compose-'));
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});
async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

describe('flow-shape composition — sub-run', () => {
  it('composes the frame-then-delegate role set without a wall', () => {
    if (!composed.ok) {
      throw new Error(
        `composer walled: ${composed.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(composed.ok).toBe(true);
  });

  it('emits a sub-run execution descriptor that targets the Fix child flow', () => {
    if (!composed.ok) throw new Error('compose failed');
    const act = composed.spec.items.find((it) => String(it.block) === 'goal-child-run');
    if (!act) throw new Error('no goal-child-run step');
    const exec = act.execution as Record<string, unknown> | undefined;
    expect(exec?.kind).toBe('sub-run');
    const ref = exec?.flow_ref as Record<string, unknown> | undefined;
    expect(ref?.flow_id).toBe('fix');
    expect(ref?.entry_mode).toBe('default');
    // goal + depth come from the role (the per-task params), carried verbatim.
    expect(typeof exec?.goal).toBe('string');
    expect((exec?.goal as string).length).toBeGreaterThan(0);
    expect(exec?.depth).toBe('medium');
    // sub-run writes a result_path only; the schema forbids a report_path.
    expect(act.writes?.result_path).toBeDefined();
    expect(act.writes?.report_path).toBeUndefined();
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

  it('the role flowId drives the binding: flowId build composes a build sub-run', () => {
    const buildVariant = {
      ...GOAL_THEN_FIX,
      id: 'goal-then-build',
      roles: GOAL_THEN_FIX.roles.map((r) =>
        r.block === 'goal-child-run' ? { ...r, flowId: 'build' as const } : r,
      ),
    };
    const outcome = composeFlow(buildVariant, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const act = outcome.spec.items.find((it) => String(it.block) === 'goal-child-run');
    const ref = (act?.execution as Record<string, unknown> | undefined)?.flow_ref as
      | Record<string, unknown>
      | undefined;
    expect(ref?.flow_id).toBe('build');
    // The bound actual is the DONOR's contract — the explainer flow is the one
    // built-in that runs a `build` child via sub-run, so its actual rides along.
    // Its name (explainer.build-result@v1) does NOT encode the child flow id
    // (`build`); that is exactly why the menu carries subRunFlowRef separately
    // rather than parsing it out of the actual name.
    expect(String(act?.output)).toBe('explainer.build-result@v1');
  });

  it('a sub-run role without a goal walls honestly', () => {
    const noGoal = {
      ...GOAL_THEN_FIX,
      id: 'goal-then-fix-nogoal',
      roles: GOAL_THEN_FIX.roles.map((r) => {
        if (r.block !== 'goal-child-run') return r;
        const { goalText: _drop, ...rest } = r;
        return rest;
      }),
    };
    const outcome = composeFlow(noGoal, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.walls.some((w) => /goalText/i.test(w.reason))).toBe(true);
    }
  });

  it('the compiled sub-run step is LIVE: it runs the child and admits an in-policy verdict', async () => {
    // Validity proves the step COMPILES; this proves it RUNS. The runtime invokes
    // the child flow and gates on the composer's own result-verdict check. An
    // admissible verdict ('accept' is in the composed check.pass) closes complete;
    // the child was really invoked.
    const runDir = join(baseDir, 'live-pass');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(isolatedSubRunFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFixFlowBytes() }),
      childRunner: async (options) => {
        childRunnerCalls += 1;
        return await stubChildRunner('accept')(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });
    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('accept');
    expect(childRunnerCalls).toBe(1);
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', child_flow_id: 'fix' }),
    );
  });

  it('the gate is real: an out-of-policy child verdict aborts rather than passing', async () => {
    // The verdict gate is not decorative. A child that closes `complete` but hands
    // back a verdict the composed check.pass does not list is a contract violation,
    // and the step aborts rather than laundering it as success.
    const runDir = join(baseDir, 'live-reject');
    const result = await executeExecutableFlow(isolatedSubRunFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFixFlowBytes() }),
      childRunner: stubChildRunner('definitely-not-a-pass-verdict'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });
    expect(result.outcome).toBe('aborted');
    // Pin the abort to the VERDICT gate, not one of the executor's many earlier
    // abort paths (resolver throw, child-schema parse, id mismatch, non-JSON
    // result). Without this, a future fixture-shape change could move the abort
    // upstream and leave the gate unexercised while this test stayed green.
    expect(result.reason).toContain('is not in check.pass');
  });

  it('the compiled sub-run step is BOUNDED: the recursion depth cap refuses it', async () => {
    // The loop was bounded by max_attempts on its retry binding; a sub-run is
    // bounded by the runtime recursion cap. Started one level past the cap, the
    // composer's own step is refused before any child runs — the bound binds the
    // composed step, not just a hand-authored fixture.
    const runDir = join(baseDir, 'bounded');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(isolatedSubRunFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      recursionDepth: RECURSION_DEPTH_CAP,
      childCompiledFlowResolver: () => ({ flowBytes: childFixFlowBytes() }),
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

  it('evaluateNovelty SEES the sub-run cell (unlike the loop, which it was blind to)', () => {
    if (!composed.ok) throw new Error('compose failed');
    const subSchem = evaluateValidity(composed.spec).schematic;
    const linear = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!linear.ok) throw new Error('linear compose failed');
    const linSchem = evaluateValidity(linear.spec).schematic;
    if (!subSchem || !linSchem) throw new Error('no schematic');
    const subNov = evaluateNovelty(subSchem, flowDefinitions);
    const linNov = evaluateNovelty(linSchem, flowDefinitions);
    // The new (block, kind) cell shows up in the sequence — the locked rubric is
    // NOT blind here, the way it is to a loop that adds no block.
    expect(subNov.sequence).toContain('goal-child-run:sub-run');
    expect(subNov.sequence).not.toBe(linNov.sequence);
  });
});

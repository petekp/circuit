import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { SliceLoopEngineFlag, UntilLoopEngineFlag } from '../../src/flows/types.js';
import type { ExecutableFlow, ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import type { GraphExecutionOutcome } from '../../src/runtime/run/graph-runner.js';
import {
  executeExecutableFlow,
  executeExecutableFlowOutcome,
} from '../../src/runtime/run/graph-runner.js';
import { iterationLedgerFromTrace } from '../../src/runtime/run/iteration-ledger.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { UntilCorridor } from '../../src/runtime/run/until-corridor.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { CompiledFlowId, StepId } from '../../src/schemas/ids.js';
import type { RecoveryRouteBindingV0 } from '../../src/schemas/recovery-route-kind.js';

// A three-step loop body: head -> body -> tail. The intermediate `loop-body`
// step is the whole point of slice 1 — it is where a wrong count-key
// generalization would abort as an illegal re-entry on the second pass. The
// tail declares both a forward exit (`pass` -> @complete) and a re-enter route
// (`reenter` -> head); the engine, when the until flag is active, swaps the
// forward route for the re-enter route until the iteration cap is reached.
const UNTIL_FLAG: UntilLoopEngineFlag = {
  headStep: 'loop-head',
  tailStep: 'loop-tail',
  bodySteps: ['loop-head', 'loop-body', 'loop-tail'],
  reenterRoute: 'reenter',
  maxIterations: 3,
  activateWhenDepthAtLeast: 'autonomous',
};

function threeStepLoopFlow(withFlag: boolean): ExecutableFlow {
  return {
    id: 'until-loop-runtime-proof',
    version: '0.1.0',
    entry: 'loop-head',
    stages: [{ id: 'body', stepIds: ['loop-head', 'loop-body', 'loop-tail'] }],
    steps: [
      {
        id: 'loop-head',
        kind: 'compose',
        writer: 'head-writer',
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
        routes: { pass: { kind: 'step', stepId: 'loop-body' } },
      },
      {
        id: 'loop-body',
        kind: 'compose',
        writer: 'body-writer',
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
        routes: { pass: { kind: 'step', stepId: 'loop-tail' } },
      },
      {
        id: 'loop-tail',
        kind: 'compose',
        writer: 'tail-writer',
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          reenter: { kind: 'step', stepId: 'loop-head' },
        },
      },
    ],
    purpose: 'Exercise the count-driven until-loop over a multi-step body.',
    ...(withFlag ? { engineFlags: { iteratesUntilCondition: UNTIL_FLAG } } : {}),
  };
}

// Every step passes deterministically. The corridor, not the executor, decides
// whether the tail re-enters the loop, so a constant forward route is enough.
const passEveryStep = {
  compose: async (_step: unknown, _context: unknown) => ({ route: 'pass' as const }),
};

function enteredCount(
  trace: readonly { readonly kind: string; readonly step_id?: string | undefined }[],
  stepId: string,
): number {
  return trace.filter((e) => e.kind === 'step.entered' && e.step_id === stepId).length;
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-until-loop-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('until-loop runtime: count-driven multi-step body', () => {
  it('runs the full body once per iteration with no cycle-guard abort on the intermediate step', async () => {
    const runFolder = join(runFolderBase, 'looped');
    const outcome = await executeExecutableFlow(threeStepLoopFlow(true), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000001',
      goal: 'until loop must re-enter the body to the iteration cap',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 12, 0, 0)),
      executors: passEveryStep,
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('complete');

    // The body ran exactly maxIterations times — head, the INTERMEDIATE step,
    // and tail all re-entered three times. The intermediate step re-entering
    // without an abort is the proof the iteration-scoped count key covers the
    // whole body span, not just head and tail.
    expect(enteredCount(trace, 'loop-head')).toBe(3);
    expect(enteredCount(trace, 'loop-body')).toBe(3);
    expect(enteredCount(trace, 'loop-tail')).toBe(3);

    // No step ever aborted as an illegal re-entry.
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    const completions = trace.filter(
      (e): e is Extract<(typeof trace)[number], { kind: 'step.completed' }> =>
        e.kind === 'step.completed',
    );

    // Each body step re-entered at attempt 1 (a fresh iteration, not a retry).
    expect(completions.filter((e) => e.step_id === 'loop-body').map((e) => e.attempt)).toEqual([
      1, 1, 1,
    ]);

    // The tail re-entered twice, then exited on the third iteration.
    expect(completions.filter((e) => e.step_id === 'loop-tail').map((e) => e.route_taken)).toEqual([
      'reenter',
      'reenter',
      'pass',
    ]);
  });

  it('is byte-identical to a single pass when the flag is absent', async () => {
    const runFolder = join(runFolderBase, 'no-flag');
    const outcome = await executeExecutableFlow(threeStepLoopFlow(false), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000002',
      goal: 'no flag means a single pass',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 12, 30, 0)),
      executors: passEveryStep,
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('complete');
    expect(enteredCount(trace, 'loop-head')).toBe(1);
    expect(enteredCount(trace, 'loop-body')).toBe(1);
    expect(enteredCount(trace, 'loop-tail')).toBe(1);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();
  });

  it('stays a single pass when the flag is set but depth is below the autonomous floor', async () => {
    const runFolder = join(runFolderBase, 'below-floor');
    const outcome = await executeExecutableFlow(threeStepLoopFlow(true), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000003',
      goal: 'until loop is inert below autonomous depth',
      depth: 'high',
      now: deterministicNow(Date.UTC(2026, 5, 27, 13, 0, 0)),
      executors: passEveryStep,
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('complete');
    expect(enteredCount(trace, 'loop-body')).toBe(1);
    expect(enteredCount(trace, 'loop-tail')).toBe(1);
  });
});

// A malformed until flag should be caught up front and rejected cleanly, before
// any step runs, rather than aborting mid-loop with a misleading cycle-guard or
// undeclared-route message that blames a step for the engine's own redirect.
describe('until-loop runtime: invalid configuration rejects upfront', () => {
  const SLICE_FLAG: SliceLoopEngineFlag = {
    headStep: 'loop-head',
    tailStep: 'loop-tail',
    advanceRoute: 'reenter',
    slicesFrom: { report: 'reports/plan.json', itemsPath: 'slices' },
    maxSlices: 3,
    activateWhenDepthAtLeast: 'high',
  };

  function flowWithEngineFlags(engineFlags: ExecutableFlow['engineFlags']): ExecutableFlow {
    return {
      ...threeStepLoopFlow(false),
      ...(engineFlags === undefined ? {} : { engineFlags }),
    };
  }

  async function rejectionOf(
    flow: ExecutableFlow,
    extra?: Partial<Parameters<typeof executeExecutableFlowOutcome>[1]>,
  ): Promise<GraphExecutionOutcome> {
    return executeExecutableFlowOutcome(flow, {
      runDir: join(runFolderBase, 'reject'),
      runId: '70000000-0000-0000-0000-0000000000ff',
      goal: 'invalid until-loop config must reject before any step runs',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 14, 0, 0)),
      executors: passEveryStep,
      ...extra,
    });
  }

  function reason(outcome: GraphExecutionOutcome): string {
    return outcome.kind === 'rejected' ? outcome.reason : `(not rejected: ${outcome.kind})`;
  }

  it('rejects when bodySteps omits the tail step', async () => {
    const outcome = await rejectionOf(
      flowWithEngineFlags({
        iteratesUntilCondition: { ...UNTIL_FLAG, bodySteps: ['loop-head', 'loop-body'] },
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/omits tailStep 'loop-tail'/);
  });

  it('rejects when bodySteps omits the head step', async () => {
    const outcome = await rejectionOf(
      flowWithEngineFlags({
        iteratesUntilCondition: { ...UNTIL_FLAG, bodySteps: ['loop-body', 'loop-tail'] },
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/omits headStep 'loop-head'/);
  });

  it('rejects when the tail step does not declare the reenter route', async () => {
    const outcome = await rejectionOf(
      flowWithEngineFlags({
        iteratesUntilCondition: { ...UNTIL_FLAG, reenterRoute: 'loop-again' },
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/declares no such route/);
  });

  it('rejects a bodyStep id that names no declared step', async () => {
    const outcome = await rejectionOf(
      flowWithEngineFlags({
        iteratesUntilCondition: {
          ...UNTIL_FLAG,
          bodySteps: ['loop-head', 'ghost', 'loop-body', 'loop-tail'],
        },
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/bodyStep 'ghost'/);
  });

  it('rejects maxIterations below 1', async () => {
    const outcome = await rejectionOf(
      flowWithEngineFlags({ iteratesUntilCondition: { ...UNTIL_FLAG, maxIterations: 0 } }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/maxIterations 0/);
  });

  it('rejects a flow that sets both the slice loop and the until loop', async () => {
    const outcome = await rejectionOf(
      flowWithEngineFlags({
        iteratesUntilCondition: UNTIL_FLAG,
        iteratesSliceLoop: SLICE_FLAG,
      }),
    );
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/at most one loop shape/);
  });

  it('rejects resuming an until-loop run (per-iteration counts are not persisted)', async () => {
    const outcome = await rejectionOf(flowWithEngineFlags({ iteratesUntilCondition: UNTIL_FLAG }), {
      resumeCheckpoint: { stepId: 'loop-head', attempt: 1, selection: 'default' },
    });
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/cannot resume an until-loop run/);
  });
});

// The runtime tests above build the ExecutableFlow in memory, which sets
// engineFlags.iteratesUntilCondition directly and SKIPS the manifest boundary.
// A real flow never does that — it ships a compiled manifest with the
// snake_case `engine_flags.iterates_until_condition` block, and the loop only
// drives if `manifestEngineFlagsToInCode` translates that block onto the
// ExecutableFlow at `fromCompiledFlow`. A live autonomous run against the real
// connector proved this path end-to-end (the body re-entered to the cap and
// closed complete); these tests pin that same path deterministically, so a
// regression in the manifest translation OR the corridor wiring is caught
// without spending a model call.
function threeStepLoopManifest(withFlag: boolean): CompiledFlow {
  const composeStep = (id: string, forward: string, extraRoutes: Record<string, string> = {}) => ({
    id,
    title: `Compose ${id}`,
    protocol: `until-manifest-${id}@v1`,
    reads: [],
    routes: { continue: forward, pass: forward, ...extraRoutes },
    executor: 'orchestrator',
    kind: 'compose' as const,
    writes: { report: { path: `reports/${id}.json`, schema: 'plan.strategy@v1' } },
    check: {
      kind: 'schema_sections' as const,
      source: { kind: 'report' as const, ref: 'report' },
      required: ['summary'],
    },
  });
  const manifest: Record<string, unknown> = {
    schema_version: '3',
    id: 'until-loop-manifest-proof',
    version: '0.1.0',
    purpose: 'Drive the until loop through the compiled-manifest boundary.',
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: true,
      default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
    },
    starts_at: 'loop-head',
    stages: [
      {
        id: 'body-stage',
        title: 'Body',
        canonical: 'act',
        steps: ['loop-head', 'loop-body', 'loop-tail'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'plan', 'analyze', 'verify', 'review', 'close'],
      rationale: 'Narrow proof flow; only the act body runs.',
    },
    steps: [
      composeStep('loop-head', 'loop-body'),
      composeStep('loop-body', 'loop-tail'),
      composeStep('loop-tail', '@complete', { reenter: 'loop-head' }),
    ],
    ...(withFlag
      ? {
          engine_flags: {
            iterates_until_condition: {
              head_step: 'loop-head',
              tail_step: 'loop-tail',
              body_steps: ['loop-head', 'loop-body', 'loop-tail'],
              reenter_route: 'reenter',
              max_iterations: 2,
              activate_when_depth_at_least: 'autonomous',
            },
          },
        }
      : {}),
  };
  return CompiledFlow.parse(manifest);
}

describe('until-loop runtime: the compiled-manifest boundary drives the loop', () => {
  it('translates the snake_case manifest flag and re-enters the body to the cap', async () => {
    const runFolder = join(runFolderBase, 'manifest-looped');
    const flow = fromCompiledFlow(threeStepLoopManifest(true));

    // The translation actually landed the in-code flag on the ExecutableFlow.
    expect(flow.engineFlags?.iteratesUntilCondition?.maxIterations).toBe(2);

    const outcome = await executeExecutableFlow(flow, {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000010',
      goal: 'manifest-driven until loop re-enters the body to the cap',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 15, 0, 0)),
      executors: passEveryStep,
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('complete');
    // The intermediate body step re-entered the second iteration with no
    // cycle-guard abort — the count-key generalization survives the manifest path.
    expect(enteredCount(trace, 'loop-head')).toBe(2);
    expect(enteredCount(trace, 'loop-body')).toBe(2);
    expect(enteredCount(trace, 'loop-tail')).toBe(2);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();
  });

  it('is a single pass when the manifest carries no engine_flags block', async () => {
    const runFolder = join(runFolderBase, 'manifest-no-flag');
    const flow = fromCompiledFlow(threeStepLoopManifest(false));
    expect(flow.engineFlags?.iteratesUntilCondition).toBeUndefined();

    const outcome = await executeExecutableFlow(flow, {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000011',
      goal: 'no manifest flag means a single pass',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 15, 30, 0)),
      executors: passEveryStep,
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('complete');
    expect(enteredCount(trace, 'loop-head')).toBe(1);
    expect(enteredCount(trace, 'loop-body')).toBe(1);
    expect(enteredCount(trace, 'loop-tail')).toBe(1);
  });
});

// Slice 2: the stop-judge. The loop no longer advances on a fixed count. Each
// iteration the tail (a reviewer relay) PROPOSES whether the goal is met; the
// engine reads only that boolean and DISPOSES it against an independent
// evidence floor. The propose-vs-dispose split is the honesty mechanism: a
// met-claim the evidence does not confirm is a blocked false-done that re-enters
// for another pass, and exhausting the iteration cap can only ever reach the
// needs-attention exit, never the clean-stop forward route.
const SLICE2_FLAG: UntilLoopEngineFlag = {
  headStep: 'loop-head',
  tailStep: 'loop-tail',
  bodySteps: ['loop-head', 'loop-body', 'loop-tail'],
  reenterRoute: 'reenter',
  maxIterations: 3,
  activateWhenDepthAtLeast: 'autonomous',
  stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
  needsAttentionRoute: 'attention',
};

describe('until-loop runtime: stop-judge disposition (pure)', () => {
  // Step the corridor to a given iteration index, then read its disposition.
  function dispositionAt(
    index: number,
    input: { goalProposed: boolean; evidenceConfirms: boolean },
    maxIterations = 3,
  ) {
    const corridor = new UntilCorridor({
      flag: { ...SLICE2_FLAG, maxIterations },
      depth: 'autonomous',
    });
    for (let i = 0; i < index; i += 1) corridor.advance();
    return corridor.disposeIteration(input);
  }

  it('stops clean when the goal is proposed AND the evidence confirms it', () => {
    expect(dispositionAt(0, { goalProposed: true, evidenceConfirms: true })).toBe('stop-clean');
  });

  it('stops clean on a confirmed goal even at the final allowed iteration', () => {
    // index 2 of maxIterations 3 is the last pass; a confirmed goal still stops
    // clean rather than being forced to needs-attention by the cap.
    expect(dispositionAt(2, { goalProposed: true, evidenceConfirms: true }, 3)).toBe('stop-clean');
  });

  it('re-enters when a met-claim is NOT confirmed by the evidence (blocked false-done)', () => {
    expect(dispositionAt(0, { goalProposed: true, evidenceConfirms: false })).toBe('reenter');
  });

  it('re-enters when the judge proposes the goal is not yet met', () => {
    expect(dispositionAt(0, { goalProposed: false, evidenceConfirms: false })).toBe('reenter');
  });

  it('exhausts to needs-attention when an unconfirmed met-claim reaches the cap', () => {
    expect(dispositionAt(2, { goalProposed: true, evidenceConfirms: false }, 3)).toBe(
      'needs-attention',
    );
  });

  it('exhausts to needs-attention when the judge never proposes done by the cap', () => {
    expect(dispositionAt(2, { goalProposed: false, evidenceConfirms: false }, 3)).toBe(
      'needs-attention',
    );
  });
});

// A judge-gated loop body: the tail writes a goal-met report (the proposal) and
// takes its clean-stop forward route. The engine intercepts at the tail seam and
// either honors that forward route, re-enters the head, or routes to the
// needs-attention exit, depending on the proposal and the evidence floor.
function judgeLoopFlow(): ExecutableFlow {
  return {
    id: 'until-loop-stop-judge-proof',
    version: '0.1.0',
    entry: 'loop-head',
    stages: [{ id: 'body', stepIds: ['loop-head', 'loop-body', 'loop-tail'] }],
    steps: [
      {
        id: 'loop-head',
        kind: 'compose',
        writer: 'head-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: { pass: { kind: 'step', stepId: 'loop-body' } },
      },
      {
        id: 'loop-body',
        kind: 'compose',
        writer: 'body-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: { pass: { kind: 'step', stepId: 'loop-tail' } },
      },
      {
        id: 'loop-tail',
        kind: 'compose',
        writer: 'tail-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: {
          // The tail always selects its clean-stop forward route; the engine
          // disposes whether that exit is honored.
          pass: { kind: 'terminal', target: '@complete' },
          reenter: { kind: 'step', stepId: 'loop-head' },
          attention: { kind: 'terminal', target: '@stop' },
        },
      },
    ],
    purpose: 'Exercise the stop-judge dispose seam over a multi-step body.',
    engineFlags: { iteratesUntilCondition: SLICE2_FLAG },
  };
}

// A compose stub that plays the judge: when the tail runs, it writes the goal-met
// report the engine reads, with the boolean chosen per tail invocation, then
// takes the clean-stop forward route. Every other step just passes.
function judgeStub(goalMetByTailCall: (tailCall: number) => boolean) {
  let tailCalls = 0;
  return {
    compose: async (step: ExecutableStep, context: RunContext) => {
      if (step.id === 'loop-tail') {
        const met = goalMetByTailCall(tailCalls);
        tailCalls += 1;
        await context.files.writeJson('reports/judge.json', { goal_met: met });
      }
      return { route: 'pass' as const };
    },
  };
}

describe('until-loop runtime: stop-judge drives the loop end-to-end', () => {
  it('loops until the judge proposes done and the evidence confirms, then stops clean', async () => {
    const runFolder = join(runFolderBase, 'judge-converges');
    // Not done on the first iteration, done on the second.
    const outcome = await executeExecutableFlow(judgeLoopFlow(), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000020',
      goal: 'loop until the judge confirms the goal is met',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 16, 0, 0)),
      executors: judgeStub((tailCall) => tailCall >= 1),
      // Default evidence floor (no proof policy declared -> confirms).
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('complete');
    // Two iterations: iteration 0 re-entered (judge said not done), iteration 1
    // stopped clean (judge said done, evidence confirmed).
    expect(enteredCount(trace, 'loop-head')).toBe(2);
    expect(enteredCount(trace, 'loop-tail')).toBe(2);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();
  });

  it('blocks a false-done: a met-claim the evidence rejects never reaches complete', async () => {
    const runFolder = join(runFolderBase, 'judge-false-done');
    // The judge claims done every iteration, but the evidence floor never agrees.
    const outcome = await executeExecutableFlow(judgeLoopFlow(), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000021',
      goal: 'a hallucinating judge must not end the loop on a claim alone',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 16, 30, 0)),
      executors: judgeStub(() => true),
      untilEvidenceFloor: () => false,
    });
    const trace = await new TraceStore(runFolder).load();

    // Three iterations of blocked false-done, then the cap routes to the
    // needs-attention exit. The run never closes complete on the judge's claim.
    expect(outcome.outcome).not.toBe('complete');
    expect(outcome.outcome).toBe('stopped');
    expect(enteredCount(trace, 'loop-head')).toBe(3);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();
  });

  it('exhausts to the needs-attention exit when the judge never proposes done', async () => {
    const runFolder = join(runFolderBase, 'judge-never-done');
    const outcome = await executeExecutableFlow(judgeLoopFlow(), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000022',
      goal: 'a loop that never converges exits needs-attention, not complete',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 17, 0, 0)),
      executors: judgeStub(() => false),
    });
    const trace = await new TraceStore(runFolder).load();

    expect(outcome.outcome).toBe('stopped');
    expect(enteredCount(trace, 'loop-head')).toBe(3);
  });

  it('rejects a stop-judge flag that declares no needs-attention route', async () => {
    const { needsAttentionRoute: _drop, ...noAttention } = SLICE2_FLAG;
    const outcome = await executeExecutableFlowOutcome(
      { ...judgeLoopFlow(), engineFlags: { iteratesUntilCondition: noAttention } },
      {
        runDir: join(runFolderBase, 'judge-no-attention'),
        runId: '70000000-0000-0000-0000-000000000023',
        goal: 'a stop-judge loop must declare where an exhausted run exits',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 27, 17, 30, 0)),
        executors: judgeStub(() => false),
      },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' ? outcome.reason : '').toMatch(/needsAttentionRoute/);
  });
});

// The frozen-eval guard. An autonomous Converge loop runs an act step with full
// default tools, so nothing structurally stops that act from editing the very
// eval surface the evidence floor reads — the test file or the verify command's
// definition — so the next pass "passes" on a weakened check. `frozenPaths`
// declares that read-only surface; the engine fingerprints it at loop entry and,
// at each tail seam, re-fingerprints before the floor disposes the judge's
// goal-met claim. A drift opens the dedicated `frozen-eval-guard` honesty latch,
// which nothing ever clears, so a tampered run can only ever end stopped
// (needs-attention), never complete. The flag carries the projectRoot-relative
// frozen paths; the guard is constructed only when projectRoot is also present.
const FROZEN_FLAG: UntilLoopEngineFlag = {
  ...SLICE2_FLAG,
  frozenPaths: ['eval.txt'],
};

// A judge stub that, on the act body step, optionally tampers a frozen file under
// the project root (writing DIFFERENT bytes than the baseline), and on the tail
// writes the goal-met proposal. `tamper` lets a case turn the eval-surface edit on
// (the attack) or off (the clean control) while everything else stays identical.
function frozenEvalStub(input: { projectRoot: string; tamper: boolean }) {
  return {
    compose: async (step: ExecutableStep, context: RunContext) => {
      if (step.id === 'loop-body' && input.tamper) {
        // The act step weakens the eval surface so the verify the judge trusts
        // would pass on a gamed check. This is the move the guard must catch.
        writeFileSync(join(input.projectRoot, 'eval.txt'), 'check x === 0');
      }
      if (step.id === 'loop-tail') {
        await context.files.writeJson('reports/judge.json', { goal_met: true });
      }
      return { route: 'pass' as const };
    },
  };
}

describe('until-loop runtime: the frozen-eval guard latches a tampered eval surface', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'circuit-frozen-project-'));
    // The read-only eval surface the loop must not touch. Baseline bytes the
    // guard fingerprints at loop entry.
    writeFileSync(join(projectRoot, 'eval.txt'), 'check x === 1');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('TAMPER: an act step that edits a frozen path cannot close complete on a goal-met claim', async () => {
    const runFolder = join(runFolderBase, 'frozen-tamper');
    const outcome = await executeExecutableFlow(
      { ...judgeLoopFlow(), engineFlags: { iteratesUntilCondition: FROZEN_FLAG } },
      {
        runDir: runFolder,
        runId: '70000000-0000-0000-0000-000000000030',
        goal: 'an act that games the eval surface must not be honored as done',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 28, 9, 0, 0)),
        projectRoot,
        // The judge proposes done and the default evidence floor would otherwise
        // confirm — so the ONLY thing that can block a complete here is the
        // frozen-eval latch the tampering opens.
        executors: frozenEvalStub({ projectRoot, tamper: true }),
      },
    );
    const trace = await new TraceStore(runFolder).load();

    // The run never closes complete on the gamed pass: it exhausts to the
    // needs-attention exit instead.
    expect(outcome.outcome).not.toBe('complete');
    expect(outcome.outcome).toBe('stopped');
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // The honesty ledger names the frozen path that drifted.
    const ledger = JSON.parse(readFileSync(join(runFolder, 'honesty-ledger.json'), 'utf8')) as {
      open_overclaims: { stepId: string; reason: string }[];
    };
    expect(ledger.open_overclaims.map((l) => l.stepId)).toContain('frozen-eval-guard');
    expect(ledger.open_overclaims.find((l) => l.stepId === 'frozen-eval-guard')?.reason).toContain(
      'eval.txt',
    );
  });

  it('CONTROL: with the eval surface untouched, the same goal-met claim closes complete', async () => {
    const runFolder = join(runFolderBase, 'frozen-control');
    const outcome = await executeExecutableFlow(
      { ...judgeLoopFlow(), engineFlags: { iteratesUntilCondition: FROZEN_FLAG } },
      {
        runDir: runFolder,
        runId: '70000000-0000-0000-0000-000000000031',
        goal: 'a clean act that leaves the eval surface alone completes honestly',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 28, 9, 30, 0)),
        projectRoot,
        executors: frozenEvalStub({ projectRoot, tamper: false }),
      },
    );

    // Same flow, same goal-met claim, same evidence floor — only the tampering
    // differs, so a complete close here proves the latch is the sole cause of the
    // tamper run's stop.
    expect(outcome.outcome).toBe('complete');
  });
});

// Slices 4-6 (carried notes, the budget cap, the no-progress ceiling) are read
// only on the stop-judge tail seam. A count-driven loop that declares one of them
// would silently ignore it — a fail-open of a declared spend cap. The validator
// must reject the combination up front rather than accept a bound it won't honor.
describe('until-loop runtime: slice 4-6 fields require a stop-judge', () => {
  const COUNT_BASE: UntilLoopEngineFlag = {
    headStep: 'loop-head',
    tailStep: 'loop-tail',
    bodySteps: ['loop-head', 'loop-body', 'loop-tail'],
    reenterRoute: 'reenter',
    maxIterations: 3,
    activateWhenDepthAtLeast: 'autonomous',
  };

  it('rejects a cumulative budget cap declared without a stop-judge', async () => {
    const outcome = await executeExecutableFlowOutcome(
      steerLoopFlow({ ...COUNT_BASE, cumulativeTokenCap: 1000 }),
      {
        runDir: join(runFolderBase, 'cap-without-judge'),
        runId: '70000000-0000-0000-0000-000000000047',
        goal: 'a count loop that declares a spend cap it cannot honor must be rejected',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 27, 22, 30, 0)),
        executors: steerStub({ goalMet: () => false }),
      },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' ? outcome.reason : '').toMatch(
      /cumulativeTokenCap.*stopJudge/,
    );
  });

  it('rejects a no-progress ceiling with no progress marker source', async () => {
    const outcome = await executeExecutableFlowOutcome(
      steerLoopFlow({
        ...COUNT_BASE,
        stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
        needsAttentionRoute: 'attention',
        noProgressCeiling: 2,
      }),
      {
        runDir: join(runFolderBase, 'ceiling-without-marker'),
        runId: '70000000-0000-0000-0000-000000000048',
        goal: 'a ceiling that can never trip because no marker is recorded must be rejected',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 27, 23, 0, 0)),
        executors: steerStub({ goalMet: () => false }),
      },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' ? outcome.reason : '').toMatch(/progressPath/);
  });

  it('rejects frozenPaths declared without a stop-judge (the freeze would be a fail-open)', async () => {
    // The frozen-eval guard latches into the honesty ledger, which exists only on
    // a judge-gated loop. A count-driven loop declaring frozenPaths would never
    // consult the guard, so the eval surface would be silently unfrozen — the
    // validator must reject it up front like the other judge-only bounds.
    const outcome = await executeExecutableFlowOutcome(
      steerLoopFlow({ ...COUNT_BASE, frozenPaths: ['eval.txt'] }),
      {
        runDir: join(runFolderBase, 'frozen-without-judge'),
        runId: '70000000-0000-0000-0000-000000000049',
        goal: 'a count loop that declares a frozen eval surface it cannot enforce must be rejected',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 27, 23, 30, 0)),
        executors: steerStub({ goalMet: () => false }),
      },
    );
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' ? outcome.reason : '').toMatch(/frozenPaths.*stopJudge/);
  });
});

// Slice 3: the honesty ledger and the abort-intercept (the make-or-break).
//
// Today, when an honesty check catches a worker overclaim and the in-step
// retries exhaust, the run aborts and no state survives. Under the until flag
// with a stop-judge, that run-boundary abort is intercepted: the engine latches
// the unresolved overclaim, re-enters a fresh iteration, and — critically — can
// never close `complete` while a latch is still open. The latch clears only when
// a later iteration re-runs that step and its honesty check passes clean.
//
// These tests drive a REAL in-step retry exhaustion (not a simulated latch): a
// body step selects its self-retry recovery route with failure evidence until
// the route's max_attempts run out, which is exactly the run-boundary abort the
// intercept catches. The recovery machinery (a work contract + a binding for the
// retry route) is what gives the route real attempts; without it the route
// aborts immediately as an unsanctioned cycle.
const RECOVERY_LOOP_FLAG: UntilLoopEngineFlag = {
  headStep: 'loop-head',
  tailStep: 'loop-tail',
  bodySteps: ['loop-head', 'loop-work', 'loop-tail'],
  reenterRoute: 'reenter',
  maxIterations: 2,
  activateWhenDepthAtLeast: 'autonomous',
  stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
  needsAttentionRoute: 'attention',
};

const recoveryLoopWorkContractRef = {
  kind: 'work_contract' as const,
  ref: 'runtime/work-contract/until-recovery/test.json',
  sha256: 'a'.repeat(64),
  flow_id: CompiledFlowId.parse('until-loop-recovery-proof'),
};

// A binding that makes loop-work's `retry` route a real recovery route with its
// own attempt budget (must_respect_max_attempts), so a failing loop-work
// re-enters itself until the budget runs out rather than aborting on first sight.
function recoveryLoopBinding(): RecoveryRouteBindingV0 {
  return {
    schema_version: 0,
    step_id: StepId.parse('loop-work'),
    route_id: 'retry',
    route_target: 'loop-work',
    kind: 'narrow_scope',
    allowed_failure_causes: ['failed_check', 'contradicted_evidence', 'scope_drift'],
    required_refs: ['trace'],
    operator_authority: 'not_required',
    attempt_budget: {
      consumes_step_attempt: false,
      must_respect_max_attempts: true,
      retry_target: 'declared_step',
    },
    guidance: { subject: 'recovery_route', must_match_step_completed: true },
    source_ref: recoveryLoopWorkContractRef,
  };
}

// head -> work -> tail, where work can self-retry (a recovery route) and the tail
// is the stop-judge. A failing work step exhausts its retries; the intercept
// catches that and latches loop-work instead of aborting.
function recoveryLoopFlow(): ExecutableFlow {
  return {
    id: 'until-loop-recovery-proof',
    version: '0.1.0',
    entry: 'loop-head',
    stages: [{ id: 'body', stepIds: ['loop-head', 'loop-work', 'loop-tail'] }],
    steps: [
      {
        id: 'loop-head',
        kind: 'compose',
        writer: 'head-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: { pass: { kind: 'step', stepId: 'loop-work' } },
      },
      {
        id: 'loop-work',
        kind: 'compose',
        writer: 'work-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: {
          pass: { kind: 'step', stepId: 'loop-tail' },
          retry: { kind: 'step', stepId: 'loop-work' },
        },
      },
      {
        id: 'loop-tail',
        kind: 'compose',
        writer: 'tail-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          reenter: { kind: 'step', stepId: 'loop-head' },
          attention: { kind: 'terminal', target: '@stop' },
        },
      },
    ],
    purpose: 'Exercise the slice-3 abort-intercept: a body step exhausts its in-step retries.',
    engineFlags: { iteratesUntilCondition: RECOVERY_LOOP_FLAG },
  };
}

// loop-work FAILS (selects its self-retry recovery route, with the failure
// evidence the route requires) for its first `failCount` invocations, then
// passes. Failing every attempt within an iteration exhausts the route's
// max_attempts. The tail always writes a goal-met report claiming done.
function exhaustingWorkStub(failCount: number) {
  let workCalls = 0;
  return {
    compose: async (step: ExecutableStep, context: RunContext) => {
      if (step.id === 'loop-tail') {
        await context.files.writeJson('reports/judge.json', { goal_met: true });
        return { route: 'pass' as const };
      }
      if (step.id === 'loop-work') {
        const fail = workCalls < failCount;
        workCalls += 1;
        if (fail) {
          // Mirror the real relay/verification executors: a loop-body check
          // stamps slice_index from the active iteration scope, so the recovery
          // resolver files this failure under its iteration and a later clean
          // iteration is not blamed for it.
          await context.trace.append({
            run_id: context.runId,
            kind: 'check.evaluated',
            step_id: step.id,
            attempt: context.activeStepAttempt ?? 1,
            check_kind: 'schema_sections',
            outcome: 'fail',
            reason: 'work overclaim: nothing changed on disk',
            ...(context.activeSliceIndex === undefined
              ? {}
              : { slice_index: context.activeSliceIndex }),
          });
          return {
            route: 'retry' as const,
            details: { reason: 'work overclaim: nothing changed on disk' },
          };
        }
      }
      return { route: 'pass' as const };
    },
  };
}

function readLedger(runFolder: string): { open_overclaims: { stepId: string }[] } | undefined {
  const path = join(runFolder, 'honesty-ledger.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

describe('until-loop runtime: slice-3 abort-intercept and the honesty ledger', () => {
  it('latches an exhausted overclaim and re-enters rather than aborting; never completes while open', async () => {
    const runFolder = join(runFolderBase, 'overclaim-never-clears');
    // loop-work fails every attempt of every iteration: it can never resolve, so
    // the latch stays open and the run can only ever exhaust to needs-attention.
    const outcome = await executeExecutableFlow(recoveryLoopFlow(), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000030',
      goal: 'an overclaim that never resolves must not close complete',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 18, 0, 0)),
      workContractRef: recoveryLoopWorkContractRef,
      recoveryRouteBindings: [recoveryLoopBinding()],
      executors: exhaustingWorkStub(Number.POSITIVE_INFINITY),
    });

    // The judge claimed done every time it ran, but the run never completes: the
    // overclaim latch keeps it honest. It exhausts the iteration cap to stopped.
    expect(outcome.outcome).toBe('stopped');
    expect(outcome.outcome).not.toBe('aborted');

    // The durable ledger records loop-work as the unresolved open overclaim.
    const ledger = readLedger(runFolder);
    expect(ledger?.open_overclaims.map((latch) => latch.stepId)).toContain('loop-work');
  });

  it('clears the latch when a later iteration re-runs the step clean, then completes', async () => {
    const runFolder = join(runFolderBase, 'overclaim-then-clears');
    // loop-work fails its two attempts in iteration 0 (exhausts -> latch ->
    // re-enter), then passes clean on iteration 1: the clean re-run clears the
    // latch, the judge confirms done, and the run closes complete.
    const outcome = await executeExecutableFlow(recoveryLoopFlow(), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000031',
      goal: 'an overclaim that later resolves clean lets the loop converge',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 18, 30, 0)),
      workContractRef: recoveryLoopWorkContractRef,
      recoveryRouteBindings: [recoveryLoopBinding()],
      executors: exhaustingWorkStub(2),
    });

    expect(outcome.outcome).toBe('complete');

    // The ledger ends clean: the latch opened in iteration 0 was cleared by the
    // clean re-run in iteration 1.
    const ledger = readLedger(runFolder);
    expect(ledger?.open_overclaims ?? []).toEqual([]);
  });
});

// Slices 4-6: carried notes (the loop learns across passes), the cumulative
// budget cap (fail-closed), and no-progress steering. All three compose at the
// stop-judge tail seam: each iteration the tail proposes goal-met plus an
// optional lesson and progress marker, and the engine carries the lesson
// forward, sums spend, and watches the marker.
const STEER_FLAG_BASE: UntilLoopEngineFlag = {
  headStep: 'loop-head',
  tailStep: 'loop-tail',
  bodySteps: ['loop-head', 'loop-body', 'loop-tail'],
  reenterRoute: 'reenter',
  maxIterations: 10,
  activateWhenDepthAtLeast: 'autonomous',
  needsAttentionRoute: 'attention',
};

// head -> body -> tail, the same judge-gated shape, parameterized by the flag so
// each test opts into the carried-notes / budget / no-progress fields it needs.
function steerLoopFlow(flag: UntilLoopEngineFlag): ExecutableFlow {
  return {
    id: 'until-loop-steer-proof',
    version: '0.1.0',
    entry: 'loop-head',
    stages: [{ id: 'body', stepIds: ['loop-head', 'loop-body', 'loop-tail'] }],
    steps: [
      {
        id: 'loop-head',
        kind: 'compose',
        writer: 'head-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: { pass: { kind: 'step', stepId: 'loop-body' } },
      },
      {
        id: 'loop-body',
        kind: 'compose',
        writer: 'body-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: { pass: { kind: 'step', stepId: 'loop-tail' } },
      },
      {
        id: 'loop-tail',
        kind: 'compose',
        writer: 'tail-writer',
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          reenter: { kind: 'step', stepId: 'loop-head' },
          attention: { kind: 'terminal', target: '@stop' },
        },
      },
    ],
    purpose: 'Exercise carried notes, the budget cap, and no-progress steering.',
    engineFlags: { iteratesUntilCondition: flag },
  };
}

// A valid, strict relay.completed entry carrying token usage, so a test can grow
// the run's cumulative spend by a known amount per iteration (the budget
// accumulator reads exactly these entries off the trace).
async function appendUsageRelay(context: RunContext, step: ExecutableStep, tokens: number) {
  await context.trace.append({
    run_id: context.runId,
    kind: 'relay.completed',
    step_id: step.id,
    attempt: context.activeStepAttempt ?? 1,
    verdict: 'ok',
    duration_ms: 1,
    result_path: 'reports/relay-result.json',
    receipt_path: 'reports/relay-receipt.json',
    usage: {
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
    },
  });
}

interface SteerStubOptions {
  readonly goalMet?: (tailCall: number) => boolean;
  readonly lesson?: (tailCall: number) => string;
  readonly progress?: (tailCall: number) => unknown;
  readonly tokensPerIteration?: number;
  // When true, the body emits a relay.completed with NO usage block (codex /
  // custom connectors), the fail-closed trigger for a budget cap.
  readonly usagelessBodyRelay?: boolean;
  // When provided, the head records how many carried notes it read on each pass,
  // proving the write-at-tail / read-at-head round trip without the composer.
  readonly notesSeenAtHead?: number[];
}

function steerStub(opts: SteerStubOptions) {
  let tailCalls = 0;
  return {
    compose: async (step: ExecutableStep, context: RunContext) => {
      if (step.id === 'loop-head' && opts.notesSeenAtHead !== undefined) {
        let count = 0;
        try {
          const notes = await context.files.readJson('reports/notes.json');
          if (Array.isArray(notes)) count = notes.length;
        } catch {
          count = 0;
        }
        opts.notesSeenAtHead.push(count);
      }
      if (step.id === 'loop-body' && opts.tokensPerIteration !== undefined) {
        await appendUsageRelay(context, step, opts.tokensPerIteration);
      }
      if (step.id === 'loop-body' && opts.usagelessBodyRelay === true) {
        await context.trace.append({
          run_id: context.runId,
          kind: 'relay.completed',
          step_id: step.id,
          attempt: context.activeStepAttempt ?? 1,
          verdict: 'ok',
          duration_ms: 1,
          result_path: 'reports/relay-result.json',
          receipt_path: 'reports/relay-receipt.json',
        });
      }
      if (step.id === 'loop-tail') {
        const report: Record<string, unknown> = {
          goal_met: opts.goalMet ? opts.goalMet(tailCalls) : false,
        };
        if (opts.lesson !== undefined) report.lesson = opts.lesson(tailCalls);
        if (opts.progress !== undefined) report.progress = opts.progress(tailCalls);
        tailCalls += 1;
        await context.files.writeJson('reports/judge.json', report);
      }
      return { route: 'pass' as const };
    },
  };
}

function readNotes(runFolder: string): { iteration: number; lesson: string; steer?: string }[] {
  try {
    return JSON.parse(readFileSync(join(runFolder, 'reports/notes.json'), 'utf8'));
  } catch {
    return [];
  }
}

describe('until-loop runtime: slice-4 carried notes', () => {
  it('carries each iteration lesson forward, so the next head reads the growing history', async () => {
    const runFolder = join(runFolderBase, 'carried-notes');
    const notesSeenAtHead: number[] = [];
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: {
        report: 'reports/judge.json',
        goalMetPath: 'goal_met',
        lessonPath: 'lesson',
      },
      carriedNotes: { report: 'reports/notes.json' },
    };
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000040',
      goal: 'a loop that learns: each pass leaves a lesson for the next',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 19, 0, 0)),
      // Not done on the first two passes, done on the third.
      executors: steerStub({
        goalMet: (tailCall) => tailCall >= 2,
        lesson: (tailCall) => `lesson ${tailCall}`,
        notesSeenAtHead,
      }),
    });

    expect(outcome.outcome).toBe('complete');
    // Three passes; the head saw 0 notes, then 1, then 2 — the round trip.
    expect(notesSeenAtHead).toEqual([0, 1, 2]);
    // The two re-entering passes each left a note; the clean-stop pass left none.
    const notes = readNotes(runFolder);
    expect(notes.map((n) => n.lesson)).toEqual(['lesson 0', 'lesson 1']);
  });
});

describe('until-loop runtime: slice-5 cumulative budget cap', () => {
  it('warns at the soft threshold then exits to needs-attention at the hard cap', async () => {
    const runFolder = join(runFolderBase, 'budget-cap');
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: {
        report: 'reports/judge.json',
        goalMetPath: 'goal_met',
        lessonPath: 'lesson',
      },
      carriedNotes: { report: 'reports/notes.json' },
      cumulativeTokenCap: 1500,
    };
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000041',
      goal: 'a loop that never converges must stop at the budget cap, not spend forever',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 19, 30, 0)),
      // Goal never met; 600 tokens/pass. 600 (clear) -> 1200 (80% warn) ->
      // 1800 (>= 1500 cap) forces the exit, well before maxIterations 10.
      executors: steerStub({
        goalMet: () => false,
        lesson: (tailCall) => `pass ${tailCall}`,
        tokensPerIteration: 600,
      }),
    });

    expect(outcome.outcome).toBe('stopped');
    const trace = await new TraceStore(runFolder).load();
    expect(enteredCount(trace, 'loop-head')).toBe(3);
    // The 80%-threshold pass left a closure-priority steer for the next pass.
    const notes = readNotes(runFolder);
    const warned = notes.find((n) => n.steer?.includes('prioritize closing out'));
    expect(warned).toBeDefined();
  });

  it('fails closed: a token cap with a usage-less relay stops the loop immediately', async () => {
    const runFolder = join(runFolderBase, 'budget-fail-closed');
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
      cumulativeTokenCap: 1_000_000,
    };
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000042',
      goal: 'an unmeasurable spend under a cap must fail closed, not run unbounded',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 20, 0, 0)),
      // The body emits a usage-LESS relay each pass. The token cap is enormous,
      // so only the unmeasurable spend can stop the loop. Fail closed must exit on
      // the very first pass rather than spend unbounded under a cap it cannot read.
      executors: steerStub({ goalMet: () => false, usagelessBodyRelay: true }),
    });

    expect(outcome.outcome).toBe('stopped');
    // Exactly one pass: fail-closed bit immediately, well before the iteration cap.
    const trace = await new TraceStore(runFolder).load();
    expect(enteredCount(trace, 'loop-head')).toBe(1);
  });
});

describe('until-loop runtime: slice-6 no-progress steering', () => {
  it('steers on the first stall then exits at the no-progress ceiling', async () => {
    const runFolder = join(runFolderBase, 'no-progress-ceiling');
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: {
        report: 'reports/judge.json',
        goalMetPath: 'goal_met',
        lessonPath: 'lesson',
        progressPath: 'progress',
      },
      carriedNotes: { report: 'reports/notes.json' },
      noProgressCeiling: 2,
    };
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000043',
      goal: 'a loop spinning with no progress must bail out before the iteration cap',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 20, 30, 0)),
      // Same progress marker every pass: pass 0 (baseline), pass 1 (stall -> steer),
      // pass 2 (second stall reaches ceiling 2 -> exit). Never the iteration cap 10.
      executors: steerStub({
        goalMet: () => false,
        lesson: (tailCall) => `pass ${tailCall}`,
        progress: () => 5,
      }),
    });

    expect(outcome.outcome).toBe('stopped');
    const trace = await new TraceStore(runFolder).load();
    expect(enteredCount(trace, 'loop-head')).toBe(3);
    const notes = readNotes(runFolder);
    const steered = notes.find((n) => n.steer?.includes('materially different approach'));
    expect(steered).toBeDefined();
  });

  it('does not trip the ceiling while the progress marker keeps changing', async () => {
    const runFolder = join(runFolderBase, 'no-progress-changing');
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: {
        report: 'reports/judge.json',
        goalMetPath: 'goal_met',
        progressPath: 'progress',
      },
      noProgressCeiling: 2,
    };
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000044',
      goal: 'real progress each pass must not be mistaken for a stall',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 21, 0, 0)),
      // Progress changes every pass, so the ceiling never trips; the goal is met
      // on the third pass and the loop converges normally.
      executors: steerStub({
        goalMet: (tailCall) => tailCall >= 2,
        progress: (tailCall) => tailCall,
      }),
    });

    expect(outcome.outcome).toBe('complete');
    const trace = await new TraceStore(runFolder).load();
    expect(enteredCount(trace, 'loop-head')).toBe(3);
  });
});

// A fake commit-containment runner: records every call instead of touching git,
// so the engine seam can be proven without a real repo. The real git-backed
// runner is exercised separately in tests/unit/commit-containment.test.ts.
function recordingContainmentRunner() {
  const begins: { branchName: string }[] = [];
  const commits: { iterationIndex: number; message: string }[] = [];
  return {
    begins,
    commits,
    runner: {
      begin(input: { branchName: string }) {
        begins.push(input);
      },
      commitIteration(input: { iterationIndex: number; message: string }) {
        commits.push(input);
      },
    },
  };
}

describe('until-loop runtime: slice-7 commit containment', () => {
  it('commits once per iteration on a single throwaway branch when both flag and runner are present', async () => {
    const runFolder = join(runFolderBase, 'commit-containment');
    const recorder = recordingContainmentRunner();
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
      iterationCommitContainment: { branchPrefix: 'circuit/converge' },
    };
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000045',
      goal: 'an autonomous loop should contain each iteration as its own commit',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 21, 30, 0)),
      commitContainmentRunner: recorder.runner,
      // Not done on the first two passes, done on the third: three iterations.
      executors: steerStub({ goalMet: (tailCall) => tailCall >= 2 }),
    });

    expect(outcome.outcome).toBe('complete');
    // The branch is begun exactly once, named with the prefix and the run id, and
    // every subsequent commit lands on it (the operator's branch never moves).
    expect(recorder.begins).toEqual([
      { branchName: 'circuit/converge-70000000-0000-0000-0000-000000000045' },
    ]);
    // One commit per completed iteration, indices 0..2, even the converging pass.
    expect(recorder.commits.map((c) => c.iterationIndex)).toEqual([0, 1, 2]);
  });

  it('is inert (no git calls, no throw) when the flag is declared but no runner is injected', async () => {
    const runFolder = join(runFolderBase, 'commit-containment-no-runner');
    const flag: UntilLoopEngineFlag = {
      ...STEER_FLAG_BASE,
      stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
      iterationCommitContainment: { branchPrefix: 'circuit/converge' },
    };
    // Same flag, but the host wires NO runner: the engine must make zero git
    // calls and the loop runs uncontained, exactly as without the flag.
    const outcome = await executeExecutableFlow(steerLoopFlow(flag), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000046',
      goal: 'the flag alone, with no injected runner, changes nothing',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 22, 0, 0)),
      executors: steerStub({ goalMet: (tailCall) => tailCall >= 2 }),
    });

    expect(outcome.outcome).toBe('complete');
    const trace = await new TraceStore(runFolder).load();
    expect(enteredCount(trace, 'loop-head')).toBe(3);
  });

  it('contains every iteration, including ones that exhaust via the abort-intercept and never reach the tail', async () => {
    const runFolder = join(runFolderBase, 'commit-containment-exhaust');
    const recorder = recordingContainmentRunner();
    // loop-work overclaims every attempt of every iteration: each iteration ends
    // via the slice-3 abort-intercept (the body step exhausts its retries and the
    // run re-enters / finally stops) and NEVER reaches the tail seam. Without the
    // fix the intercept bypasses the only commit site, so the branch is never even
    // begun and the exhausted work is never contained.
    const outcome = await executeExecutableFlow(
      {
        ...recoveryLoopFlow(),
        engineFlags: {
          iteratesUntilCondition: {
            ...RECOVERY_LOOP_FLAG,
            iterationCommitContainment: { branchPrefix: 'circuit/converge' },
          },
        },
      },
      {
        runDir: runFolder,
        runId: '70000000-0000-0000-0000-000000000049',
        goal: 'an exhausting loop must still contain each pass as its own commit',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 27, 23, 30, 0)),
        workContractRef: recoveryLoopWorkContractRef,
        recoveryRouteBindings: [recoveryLoopBinding()],
        commitContainmentRunner: recorder.runner,
        executors: exhaustingWorkStub(Number.POSITIVE_INFINITY),
      },
    );

    expect(outcome.outcome).toBe('stopped');
    // The throwaway branch is begun once, and BOTH exhausted iterations (the
    // re-entering one and the final stopped one) are contained, in order.
    expect(recorder.begins).toEqual([
      { branchName: 'circuit/converge-70000000-0000-0000-0000-000000000049' },
    ]);
    expect(recorder.commits.map((c) => c.iterationIndex)).toEqual([0, 1]);
  });

  it('keeps one commit per iteration when an exhausted pass is followed by a clean converging pass', async () => {
    const runFolder = join(runFolderBase, 'commit-containment-mixed');
    const recorder = recordingContainmentRunner();
    // Iteration 0 exhausts its retries (contained at the intercept), iteration 1
    // re-runs loop-work clean and converges through the tail (contained at the tail
    // seam). The two commit sites must cooperate: exactly one commit per iteration,
    // indices in order, no double-commit and no folding.
    const outcome = await executeExecutableFlow(
      {
        ...recoveryLoopFlow(),
        engineFlags: {
          iteratesUntilCondition: {
            ...RECOVERY_LOOP_FLAG,
            iterationCommitContainment: { branchPrefix: 'circuit/converge' },
          },
        },
      },
      {
        runDir: runFolder,
        runId: '70000000-0000-0000-0000-000000000050',
        goal: 'an exhausted pass then a clean pass must contain as two commits, in order',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 28, 0, 0, 0)),
        workContractRef: recoveryLoopWorkContractRef,
        recoveryRouteBindings: [recoveryLoopBinding()],
        commitContainmentRunner: recorder.runner,
        executors: exhaustingWorkStub(2),
      },
    );

    expect(outcome.outcome).toBe('complete');
    expect(recorder.begins).toHaveLength(1);
    expect(recorder.commits.map((c) => c.iterationIndex)).toEqual([0, 1]);
  });
});

// The experiment ledger. Every judge-gated pass stamps a run.until-judgment
// entry at the tail seam after its disposition is final; iterationLedgerFromTrace
// projects those entries into one row per iteration. These tests drive the same
// judge harness above, then read the stamped entries back off the durable trace
// to prove the per-pass record lands honestly — both on a converging run and on
// a tampered run that must never read back as a clean stop.
describe('until-loop runtime: the experiment ledger records every judged pass', () => {
  it('records one row per iteration with the settled disposition and confirmed clean stop', async () => {
    const runFolder = join(runFolderBase, 'ledger-converges');
    // Not done on iterations 0 and 1, done on iteration 2.
    const outcome = await executeExecutableFlow(judgeLoopFlow(), {
      runDir: runFolder,
      runId: '70000000-0000-0000-0000-000000000060',
      goal: 'the ledger records each pass and the converging stop',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 28, 10, 0, 0)),
      executors: judgeStub((tailCall) => tailCall >= 2),
    });
    const trace = await new TraceStore(runFolder).load();
    expect(outcome.outcome).toBe('complete');

    const rows = iterationLedgerFromTrace(trace);
    expect(rows.map((r) => r.iteration)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.disposition)).toEqual(['reenter', 'reenter', 'stop-clean']);
    expect(rows[2]?.goalProposed).toBe(true);
    expect(rows[2]?.evidenceConfirmed).toBe(true);
    expect(rows.every((r) => r.openLatchCount === 0)).toBe(true);
  });

  it('records a tampered pass faithfully: goal proposed, evidence rejected, a latch open, never stop-clean', async () => {
    const runFolder = join(runFolderBase, 'ledger-tamper');
    // A fresh project root with the frozen eval surface the tampering act edits.
    const tamperRoot = mkdtempSync(join(tmpdir(), 'circuit-ledger-frozen-'));
    writeFileSync(join(tamperRoot, 'eval.txt'), 'check x === 1');
    try {
      const outcome = await executeExecutableFlow(
        { ...judgeLoopFlow(), engineFlags: { iteratesUntilCondition: FROZEN_FLAG } },
        {
          runDir: runFolder,
          runId: '70000000-0000-0000-0000-000000000061',
          goal: 'a gamed eval surface must read back as proposed-but-unconfirmed, never clean',
          depth: 'autonomous',
          now: deterministicNow(Date.UTC(2026, 5, 28, 10, 30, 0)),
          projectRoot: tamperRoot,
          executors: frozenEvalStub({ projectRoot: tamperRoot, tamper: true }),
        },
      );
      const trace = await new TraceStore(runFolder).load();
      // The run never closes complete on the gamed pass.
      expect(outcome.outcome).toBe('stopped');

      const rows = iterationLedgerFromTrace(trace);
      expect(rows.length).toBeGreaterThan(0);
      // The judge proposed done every pass, but the frozen-eval latch keeps the
      // evidence from confirming — so no row is ever a clean stop.
      expect(rows.every((r) => r.disposition !== 'stop-clean')).toBe(true);
      const tamperRow = rows.find((r) => r.goalProposed && !r.evidenceConfirmed);
      expect(tamperRow).toBeDefined();
      expect(tamperRow?.openLatchCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tamperRoot, { recursive: true, force: true });
    }
  });
});

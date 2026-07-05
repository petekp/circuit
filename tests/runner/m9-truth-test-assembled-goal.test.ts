// A5 truth test (first-class composition): run the assembled GOAL flow through
// the shared composed path — assemble → compile → RUN — and prove the deepest
// generality claim: an assembled flow's SUB-RUN path runs, not just compiles.
//
// Goal is the assembler's generality stress-test. It is the only built-in that
// composes whole flows as steps (five `goal-child-run` sub-run steps). The build
// truth test (m9-truth-test-assembled-build.test.ts) proved a strict relay/
// compose/checkpoint spine runs from the assembler; this extends that to the
// sub-run execution kind, plus goal's two-pass gate and terminal-outcome bind.
//
// Two halves, mirroring the build truth test:
//   1. Compile parity. The assembled-then-compiled goal deep-equals both the
//      shipped goal CompiledFlow (re-proving equivalence from the production
//      source in src/) and the on-disk generated/flows/goal/circuit.json the
//      runtime loads. So the assembled artifact IS the bytes the runtime runs.
//   2. Run validity. Those bytes drive a full Goal run — clarify relay, contract
//      compose, a child sub-run, attempt, evaluation, two gate-review relays,
//      close — to @complete on the real runner, using the same executor stubs
//      the goal-flow package test uses. Not tautological with the equivalence
//      test: it exercises the sub-run execution kind end-to-end, so an assembled
//      goal that compiled but could not run its child step would fail here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import { goalAssemblySpec } from '../../src/flows/goal/assembly-spec.js';
import { GoalClarifiedTask, GoalGate, GoalResult } from '../../src/flows/goal/reports.js';
import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { RunResult } from '../../src/schemas/result.js';

const ON_DISK_FIXTURE = resolve('generated/flows/goal/circuit.json');
const GOAL_RUNTIME_TIMEOUT_MS = 120_000;

const goalFlowDefinition = (() => {
  const definition = flowDefinitions.find((entry) => entry.id === 'goal');
  if (definition === undefined) {
    throw new Error('missing goal FlowDefinition in the catalog');
  }
  return definition;
})();

function compileSingle(schematic: ReturnType<typeof assembleFlowSchematic>): CompiledFlow {
  const result = compileSchematicToCompiledFlow(schematic);
  if (result.kind !== 'single') {
    throw new Error(`expected a single compiled flow, got '${result.kind}'`);
  }
  return result.flow;
}

function readJson<T>(runFolder: string, path: string): T {
  return JSON.parse(readFileSync(join(runFolder, path), 'utf8')) as T;
}

// A clarified-task report that keeps the original request authoritative and
// routes the contract step to a single static child target. Mirrors the
// goal-flow package test's `clarifiedTask` fixture.
function clarifiedTask(goal: string): ReturnType<typeof GoalClarifiedTask.parse> {
  return GoalClarifiedTask.parse({
    schema: 'goal.clarified-task@v1',
    verdict: 'continue',
    original_request: goal,
    target: { kind: 'flow', id: 'goal' },
    guide_id: 'goal-v1',
    clarified_prompt: goal,
    objective: goal,
    desired_outcome: goal,
    proof_needed: [
      {
        kind: 'command',
        description: 'Use the selected child flow proof and verification evidence.',
        required: true,
      },
    ],
    constraints: ['Preserve the operator request and current flow behavior.'],
    scope: {
      in_bounds: ['The operator objective and its proof.'],
      out_of_bounds: ['Dynamic child flow loading.'],
    },
    assumptions: ['The current run folder is the authoritative Goal state.'],
    missing_information: [],
    iteration_policy: ['Inspect evidence after each step and choose the next safe route.'],
    stop_conditions: ['Stop if required proof cannot be obtained.'],
    suggested_parts: [],
  });
}

function childRunResult(
  step: Extract<ExecutableStep, { kind: 'sub-run' }>,
  context: RunContext,
): ReturnType<typeof RunResult.parse> {
  return RunResult.parse({
    schema_version: 1,
    run_id: '00000000-0000-0000-0000-000000000101',
    flow_id: step.flowRef,
    goal: context.goal,
    outcome: 'complete',
    summary: `${step.flowRef} child flow completed with report-backed evidence.`,
    closed_at: context.now().toISOString(),
    trace_entries_observed: 1,
    manifest_hash: `${step.flowRef}-hash`,
    verdict: 'accept',
  });
}

function gateReport(stepId: string): ReturnType<typeof GoalGate.parse> {
  if (stepId === 'goal-gate-pass-1') {
    return GoalGate.parse({
      schema: 'goal.gate@v1',
      verdict: 'gate-pass',
      clean_streak: 1,
      required_passes: 2,
      blocking_findings: [],
      low_findings: [],
      passes: [
        {
          pass_id: 'gate-1',
          attack_lens: 'contract-and-proof',
          evidence_checked: ['reports/goal/contract.json', 'reports/goal/evidence-evaluation.json'],
          verdict: 'gate-pass',
        },
      ],
      next_route: 'run-next-gate-pass',
    });
  }
  return GoalGate.parse({
    schema: 'goal.gate@v1',
    verdict: 'gate-pass',
    clean_streak: 2,
    required_passes: 2,
    blocking_findings: [],
    low_findings: [],
    passes: [
      {
        pass_id: 'gate-1',
        attack_lens: 'contract-and-proof',
        evidence_checked: ['reports/goal/contract.json', 'reports/goal/evidence-evaluation.json'],
        verdict: 'gate-pass',
      },
      {
        pass_id: 'gate-2',
        attack_lens: 'false-done-and-recovery',
        evidence_checked: ['reports/goal/attempts/attempt-1.json', 'reports/goal/gate-pass-1.json'],
        verdict: 'gate-pass',
      },
    ],
    next_route: 'close',
  });
}

// The same happy-path executor stubs the goal-flow package test uses: a sub-run
// executor that writes a child result (the path under proof here), plus a relay
// executor for clarify and the two gate passes.
function happyPathExecutors(): Partial<ExecutorRegistry> {
  return {
    'sub-run': async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
      if (step.kind !== 'sub-run') throw new Error(`unexpected step kind ${step.kind}`);
      const result = step.writes?.result;
      if (result === undefined) throw new Error('Goal child step must write a result');
      await context.files.writeJson(result, childRunResult(step, context));
      return { route: 'pass', details: { flow_ref: step.flowRef } };
    },
    relay: async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
      if (step.kind !== 'relay') throw new Error(`unexpected step kind ${step.kind}`);
      const report = step.writes?.report;
      if (report === undefined) throw new Error('Goal relay step must write a report');
      if (step.id === 'clarify-goal') {
        await context.files.writeJson(report, clarifiedTask(context.goal));
        return { route: 'continue', details: { verdict: 'continue' } };
      }
      await context.files.writeJson(report, gateReport(step.id));
      return { route: 'pass', details: { verdict: 'gate-pass' } };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-a5-goal-truth-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('A5 truth test — assembled goal through the shared composed path', () => {
  it('assembles the goal spec to the same FlowSchematic as the shipped definition', () => {
    const assembled = assembleFlowSchematic(goalAssemblySpec);
    const shipped = schematicForFlowDefinition(goalFlowDefinition);
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled goal to the same CompiledFlow as the shipped definition', () => {
    const assembled = compileSingle(assembleFlowSchematic(goalAssemblySpec));
    const shipped = compileSingle(schematicForFlowDefinition(goalFlowDefinition));
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled goal to the on-disk circuit.json the runtime loads', () => {
    const assembled = compileSingle(assembleFlowSchematic(goalAssemblySpec));
    const onDisk = CompiledFlow.parse(JSON.parse(readFileSync(ON_DISK_FIXTURE, 'utf8')));
    expect(CompiledFlow.parse(assembled)).toEqual(onDisk);
  });

  it(
    'runs the assembled goal through the real runner to @complete (sub-run path executes)',
    async () => {
      const assembled = compileSingle(assembleFlowSchematic(goalAssemblySpec));
      const bytes = Buffer.from(`${JSON.stringify(assembled)}\n`);
      const runFolder = join(runFolderBase, 'assembled-goal-run');

      const outcome = await runCompiledFlow({
        flowBytes: bytes,
        runDir: runFolder,
        runId: '00000000-0000-0000-0000-0000000009a5',
        goal: 'Fix the flaky login bug and prove it stays fixed',
        depth: 'medium',
        now: () => new Date('2026-05-20T12:00:00.000Z'),
        executors: happyPathExecutors(),
        maxSteps: 20,
      });

      expect(outcome.outcome).toBe('complete');

      // The sub-run child result the assembled flow's sub-run step wrote — direct
      // evidence the composed sub-run path executed, not just compiled.
      const childResult = RunResult.parse(
        readJson(runFolder, 'reports/goal/child-results/fix-result.json'),
      );
      expect(childResult.outcome).toBe('complete');
      expect(childResult.flow_id).toBe('fix');

      // The two-pass gate and terminal-outcome bind closed the run as complete.
      const gate = GoalGate.parse(readJson(runFolder, 'reports/goal/gate.json'));
      expect(gate.clean_streak).toBe(2);

      const goalResult = GoalResult.parse(readJson(runFolder, 'reports/goal-result.json'));
      expect(goalResult.outcome).toBe('complete');
    },
    GOAL_RUNTIME_TIMEOUT_MS,
  );
});

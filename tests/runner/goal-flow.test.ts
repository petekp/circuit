import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectRunStatusFromRunFolder } from '../../src/app/run-status/run-folder-projector.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import {
  GoalAttempt,
  GoalClarifiedTask,
  GoalContract,
  GoalEvidenceEvaluation,
  GoalGate,
  GoalRecovery,
  GoalResult,
} from '../../src/flows/goal/reports.js';
import type { StepOutcome } from '../../src/runtime/domain/step.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import {
  runCompiledFlow,
  runCompiledFlowWithWaiting,
} from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { RunResult } from '../../src/schemas/result.js';

const CHILD_TARGETS = ['fix', 'build', 'review', 'explore', 'pursue'] as const;

function goalCompiledFlow(): CompiledFlow {
  const goalFlowDefinition = flowDefinitions.find((definition) => definition.id === 'goal');
  if (goalFlowDefinition === undefined) throw new Error('Goal flow missing from catalog');
  const compiled = compileSchematicToCompiledFlow(schematicForFlowDefinition(goalFlowDefinition));
  if (compiled.kind !== 'single') throw new Error('Goal should compile to one graph');
  return compiled.flow;
}

function goalFlowBytes(): Buffer {
  return Buffer.from(JSON.stringify(goalCompiledFlow()));
}

function readJson<T>(runFolder: string, path: string): T {
  return JSON.parse(readFileSync(join(runFolder, path), 'utf8')) as T;
}

function childRunResult(
  step: Extract<ExecutableStep, { kind: 'sub-run' }>,
  context: RunContext,
  verdict = 'accept',
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
    verdict,
  });
}

function clarifiedTask(
  goal: string,
  overrides: Partial<ReturnType<typeof GoalClarifiedTask.parse>> = {},
): ReturnType<typeof GoalClarifiedTask.parse> {
  return GoalClarifiedTask.parse({
    schema: 'goal.clarified-task@v1',
    verdict: 'continue',
    original_request: goal,
    target: {
      kind: 'flow',
      id: 'goal',
    },
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
    ...overrides,
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
    low_findings: [
      {
        text: 'A low-severity follow-up remains documented for the operator.',
        refs: ['reports/goal/gate.json'],
      },
    ],
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

function blockedGateReport(): ReturnType<typeof GoalGate.parse> {
  return GoalGate.parse({
    schema: 'goal.gate@v1',
    verdict: 'blocked',
    clean_streak: 0,
    required_passes: 2,
    blocking_findings: [
      {
        severity: 'medium',
        text: 'The proof packet says the goal is done but does not link the required evidence.',
        refs: ['reports/goal/evidence-evaluation.json'],
        recovery_route: 'checkpoint',
      },
    ],
    low_findings: [],
    passes: [
      {
        pass_id: 'gate-1',
        attack_lens: 'false-done-and-recovery',
        evidence_checked: ['reports/goal/contract.json', 'reports/goal/evidence-evaluation.json'],
        verdict: 'blocked',
      },
    ],
    next_route: 'recover',
  });
}

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

function blockedGateExecutors(): Partial<ExecutorRegistry> {
  return {
    ...happyPathExecutors(),
    relay: async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
      if (step.kind !== 'relay') throw new Error(`unexpected step kind ${step.kind}`);
      if (step.id === 'clarify-goal') {
        const report = step.writes?.report;
        if (report === undefined) throw new Error('Goal Clarify step must write a report');
        await context.files.writeJson(report, clarifiedTask(context.goal));
        return { route: 'continue', details: { verdict: 'continue' } };
      }
      if (step.id !== 'goal-gate-pass-1') {
        throw new Error(`blocked-gate fixture should not reach ${step.id}`);
      }
      const report = step.writes?.report;
      if (report === undefined) throw new Error('Goal gate step must write a report');
      await context.files.writeJson(report, blockedGateReport());
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        check_kind: 'result_verdict',
        outcome: 'fail',
        reason: 'goal gate reported blocking findings',
      });
      return { route: 'retry', details: { verdict: 'blocked' } };
    },
  };
}

function weakChildProofExecutors(): Partial<ExecutorRegistry> {
  return {
    relay: async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
      if (step.kind !== 'relay') throw new Error(`unexpected step kind ${step.kind}`);
      if (step.id !== 'clarify-goal') throw new Error(`unexpected relay step ${step.id}`);
      const report = step.writes?.report;
      if (report === undefined) throw new Error('Goal Clarify step must write a report');
      await context.files.writeJson(report, clarifiedTask(context.goal));
      return { route: 'continue', details: { verdict: 'continue' } };
    },
    'sub-run': async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
      if (step.kind !== 'sub-run') throw new Error(`unexpected step kind ${step.kind}`);
      if (step.flowRef !== 'build') {
        throw new Error(`weak-child-proof fixture expected Build, got ${step.flowRef}`);
      }
      const result = step.writes?.result;
      if (result === undefined) throw new Error('Goal child step must write a result');
      await context.files.writeJson(result, childRunResult(step, context, 'accept-with-fixes'));
      return { route: 'pass', details: { flow_ref: step.flowRef } };
    },
  };
}

function missingEvidenceExecutors(): Partial<ExecutorRegistry> {
  return {
    relay: async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
      if (step.kind !== 'relay') throw new Error(`unexpected step kind ${step.kind}`);
      if (step.id !== 'clarify-goal') throw new Error(`unexpected relay step ${step.id}`);
      const report = step.writes?.report;
      if (report === undefined) throw new Error('Goal Clarify step must write a report');
      await context.files.writeJson(report, clarifiedTask(context.goal));
      return { route: 'continue', details: { verdict: 'continue' } };
    },
    'sub-run': async (step: ExecutableStep): Promise<StepOutcome> => {
      if (step.kind !== 'sub-run') throw new Error(`unexpected step kind ${step.kind}`);
      return { route: 'pass', details: { omitted_child_result: true } };
    },
  };
}

function expectStoppedRunWithGoalOutcome(
  runFolder: string,
  result: Awaited<ReturnType<typeof runCompiledFlow>>,
  goalOutcome: GoalResult['outcome'],
): void {
  expect(result.outcome).toBe('stopped');

  const runResult = RunResult.parse(readJson(runFolder, 'reports/result.json'));
  expect(runResult.outcome).toBe('stopped');
  expect(runResult.reason).toContain("reported outcome 'needs_attention'");
  expect(runResult.verdict).toBeUndefined();

  const projected = projectRunStatusFromRunFolder(runFolder);
  expect(projected.engine_state).toBe('completed');
  if (projected.engine_state !== 'completed') throw new Error('expected completed run status');
  expect(projected.terminal_outcome).toBe('stopped');

  const goalResult = GoalResult.parse(readJson(runFolder, 'reports/goal-result.json'));
  expect(goalResult.outcome).toBe(goalOutcome);
  expect(goalResult.outcome).not.toBe('complete');
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-goal-flow-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('Goal flow package', () => {
  it('compiles with one static child sub-run step for every supported target', () => {
    const flow = goalCompiledFlow();
    const subRuns = flow.steps.filter((step) => step.kind === 'sub-run');

    expect(flow.starts_at).toBe('clarify-goal');
    const clarify = flow.steps.find((step) => step.id === 'clarify-goal');
    expect(clarify?.kind).toBe('relay');
    if (clarify === undefined || clarify.kind !== 'relay') {
      throw new Error('Goal flow must include a relay clarify step');
    }
    expect(clarify?.route_from_report).toEqual({ path: ['verdict'] });
    expect(clarify.writes.report).toEqual({
      path: 'reports/goal/clarified-task.json',
      schema: 'goal.clarified-task@v1',
    });

    expect(subRuns.map((step) => step.id).sort()).toEqual(
      CHILD_TARGETS.map((target) => `goal-run-${target}`).sort(),
    );
    expect(subRuns.map((step) => step.flow_ref.flow_id).sort()).toEqual([...CHILD_TARGETS].sort());
    expect(subRuns.every((step) => step.flow_ref.entry_mode === 'default')).toBe(true);

    const contract = flow.steps.find((step) => step.id === 'goal-contract');
    expect(contract?.reads).toContain('reports/goal/clarified-task.json');
    expect(contract?.route_from_report).toEqual({ path: ['selected_flow_target'] });
    for (const target of CHILD_TARGETS) {
      expect(contract?.routes[target]).toBe(`goal-run-${target}`);
    }

    const gatePass1 = flow.steps.find((step) => step.id === 'goal-gate-pass-1');
    const gatePass2 = flow.steps.find((step) => step.id === 'goal-gate-pass-2');
    expect(gatePass1?.kind).toBe('relay');
    expect(gatePass2?.kind).toBe('relay');
    if (gatePass1 === undefined || gatePass1.kind !== 'relay') {
      throw new Error('Goal flow must include a first relay gate pass');
    }
    if (gatePass2 === undefined || gatePass2.kind !== 'relay') {
      throw new Error('Goal flow must include a second relay gate pass');
    }
    for (const gate of [gatePass1, gatePass2]) {
      expect(gate.check.pass).toEqual(['gate-pass', 'blocked']);
      expect(gate.route_from_report).toEqual({ path: ['next_route'] });
      expect(gate.routes.recover).toBe('goal-recovery');
    }
    expect(gatePass1.routes['run-next-gate-pass']).toBe('goal-gate-pass-2');
    expect(gatePass1.routes.close).toBe('goal-recovery');
    expect(gatePass2.routes.close).toBe('goal-close');
  });

  it('rejects Goal Clarify reports that smuggle completion-gate ceremony', () => {
    expect(() =>
      GoalClarifiedTask.parse({
        ...clarifiedTask('Build the dashboard filter'),
        clarified_prompt:
          'Build the dashboard filter. Before completion, adversarially review the result.',
      }),
    ).toThrow(/adversarial review loop/);
    expect(() =>
      GoalClarifiedTask.parse({
        ...clarifiedTask('Build the dashboard filter'),
        stop_conditions: ['Before completion, require two consecutive clean reviews.'],
      }),
    ).toThrow(/adversarial review loop/);
    expect(() =>
      GoalClarifiedTask.parse({
        ...clarifiedTask('Build the dashboard filter'),
        iteration_policy: ['Do the work, then require two clean reviews.'],
      }),
    ).toThrow(/adversarial review loop/);
  });

  it('allows Goal Clarify to keep completion-gate ceremony out of scope', () => {
    expect(() =>
      GoalClarifiedTask.parse({
        ...clarifiedTask('Review the fixture'),
        scope: {
          ...clarifiedTask('Review the fixture').scope,
          out_of_bounds: ['Adversarial multi-pass review ceremony or two-clean-review gating.'],
        },
      }),
    ).not.toThrow();
  });

  it('rejects Goal Clarify ask or stop verdicts without recovery context', () => {
    expect(() =>
      GoalClarifiedTask.parse({
        ...clarifiedTask('Build the dashboard filter'),
        verdict: 'ask',
        missing_information: [],
      }),
    ).toThrow(/missing information/);
    expect(() =>
      GoalClarifiedTask.parse({
        ...clarifiedTask('Build the dashboard filter'),
        verdict: 'stop',
        stop_conditions: [],
      }),
    ).toThrow(/stop condition/);
  });

  it('uses Review only for audit-only goals, not mixed implementation goals', async () => {
    for (const [name, goal, expectedTarget] of [
      ['audit-only', 'Review the auth diff and report medium-or-above findings', 'review'],
      ['mixed-implementation', 'Review and fix the flaky login bug', 'fix'],
    ] as const) {
      const runFolder = join(runFolderBase, name);
      await runCompiledFlowWithWaiting({
        flowBytes: goalFlowBytes(),
        runDir: runFolder,
        runId: `00000000-0000-0000-0000-00000000030${expectedTarget === 'review' ? '1' : '2'}`,
        goal,
        depth: 'high',
        now: () => new Date('2026-05-20T12:00:00.000Z'),
        executors: missingEvidenceExecutors(),
        maxSteps: 20,
      });

      const contract = GoalContract.parse(readJson(runFolder, 'reports/goal/contract.json'));
      expect(contract.selected_flow_target).toBe(expectedTarget);
    }
  });

  it('keeps the original request authoritative when Clarify narrows a mixed goal', async () => {
    const runFolder = join(runFolderBase, 'clarify-narrowed-target');
    await runCompiledFlowWithWaiting({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000303',
      goal: 'Review and fix the flaky login bug',
      depth: 'high',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: {
        relay: async (step: ExecutableStep, context: RunContext): Promise<StepOutcome> => {
          if (step.kind !== 'relay') throw new Error(`unexpected step kind ${step.kind}`);
          if (step.id !== 'clarify-goal') throw new Error(`unexpected relay step ${step.id}`);
          const report = step.writes?.report;
          if (report === undefined) throw new Error('Goal Clarify step must write a report');
          await context.files.writeJson(
            report,
            clarifiedTask(context.goal, {
              clarified_prompt: 'Review the flaky login report',
              objective: 'Review the flaky login report',
              desired_outcome: 'A review report exists for the flaky login report.',
            }),
          );
          return { route: 'continue', details: { verdict: 'continue' } };
        },
        'sub-run': async (step: ExecutableStep): Promise<StepOutcome> => {
          if (step.kind !== 'sub-run') throw new Error(`unexpected step kind ${step.kind}`);
          return { route: 'pass', details: { omitted_child_result: true } };
        },
      },
      maxSteps: 20,
    });

    const contract = GoalContract.parse(readJson(runFolder, 'reports/goal/contract.json'));
    expect(contract.selected_flow_target).toBe('fix');
  });

  it('completes only after a satisfied evaluation and two gate passes', async () => {
    const runFolder = join(runFolderBase, 'happy-path');
    const result = await runCompiledFlow({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000201',
      goal: 'Fix the flaky login bug and prove it stays fixed',
      depth: 'medium',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: happyPathExecutors(),
      maxSteps: 20,
    });

    expect(result.outcome).toBe('complete');
    const evaluation = GoalEvidenceEvaluation.parse(
      readJson(runFolder, 'reports/goal/evidence-evaluation.json'),
    );
    expect(evaluation.next_route).toBe('completion-gate');

    const gate = GoalGate.parse(readJson(runFolder, 'reports/goal/gate.json'));
    expect(gate.clean_streak).toBe(2);
    expect(gate.passes.map((pass) => pass.attack_lens)).toEqual([
      'contract-and-proof',
      'false-done-and-recovery',
    ]);

    const goalResult = GoalResult.parse(readJson(runFolder, 'reports/goal-result.json'));
    expect(goalResult.outcome).toBe('complete');
    expect(goalResult.residual_risks).toEqual([
      'A low-severity follow-up remains documented for the operator.',
    ]);
    expect(goalResult.gate).toEqual({
      clean_streak: 2,
      required_passes: 2,
      final_verdict: 'gate-pass',
    });
  });

  it('does not treat a child run with follow-up verdict as proved Goal evidence', async () => {
    const runFolder = join(runFolderBase, 'weak-child-proof');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000204',
      goal: 'Build the dashboard filter and prove it works',
      depth: 'high',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: weakChildProofExecutors(),
      maxSteps: 20,
    });

    expect(isGraphCheckpointWaitingResult(result)).toBe(true);
    if (!isGraphCheckpointWaitingResult(result)) throw new Error('expected waiting checkpoint');
    expect(result.checkpoint.stepId).toBe('goal-recovery-checkpoint');

    const attempt = GoalAttempt.parse(readJson(runFolder, 'reports/goal/attempts/attempt-1.json'));
    expect(attempt.outcome).toBe('complete');

    const evaluation = GoalEvidenceEvaluation.parse(
      readJson(runFolder, 'reports/goal/evidence-evaluation.json'),
    );
    expect(evaluation.verdict).toBe('missing-evidence');
    expect(evaluation.next_route).toBe('checkpoint');
    expect(evaluation.claim_results[0]?.status).toBe('missing');
    expect(evaluation.claim_results[0]?.gap).toContain('verdict accept-with-fixes');
    expect(() => readJson(runFolder, 'reports/goal/gate-pass-1.json')).toThrow();
    expect(() => readJson(runFolder, 'reports/goal-result.json')).toThrow();
  });

  it('routes a medium gate finding through recovery and waits instead of closing', async () => {
    const runFolder = join(runFolderBase, 'blocked-gate');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000203',
      goal: 'Fix the flaky login bug and prove it stays fixed',
      depth: 'high',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: blockedGateExecutors(),
      maxSteps: 20,
    });

    expect(isGraphCheckpointWaitingResult(result)).toBe(true);
    if (!isGraphCheckpointWaitingResult(result)) throw new Error('expected waiting checkpoint');
    expect(result.checkpoint.stepId).toBe('goal-recovery-checkpoint');

    const evaluation = GoalEvidenceEvaluation.parse(
      readJson(runFolder, 'reports/goal/evidence-evaluation.json'),
    );
    expect(evaluation.verdict).toBe('satisfied');
    expect(evaluation.next_route).toBe('completion-gate');

    const gate = GoalGate.parse(readJson(runFolder, 'reports/goal/gate-pass-1.json'));
    expect(gate.clean_streak).toBe(0);
    expect(gate.next_route).toBe('recover');
    expect(gate.blocking_findings[0]?.severity).toBe('medium');

    const recovery = GoalRecovery.parse(readJson(runFolder, 'reports/goal/recovery.json'));
    expect(recovery.reason).toBe('review-blocked');
    expect(recovery.selected_route).toBe('checkpoint');
    expect(recovery.operator_input_required).toBe(true);
    expect(() => readJson(runFolder, 'reports/goal-result.json')).toThrow();
  });

  it('routes missing child evidence through recovery and waits at the Goal checkpoint in deep mode', async () => {
    const runFolder = join(runFolderBase, 'missing-evidence');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000202',
      goal: 'Fix the flaky login bug and prove it stays fixed',
      depth: 'high',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: missingEvidenceExecutors(),
      maxSteps: 20,
    });

    expect(isGraphCheckpointWaitingResult(result)).toBe(true);
    if (!isGraphCheckpointWaitingResult(result)) throw new Error('expected waiting checkpoint');
    expect(result.checkpoint.stepId).toBe('goal-recovery-checkpoint');
    expect(result.checkpoint.allowedChoices).toEqual(['continue', 'blocked', 'handoff']);

    const evaluation = GoalEvidenceEvaluation.parse(
      readJson(runFolder, 'reports/goal/evidence-evaluation.json'),
    );
    expect(evaluation.verdict).toBe('blocked');
    expect(evaluation.next_route).toBe('checkpoint');

    const recovery = GoalRecovery.parse(readJson(runFolder, 'reports/goal/recovery.json'));
    expect(recovery.selected_route).toBe('checkpoint');
    expect(recovery.operator_input_required).toBe(true);
    expect(() => readJson(runFolder, 'reports/goal-result.json')).toThrow();
  });

  it('does not report run-level success when standard Goal closes with missing evidence', async () => {
    const runFolder = join(runFolderBase, 'standard-missing-evidence-close');
    const result = await runCompiledFlow({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000205',
      goal: 'Fix the flaky login bug and prove it stays fixed',
      depth: 'medium',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: missingEvidenceExecutors(),
      maxSteps: 20,
    });

    expectStoppedRunWithGoalOutcome(runFolder, result, 'needs_attention');
  });

  it('does not report run-level success when standard Goal closes after a blocked gate', async () => {
    const runFolder = join(runFolderBase, 'standard-blocked-gate-close');
    const result = await runCompiledFlow({
      flowBytes: goalFlowBytes(),
      runDir: runFolder,
      runId: '00000000-0000-0000-0000-000000000206',
      goal: 'Fix the flaky login bug and prove it stays fixed',
      depth: 'medium',
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      executors: blockedGateExecutors(),
      maxSteps: 20,
    });

    expectStoppedRunWithGoalOutcome(runFolder, result, 'needs_attention');
  });
});

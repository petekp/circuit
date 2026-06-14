// Sub-run executor.
//
// A sub-run is admitted back into the parent only through the child RunResult.
// The parent copies that result file, checks its verdict against the parent
// step policy, and records parent trace events without interpreting child trace
// internals.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  CompiledFlow as CompiledFlowSchema,
  type CompiledFlow as ParsedChildFlow,
} from '../../schemas/compiled-flow.js';
import { type RunResult as ParsedRunResult, RunResult } from '../../schemas/result.js';
import type { StepOutcome } from '../domain/step.js';
import type { SubRunStep } from '../manifest/executable-flow.js';
import { NO_VERDICT_SENTINEL } from '../run/relay-support.js';
import type { RunContext } from '../run/run-context.js';
import {
  type StepExecutionResult,
  stepExecutionFailedFrom,
  stepExecutionOutcome,
  unwrapStepExecutionResult,
} from './result.js';

function checkPassVerdicts(step: SubRunStep): readonly string[] {
  const pass = step.check.pass;
  return Array.isArray(pass)
    ? pass.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

async function recordSubRunCheckFailure(
  step: SubRunStep,
  context: RunContext,
  reason: string,
): Promise<never> {
  const attempt = context.activeStepAttempt ?? 1;
  await context.trace.append({
    run_id: context.runId,
    kind: 'check.evaluated',
    step_id: step.id,
    attempt,
    check_kind: 'result_verdict',
    outcome: 'fail',
    reason,
  });
  throw new Error(reason);
}

function evaluateChildResult(
  step: SubRunStep,
  resultBody: ParsedRunResult,
): { verdict: string; admitted: boolean; failureReason?: string } {
  const verdict = resultBody.verdict;
  if (typeof verdict !== 'string' || verdict.length === 0) {
    return {
      verdict: NO_VERDICT_SENTINEL,
      admitted: false,
      failureReason: `sub-run step '${step.id}': child result body lacks a non-empty string 'verdict' field`,
    };
  }
  const pass = checkPassVerdicts(step);
  if (!pass.includes(verdict)) {
    return {
      verdict,
      admitted: false,
      failureReason: `sub-run step '${step.id}': child verdict '${verdict}' is not in check.pass [${pass.join(', ')}]`,
    };
  }
  return { verdict, admitted: true };
}

function parseChildResultBody(
  step: SubRunStep,
  childResultText: string,
): { body?: ParsedRunResult; failureReason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(childResultText);
  } catch (error) {
    return {
      failureReason: `sub-run step '${step.id}': child result body did not parse as JSON (${(error as Error).message})`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      failureReason: `sub-run step '${step.id}': child result body parsed but is not a JSON object`,
    };
  }
  try {
    return { body: RunResult.parse(parsed) };
  } catch (error) {
    return {
      failureReason: `sub-run step '${step.id}': child result body failed result schema (${(error as Error).message})`,
    };
  }
}

async function executeSubRunInternal(step: SubRunStep, context: RunContext): Promise<StepOutcome> {
  const attempt = context.activeStepAttempt ?? 1;
  const resultWrite = step.writes?.result;
  if (resultWrite === undefined) {
    throw new Error(`sub-run step '${step.id}' is missing writes.result`);
  }
  if (step.writes?.report !== undefined && step.writes.report.path !== resultWrite.path) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': writes.report materialization at a path different from writes.result is not yet supported`,
    );
  }
  if (context.childCompiledFlowResolver === undefined) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': childCompiledFlowResolver is required to resolve child flow '${step.flowRef}'`,
    );
  }
  if (context.childRunner === undefined) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': childRunner is required to run child flow '${step.flowRef}'`,
    );
  }

  let resolved: Awaited<ReturnType<NonNullable<RunContext['childCompiledFlowResolver']>>>;
  try {
    resolved = await context.childCompiledFlowResolver({
      flowId: step.flowRef,
      entryMode: step.entryMode,
      ...(step.version === undefined ? {} : { version: step.version }),
    });
  } catch (error) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': child flow resolution failed (${(error as Error).message})`,
    );
  }
  let childFlow: ParsedChildFlow;
  try {
    childFlow = CompiledFlowSchema.parse(
      JSON.parse(Buffer.from(resolved.flowBytes).toString('utf8')),
    );
  } catch (error) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': child flow resolution returned invalid compiled flow (${(error as Error).message})`,
    );
  }
  if (childFlow.id !== step.flowRef) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': resolver returned flow id '${childFlow.id}' but flow_ref names '${step.flowRef}'`,
    );
  }

  const childRunId = randomUUID();
  const childRunDir = join(dirname(context.runDir), childRunId);
  await context.trace.append({
    run_id: context.runId,
    kind: 'sub_run.started',
    step_id: step.id,
    attempt,
    child_run_id: childRunId,
    child_flow_id: childFlow.id,
    child_entry_mode: step.entryMode,
    child_depth: step.depth,
  });

  const startMs = Date.now();
  let childResult: Awaited<ReturnType<NonNullable<RunContext['childRunner']>>>;
  try {
    childResult = await context.childRunner({
      flowBytes: resolved.flowBytes,
      runDir: childRunDir,
      runId: childRunId,
      goal: step.goal,
      entryModeName: step.entryMode,
      depth: step.depth,
      now: context.now,
      // A child run has no operator of its own; inherit the parent's unattended
      // signal so the child's checkpoints reach a terminal outcome rather than
      // parking unanswerable. Inert while the parent is attended (unset).
      ...(context.unattended === undefined ? {} : { unattended: context.unattended }),
      ...(context.childExecutors === undefined ? {} : { executors: context.childExecutors }),
      ...(context.childCompiledFlowResolver === undefined
        ? {}
        : { childCompiledFlowResolver: context.childCompiledFlowResolver }),
      childRunner: context.childRunner,
      externalFiles: context.externalFiles,
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      ...(context.evidencePolicy === undefined ? {} : { evidencePolicy: context.evidencePolicy }),
      ...(context.worktreeRunner === undefined ? {} : { worktreeRunner: context.worktreeRunner }),
      ...(context.relayConnector === undefined ? {} : { relayConnector: context.relayConnector }),
      ...(context.relayer === undefined ? {} : { relayer: context.relayer }),
      ...(context.hostKind === undefined ? {} : { hostKind: context.hostKind }),
      ...(context.selectionConfigLayers === undefined
        ? {}
        : { selectionConfigLayers: context.selectionConfigLayers }),
      ...(context.policyLayers === undefined ? {} : { policyLayers: context.policyLayers }),
      ...(context.progress === undefined ? {} : { progress: context.progress }),
    });
  } catch (error) {
    return await recordSubRunCheckFailure(
      step,
      context,
      `sub-run step '${step.id}': child flow invocation failed (${(error as Error).message})`,
    );
  }

  const durationMs = Math.max(0, Date.now() - startMs);
  const childResultText = await context.externalFiles.readText(childResult.resultPath);
  await context.files.writeText(resultWrite, childResultText);
  const parsedChildResult = parseChildResultBody(step, childResultText);
  if (parsedChildResult.body === undefined) {
    const reason =
      parsedChildResult.failureReason ??
      `sub-run step '${step.id}': child result body could not be parsed`;
    await context.trace.append({
      run_id: context.runId,
      kind: 'sub_run.completed',
      step_id: step.id,
      attempt,
      child_run_id: childRunId,
      child_outcome: childResult.outcome,
      verdict: NO_VERDICT_SENTINEL,
      duration_ms: durationMs,
      result_path: resultWrite.path,
    });
    return await recordSubRunCheckFailure(step, context, reason);
  }
  const childResultBody = parsedChildResult.body;

  const verdict = evaluateChildResult(step, childResultBody);
  const childComplete = childResultBody.outcome === 'complete';
  const admitted = verdict.admitted && childComplete;
  await context.trace.append({
    run_id: context.runId,
    kind: 'sub_run.completed',
    step_id: step.id,
    attempt,
    child_run_id: childRunId,
    child_outcome: childResultBody.outcome,
    verdict: verdict.verdict,
    duration_ms: durationMs,
    result_path: resultWrite.path,
  });

  if (admitted) {
    await context.trace.append({
      run_id: context.runId,
      kind: 'check.evaluated',
      step_id: step.id,
      attempt,
      check_kind: 'result_verdict',
      outcome: 'pass',
    });
    return { route: 'pass', details: { child_run_id: childRunId, verdict: verdict.verdict } };
  }

  // A child that ran end to end and handed back a typed RunResult but closed
  // with a non-complete outcome (e.g. build aborts after exhausting verification
  // retries) is a legible non-success, not an infrastructure failure: the child
  // never CLAIMED success, so the parent should not crash. When the step
  // declares a `stop` route, take it and let the parent flow decide what closing
  // on a non-admissible child means (goal: @stop -> stopped). The recorded
  // reason names the child's own outcome, which is the real cause, rather than
  // the downstream "missing verdict" symptom. A child that closed `complete`
  // without an admissible verdict is a genuine contract violation and still
  // aborts below.
  if (!childComplete && step.routes.stop !== undefined) {
    const reason = `sub-run step '${step.id}': child closed with outcome '${childResultBody.outcome}'`;
    await context.trace.append({
      run_id: context.runId,
      kind: 'check.evaluated',
      step_id: step.id,
      attempt,
      check_kind: 'result_verdict',
      outcome: 'fail',
      reason,
    });
    return {
      route: 'stop',
      details: {
        child_run_id: childRunId,
        child_outcome: childResultBody.outcome,
        verdict: verdict.verdict,
      },
    };
  }

  return await recordSubRunCheckFailure(
    step,
    context,
    verdict.failureReason ??
      `sub-run step '${step.id}': child closed with outcome '${childResultBody.outcome}'`,
  );
}

export async function executeSubRunResult(
  step: SubRunStep,
  context: RunContext,
): Promise<StepExecutionResult> {
  try {
    return stepExecutionOutcome(await executeSubRunInternal(step, context));
  } catch (error) {
    return stepExecutionFailedFrom(error);
  }
}

export async function executeSubRun(step: SubRunStep, context: RunContext): Promise<StepOutcome> {
  return unwrapStepExecutionResult(await executeSubRunResult(step, context));
}

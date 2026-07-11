// Per-branch runtime work after fanout expansion. Keep production relay
// attempts, injected connector compatibility, and sub-run worktree execution
// distinct so trace and report outputs stay comparable across branch kinds.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runCrossReportValidator } from '../../flows/registries/cross-report-validators.js';
import { parseReport } from '../../flows/registries/report-schemas.js';
import { CompiledFlow as CompiledFlowSchema } from '../../schemas/compiled-flow.js';
import { CompiledDepth } from '../../schemas/process.js';
import { RunResult } from '../../schemas/result.js';
import type { TraceEntry } from '../domain/trace.js';
import {
  type ProductionRelayAttemptValidationInput,
  type RelayConnector,
  executeProductionRelayAttempt,
} from '../executors/relay.js';
import { RECURSION_DEPTH_CAP } from '../executors/sub-run.js';
import type { FanoutStep, RelayStep } from '../manifest/executable-flow.js';
import type { WorktreeRunner } from '../run/child-runner.js';
import { planRelayGuidanceDecision } from '../run/relay-guidance.js';
import {
  type RelayStep as CompiledRelayStepV1,
  composeInjectedFanoutBranchPrompt,
} from '../run/relay-support.js';
import { lookupReusableSubRunBranch } from '../run/reuse-children.js';
import type { RunContext } from '../run/run-context.js';
import {
  type BranchOutcome,
  NO_VERDICT_SENTINEL,
  type ResolvedBranch,
  type ResolvedRelayBranch,
  type ResolvedSubRunBranch,
} from './types.js';

// The read-side `TraceEntry` union carries literal `kind` discriminants (so
// `Extract` narrows by kind) plus branded ids and the auto-filled base fields.
// Append sites build entries from already well-typed runtime values, so drop the
// base fields that `context.trace.append` fills (`schema_version`, `sequence`,
// `recorded_at`) along with `run_id`/`kind`, and de-brand string/enum fields back
// to the loose append contract the call sites here actually pass (plain
// `step.id`, `randomUUID()` ids, string verdicts/outcomes).
type DebrandAppendValue<T> = T extends string ? string : T;
type FanoutBranchFields<K extends TraceEntry['kind']> = {
  [P in keyof Omit<
    Extract<TraceEntry, { kind: K }>,
    'run_id' | 'kind' | 'schema_version' | 'sequence' | 'recorded_at'
  >]: DebrandAppendValue<Extract<TraceEntry, { kind: K }>[P]>;
};

type FanoutBranchStartedFields = FanoutBranchFields<'fanout.branch_started'>;
type FanoutBranchCompletedFields = FanoutBranchFields<'fanout.branch_completed'>;

async function appendFanoutBranchStarted(
  context: RunContext,
  fields: FanoutBranchStartedFields,
): Promise<void> {
  await context.trace.append({
    run_id: context.runId,
    kind: 'fanout.branch_started',
    ...fields,
  });
}

async function appendFanoutBranchCompleted(
  context: RunContext,
  fields: FanoutBranchCompletedFields,
): Promise<void> {
  await context.trace.append({
    run_id: context.runId,
    kind: 'fanout.branch_completed',
    ...fields,
  });
}

function admitList(step: FanoutStep): string[] {
  const admit = step.check.verdicts?.admit;
  return Array.isArray(admit)
    ? admit.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function branchResult(
  body: unknown,
  admit: readonly string[],
): { verdict: string; admitted: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { verdict: NO_VERDICT_SENTINEL, admitted: false };
  }
  const verdict = (body as { readonly verdict?: unknown }).verdict;
  if (typeof verdict !== 'string' || verdict.length === 0) {
    return { verdict: NO_VERDICT_SENTINEL, admitted: false };
  }
  return { verdict, admitted: admit.includes(verdict) };
}

function parseConnectorResponse(response: unknown): unknown {
  if (typeof response !== 'string') return response;
  return JSON.parse(response);
}

function relayBranchProvenanceFailure(
  branch: ResolvedRelayBranch,
  reportBody: unknown,
): string | undefined {
  const field = branch.provenance_field;
  if (field === undefined) return undefined;
  if (reportBody === null || typeof reportBody !== 'object' || Array.isArray(reportBody)) {
    return `relay fanout branch '${branch.branch_id}': report field '${field}' must equal branch_id '${branch.branch_id}' but report body is not an object`;
  }
  const observed = (reportBody as Record<string, unknown>)[field];
  if (observed !== branch.branch_id) {
    return `relay fanout branch '${branch.branch_id}': report field '${field}' must equal branch_id '${branch.branch_id}'`;
  }
  return undefined;
}

function relayBranchReads(step: FanoutStep): readonly string[] {
  return (step.reads ?? []).map((ref) => ref.path);
}

// Title carries only ids: the branch goal renders as its own labeled
// prompt segment (a multi-line goal would break the one-line Title header).
function syntheticRelayTitle(step: FanoutStep, branch: ResolvedRelayBranch): string {
  return `${step.title ?? step.id} / ${branch.branch_id}`;
}

function syntheticRelayStep(
  step: FanoutStep,
  branch: ResolvedRelayBranch,
  branchDirRel: string,
): RelayStep {
  const selection =
    branch.selection === undefined || branch.selection === null
      ? {}
      : { selection: branch.selection as NonNullable<RelayStep['selection']> };
  return {
    id: `${step.id}-${branch.branch_id}`,
    title: syntheticRelayTitle(step, branch),
    ...(step.protocol === undefined ? {} : { protocol: step.protocol }),
    routes: { pass: { kind: 'terminal', target: '@complete' } },
    ...(step.reads === undefined ? {} : { reads: step.reads }),
    writes: {
      request: { path: `${branchDirRel}/request.txt` },
      receipt: { path: `${branchDirRel}/receipt.txt` },
      result: { path: `${branchDirRel}/result.json` },
      report: { path: `${branchDirRel}/report.json`, schema: branch.report_schema },
    },
    ...selection,
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: admitList(step),
    },
    kind: 'relay',
    role: branch.role,
    ...(branch.connector === undefined ? {} : { connector: branch.connector }),
    report: { path: `${branchDirRel}/report.json`, schema: branch.report_schema },
  };
}

function syntheticCompiledRelayStepV1(
  step: FanoutStep,
  branch: ResolvedRelayBranch,
  branchDirRel: string,
): CompiledRelayStepV1 {
  return {
    id: `${step.id}-${branch.branch_id}` as never,
    title: syntheticRelayTitle(step, branch),
    protocol: (step.protocol ?? `${step.id}@v1`) as never,
    reads: relayBranchReads(step) as never,
    routes: { pass: '@complete' },
    ...(branch.selection === undefined ? {} : { selection: branch.selection as never }),
    skill_slots: [],
    executor: 'worker',
    kind: 'relay',
    role: branch.role as never,
    ...(branch.connector === undefined ? {} : { connector: branch.connector as never }),
    writes: {
      request: `${branchDirRel}/request.txt` as never,
      receipt: `${branchDirRel}/receipt.txt` as never,
      result: `${branchDirRel}/result.json` as never,
      report: {
        path: `${branchDirRel}/report.json` as never,
        schema: branch.report_schema,
      },
    },
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: [...admitList(step)],
    },
  };
}

function validateAcceptedRelayFanoutBranch(
  branch: ResolvedRelayBranch,
  input: ProductionRelayAttemptValidationInput,
) {
  const parseResult = parseReport(branch.report_schema, input.relayResult.result_body);
  if (parseResult.kind === 'fail') {
    return {
      evaluation: {
        kind: 'fail' as const,
        reason: `relay fanout branch '${branch.branch_id}': ${parseResult.reason}`,
        observedVerdict: input.checkEvaluation.verdict,
      },
    };
  }
  const parsedBody = JSON.parse(input.relayResult.result_body) as unknown;
  const provenanceFailure = relayBranchProvenanceFailure(branch, parsedBody);
  if (provenanceFailure !== undefined) {
    return {
      evaluation: {
        kind: 'fail' as const,
        reason: provenanceFailure,
        observedVerdict: input.checkEvaluation.verdict,
      },
    };
  }
  const crossResult = runCrossReportValidator(
    branch.report_schema,
    input.flow,
    input.context.runDir,
    input.relayResult.result_body,
  );
  if (crossResult.kind === 'fail') {
    return {
      evaluation: {
        kind: 'fail' as const,
        reason: `relay fanout branch '${branch.branch_id}': ${crossResult.reason}`,
        observedVerdict: input.checkEvaluation.verdict,
      },
    };
  }
  return { evaluation: input.checkEvaluation, parsedBody };
}

export function planRelayFanoutBranchGuidanceDecision(input: {
  readonly step: FanoutStep;
  readonly context: RunContext;
  readonly branch: ResolvedRelayBranch;
  readonly relayConnector?: RelayConnector;
  readonly branchDirRel: string;
}): ReturnType<typeof planRelayGuidanceDecision> {
  const relayStep = syntheticRelayStep(input.step, input.branch, input.branchDirRel);
  return planRelayGuidanceDecision({
    context: input.context,
    step: relayStep,
    compiledStep: syntheticCompiledRelayStepV1(input.step, input.branch, input.branchDirRel),
    depth: CompiledDepth.parse(input.context.depth ?? 'medium'),
    ...(input.relayConnector === undefined ? {} : { suppliedConnector: input.relayConnector }),
  });
}

export async function executeRelayFanoutBranch(
  step: FanoutStep,
  context: RunContext,
  branch: ResolvedRelayBranch,
  relayConnector: RelayConnector | undefined,
  branchDirRel: string,
  branchDirAbs: string,
): Promise<BranchOutcome> {
  const startMs = Date.now();
  const attempt = context.activeStepAttempt ?? 1;
  const childRunId = randomUUID();
  const resultPath = `${branchDirRel}/result.json`;
  const reportPath = `${branchDirRel}/report.json`;
  await appendFanoutBranchStarted(context, {
    step_id: step.id,
    attempt,
    branch_id: branch.branch_id,
    branch_kind: 'relay',
    child_run_id: childRunId,
    worktree_path: branchDirAbs,
  });

  try {
    if (relayConnector === undefined) {
      // Production relay branches reuse the normal relay attempt path so request,
      // receipt, result, report, trace, and validation behavior match top-level
      // relay steps. Injected connectors below remain a compatibility path for
      // tests and hosts that provide their own branch-local relay implementation.
      const relayStep = syntheticRelayStep(step, branch, branchDirRel);
      const relayAttempt = await executeProductionRelayAttempt({
        step: relayStep,
        compiledStep: syntheticCompiledRelayStepV1(step, branch, branchDirRel),
        context,
        branchGoal: branch.goal,
        formatConnectorFailureReason: (_stepId, error) => {
          const reason = error instanceof Error ? error.message : String(error);
          return `relay fanout branch '${branch.branch_id}': connector invocation failed (${reason})`;
        },
        validateAcceptedResult: (input) => validateAcceptedRelayFanoutBranch(branch, input),
      });
      const durationMs = Math.max(0, Date.now() - startMs);
      const outcome =
        relayAttempt.kind === 'connector_failed'
          ? {
              child_outcome: 'aborted' as const,
              verdict: NO_VERDICT_SENTINEL,
              result_path: resultPath,
              admitted: false,
              failure_reason: relayAttempt.reason,
            }
          : relayAttempt.evaluation.kind === 'pass'
            ? {
                child_outcome: 'complete' as const,
                verdict: relayAttempt.evaluation.verdict,
                result_path: relayAttempt.report_path ?? reportPath,
                result_body: relayAttempt.parsed_body,
                admitted: true,
              }
            : {
                child_outcome: 'aborted' as const,
                verdict: relayAttempt.relay_completed_verdict,
                result_path: resultPath,
                admitted: false,
                failure_reason: relayAttempt.evaluation.reason,
              };
      await appendFanoutBranchCompleted(context, {
        step_id: step.id,
        attempt,
        branch_id: branch.branch_id,
        branch_kind: 'relay',
        child_run_id: childRunId,
        child_outcome: outcome.child_outcome,
        verdict: outcome.verdict,
        duration_ms: durationMs,
        result_path: outcome.result_path,
      });
      return {
        branch_id: branch.branch_id,
        child_run_id: childRunId,
        worktree_path: branchDirAbs,
        duration_ms: durationMs,
        ...outcome,
      };
    }

    // Injected-connector compatibility path (tests / host-provided branch-local
    // relays): the connector receives the branch goal directly and Circuit does
    // NOT compose the relay prompt here, so no skills are rendered into it —
    // selection, slot, and skill-hook-injected skills alike. Skill-hook injection
    // applies on the production fanout path above (executeProductionRelayAttempt,
    // which composes the prompt with the resolved loadedSkills). This is an
    // intentional, pre-existing property of the compatibility path, not a gap in
    // injection.
    await context.files.writeJson(`${branchDirRel}/request.json`, {
      branch_id: branch.branch_id,
      goal: branch.goal,
    });
    const { relayExecution } = planRelayFanoutBranchGuidanceDecision({
      step,
      context,
      branch,
      relayConnector,
      branchDirRel,
    });
    const response = await relayConnector.relay({
      runId: context.runId,
      stepId: `${step.id}-${branch.branch_id}`,
      role: relayExecution.role,
      // The runtime JSON.parses the response and checks the verdict against
      // the admit list, so the prompt must state that contract even on this
      // compatibility path.
      prompt: composeInjectedFanoutBranchPrompt(branch.goal, admitList(step)),
      connector: relayExecution.connectorName,
    });
    const reportBody = parseConnectorResponse(response);
    const provenanceFailure = relayBranchProvenanceFailure(branch, reportBody);
    const evaluation = branchResult(reportBody, admitList(step));
    const admitted = provenanceFailure === undefined && evaluation.admitted;
    await context.files.writeJson(resultPath, reportBody);
    await context.files.writeJson({ path: reportPath, schema: branch.report_schema }, reportBody);
    await context.files.writeText(
      `${branchDirRel}/receipt.txt`,
      `stub relay receipt for ${branch.branch_id}\n`,
    );
    const durationMs = Math.max(0, Date.now() - startMs);
    await appendFanoutBranchCompleted(context, {
      step_id: step.id,
      attempt,
      branch_id: branch.branch_id,
      branch_kind: 'relay',
      child_run_id: childRunId,
      child_outcome: admitted ? 'complete' : 'aborted',
      verdict: evaluation.verdict,
      duration_ms: durationMs,
      result_path: reportPath,
    });
    return {
      branch_id: branch.branch_id,
      child_run_id: childRunId,
      worktree_path: branchDirAbs,
      child_outcome: admitted ? 'complete' : 'aborted',
      verdict: evaluation.verdict,
      result_path: reportPath,
      result_body: reportBody,
      duration_ms: durationMs,
      admitted,
      ...(provenanceFailure === undefined ? {} : { failure_reason: provenanceFailure }),
    };
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startMs);
    await appendFanoutBranchCompleted(context, {
      step_id: step.id,
      attempt,
      branch_id: branch.branch_id,
      branch_kind: 'relay',
      child_run_id: childRunId,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      duration_ms: durationMs,
      result_path: resultPath,
    });
    return {
      branch_id: branch.branch_id,
      child_run_id: childRunId,
      worktree_path: branchDirAbs,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      result_path: resultPath,
      duration_ms: durationMs,
      admitted: false,
      failure_reason: (error as Error).message,
    };
  }
}

export async function executeSubRunFanoutBranch(
  step: FanoutStep,
  context: RunContext,
  branch: ResolvedSubRunBranch,
  worktreeRunner: WorktreeRunner,
  branchDirRel: string,
  worktreePath: string,
): Promise<BranchOutcome> {
  const startMs = Date.now();
  const attempt = context.activeStepAttempt ?? 1;
  const childRunId = randomUUID();
  const resultPath = `${branchDirRel}/result.json`;
  await appendFanoutBranchStarted(context, {
    step_id: step.id,
    attempt,
    branch_id: branch.branch_id,
    branch_kind: 'sub-run',
    child_run_id: childRunId,
    worktree_path: worktreePath,
  });

  if (context.childCompiledFlowResolver === undefined || context.childRunner === undefined) {
    const failureReason = `fanout step '${step.id}': child resolver and child runner are required for sub-run branches`;
    const durationMs = Math.max(0, Date.now() - startMs);
    await appendFanoutBranchCompleted(context, {
      step_id: step.id,
      attempt,
      branch_id: branch.branch_id,
      branch_kind: 'sub-run',
      child_run_id: childRunId,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      duration_ms: durationMs,
      result_path: resultPath,
    });
    return {
      branch_id: branch.branch_id,
      child_run_id: childRunId,
      worktree_path: worktreePath,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      result_path: resultPath,
      duration_ms: durationMs,
      admitted: false,
      failure_reason: failureReason,
    };
  }

  // Recursion bound, the fanout-branch twin of the single-child sub-run guard.
  // A fanout branch spawns a child run through the same childRunner, so it can
  // recurse unbounded the same way. Decided before childRunner is called, so a
  // refused branch never starts a child run, and recorded as a legible branch
  // failure (admitted: false) the join policy then weighs, rather than a crash.
  const currentDepth = context.recursionDepth ?? 0;
  const childDepth = currentDepth + 1;
  const ancestors = context.recursionAncestors ?? new Set<string>();
  const refuseBranch = async (failureReason: string): Promise<BranchOutcome> => {
    const durationMs = Math.max(0, Date.now() - startMs);
    await appendFanoutBranchCompleted(context, {
      step_id: step.id,
      attempt,
      branch_id: branch.branch_id,
      branch_kind: 'sub-run',
      child_run_id: childRunId,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      duration_ms: durationMs,
      result_path: resultPath,
    });
    return {
      branch_id: branch.branch_id,
      child_run_id: childRunId,
      worktree_path: worktreePath,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      result_path: resultPath,
      duration_ms: durationMs,
      admitted: false,
      failure_reason: failureReason,
    };
  };
  if (childDepth > RECURSION_DEPTH_CAP) {
    return await refuseBranch(
      `fanout step '${step.id}': starting sub-run branch '${branch.branch_id}' into '${branch.flowRef}' at recursion depth ${childDepth} would exceed the recursion depth cap of ${RECURSION_DEPTH_CAP}`,
    );
  }
  if (ancestors.has(branch.flowRef)) {
    const chain = [...ancestors].join(' -> ');
    return await refuseBranch(
      `fanout step '${step.id}': sub-run branch '${branch.branch_id}' targets flow '${branch.flowRef}' which is already in the recursion ancestor chain [${chain}]; refusing to start it to avoid an unbounded recursion cycle`,
    );
  }

  // Restart cheapness (`--reuse-children-from`): if this fresh run was pointed at
  // a prior crashed run's folder and that run already finished this exact branch
  // in an isolating worktree, admit its result instead of re-running the child.
  // The branch's real file effect lives in the prior worktree, which the
  // disjoint-merge collector reads from `outcome.worktree_path`; we point there
  // and skip both `worktreeRunner.add` and the expensive child run. The prior
  // result is copied into this run's branch folder so its artifacts stay
  // self-contained, and the completion entry carries `reused_from` so the trace
  // stays honest that the work was reused, not freshly executed. The lookup's
  // safety floor (sub-run branch only, complete+admissible result, worktree still
  // on disk) lives in reuse-children.ts; any miss falls through to a fresh run.
  if (context.reuseChildrenFrom !== undefined) {
    const reused = await lookupReusableSubRunBranch({
      priorRunFolder: context.reuseChildrenFrom,
      stepId: step.id,
      branchId: branch.branch_id,
      expectedFlowRef: branch.flowRef,
    });
    if (reused !== undefined) {
      await context.files.writeJson(resultPath, reused.resultBody);
      const evaluation = branchResult(reused.resultBody, admitList(step));
      const admitted = reused.resultBody.outcome === 'complete' && evaluation.admitted;
      const durationMs = Math.max(0, Date.now() - startMs);
      await appendFanoutBranchCompleted(context, {
        step_id: step.id,
        attempt,
        branch_id: branch.branch_id,
        branch_kind: 'sub-run',
        child_run_id: childRunId,
        child_outcome: reused.resultBody.outcome,
        verdict: evaluation.verdict,
        duration_ms: durationMs,
        result_path: resultPath,
        reused_from: reused.childRunId,
      });
      return {
        branch_id: branch.branch_id,
        child_run_id: childRunId,
        worktree_path: reused.worktreePath,
        child_outcome: reused.resultBody.outcome,
        verdict: evaluation.verdict,
        result_path: resultPath,
        result_body: reused.resultBody,
        duration_ms: durationMs,
        admitted,
      };
    }
  }

  try {
    const branchName = `circuit/${context.runId}/${step.id}/${branch.branch_id}`;
    // Provision the branch worktree against the run's project root, not the
    // engine's process cwd, so a non-cwd `--project-root` invocation still
    // creates the worktree in the right repository.
    await Promise.resolve(
      worktreeRunner.add({
        worktreePath,
        baseRef: 'HEAD',
        branchName,
        ...(context.projectRoot === undefined ? {} : { repoRoot: context.projectRoot }),
      }),
    );
    const resolved = await context.childCompiledFlowResolver({
      flowId: branch.flowRef,
      entryMode: branch.entryMode,
      ...(branch.version === undefined ? {} : { version: branch.version }),
    });
    const childFlow = CompiledFlowSchema.parse(
      JSON.parse(Buffer.from(resolved.flowBytes).toString('utf8')),
    );
    if (childFlow.id !== branch.flowRef) {
      throw new Error(
        `resolver returned flow id '${childFlow.id}' but branch flow_ref names '${branch.flowRef}'`,
      );
    }
    const childRunDir = join(dirname(context.runDir), childRunId);
    const child = await context.childRunner({
      flowBytes: resolved.flowBytes,
      runDir: childRunDir,
      runId: childRunId,
      goal: branch.goal,
      entryModeName: branch.entryMode,
      depth: branch.depth,
      now: context.now,
      // A fanout branch is a composed/nested child; inherit the parent's
      // unattended signal so its checkpoints reach a terminal outcome rather
      // than parking unanswerable. Inert while the parent is attended (unset).
      ...(context.unattended === undefined ? {} : { unattended: context.unattended }),
      ...(context.childExecutors === undefined ? {} : { executors: context.childExecutors }),
      ...(context.childCompiledFlowResolver === undefined
        ? {}
        : { childCompiledFlowResolver: context.childCompiledFlowResolver }),
      childRunner: context.childRunner,
      // Carry the bound forward so a branch's own descendants keep accumulating
      // depth and the ancestor chain (this branch's target id joins it).
      recursionDepth: childDepth,
      recursionAncestors: new Set([...ancestors, branch.flowRef]),
      externalFiles: context.externalFiles,
      projectRoot: worktreePath,
      ...(context.evidencePolicy === undefined ? {} : { evidencePolicy: context.evidencePolicy }),
      worktreeRunner,
      ...(context.relayConnector === undefined ? {} : { relayConnector: context.relayConnector }),
      ...(context.relayer === undefined ? {} : { relayer: context.relayer }),
      ...(context.hostKind === undefined ? {} : { hostKind: context.hostKind }),
      ...(context.selectionConfigLayers === undefined
        ? {}
        : { selectionConfigLayers: context.selectionConfigLayers }),
      ...(context.policyLayers === undefined ? {} : { policyLayers: context.policyLayers }),
      ...(context.progress === undefined ? {} : { progress: context.progress }),
    });
    const childResultText = await context.externalFiles.readText(child.resultPath);
    const childResult = RunResult.parse(JSON.parse(childResultText));
    await context.files.writeJson(resultPath, childResult);
    const evaluation = branchResult(childResult, admitList(step));
    const admitted = childResult.outcome === 'complete' && evaluation.admitted;
    const durationMs = Math.max(0, Date.now() - startMs);
    await appendFanoutBranchCompleted(context, {
      step_id: step.id,
      attempt,
      branch_id: branch.branch_id,
      branch_kind: 'sub-run',
      child_run_id: childRunId,
      child_outcome: childResult.outcome,
      verdict: evaluation.verdict,
      duration_ms: durationMs,
      result_path: resultPath,
    });
    return {
      branch_id: branch.branch_id,
      child_run_id: childRunId,
      worktree_path: worktreePath,
      child_outcome: childResult.outcome,
      verdict: evaluation.verdict,
      result_path: resultPath,
      result_body: childResult,
      duration_ms: durationMs,
      admitted,
    };
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startMs);
    await appendFanoutBranchCompleted(context, {
      step_id: step.id,
      attempt,
      branch_id: branch.branch_id,
      branch_kind: 'sub-run',
      child_run_id: childRunId,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      duration_ms: durationMs,
      result_path: resultPath,
    });
    return {
      branch_id: branch.branch_id,
      child_run_id: childRunId,
      worktree_path: worktreePath,
      child_outcome: 'aborted',
      verdict: NO_VERDICT_SENTINEL,
      result_path: resultPath,
      duration_ms: durationMs,
      admitted: false,
      failure_reason: (error as Error).message,
    };
  }
}

export function branchNeedsWorktree(branch: ResolvedBranch): boolean {
  return branch.kind === 'sub-run';
}

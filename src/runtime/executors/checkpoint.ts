// Runtime side of checkpoint requests: write the request, emit trace evidence,
// decide whether depth waits or auto-resolves, and apply an operator resume
// selection. Resume validation lives in the run resume path.
import { ZodError } from 'zod';
import { findCheckpointBriefBuilder } from '../../flows/registries/checkpoint-writers/registry.js';
import { requireRuntimeIndexedStep } from '../../flows/registries/runtime-index.js';
import { policyRefsForRuntimeInputs } from '../../policy/policy-envelope.js';
import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import { CompiledFlowId, RunId } from '../../schemas/ids.js';
import type { OperatorAutoResolution } from '../../schemas/operator-summary.js';
import type { Ref } from '../../schemas/ref.js';
import {
  type AutoResolutionPolicy,
  type CheckpointPolicy,
  CheckpointStep as SchemaCheckpointStep,
} from '../../schemas/step.js';
import { resolveHighestScoreAutoResolution } from '../../shared/checkpoint-auto-resolution.js';
import {
  CheckpointBoundaryProjectionError,
  projectCheckpointBoundaryV0,
} from '../../shared/checkpoint-boundary.js';
import { sha256Hex } from '../../shared/connector-relay.js';
import { resolveDottedPath } from '../../shared/fanout-branch-template.js';
import {
  type CheckpointChoice,
  resolveCheckpointChoicesSource,
} from '../../shared/runtime-source.js';
import type { StepOutcome } from '../domain/step.js';
import type { CheckpointStep } from '../manifest/executable-flow.js';
import { appendCheckpointResolutionGuidance } from '../run/guidance.js';
import type { RunContext } from '../run/run-context.js';
import {
  type StepExecutionResult,
  stepExecutionFailed,
  stepExecutionFailedFrom,
  stepExecutionOutcome,
  unwrapStepExecutionResult,
} from './result.js';

type CheckpointResolution =
  | {
      readonly kind: 'resolved';
      readonly selection: string;
      readonly resolutionSource: 'operator' | 'declared-default' | 'policy';
      readonly autoResolved: boolean;
      readonly autoResolution?: OperatorAutoResolution;
      readonly guidanceEvidenceRefs?: readonly Ref[];
      readonly rejectedOptions?: GuidanceDecisionTraceEntryBody['rejected_options'];
    }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'failed'; readonly reason: string };

type CheckpointRouteResolution =
  | { readonly kind: 'resolved'; readonly routeId: string }
  | { readonly kind: 'failed'; readonly reason: string };

type CheckpointBoundaryProjection = ReturnType<typeof projectCheckpointBoundaryV0>;

// Unified materialized-choice shape. Static choices come from the strict
// CheckpointPolicy schema (`label?`/`description?` carry Zod's `| undefined`);
// dynamic choices come from resolveCheckpointChoicesSource as CheckpointChoice.
// The schema element type is the wider of the two, so both flow into it.
type MaterializedChoice = NonNullable<CheckpointPolicy['choices']>[number];

function policy(step: CheckpointStep): CheckpointPolicy {
  if (step.policy === undefined || step.policy === null || typeof step.policy !== 'object') {
    throw new Error(`checkpoint step '${step.id}' is missing checkpoint policy`);
  }
  return step.policy;
}

async function materializePolicy(
  step: CheckpointStep,
  context: RunContext,
): Promise<{
  readonly prompt: string;
  readonly safe_default_choice?: string;
  readonly choices: readonly MaterializedChoice[];
  readonly choice_source: 'static' | 'dynamic';
  readonly auto_resolution?: AutoResolutionPolicy;
}> {
  const stepPolicy = policy(step);
  const choiceSource = stepPolicy.choices_from === undefined ? 'static' : 'dynamic';
  const choices =
    stepPolicy.choices ??
    (stepPolicy.choices_from === undefined
      ? undefined
      : await resolveCheckpointChoicesSource({
          source: stepPolicy.choices_from,
          files: context.files,
          ...(context.axes === undefined ? {} : { axes: context.axes }),
          owner: `checkpoint step '${step.id}' choices_from`,
        }));
  if (choices === undefined || choices.length === 0) {
    throw new Error(`checkpoint step '${step.id}' has no executable checkpoint choices`);
  }
  return {
    prompt: stepPolicy.prompt,
    choices,
    choice_source: choiceSource,
    ...(stepPolicy.safe_default_choice === undefined
      ? {}
      : { safe_default_choice: stepPolicy.safe_default_choice }),
    ...(stepPolicy.auto_resolution === undefined
      ? {}
      : { auto_resolution: stepPolicy.auto_resolution }),
  };
}

function projectRuntimeCheckpointBoundary(input: {
  readonly step: CheckpointStep;
  readonly stepPolicy: Awaited<ReturnType<typeof materializePolicy>>;
  readonly context: RunContext;
}): CheckpointBoundaryProjection {
  const indexedStep = requireRuntimeIndexedStep(
    input.context.packageIndex,
    input.step.id,
    'checkpoint',
  );
  const report = indexedStep.writes.report;
  const indexedPolicy = indexedStep.policy as {
    readonly prompt: string;
    readonly choices?: readonly CheckpointChoice[] | undefined;
    readonly choices_from?: unknown | undefined;
    readonly safe_default_choice?: string | undefined;
    readonly auto_resolution?: unknown | undefined;
    readonly report_template?: unknown | undefined;
  };
  try {
    const schemaStep = SchemaCheckpointStep.parse({
      id: indexedStep.id,
      title: indexedStep.title,
      protocol: indexedStep.protocol,
      reads: indexedStep.reads,
      routes: indexedStep.routes,
      ...(indexedStep.selection === undefined ? {} : { selection: indexedStep.selection }),
      ...(indexedStep.skill_slots === undefined ? {} : { skill_slots: indexedStep.skill_slots }),
      ...(indexedStep.budgets === undefined ? {} : { budgets: indexedStep.budgets }),
      executor: 'orchestrator',
      kind: 'checkpoint',
      policy: {
        prompt: indexedPolicy.prompt,
        ...(indexedPolicy.choices_from === undefined
          ? { choices: indexedPolicy.choices ?? input.stepPolicy.choices }
          : { choices_from: indexedPolicy.choices_from }),
        ...(indexedPolicy.safe_default_choice === undefined
          ? {}
          : { safe_default_choice: indexedPolicy.safe_default_choice }),
        ...(indexedPolicy.auto_resolution === undefined
          ? {}
          : { auto_resolution: indexedPolicy.auto_resolution }),
        ...(indexedPolicy.report_template === undefined
          ? {}
          : { report_template: indexedPolicy.report_template }),
      },
      writes: {
        request: indexedStep.writes.request,
        response: indexedStep.writes.response,
        ...(report === undefined ? {} : { report }),
      },
      check: indexedStep.check,
    });

    return projectCheckpointBoundaryV0({
      step: schemaStep,
      flowId: CompiledFlowId.parse(input.context.flow.id),
      declaredDefaultPolicyRefs: policyRefsForRuntimeInputs({
        ...(input.context.selectionConfigLayers === undefined
          ? {}
          : { configLayers: input.context.selectionConfigLayers }),
        ...(input.context.policyLayers === undefined
          ? {}
          : { policyLayers: input.context.policyLayers }),
      }),
    });
  } catch (error) {
    if (error instanceof ZodError || error instanceof CheckpointBoundaryProjectionError) {
      throw new Error(
        `checkpoint step '${input.step.id}' authority boundary projection failed: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Project the checkpoint authority boundary for a runtime step, materializing
 * its policy first. Exported for the release-proof capture harness, which
 * hand-rolls the frame-step checkpoint yet must emit the same
 * boundary_ref/boundary_hash the real executor does, so resume validation
 * (which re-projects the boundary from the saved flow) accepts the proof run.
 */
export async function projectRuntimeCheckpointBoundaryForStep(
  step: CheckpointStep,
  context: RunContext,
): Promise<CheckpointBoundaryProjection> {
  const stepPolicy = await materializePolicy(step, context);
  return projectRuntimeCheckpointBoundary({ step, stepPolicy, context });
}

async function resolveCheckpoint(
  step: CheckpointStep,
  context: RunContext,
  depth: string | undefined,
  stepPolicy: Awaited<ReturnType<typeof materializePolicy>>,
): Promise<CheckpointResolution> {
  const effectiveDepth = depth ?? 'medium';
  const autonomous = context.axes?.autonomous === true || effectiveDepth === 'autonomous';
  if (!autonomous && (effectiveDepth === 'high' || effectiveDepth === 'tournament')) {
    return { kind: 'waiting' };
  }
  if (autonomous) {
    if (stepPolicy.auto_resolution !== undefined) {
      return await resolveAutoResolution(step, context, stepPolicy, stepPolicy.auto_resolution);
    }
    const selection = stepPolicy.safe_default_choice;
    if (selection === undefined) {
      return {
        kind: 'failed',
        reason: `checkpoint step '${step.id}' cannot auto-resolve autonomous depth without a declared default choice`,
      };
    }
    return {
      kind: 'resolved',
      selection,
      resolutionSource: 'declared-default',
      autoResolved: true,
    };
  }
  const selection = stepPolicy.safe_default_choice;
  if (selection === undefined) {
    return {
      kind: 'failed',
      reason: `checkpoint step '${step.id}' cannot resolve ${effectiveDepth} depth without a declared safe default choice`,
    };
  }
  return { kind: 'resolved', selection, resolutionSource: 'declared-default', autoResolved: true };
}

async function resolveAutoResolution(
  step: CheckpointStep,
  context: RunContext,
  stepPolicy: Awaited<ReturnType<typeof materializePolicy>>,
  autoResolution: AutoResolutionPolicy,
): Promise<CheckpointResolution> {
  const sourceText = await context.files.readText(autoResolution.source_report);
  const sourceRaw = JSON.parse(sourceText) as unknown;
  const sourceReportRef: Ref = {
    kind: 'report',
    ref: autoResolution.source_report,
    sha256: sha256Hex(sourceText),
    run_id: RunId.parse(context.runId),
    flow_id: CompiledFlowId.parse(context.flow.id),
  };
  const branches = resolveDottedPath(sourceRaw, autoResolution.branches_path);
  if (!Array.isArray(branches)) {
    return {
      kind: 'failed',
      reason: `checkpoint step '${step.id}' highest-score source '${autoResolution.source_report}.${autoResolution.branches_path}' did not resolve to an array`,
    };
  }
  try {
    const highestScore = resolveHighestScoreAutoResolution({
      checkpointId: step.id,
      ...(step.title === undefined ? {} : { checkpointLabel: step.title }),
      choices: stepPolicy.choices.map((choice) => choice.id),
      resolvedAt: context.now().toISOString(),
      branches,
      idPath: autoResolution.id_path,
      rubricResultPath: autoResolution.rubric_result_path,
    });
    return {
      kind: 'resolved',
      selection: highestScore.selection,
      resolutionSource: 'policy',
      autoResolved: true,
      autoResolution: highestScore.record,
      guidanceEvidenceRefs: [sourceReportRef],
      rejectedOptions: highestScore.record.alternatives_available.slice(0, 3).map((choiceId) => ({
        option: { choice_id: choiceId },
        reason_code: 'lower_auto_resolution_score',
        blocked_by: sourceReportRef,
      })),
    };
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkpointRouteIdForResolution(input: {
  readonly step: CheckpointStep;
  readonly stepPolicy: Awaited<ReturnType<typeof materializePolicy>>;
  readonly selection: string;
}): CheckpointRouteResolution {
  if (Object.hasOwn(input.step.routes, input.selection)) {
    return { kind: 'resolved', routeId: input.selection };
  }
  if (input.stepPolicy.choice_source === 'dynamic') {
    if (Object.hasOwn(input.step.routes, 'select')) return { kind: 'resolved', routeId: 'select' };
    if (Object.hasOwn(input.step.routes, 'pass')) return { kind: 'resolved', routeId: 'pass' };
  }
  return {
    kind: 'failed',
    reason: `checkpoint step '${input.step.id}' selected '${input.selection}' but no declared route matches that checkpoint choice`,
  };
}

function checkpointRequestBody(input: {
  readonly step: CheckpointStep;
  readonly context: RunContext;
  readonly stepPolicy: Awaited<ReturnType<typeof materializePolicy>>;
  readonly boundary: CheckpointBoundaryProjection;
  readonly checkpointReportSha256?: string;
}) {
  const stepPolicy = input.stepPolicy;
  return {
    schema_version: 1,
    step_id: input.step.id,
    prompt: stepPolicy.prompt,
    allowed_choices: stepPolicy.choices.map((choice) => choice.id),
    ...(stepPolicy.safe_default_choice === undefined
      ? {}
      : { safe_default_choice: stepPolicy.safe_default_choice }),
    execution_context: {
      ...(input.context.axes === undefined ? {} : { axes: input.context.axes }),
      ...(input.context.projectRoot === undefined
        ? {}
        : { project_root: input.context.projectRoot }),
      ...(input.context.workContractRef === undefined
        ? {}
        : { work_contract_ref: input.context.workContractRef }),
      checkpoint_boundary_ref: input.boundary.request_trace.boundary_ref,
      checkpoint_boundary_hash: input.boundary.request_trace.boundary_hash,
      selection_config_layers: input.context.selectionConfigLayers ?? [],
      policy_layers: input.context.policyLayers ?? [],
      ...(input.checkpointReportSha256 === undefined
        ? {}
        : { checkpoint_report_sha256: input.checkpointReportSha256 }),
    },
  };
}

export async function executeCheckpointResult(
  step: CheckpointStep,
  context: RunContext,
): Promise<StepExecutionResult> {
  const attempt = context.activeStepAttempt ?? 1;
  try {
    const request = step.writes?.request;
    const response = step.writes?.response;
    if (request === undefined || response === undefined) {
      return stepExecutionFailed(
        `checkpoint step '${step.id}' requires writes.request and writes.response`,
      );
    }
    const indexedStep = requireRuntimeIndexedStep(context.packageIndex, step.id, 'checkpoint');
    const stepPolicy = await materializePolicy(step, context);
    const boundary = projectRuntimeCheckpointBoundary({ step, stepPolicy, context });

    let checkpointReportSha256: string | undefined;
    let checkpointRequestSha256: string | undefined;
    const report = step.writes?.report;
    const resumedSelection =
      context.resumeCheckpoint?.stepId === step.id ? context.resumeCheckpoint.selection : undefined;
    const resolution = await resolveCheckpoint(step, context, context.depth, stepPolicy);
    if (resumedSelection === undefined) {
      if (report !== undefined) {
        const builder =
          report.schema === undefined ? undefined : findCheckpointBriefBuilder(report.schema);
        if (builder === undefined || report.schema === undefined) {
          return stepExecutionFailed(`checkpoint step '${step.id}' has unsupported report schema`);
        }
        const body = builder.build({
          runFolder: context.runDir,
          step: indexedStep,
          goal: context.goal,
          ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
          responsePath: response.path,
        });
        await context.files.writeJson(report, body);
        checkpointReportSha256 = sha256Hex(await context.files.readText(report));
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          attempt,
          report_path: report.path,
          report_schema: report.schema,
        });
      }

      const requestBody = checkpointRequestBody({
        step,
        context,
        stepPolicy,
        boundary,
        ...(checkpointReportSha256 === undefined ? {} : { checkpointReportSha256 }),
      });
      await context.files.writeJson(request, requestBody);
      const requestText = await context.files.readText(request);
      checkpointRequestSha256 = sha256Hex(requestText);
      await context.trace.append({
        run_id: context.runId,
        kind: 'checkpoint.requested',
        step_id: step.id,
        attempt,
        request_path: request.path,
        request_report_hash: checkpointRequestSha256,
        boundary_ref: boundary.request_trace.boundary_ref,
        boundary_hash: boundary.request_trace.boundary_hash,
        options: stepPolicy.choices.map((choice) => choice.id),
        ...(resolution.kind === 'waiting' ? { auto_resolved: false } : {}),
      });
    }

    const effectiveResolution: CheckpointResolution =
      resumedSelection === undefined
        ? resolution
        : {
            kind: 'resolved',
            selection: resumedSelection,
            resolutionSource: 'operator',
            autoResolved: false,
          };
    if (effectiveResolution.kind === 'waiting') {
      return stepExecutionOutcome({
        kind: 'waiting_checkpoint',
        checkpoint: {
          stepId: step.id,
          attempt,
          requestPath: context.files.resolve(request),
          allowedChoices: stepPolicy.choices.map((choice) => choice.id),
        },
      });
    }
    if (effectiveResolution.kind === 'failed') {
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        attempt,
        check_kind: 'checkpoint_selection',
        outcome: 'fail',
        reason: effectiveResolution.reason,
      });
      return stepExecutionFailed(effectiveResolution.reason);
    }

    const allowed = step.check.allow;
    const effectiveAllowed = Array.isArray(allowed)
      ? allowed
      : stepPolicy.choices.map((choice) => choice.id);
    if (!effectiveAllowed.includes(effectiveResolution.selection)) {
      return stepExecutionFailed(
        `checkpoint step '${step.id}' selected '${effectiveResolution.selection}' but check.allow is [${effectiveAllowed.join(', ')}]`,
      );
    }
    const routeResult = checkpointRouteIdForResolution({
      step,
      stepPolicy,
      selection: effectiveResolution.selection,
    });
    if (routeResult.kind === 'failed') {
      return stepExecutionFailed(routeResult.reason);
    }
    const routeId = routeResult.routeId;
    if (checkpointRequestSha256 === undefined) {
      checkpointRequestSha256 = sha256Hex(await context.files.readText(request));
    }
    const guidance = await appendCheckpointResolutionGuidance(context, {
      stepId: step.id,
      attempt,
      choiceId: effectiveResolution.selection,
      routeId,
      autoResolved: effectiveResolution.autoResolved,
      resolutionSource: effectiveResolution.resolutionSource,
      requestPath: request.path,
      requestReportHash: checkpointRequestSha256,
      ...(effectiveResolution.guidanceEvidenceRefs === undefined
        ? {}
        : { evidenceRefs: effectiveResolution.guidanceEvidenceRefs }),
      ...(effectiveResolution.rejectedOptions === undefined
        ? {}
        : { rejectedOptions: effectiveResolution.rejectedOptions }),
    });
    if (guidance === undefined) {
      const reason = `checkpoint step '${step.id}' requires checkpoint_resolution guidance before crossing the checkpoint boundary`;
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        attempt,
        check_kind: 'checkpoint_selection',
        outcome: 'fail',
        reason,
      });
      return stepExecutionFailed(reason);
    }
    await context.files.writeJson(response, {
      schema_version: 1,
      step_id: step.id,
      selection: effectiveResolution.selection,
      route_id: routeId,
      resolution_source: effectiveResolution.resolutionSource,
      ...(effectiveResolution.autoResolution === undefined
        ? {}
        : { auto_resolution: effectiveResolution.autoResolution }),
    });
    await context.trace.append({
      run_id: context.runId,
      kind: 'checkpoint.resolved',
      step_id: step.id,
      attempt,
      selection: effectiveResolution.selection,
      route_id: routeId,
      auto_resolved: effectiveResolution.autoResolved,
      resolution_source: effectiveResolution.resolutionSource,
      response_path: response.path,
    });
    await context.trace.append({
      run_id: context.runId,
      kind: 'check.evaluated',
      step_id: step.id,
      attempt,
      check_kind: 'checkpoint_selection',
      outcome: 'pass',
    });

    return stepExecutionOutcome({
      route: routeId,
      details: { selection: effectiveResolution.selection },
    });
  } catch (error) {
    return stepExecutionFailedFrom(error);
  }
}

export async function executeCheckpoint(
  step: CheckpointStep,
  context: RunContext,
): Promise<StepOutcome> {
  return unwrapStepExecutionResult(await executeCheckpointResult(step, context));
}

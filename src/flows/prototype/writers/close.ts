import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { CheckpointReviewComment } from '../../../schemas/checkpoint-review-response.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type { CloseBuildContext, CloseBuilder } from '../../registries/close-writers/types.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type { RuntimeIndexedCheckpointStep } from '../../registries/runtime-index.js';
import {
  PrototypeArtifact,
  PrototypeBrief,
  PrototypeCheckpointSelection,
  PrototypePlan,
  PrototypeResult,
  type PrototypeResultReportPointer,
  type PrototypeResult as PrototypeResultValue,
  PrototypeVariantAggregate,
  PrototypeVariantChoiceOptions,
  PrototypeVariantId,
  PrototypeVariantProviderEvidence,
  PrototypeVariantReview,
  PrototypeVariantVerification,
  PrototypeVerification,
} from '../reports.js';

const CheckpointResponse = z.looseObject({
  schema_version: z.literal(1),
  step_id: z.literal('prototype-checkpoint-step'),
  selection: PrototypeCheckpointSelection,
  route_id: z.string().min(1).optional(),
  resolution_source: z.enum(['operator', 'declared-default', 'policy']),
  comments: z.array(CheckpointReviewComment).max(24).optional(),
});

type CheckpointResponse = z.infer<typeof CheckpointResponse>;

const VariantCheckpointResponse = z.looseObject({
  schema_version: z.literal(1),
  step_id: z.literal('prototype-variant-checkpoint-step'),
  selection: PrototypeVariantId,
  route_id: z.string().min(1).optional(),
  resolution_source: z.enum(['operator', 'declared-default', 'policy']),
  comments: z.array(CheckpointReviewComment).max(24).optional(),
});

type VariantCheckpointResponse = z.infer<typeof VariantCheckpointResponse>;

const BASE_SINGLE_POINTERS = [
  { report_id: 'prototype.brief', schema: 'prototype.brief@v1' },
  { report_id: 'prototype.plan', schema: 'prototype.plan@v1' },
  { report_id: 'prototype.artifact', schema: 'prototype.artifact@v1' },
] as const;

const BASE_VARIANT_POINTERS = [
  { report_id: 'prototype.brief', schema: 'prototype.brief@v1' },
  { report_id: 'prototype.plan', schema: 'prototype.plan@v1' },
  { report_id: 'prototype.variant-options', schema: 'prototype.variant-options@v1' },
  { report_id: 'prototype.variant-aggregate', schema: 'prototype.variant-aggregate@v1' },
  {
    report_id: 'prototype.variant-provider-evidence',
    schema: 'prototype.variant-provider-evidence@v1',
  },
  { report_id: 'prototype.variant-verification', schema: 'prototype.variant-verification@v1' },
] as const;

function checkpointStep(
  context: CloseBuildContext,
  stepId: string,
): RuntimeIndexedCheckpointStep | undefined {
  const step = context.flow.steps.find(
    (candidate): candidate is RuntimeIndexedCheckpointStep =>
      candidate.id === stepId && candidate.kind === 'checkpoint',
  );
  return step;
}

function readCheckpointResponse(
  context: CloseBuildContext,
): { readonly path: string; readonly response: CheckpointResponse } | undefined {
  const step = checkpointStep(context, 'prototype-checkpoint-step');
  if (step === undefined) return undefined;
  const responsePath = step.writes.response;
  const abs = resolveRunRelative(context.runFolder, responsePath);
  if (!existsSync(abs)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(abs, 'utf8'));
  return { path: responsePath, response: CheckpointResponse.parse(raw) };
}

function readVariantCheckpointResponse(
  context: CloseBuildContext,
): { readonly path: string; readonly response: VariantCheckpointResponse } | undefined {
  const step = checkpointStep(context, 'prototype-variant-checkpoint-step');
  if (step === undefined) return undefined;
  const responsePath = step.writes.response;
  const abs = resolveRunRelative(context.runFolder, responsePath);
  if (!existsSync(abs)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(abs, 'utf8'));
  return { path: responsePath, response: VariantCheckpointResponse.parse(raw) };
}

function existingCheckpointRequestPath(context: CloseBuildContext): string | undefined {
  const step = checkpointStep(context, 'prototype-checkpoint-step');
  if (step === undefined) return undefined;
  const requestPath = step.writes.request;
  return existsSync(resolveRunRelative(context.runFolder, requestPath)) ? requestPath : undefined;
}

function existingVariantCheckpointRequestPath(context: CloseBuildContext): string | undefined {
  const step = checkpointStep(context, 'prototype-variant-checkpoint-step');
  if (step === undefined) return undefined;
  const requestPath = step.writes.request;
  return existsSync(resolveRunRelative(context.runFolder, requestPath)) ? requestPath : undefined;
}

function evidenceLinks(
  context: CloseBuildContext,
  checkpointResponse: ReturnType<typeof readCheckpointResponse>,
): PrototypeResultReportPointer[] {
  const links: PrototypeResultReportPointer[] = BASE_SINGLE_POINTERS.map((pointer) => ({
    ...pointer,
    path: reportPathForSchemaInRuntimeFlow(context.flow, pointer.schema),
  }));
  if (reportExists(context, 'prototype.verification@v1')) {
    links.push({
      report_id: 'prototype.verification',
      schema: 'prototype.verification@v1',
      path: reportPathForSchemaInRuntimeFlow(context.flow, 'prototype.verification@v1'),
    });
  }
  const checkpointRequestPath = existingCheckpointRequestPath(context);
  if (checkpointRequestPath !== undefined) {
    links.push({
      report_id: 'prototype.checkpoint.request',
      schema: 'checkpoint.request@v1',
      path: checkpointRequestPath,
    });
  }
  if (checkpointResponse !== undefined) {
    links.push({
      report_id: 'prototype.checkpoint.response',
      schema: 'checkpoint.response@v1',
      path: checkpointResponse.path,
    });
  }
  return links;
}

function reportExists(context: CloseBuildContext, schemaName: string): boolean {
  const path = reportPathForSchemaInRuntimeFlow(context.flow, schemaName);
  return existsSync(resolveRunRelative(context.runFolder, path));
}

function readOptionalReport<T>(
  context: CloseBuildContext,
  schemaName: string,
  parse: (raw: unknown) => T,
): T | undefined {
  const path = reportPathForSchemaInRuntimeFlow(context.flow, schemaName);
  const abs = resolveRunRelative(context.runFolder, path);
  if (!existsSync(abs)) return undefined;
  return parse(JSON.parse(readFileSync(abs, 'utf8')));
}

function variantEvidenceLinks(
  context: CloseBuildContext,
  checkpointResponse: ReturnType<typeof readVariantCheckpointResponse>,
): PrototypeResultReportPointer[] {
  const links: PrototypeResultReportPointer[] = BASE_VARIANT_POINTERS.map((pointer) => ({
    ...pointer,
    path: reportPathForSchemaInRuntimeFlow(context.flow, pointer.schema),
  }));
  if (reportExists(context, 'prototype.variant-review@v1')) {
    links.push({
      report_id: 'prototype.variant-review',
      schema: 'prototype.variant-review@v1',
      path: reportPathForSchemaInRuntimeFlow(context.flow, 'prototype.variant-review@v1'),
    });
  }
  if (reportExists(context, 'prototype.variant-choice-options@v1')) {
    links.push({
      report_id: 'prototype.variant-choice-options',
      schema: 'prototype.variant-choice-options@v1',
      path: reportPathForSchemaInRuntimeFlow(context.flow, 'prototype.variant-choice-options@v1'),
    });
  }
  const checkpointRequestPath = existingVariantCheckpointRequestPath(context);
  if (checkpointRequestPath !== undefined) {
    links.push({
      report_id: 'prototype.checkpoint.request',
      schema: 'checkpoint.request@v1',
      path: checkpointRequestPath,
    });
  }
  if (checkpointResponse !== undefined) {
    links.push({
      report_id: 'prototype.checkpoint.response',
      schema: 'checkpoint.response@v1',
      path: checkpointResponse.path,
    });
  }
  return links;
}

function checkpointStatus(
  response: CheckpointResponse | VariantCheckpointResponse | undefined,
): PrototypeResultValue['checkpoint_status'] {
  if (response === undefined) return 'not_reached';
  return response.resolution_source === 'operator' ? 'operator_selected' : 'auto_resolved';
}

function outcomeFor(input: {
  readonly artifact: PrototypeArtifact;
  readonly verification: PrototypeVerification | undefined;
  readonly checkpoint: CheckpointResponse | undefined;
}): PrototypeResultValue['outcome'] {
  if (input.artifact.verdict !== 'accept') return 'needs_attention';
  if (input.verification === undefined) return 'needs_attention';
  if (input.verification.overall_status !== 'passed') return 'needs_attention';
  if (input.checkpoint === undefined) return 'needs_attention';
  if (input.checkpoint.selection === 'save-build-input') return 'build_input_saved';
  if (input.checkpoint.selection === 'discard-prototype') return 'discarded';
  return 'kept';
}

function nextStepFor(input: {
  readonly outcome: PrototypeResultValue['outcome'];
  readonly plan: PrototypePlan;
  readonly artifact: PrototypeArtifact;
}): string {
  if (input.outcome === 'build_input_saved') {
    return 'Use build_followup_prompt as the starting brief for Build when you are ready to turn this prototype into production code.';
  }
  if (input.outcome === 'discarded') {
    return 'Leave the artifact as evidence, or delete prototype_root after reviewing why it was discarded.';
  }
  if (input.outcome === 'kept') {
    return `Inspect ${input.artifact.entry_points[0] ?? input.plan.interaction_path} and decide whether a separate Build run is warranted.`;
  }
  return 'Review the artifact, verification report, and limitations before deciding whether to rerun Prototype or switch to Explore.';
}

function summaryFor(input: {
  readonly outcome: PrototypeResultValue['outcome'];
  readonly artifact: PrototypeArtifact;
  readonly verification: PrototypeVerification | undefined;
  readonly checkpoint: CheckpointResponse | undefined;
}): string {
  if (input.artifact.verdict !== 'accept') {
    return `Prototype needs attention: the artifact relay reported '${input.artifact.verdict}'. ${input.artifact.summary}`;
  }
  if (input.verification === undefined) {
    return `Prototype needs attention: no verification report was written before close. ${input.artifact.summary}`;
  }
  if (input.verification.overall_status !== 'passed') {
    return `Prototype needs attention: artifact integrity or target checks failed. ${input.artifact.summary}`;
  }
  if (input.checkpoint === undefined) {
    return `Prototype needs attention: verification passed but no checkpoint choice was recorded. ${input.artifact.summary}`;
  }
  if (input.outcome === 'build_input_saved') {
    return `Prototype verified and saved as Build input. ${input.artifact.summary}`;
  }
  if (input.outcome === 'discarded') {
    return `Prototype verified and marked discarded. ${input.artifact.summary}`;
  }
  return `Prototype verified and kept. ${input.artifact.summary}`;
}

export const prototypeCloseBuilder: CloseBuilder = {
  resultSchemaName: 'prototype.result@v1',
  reads: [
    { name: 'brief', schema: 'prototype.brief@v1', required: true },
    { name: 'plan', schema: 'prototype.plan@v1', required: true },
    { name: 'artifact', schema: 'prototype.artifact@v1', required: false },
    { name: 'verification', schema: 'prototype.verification@v1', required: false },
    { name: 'variantOptions', schema: 'prototype.variant-options@v1', required: false },
    { name: 'variantAggregate', schema: 'prototype.variant-aggregate@v1', required: false },
    {
      name: 'variantProviderEvidence',
      schema: 'prototype.variant-provider-evidence@v1',
      required: false,
    },
    {
      name: 'variantVerification',
      schema: 'prototype.variant-verification@v1',
      required: false,
    },
    { name: 'variantReview', schema: 'prototype.variant-review@v1', required: false },
    {
      name: 'variantChoiceOptions',
      schema: 'prototype.variant-choice-options@v1',
      required: false,
    },
  ],
  build(context: CloseBuildContext): unknown {
    const brief = PrototypeBrief.parse(context.inputs.brief);
    const plan = PrototypePlan.parse(context.inputs.plan);
    if (context.inputs.variantAggregate !== undefined) {
      return buildVariantResult({ context, brief, plan });
    }
    if (context.inputs.artifact === undefined) {
      throw new Error('prototype.result@v1 close requires prototype.artifact@v1 in single mode');
    }
    const artifact = PrototypeArtifact.parse(context.inputs.artifact);
    const verification =
      context.inputs.verification === undefined
        ? readOptionalReport(context, 'prototype.verification@v1', (raw) =>
            PrototypeVerification.parse(raw),
          )
        : PrototypeVerification.parse(context.inputs.verification);
    const checkpoint = readCheckpointResponse(context);
    const outcome = outcomeFor({ artifact, verification, checkpoint: checkpoint?.response });
    return PrototypeResult.parse({
      summary: summaryFor({ outcome, artifact, verification, checkpoint: checkpoint?.response }),
      outcome,
      artifact_status: artifact.verdict === 'accept' ? 'accepted' : 'blocked',
      verification_status:
        verification === undefined
          ? 'blocked'
          : verification.overall_status === 'passed'
            ? 'passed'
            : 'failed',
      checkpoint_status: checkpointStatus(checkpoint?.response),
      checkpoint_selection: checkpoint?.response.selection ?? 'not_reached',
      ...(checkpoint?.response.comments === undefined || checkpoint.response.comments.length === 0
        ? {}
        : { checkpoint_comments: checkpoint.response.comments }),
      prototype_root: artifact.prototype_root,
      entry_points: artifact.entry_points,
      integration_touchpoints: artifact.integration_touchpoints,
      preview_instructions: artifact.preview_instructions,
      ...(outcome === 'build_input_saved'
        ? { build_followup_prompt: plan.build_followup_prompt }
        : {}),
      residual_risks: artifact.known_limitations,
      next_step: nextStepFor({ outcome, plan, artifact }),
      claim_limits: brief.claim_limits,
      evidence_links: evidenceLinks(context, checkpoint),
    });
  },
};

function buildVariantResult(input: {
  readonly context: CloseBuildContext;
  readonly brief: PrototypeBrief;
  readonly plan: PrototypePlan;
}): unknown {
  const { context, brief, plan } = input;
  const aggregate = PrototypeVariantAggregate.parse(context.inputs.variantAggregate);
  const providerEvidence =
    context.inputs.variantProviderEvidence === undefined
      ? undefined
      : PrototypeVariantProviderEvidence.parse(context.inputs.variantProviderEvidence);
  const verification =
    context.inputs.variantVerification === undefined
      ? undefined
      : PrototypeVariantVerification.parse(context.inputs.variantVerification);
  const review =
    context.inputs.variantReview === undefined
      ? readOptionalReport(context, 'prototype.variant-review@v1', (raw) =>
          PrototypeVariantReview.parse(raw),
        )
      : PrototypeVariantReview.parse(context.inputs.variantReview);
  const choiceOptions =
    context.inputs.variantChoiceOptions === undefined
      ? readOptionalReport(context, 'prototype.variant-choice-options@v1', (raw) =>
          PrototypeVariantChoiceOptions.parse(raw),
        )
      : PrototypeVariantChoiceOptions.parse(context.inputs.variantChoiceOptions);
  const checkpoint = readVariantCheckpointResponse(context);
  const selectedVariantId = checkpoint?.response.selection;
  const selectedBranch =
    selectedVariantId === undefined
      ? undefined
      : aggregate.branches.find((branch) => branch.branch_id === selectedVariantId);
  const selectedArtifact = selectedBranch?.result_body;
  const selectedProviderEvidenceStatus =
    selectedVariantId === undefined
      ? 'missing'
      : (providerEvidence?.variants.find((variant) => variant.variant_id === selectedVariantId)
          ?.status ?? 'missing');
  const verificationPassed = verification?.overall_status === 'passed';
  const hasCheckpoint = checkpoint !== undefined;
  const outcome =
    verificationPassed &&
    hasCheckpoint &&
    selectedArtifact !== undefined &&
    selectedProviderEvidenceStatus === 'captured'
      ? 'kept'
      : 'needs_attention';
  const admittedVariantCount =
    verification?.admitted_variant_count ??
    aggregate.branches.filter((branch) => branch.child_outcome === 'complete' && branch.admitted)
      .length;
  const capturedProviderEvidenceCount = providerEvidence?.captured_count ?? 0;
  const selectedLabel =
    selectedArtifact?.variant_label ??
    choiceOptions?.choices.find((choice) => choice.id === selectedVariantId)?.label;
  const summary =
    outcome === 'kept'
      ? `Prototype model comparison verified and kept ${selectedLabel ?? selectedVariantId}.`
      : 'Prototype model comparison needs attention before a variant can be kept.';
  return PrototypeResult.parse({
    mode: 'model-comparison',
    summary,
    outcome,
    artifact_status: selectedArtifact?.verdict === 'accept' ? 'accepted' : 'blocked',
    verification_status:
      verification === undefined
        ? 'blocked'
        : verification.overall_status === 'passed'
          ? 'passed'
          : 'failed',
    checkpoint_status: checkpointStatus(checkpoint?.response),
    checkpoint_selection: selectedVariantId ?? 'not_reached',
    ...(checkpoint?.response.comments === undefined || checkpoint.response.comments.length === 0
      ? {}
      : { checkpoint_comments: checkpoint.response.comments }),
    prototype_root: plan.prototype_root,
    entry_points: selectedArtifact?.entry_points ?? [],
    preview_instructions:
      selectedArtifact?.preview_instructions ??
      `Inspect variant reports under ${plan.prototype_root}/variants before rerunning Prototype.`,
    residual_risks: [
      ...new Set([
        ...aggregate.branches.flatMap((branch) => branch.result_body?.known_limitations ?? []),
        ...(review?.risks ?? []),
        ...(review?.missing_evidence ?? []),
        ...plan.risks,
      ]),
    ],
    next_step:
      outcome === 'kept'
        ? `Inspect ${selectedArtifact?.entry_points[0] ?? plan.interaction_path}; run Build separately only if the chosen local prototype should become production code.`
        : 'Review the variant aggregate, provider evidence, and verification report before rerunning Prototype model comparison.',
    claim_limits: brief.claim_limits,
    evidence_links: variantEvidenceLinks(context, checkpoint),
    variant_count: aggregate.branch_count,
    admitted_variant_count: admittedVariantCount,
    captured_provider_evidence_count: capturedProviderEvidenceCount,
    model_evidence_status: selectedProviderEvidenceStatus,
    ...(review?.recommended_variant_id === undefined
      ? {}
      : { recommended_variant_id: review.recommended_variant_id }),
    ...(selectedVariantId === undefined ? {} : { selected_variant_id: selectedVariantId }),
    ...(selectedLabel === undefined ? {} : { selected_variant_label: selectedLabel }),
    ...(selectedArtifact?.variant_root === undefined
      ? {}
      : { selected_variant_root: selectedArtifact.variant_root }),
    ...(review?.comparison_summary === undefined
      ? {}
      : { comparison_summary: review.comparison_summary }),
  });
}

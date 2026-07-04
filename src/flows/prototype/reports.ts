import { z } from 'zod';
import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER } from '../../policy/rubric.js';
import { ConnectorReference } from '../../schemas/config.js';
import { RelayResolutionSource } from '../../schemas/connector.js';
import { RubricJudgment, RubricResult } from '../../schemas/rubric.js';
import { Effort, ProviderScopedModel } from '../../schemas/selection-policy.js';
import {
  VerificationCommand,
  VerificationCommandResult,
  VerificationResult,
} from '../../schemas/verification.js';
import { resultReportPointer } from '../report-schema-kit.js';

const NonEmptyStringArray = z.array(z.string().min(1)).min(1);
const StringArray = z.array(z.string().min(1));

const PROTOTYPE_RESULT_SCHEMA_BY_REPORT_ID = {
  'prototype.brief': 'prototype.brief@v1',
  'prototype.plan': 'prototype.plan@v1',
  'prototype.artifact': 'prototype.artifact@v1',
  'prototype.verification': 'prototype.verification@v1',
  'prototype.variant-options': 'prototype.variant-options@v1',
  'prototype.variant-aggregate': 'prototype.variant-aggregate@v1',
  'prototype.variant-provider-evidence': 'prototype.variant-provider-evidence@v1',
  'prototype.variant-verification': 'prototype.variant-verification@v1',
  'prototype.variant-review': 'prototype.variant-review@v1',
  'prototype.variant-choice-options': 'prototype.variant-choice-options@v1',
  'prototype.checkpoint.request': 'checkpoint.request@v1',
  'prototype.checkpoint.response': 'checkpoint.response@v1',
} as const;

export const PrototypeCheckpointSelection = z.enum([
  'keep-prototype',
  'save-build-input',
  'discard-prototype',
]);
export type PrototypeCheckpointSelection = z.infer<typeof PrototypeCheckpointSelection>;

export const PrototypeCheckpointSelectionOrMissing = z.union([
  PrototypeCheckpointSelection,
  z.literal('not_reached'),
]);
export type PrototypeCheckpointSelectionOrMissing = z.infer<
  typeof PrototypeCheckpointSelectionOrMissing
>;

function addPathIssue(
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  ctx.addIssue({
    code: 'custom',
    path: [...path],
    message,
  });
}

function validateProjectRelativePath(value: string, ctx: z.RefinementCtx): void {
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)) {
    addPathIssue(ctx, [], 'path must be project-relative and cannot use absolute or home paths');
  }
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    addPathIssue(ctx, [], 'path must not use UNC or network absolute paths');
  }
  if (value.includes('\\')) {
    addPathIssue(ctx, [], 'path must use forward slashes');
  }
  if (value.endsWith('/')) {
    addPathIssue(ctx, [], 'path must not end with a slash');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    addPathIssue(ctx, [], 'path must be normalized and must not escape the project root');
  }
}

// Workers sometimes emit a leading './' or a single stray '/' on
// otherwise-valid relative paths (live example: a tournament variant
// reported '/.circuit/runs/.../index.html' for a file that existed at the
// relative path, and lost its branch over the one character). Neither
// prefix carries escape risk, so strip both before validation instead of
// aborting the run. '//' (UNC), '~', drive letters, and any '..' segments
// still reject, and downstream existence checks still require every
// reported path to exist on disk.
function stripForgivablePrefixes(value: string): string {
  let result = value;
  for (;;) {
    if (result.startsWith('./')) {
      result = result.slice(2);
      continue;
    }
    if (result.startsWith('/') && !result.startsWith('//')) {
      result = result.slice(1);
      continue;
    }
    return result;
  }
}

export const PrototypeProjectRelativePath = z
  .string()
  .min(1)
  .transform(stripForgivablePrefixes)
  .superRefine(validateProjectRelativePath);
export type PrototypeProjectRelativePath = z.infer<typeof PrototypeProjectRelativePath>;

export const PrototypeRootPath = PrototypeProjectRelativePath.superRefine((root, ctx) => {
  const [firstSegment] = root.split('/');
  if (firstSegment === undefined) return;
  if (['dist', 'generated', 'node_modules', 'plugins'].includes(firstSegment)) {
    addPathIssue(
      ctx,
      [],
      `prototype_root must not live under generated or host package output (${firstSegment})`,
    );
  }
});
export type PrototypeRootPath = z.infer<typeof PrototypeRootPath>;

function isUnderRoot(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}

function validatePathsUnderRoot(input: {
  readonly ctx: z.RefinementCtx;
  readonly root: string;
  readonly values: readonly string[];
  readonly path: readonly (string | number)[];
}): void {
  input.values.forEach((value, index) => {
    if (!isUnderRoot(value, input.root)) {
      addPathIssue(
        input.ctx,
        [...input.path, index],
        `path must be inside prototype_root '${input.root}'`,
      );
    }
  });
}

function hasClaimLimit(claimLimits: readonly string[], required: string): boolean {
  const needle = required.toLowerCase();
  return claimLimits.some((limit) => limit.toLowerCase().includes(needle));
}

function validatePrototypeClaimLimits(
  claimLimits: readonly string[],
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (!hasClaimLimit(claimLimits, 'not production')) {
    addPathIssue(ctx, path, "claim_limits must include a 'not production' limit");
  }
  if (!hasClaimLimit(claimLimits, 'not deployed')) {
    addPathIssue(ctx, path, "claim_limits must include a 'not deployed' limit");
  }
}

export const PrototypeBrief = z
  .object({
    objective: z.string().min(1),
    prototype_scope: z.string().min(1),
    out_of_scope: NonEmptyStringArray,
    target_user: z.string().min(1),
    success_criteria: NonEmptyStringArray,
    prototype_root: PrototypeRootPath,
    verification_command_candidates: z.array(VerificationCommand),
    claim_limits: NonEmptyStringArray,
  })
  .strict()
  .superRefine((brief, ctx) => {
    validatePrototypeClaimLimits(brief.claim_limits, ctx, ['claim_limits']);
  });
export type PrototypeBrief = z.infer<typeof PrototypeBrief>;

export const PrototypePlan = z
  .object({
    objective: z.string().min(1),
    prototype_root: PrototypeRootPath,
    files_to_create: z.array(PrototypeProjectRelativePath).min(1),
    entry_points: z.array(PrototypeProjectRelativePath).min(1),
    interaction_path: PrototypeProjectRelativePath,
    preview_instructions: z.string().min(1),
    verification: z
      .object({
        commands: z.array(VerificationCommand),
      })
      .strict(),
    build_followup_prompt: z.string().min(1),
    risks: NonEmptyStringArray,
    claim_limits: NonEmptyStringArray,
  })
  .strict()
  .superRefine((plan, ctx) => {
    validatePathsUnderRoot({
      ctx,
      root: plan.prototype_root,
      values: plan.files_to_create,
      path: ['files_to_create'],
    });
    validatePathsUnderRoot({
      ctx,
      root: plan.prototype_root,
      values: plan.entry_points,
      path: ['entry_points'],
    });
    validatePathsUnderRoot({
      ctx,
      root: plan.prototype_root,
      values: [plan.interaction_path],
      path: ['interaction_path'],
    });
    validatePrototypeClaimLimits(plan.claim_limits, ctx, ['claim_limits']);
  });
export type PrototypePlan = z.infer<typeof PrototypePlan>;

export const PrototypeArtifact = z
  .object({
    verdict: z.enum(['accept', 'blocked']),
    summary: z.string().min(1),
    prototype_root: PrototypeRootPath,
    created_files: z.array(PrototypeProjectRelativePath),
    entry_points: z.array(PrototypeProjectRelativePath),
    preview_instructions: z.string().min(1),
    known_limitations: StringArray,
    evidence: NonEmptyStringArray,
    claim_limits: NonEmptyStringArray,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    validatePathsUnderRoot({
      ctx,
      root: artifact.prototype_root,
      values: artifact.created_files,
      path: ['created_files'],
    });
    validatePathsUnderRoot({
      ctx,
      root: artifact.prototype_root,
      values: artifact.entry_points,
      path: ['entry_points'],
    });
    validatePrototypeClaimLimits(artifact.claim_limits, ctx, ['claim_limits']);
    if (artifact.verdict === 'accept') {
      if (artifact.created_files.length === 0) {
        addPathIssue(
          ctx,
          ['created_files'],
          "created_files must be non-empty for verdict 'accept'",
        );
      }
      if (artifact.entry_points.length === 0) {
        addPathIssue(ctx, ['entry_points'], "entry_points must be non-empty for verdict 'accept'");
      }
    }
  });
export type PrototypeArtifact = z.infer<typeof PrototypeArtifact>;

export const PrototypeVariantId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'variant_id must be a fanout-safe kebab-case slug',
  });
export type PrototypeVariantId = z.infer<typeof PrototypeVariantId>;

export const PrototypeRubricDimId = z.enum(THREE_AXIS_RUBRIC_TIE_BREAK_ORDER);
export type PrototypeRubricDimId = z.infer<typeof PrototypeRubricDimId>;

function refineExactPrototypeRubricDims(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
): void {
  const expected = new Set<string>(THREE_AXIS_RUBRIC_TIE_BREAK_ORDER);
  for (const dimId of THREE_AXIS_RUBRIC_TIE_BREAK_ORDER) {
    if (value[dimId] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [dimId],
        message: `missing rubric dim '${dimId}'`,
      });
    }
  }
  for (const dimId of Object.keys(value)) {
    if (!expected.has(dimId)) {
      ctx.addIssue({
        code: 'custom',
        path: [dimId],
        message: `unknown rubric dim '${dimId}'`,
      });
    }
  }
}

export const PrototypeRubricModelJudgments = z
  .record(PrototypeRubricDimId, RubricJudgment)
  .superRefine(refineExactPrototypeRubricDims);
export type PrototypeRubricModelJudgments = z.infer<typeof PrototypeRubricModelJudgments>;

const PrototypeVariantSelection = z
  .object({
    model: ProviderScopedModel,
    effort: Effort,
  })
  .strict();

export const PrototypeVariantOption = z
  .object({
    variant_id: PrototypeVariantId,
    label: z.string().min(1),
    provider: ProviderScopedModel.shape.provider,
    model: ProviderScopedModel.shape.model,
    effort: Effort,
    connector: ConnectorReference.optional(),
    connector_name: z.string().min(1),
    connector_source: RelayResolutionSource,
    prototype_root: PrototypeRootPath,
    variant_root: PrototypeRootPath,
    entry_point_hint: PrototypeProjectRelativePath,
    selection: PrototypeVariantSelection,
    selection_source: z.string().min(1),
    goal: z.string().min(1),
  })
  .strict()
  .superRefine((option, ctx) => {
    if (option.provider !== option.selection.model.provider) {
      addPathIssue(ctx, ['provider'], 'provider must match selection.model.provider');
    }
    if (option.model !== option.selection.model.model) {
      addPathIssue(ctx, ['model'], 'model must match selection.model.model');
    }
    if (option.effort !== option.selection.effort) {
      addPathIssue(ctx, ['effort'], 'effort must match selection.effort');
    }
    validatePathsUnderRoot({
      ctx,
      root: option.variant_root,
      values: [option.entry_point_hint],
      path: ['entry_point_hint'],
    });
  });
export type PrototypeVariantOption = z.infer<typeof PrototypeVariantOption>;

export const PrototypeVariantOptions = z
  .object({
    schema_version: z.literal(1),
    objective: z.string().min(1),
    prototype_root: PrototypeRootPath,
    variant_count: z.number().int().min(2).max(4),
    variants: z.array(PrototypeVariantOption).min(2).max(4),
    claim_limits: NonEmptyStringArray,
  })
  .strict()
  .superRefine((options, ctx) => {
    validatePrototypeClaimLimits(options.claim_limits, ctx, ['claim_limits']);
    if (options.variant_count !== options.variants.length) {
      addPathIssue(ctx, ['variant_count'], 'variant_count must match variants.length');
    }
    const seen = new Set<string>();
    for (const [index, variant] of options.variants.entries()) {
      if (seen.has(variant.variant_id)) {
        addPathIssue(
          ctx,
          ['variants', index, 'variant_id'],
          `duplicate variant_id '${variant.variant_id}'`,
        );
      }
      seen.add(variant.variant_id);
      const expectedRoot = `${options.prototype_root}/variants/${variant.variant_id}`;
      if (variant.prototype_root !== options.prototype_root) {
        addPathIssue(
          ctx,
          ['variants', index, 'prototype_root'],
          `prototype_root must match '${options.prototype_root}'`,
        );
      }
      if (variant.variant_root !== expectedRoot) {
        addPathIssue(
          ctx,
          ['variants', index, 'variant_root'],
          `variant_root must be '${expectedRoot}' for variant_id '${variant.variant_id}'`,
        );
      }
    }
  });
export type PrototypeVariantOptions = z.infer<typeof PrototypeVariantOptions>;

export const PrototypeVariantArtifact = z
  .object({
    verdict: z.enum(['accept', 'blocked']),
    variant_id: PrototypeVariantId,
    variant_label: z.string().min(1),
    summary: z.string().min(1),
    prototype_root: PrototypeRootPath,
    variant_root: PrototypeRootPath,
    created_files: z.array(PrototypeProjectRelativePath),
    entry_points: z.array(PrototypeProjectRelativePath),
    preview_instructions: z.string().min(1),
    known_limitations: StringArray,
    evidence: NonEmptyStringArray,
    rubric_model_judgments: PrototypeRubricModelJudgments,
    claim_limits: NonEmptyStringArray,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const expectedRoot = `${artifact.prototype_root}/variants/${artifact.variant_id}`;
    if (artifact.variant_root !== expectedRoot) {
      addPathIssue(
        ctx,
        ['variant_root'],
        `variant_root must be '${expectedRoot}' for variant_id '${artifact.variant_id}'`,
      );
    }
    validatePathsUnderRoot({
      ctx,
      root: artifact.variant_root,
      values: artifact.created_files,
      path: ['created_files'],
    });
    validatePathsUnderRoot({
      ctx,
      root: artifact.variant_root,
      values: artifact.entry_points,
      path: ['entry_points'],
    });
    validatePrototypeClaimLimits(artifact.claim_limits, ctx, ['claim_limits']);
    if (artifact.verdict === 'accept') {
      if (artifact.created_files.length === 0) {
        addPathIssue(
          ctx,
          ['created_files'],
          "created_files must be non-empty for verdict 'accept'",
        );
      }
      if (artifact.entry_points.length === 0) {
        addPathIssue(ctx, ['entry_points'], "entry_points must be non-empty for verdict 'accept'");
      }
    }
  });
export type PrototypeVariantArtifact = z.infer<typeof PrototypeVariantArtifact>;

export const PrototypeVariantAggregateBranch = z
  .object({
    branch_id: PrototypeVariantId,
    child_run_id: z.string().min(1),
    child_outcome: z.enum(['complete', 'aborted', 'handoff', 'stopped', 'escalated']),
    verdict: z.string().min(1),
    admitted: z.boolean(),
    result_path: z.string().min(1),
    duration_ms: z.number().nonnegative(),
    result_body: PrototypeVariantArtifact.optional(),
    rubric_result: RubricResult.optional(),
  })
  .strict();
export type PrototypeVariantAggregateBranch = z.infer<typeof PrototypeVariantAggregateBranch>;

export const PrototypeVariantAggregate = z
  .object({
    schema_version: z.literal(1),
    join_policy: z.literal('aggregate-survivors'),
    branch_count: z.number().int().positive(),
    branches: z.array(PrototypeVariantAggregateBranch).min(1),
  })
  .strict()
  .superRefine((aggregate, ctx) => {
    if (aggregate.branch_count !== aggregate.branches.length) {
      addPathIssue(ctx, ['branch_count'], 'branch_count must match branches.length');
    }
    for (const [index, branch] of aggregate.branches.entries()) {
      if (branch.child_outcome === 'complete' && branch.result_body === undefined) {
        addPathIssue(
          ctx,
          ['branches', index, 'result_body'],
          'complete variant branches must include result_body provenance',
        );
      }
      if (branch.child_outcome === 'complete' && branch.rubric_result === undefined) {
        addPathIssue(
          ctx,
          ['branches', index, 'rubric_result'],
          'complete variant branches must include rubric_result provenance',
        );
      }
      if (
        branch.child_outcome === 'complete' &&
        branch.result_body !== undefined &&
        branch.result_body.variant_id !== branch.branch_id
      ) {
        addPathIssue(
          ctx,
          ['branches', index, 'result_body', 'variant_id'],
          `branch_id '${branch.branch_id}' must match result_body.variant_id '${branch.result_body.variant_id}'`,
        );
      }
    }
  });
export type PrototypeVariantAggregate = z.infer<typeof PrototypeVariantAggregate>;

export const PrototypeVariantProviderEvidenceItem = z
  .object({
    variant_id: PrototypeVariantId,
    label: z.string().min(1),
    relay_step_id: z.string().min(1),
    status: z.enum(['captured', 'missing']),
    connector_name: z.string().min(1).optional(),
    provider: ProviderScopedModel.shape.provider.optional(),
    model: ProviderScopedModel.shape.model.optional(),
    effort: Effort.optional(),
    trace_sequence: z.number().int().nonnegative().optional(),
    trace_entry_kind: z.literal('relay.started').optional(),
    resolved_from: RelayResolutionSource.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.status === 'captured') {
      if (item.connector_name === undefined) {
        addPathIssue(ctx, ['connector_name'], 'captured provider evidence requires connector_name');
      }
      if (item.provider === undefined) {
        addPathIssue(ctx, ['provider'], 'captured provider evidence requires provider');
      }
      if (item.model === undefined) {
        addPathIssue(ctx, ['model'], 'captured provider evidence requires model');
      }
      if (item.effort === undefined) {
        addPathIssue(ctx, ['effort'], 'captured provider evidence requires effort');
      }
      if (item.trace_sequence === undefined) {
        addPathIssue(ctx, ['trace_sequence'], 'captured provider evidence requires trace_sequence');
      }
      if (item.trace_entry_kind === undefined) {
        addPathIssue(
          ctx,
          ['trace_entry_kind'],
          "captured provider evidence requires trace_entry_kind 'relay.started'",
        );
      }
      if (item.resolved_from === undefined) {
        addPathIssue(ctx, ['resolved_from'], 'captured provider evidence requires resolved_from');
      }
    }
  });
export type PrototypeVariantProviderEvidenceItem = z.infer<
  typeof PrototypeVariantProviderEvidenceItem
>;

export const PrototypeVariantMissingEvidence = z
  .object({
    variant_id: PrototypeVariantId,
    relay_step_id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type PrototypeVariantMissingEvidence = z.infer<typeof PrototypeVariantMissingEvidence>;

export const PrototypeVariantProviderEvidence = z
  .object({
    schema_version: z.literal(1),
    evidence_source: z.literal('relay.started resolved_selection trace entries'),
    required_captured_count: z.number().int().min(2),
    captured_count: z.number().int().nonnegative(),
    variants: z.array(PrototypeVariantProviderEvidenceItem).min(2),
    missing_evidence: z.array(PrototypeVariantMissingEvidence),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.required_captured_count !== report.variants.length) {
      addPathIssue(
        ctx,
        ['required_captured_count'],
        'required_captured_count must equal variants length',
      );
    }
    const captured = report.variants.filter((variant) => variant.status === 'captured').length;
    if (report.captured_count !== captured) {
      addPathIssue(ctx, ['captured_count'], 'captured_count must equal captured variants length');
    }
    const seen = new Set<string>();
    for (const [index, variant] of report.variants.entries()) {
      if (seen.has(variant.variant_id)) {
        addPathIssue(
          ctx,
          ['variants', index, 'variant_id'],
          `duplicate variant_id '${variant.variant_id}'`,
        );
      }
      seen.add(variant.variant_id);
    }
    const missing = report.variants.filter((variant) => variant.status === 'missing');
    if (report.missing_evidence.length !== missing.length) {
      addPathIssue(
        ctx,
        ['missing_evidence'],
        'missing_evidence must contain one entry for each missing variant evidence row',
      );
    }
  });
export type PrototypeVariantProviderEvidence = z.infer<typeof PrototypeVariantProviderEvidence>;

export const PrototypeVariantVerificationItem = z
  .object({
    variant_id: PrototypeVariantId,
    status: z.enum(['passed', 'failed', 'blocked']),
    entry_points: z.array(PrototypeProjectRelativePath),
    created_files: z.array(PrototypeProjectRelativePath),
    failure_summary: z.string().min(1).optional(),
    notes: StringArray,
  })
  .strict();
export type PrototypeVariantVerificationItem = z.infer<typeof PrototypeVariantVerificationItem>;

export const PrototypeVariantVerification = z
  .object({
    overall_status: z.enum(['passed', 'failed']),
    required_captured_provider_evidence_count: z.literal(2),
    captured_provider_evidence_count: z.number().int().nonnegative(),
    admitted_variant_count: z.number().int().nonnegative(),
    variant_results: z.array(PrototypeVariantVerificationItem).min(1),
    commands: z.array(VerificationCommandResult),
  })
  .strict()
  .superRefine((verification, ctx) => {
    if (
      verification.overall_status === 'passed' &&
      verification.captured_provider_evidence_count <
        verification.required_captured_provider_evidence_count
    ) {
      addPathIssue(
        ctx,
        ['captured_provider_evidence_count'],
        'passed variant verification requires at least two captured provider evidence records',
      );
    }
    if (verification.overall_status === 'passed' && verification.admitted_variant_count < 2) {
      addPathIssue(
        ctx,
        ['admitted_variant_count'],
        'passed variant verification requires at least two admitted variants',
      );
    }
  });
export type PrototypeVariantVerification = z.infer<typeof PrototypeVariantVerification>;

export const PrototypeVariantReviewVerdict = z.enum([
  'recommend',
  'no-clear-winner',
  'needs-operator',
]);
export type PrototypeVariantReviewVerdict = z.infer<typeof PrototypeVariantReviewVerdict>;

export const PrototypeVariantReview = z
  .object({
    verdict: PrototypeVariantReviewVerdict,
    recommended_variant_id: PrototypeVariantId,
    comparison_summary: z.string().min(1),
    strengths: z.array(
      z
        .object({
          variant_id: PrototypeVariantId,
          note: z.string().min(1),
        })
        .strict(),
    ),
    risks: StringArray,
    missing_evidence: StringArray,
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type PrototypeVariantReview = z.infer<typeof PrototypeVariantReview>;

export const PrototypeVariantChoiceOption = z
  .object({
    id: PrototypeVariantId,
    label: z.string().min(1),
    description: z.string().min(1),
    variant_id: PrototypeVariantId,
    variant_root: PrototypeRootPath,
    entry_points: z.array(PrototypeProjectRelativePath).min(1),
    verification_status: z.literal('passed'),
    model_evidence_status: z.literal('captured'),
    review_recommendation: z.boolean(),
    recommended: z.boolean(),
  })
  .strict()
  .superRefine((choice, ctx) => {
    if (choice.id !== choice.variant_id) {
      addPathIssue(
        ctx,
        ['id'],
        'choice id must match variant_id for V1 variant checkpoint choices',
      );
    }
  });
export type PrototypeVariantChoiceOption = z.infer<typeof PrototypeVariantChoiceOption>;

export const PrototypeVariantChoiceOptions = z
  .object({
    schema_version: z.literal(1),
    prompt: z.string().min(1),
    recommended_variant_id: PrototypeVariantId,
    choices: z.array(PrototypeVariantChoiceOption).min(2),
  })
  .strict()
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    let recommendedCount = 0;
    for (const [index, choice] of options.choices.entries()) {
      if (seen.has(choice.id)) {
        addPathIssue(ctx, ['choices', index, 'id'], `duplicate choice id '${choice.id}'`);
      }
      seen.add(choice.id);
      if (choice.recommended) recommendedCount += 1;
    }
    if (!seen.has(options.recommended_variant_id)) {
      addPathIssue(
        ctx,
        ['recommended_variant_id'],
        `recommended_variant_id '${options.recommended_variant_id}' must be present in choices`,
      );
    }
    if (recommendedCount !== 1) {
      addPathIssue(ctx, ['choices'], 'exactly one variant choice must be recommended');
    }
  });
export type PrototypeVariantChoiceOptions = z.infer<typeof PrototypeVariantChoiceOptions>;

export const PrototypeVerificationCommand = VerificationCommand;
export type PrototypeVerificationCommand = z.infer<typeof PrototypeVerificationCommand>;

export const PrototypeVerificationCommandResult = VerificationCommandResult;
export type PrototypeVerificationCommandResult = z.infer<typeof PrototypeVerificationCommandResult>;

export const PrototypeVerification = VerificationResult;
export type PrototypeVerification = z.infer<typeof PrototypeVerification>;

export const PrototypeResultReportId = z.enum([
  'prototype.brief',
  'prototype.plan',
  'prototype.artifact',
  'prototype.verification',
  'prototype.variant-options',
  'prototype.variant-aggregate',
  'prototype.variant-provider-evidence',
  'prototype.variant-verification',
  'prototype.variant-review',
  'prototype.variant-choice-options',
  'prototype.checkpoint.request',
  'prototype.checkpoint.response',
]);
export type PrototypeResultReportId = z.infer<typeof PrototypeResultReportId>;

export const PrototypeResultReportPointer = resultReportPointer(
  PrototypeResultReportId,
  PROTOTYPE_RESULT_SCHEMA_BY_REPORT_ID,
);
export type PrototypeResultReportPointer = z.infer<typeof PrototypeResultReportPointer>;

const PrototypeResultBase = z.object({
  summary: z.string().min(1),
  outcome: z.enum(['kept', 'build_input_saved', 'discarded', 'needs_attention', 'failed']),
  artifact_status: z.enum(['accepted', 'blocked']),
  verification_status: z.enum(['passed', 'failed', 'blocked']),
  checkpoint_status: z.enum(['not_reached', 'auto_resolved', 'operator_selected']),
  prototype_root: PrototypeRootPath,
  entry_points: z.array(PrototypeProjectRelativePath),
  preview_instructions: z.string().min(1),
  residual_risks: StringArray,
  next_step: z.string().min(1),
  claim_limits: NonEmptyStringArray,
  evidence_links: z.array(PrototypeResultReportPointer).min(3),
});

export const PrototypeSingleArtifactResult = PrototypeResultBase.extend({
  mode: z.literal('single-artifact').default('single-artifact'),
  checkpoint_selection: PrototypeCheckpointSelectionOrMissing,
  build_followup_prompt: z.string().min(1).optional(),
})
  .strict()
  .superRefine((result, ctx) => {
    validatePathsUnderRoot({
      ctx,
      root: result.prototype_root,
      values: result.entry_points,
      path: ['entry_points'],
    });
    validatePrototypeClaimLimits(result.claim_limits, ctx, ['claim_limits']);
    const seen = new Set<PrototypeResultReportId>();
    for (const [index, pointer] of result.evidence_links.entries()) {
      if (seen.has(pointer.report_id)) {
        addPathIssue(
          ctx,
          ['evidence_links', index, 'report_id'],
          `duplicate report_id '${pointer.report_id}'`,
        );
      }
      seen.add(pointer.report_id);
    }
    if (result.checkpoint_status === 'not_reached') {
      if (result.checkpoint_selection !== 'not_reached') {
        addPathIssue(
          ctx,
          ['checkpoint_selection'],
          "checkpoint_selection must be 'not_reached' when checkpoint_status is 'not_reached'",
        );
      }
    } else if (result.checkpoint_selection === 'not_reached') {
      addPathIssue(
        ctx,
        ['checkpoint_selection'],
        'checkpoint_selection must name the checkpoint choice when checkpoint_status is reached',
      );
    }
    if (result.outcome === 'build_input_saved' && result.build_followup_prompt === undefined) {
      addPathIssue(
        ctx,
        ['build_followup_prompt'],
        "build_followup_prompt is required when outcome is 'build_input_saved'",
      );
    }
    if (['kept', 'build_input_saved', 'discarded'].includes(result.outcome)) {
      if (result.artifact_status !== 'accepted') {
        addPathIssue(
          ctx,
          ['artifact_status'],
          `artifact_status must be 'accepted' when outcome is '${result.outcome}'`,
        );
      }
      if (result.verification_status !== 'passed') {
        addPathIssue(
          ctx,
          ['verification_status'],
          `verification_status must be 'passed' when outcome is '${result.outcome}'`,
        );
      }
      if (result.checkpoint_status === 'not_reached') {
        addPathIssue(
          ctx,
          ['checkpoint_status'],
          `checkpoint_status must be reached when outcome is '${result.outcome}'`,
        );
      }
    }
  });
export type PrototypeSingleArtifactResult = z.infer<typeof PrototypeSingleArtifactResult>;

export const PrototypeModelComparisonResult = PrototypeResultBase.extend({
  mode: z.literal('model-comparison'),
  checkpoint_selection: z.union([PrototypeVariantId, z.literal('not_reached')]),
  variant_count: z.number().int().min(2).max(4),
  admitted_variant_count: z.number().int().nonnegative(),
  captured_provider_evidence_count: z.number().int().nonnegative(),
  model_evidence_status: z.enum(['captured', 'missing']),
  recommended_variant_id: PrototypeVariantId.optional(),
  selected_variant_id: PrototypeVariantId.optional(),
  selected_variant_label: z.string().min(1).optional(),
  selected_variant_root: PrototypeRootPath.optional(),
  comparison_summary: z.string().min(1).optional(),
})
  .strict()
  .superRefine((result, ctx) => {
    validatePathsUnderRoot({
      ctx,
      root: result.prototype_root,
      values: result.entry_points,
      path: ['entry_points'],
    });
    validatePrototypeClaimLimits(result.claim_limits, ctx, ['claim_limits']);
    const seen = new Set<PrototypeResultReportId>();
    for (const [index, pointer] of result.evidence_links.entries()) {
      if (seen.has(pointer.report_id)) {
        addPathIssue(
          ctx,
          ['evidence_links', index, 'report_id'],
          `duplicate report_id '${pointer.report_id}'`,
        );
      }
      seen.add(pointer.report_id);
    }
    if (result.checkpoint_status === 'not_reached') {
      if (result.checkpoint_selection !== 'not_reached') {
        addPathIssue(
          ctx,
          ['checkpoint_selection'],
          "checkpoint_selection must be 'not_reached' when checkpoint_status is 'not_reached'",
        );
      }
      if (result.selected_variant_id !== undefined) {
        addPathIssue(
          ctx,
          ['selected_variant_id'],
          'selected_variant_id must be absent when checkpoint_status is not_reached',
        );
      }
    } else {
      if (result.checkpoint_selection === 'not_reached') {
        addPathIssue(
          ctx,
          ['checkpoint_selection'],
          'checkpoint_selection must name the selected variant when checkpoint_status is reached',
        );
      }
      if (result.selected_variant_id === undefined) {
        addPathIssue(
          ctx,
          ['selected_variant_id'],
          'selected_variant_id is required when checkpoint_status is reached',
        );
      } else if (result.selected_variant_id !== result.checkpoint_selection) {
        addPathIssue(
          ctx,
          ['selected_variant_id'],
          'selected_variant_id must match checkpoint_selection',
        );
      }
    }
    if (result.outcome === 'kept') {
      if (result.artifact_status !== 'accepted') {
        addPathIssue(ctx, ['artifact_status'], "artifact_status must be 'accepted' when kept");
      }
      if (result.verification_status !== 'passed') {
        addPathIssue(
          ctx,
          ['verification_status'],
          "verification_status must be 'passed' when kept",
        );
      }
      if (result.checkpoint_status === 'not_reached') {
        addPathIssue(ctx, ['checkpoint_status'], 'checkpoint_status must be reached when kept');
      }
      if (result.selected_variant_label === undefined) {
        addPathIssue(
          ctx,
          ['selected_variant_label'],
          'selected_variant_label is required when kept',
        );
      }
      if (result.selected_variant_root === undefined) {
        addPathIssue(ctx, ['selected_variant_root'], 'selected_variant_root is required when kept');
      }
      if (result.model_evidence_status !== 'captured') {
        addPathIssue(ctx, ['model_evidence_status'], "model_evidence_status must be 'captured'");
      }
      if (result.comparison_summary === undefined) {
        addPathIssue(ctx, ['comparison_summary'], 'comparison_summary is required when kept');
      }
    }
    if (
      (result.outcome === 'build_input_saved' || result.outcome === 'discarded') &&
      result.mode === 'model-comparison'
    ) {
      addPathIssue(
        ctx,
        ['outcome'],
        "model-comparison V1 only closes with 'kept' or 'needs_attention'",
      );
    }
  });
export type PrototypeModelComparisonResult = z.infer<typeof PrototypeModelComparisonResult>;

export const PrototypeResult = z.union([
  PrototypeSingleArtifactResult,
  PrototypeModelComparisonResult,
]);
export type PrototypeResult = z.infer<typeof PrototypeResult>;

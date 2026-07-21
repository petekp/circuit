import { z } from 'zod';

export const MCP_SCHEMA_VERSION = 1 as const;

export const MCP_TOOL_NAMES = [
  'circuit_start',
  'circuit_status',
  'circuit_resume',
  'circuit_cancel',
  'circuit_list',
  'circuit_recover',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const McpPublicFlowV1 = z.enum(['review', 'fix', 'build', 'explore', 'prototype']);
export type McpPublicFlowV1 = z.infer<typeof McpPublicFlowV1>;

export const McpRunStateV1 = z.enum([
  'starting',
  'running',
  'waiting_for_input',
  'resuming',
  'cancelling',
  'complete',
  'needs_attention',
  'cancelled',
  'interrupted',
  'recovery_required',
]);
export type McpRunStateV1 = z.infer<typeof McpRunStateV1>;

const RunIdV1 = z.guid({ error: 'run_id must be a UUID' });
const CursorV1 = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SummaryV1 = z.string().trim().min(1).max(1_000);
const GoalV1 = z.string().trim().min(1).max(8_000);
const WhyV1 = z.string().trim().min(1).max(2_000);
const ChoiceIdV1 = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'choice_id must be a safe lowercase identifier');
const CheckpointTokenV1 = z.string().min(16).max(1_024);
const SafeNameV1 = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/, 'must be a bounded name, not a command');

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', path, message });
}

const McpStartConsentV1 = z
  .object({
    cached_web_search: z.literal(true).optional(),
    untracked_review_content: z.literal(true).optional(),
  })
  .strict();

const McpPrototypeVariantV1 = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'variant id must be a safe kebab-case slug'),
    label: z.string().trim().min(1).max(80),
    // The server must also check this name against the live Codex model roster.
    model: SafeNameV1,
    effort: z.enum(['low', 'medium', 'high', 'xhigh']),
  })
  .strict();

const McpPrototypeVariantsV1 = z
  .array(McpPrototypeVariantV1)
  .min(2)
  .max(4)
  .superRefine((variants, ctx) => {
    const ids = new Set<string>();
    for (const [index, variant] of variants.entries()) {
      if (ids.has(variant.id)) {
        addIssue(ctx, [index, 'id'], `duplicate variant id '${variant.id}'`);
      }
      ids.add(variant.id);
    }
  });

export const CircuitStartInputV1 = z
  .object({
    flow: McpPublicFlowV1,
    goal: GoalV1,
    why: WhyV1.optional(),
    power: z.enum(['auto', 'low', 'medium', 'high']).optional(),
    process: z.enum(['low', 'medium', 'high']).optional(),
    tournament: z.number().int().min(2).max(4).optional(),
    autonomous: z.boolean().optional(),
    include_untracked_content: z.boolean().optional(),
    variants: McpPrototypeVariantsV1.optional(),
    consent: McpStartConsentV1.optional(),
    web_search: z.enum(['off', 'cached']).default('off'),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.web_search === 'cached' && input.consent?.cached_web_search !== true) {
      addIssue(
        ctx,
        ['consent', 'cached_web_search'],
        'cached web search requires explicit consent because the query leaves the machine',
      );
    }
    if (input.consent?.cached_web_search === true && input.web_search !== 'cached') {
      addIssue(ctx, ['consent', 'cached_web_search'], 'cached web search consent is unused');
    }

    if (input.include_untracked_content === true) {
      if (input.flow !== 'review') {
        addIssue(
          ctx,
          ['include_untracked_content'],
          'untracked content can be included only in Review',
        );
      }
      if (input.consent?.untracked_review_content !== true) {
        addIssue(
          ctx,
          ['consent', 'untracked_review_content'],
          'including untracked Review contents requires explicit consent',
        );
      }
    }
    if (
      input.consent?.untracked_review_content === true &&
      input.include_untracked_content !== true
    ) {
      addIssue(
        ctx,
        ['consent', 'untracked_review_content'],
        'untracked Review content consent is unused',
      );
    }

    if (input.tournament !== undefined && input.flow !== 'explore' && input.flow !== 'prototype') {
      addIssue(ctx, ['tournament'], 'tournament is supported only by Explore and Prototype');
    }
    if (input.tournament !== undefined && input.autonomous === true) {
      addIssue(ctx, ['autonomous'], 'tournament and autonomous cannot be combined');
    }

    if (input.flow === 'prototype' && input.tournament !== undefined) {
      if (input.variants === undefined) {
        addIssue(ctx, ['variants'], 'Prototype tournament requires one variant per branch');
      } else if (input.variants.length !== input.tournament) {
        addIssue(
          ctx,
          ['variants'],
          `Prototype tournament requires exactly ${input.tournament} variants`,
        );
      }
    } else if (input.variants !== undefined) {
      addIssue(ctx, ['variants'], 'variants are allowed only for a Prototype tournament');
    }
  });
export type CircuitStartInputV1 = z.infer<typeof CircuitStartInputV1>;

export const CircuitStatusInputV1 = z
  .object({
    run_id: RunIdV1,
    after_cursor: CursorV1.optional(),
    max_events: z.number().int().min(1).max(100).optional(),
    wait_ms: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type CircuitStatusInputV1 = z.infer<typeof CircuitStatusInputV1>;

export const CircuitResumeInputV1 = z
  .object({
    run_id: RunIdV1,
    checkpoint_token: CheckpointTokenV1,
    choice_id: ChoiceIdV1,
  })
  .strict();
export type CircuitResumeInputV1 = z.infer<typeof CircuitResumeInputV1>;

export const CircuitCancelInputV1 = z.object({ run_id: RunIdV1 }).strict();
export type CircuitCancelInputV1 = z.infer<typeof CircuitCancelInputV1>;

export const CircuitListInputV1 = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type CircuitListInputV1 = z.infer<typeof CircuitListInputV1>;

export const CircuitRecoverInputV1 = z.object({ run_id: RunIdV1 }).strict();
export type CircuitRecoverInputV1 = z.infer<typeof CircuitRecoverInputV1>;

export const MCP_TOOL_INPUT_SCHEMAS = {
  circuit_start: CircuitStartInputV1,
  circuit_status: CircuitStatusInputV1,
  circuit_resume: CircuitResumeInputV1,
  circuit_cancel: CircuitCancelInputV1,
  circuit_list: CircuitListInputV1,
  circuit_recover: CircuitRecoverInputV1,
} as const satisfies Record<McpToolName, z.ZodType>;

const McpErrorV1 = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'error code must be stable lowercase snake case'),
    message: z.string().trim().min(1).max(1_000),
    next_action: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const McpErrorResponseV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(false),
    error: McpErrorV1,
  })
  .strict();
export type McpErrorResponseV1 = z.infer<typeof McpErrorResponseV1>;

const McpProgressEventV1 = z
  .object({
    cursor: CursorV1,
    kind: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9._-]*$/, 'event kind must be a stable lowercase identifier'),
    recorded_at: z.iso.datetime(),
    summary: SummaryV1,
  })
  .strict();

const McpCheckpointChoiceV1 = z
  .object({
    id: ChoiceIdV1,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const McpCheckpointV1 = z
  .object({
    token: CheckpointTokenV1,
    prompt: z.string().trim().min(1).max(4_000),
    choices: z.array(McpCheckpointChoiceV1).min(1).max(20),
  })
  .strict();

function isJsonValue(value: unknown, seen: Set<object>, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) => isJsonValue(item, seen, depth + 1));
  } finally {
    seen.delete(value);
  }
}

const BoundedReportDataV1 = z.unknown().superRefine((value, ctx) => {
  if (!isJsonValue(value, new Set<object>(), 0)) {
    addIssue(ctx, [], 'final report data must be plain JSON');
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > 262_144) {
    addIssue(ctx, [], 'final report data must not exceed 262144 UTF-8 bytes');
  }
});

const McpFinalReportV1 = z
  .object({
    schema: SafeNameV1,
    summary: SummaryV1,
    data: BoundedReportDataV1,
  })
  .strict();

export const CircuitStartSuccessV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(true),
    run_id: RunIdV1,
    state: z.enum(['starting', 'running']),
    next_cursor: CursorV1,
    summary: SummaryV1,
  })
  .strict();
export type CircuitStartSuccessV1 = z.infer<typeof CircuitStartSuccessV1>;
export const CircuitStartResponseV1 = z.discriminatedUnion('ok', [
  CircuitStartSuccessV1,
  McpErrorResponseV1,
]);
export type CircuitStartResponseV1 = z.infer<typeof CircuitStartResponseV1>;

export const CircuitStatusSuccessV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(true),
    run_id: RunIdV1,
    state: McpRunStateV1,
    events: z.array(McpProgressEventV1).max(100),
    next_cursor: CursorV1,
    truncated: z.boolean(),
    checkpoint: McpCheckpointV1.optional(),
    final_report: McpFinalReportV1.optional(),
    summary: SummaryV1,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.state === 'waiting_for_input' && result.checkpoint === undefined) {
      addIssue(ctx, ['checkpoint'], 'waiting_for_input requires checkpoint data');
    }
    if (result.state !== 'waiting_for_input' && result.checkpoint !== undefined) {
      addIssue(ctx, ['checkpoint'], 'checkpoint data is allowed only while waiting for input');
    }
    if (result.state === 'complete' && result.final_report === undefined) {
      addIssue(ctx, ['final_report'], 'a complete run requires final report data');
    }
  });
export type CircuitStatusSuccessV1 = z.infer<typeof CircuitStatusSuccessV1>;
export const CircuitStatusResponseV1 = z.union([CircuitStatusSuccessV1, McpErrorResponseV1]);
export type CircuitStatusResponseV1 = z.infer<typeof CircuitStatusResponseV1>;

export const CircuitResumeSuccessV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(true),
    run_id: RunIdV1,
    state: z.enum(['resuming', 'running']),
    next_cursor: CursorV1,
    summary: SummaryV1,
  })
  .strict();
export type CircuitResumeSuccessV1 = z.infer<typeof CircuitResumeSuccessV1>;
export const CircuitResumeResponseV1 = z.discriminatedUnion('ok', [
  CircuitResumeSuccessV1,
  McpErrorResponseV1,
]);
export type CircuitResumeResponseV1 = z.infer<typeof CircuitResumeResponseV1>;

export const CircuitCancelSuccessV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(true),
    run_id: RunIdV1,
    state: z.enum(['cancelled', 'recovery_required']),
    cleanup_confirmed: z.boolean(),
    summary: SummaryV1,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.state === 'cancelled' && !result.cleanup_confirmed) {
      addIssue(ctx, ['cleanup_confirmed'], 'cancelled requires confirmed cleanup');
    }
    if (result.state === 'recovery_required' && result.cleanup_confirmed) {
      addIssue(ctx, ['cleanup_confirmed'], 'recovery_required means cleanup is not confirmed');
    }
  });
export type CircuitCancelSuccessV1 = z.infer<typeof CircuitCancelSuccessV1>;
export const CircuitCancelResponseV1 = z.union([CircuitCancelSuccessV1, McpErrorResponseV1]);
export type CircuitCancelResponseV1 = z.infer<typeof CircuitCancelResponseV1>;

const McpRunListItemV1 = z
  .object({
    run_id: RunIdV1,
    flow: McpPublicFlowV1,
    state: McpRunStateV1,
    updated_at: z.iso.datetime(),
    checkpoint_available: z.boolean(),
    summary: SummaryV1,
  })
  .strict();

export const CircuitListSuccessV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(true),
    runs: z.array(McpRunListItemV1).max(50),
    truncated: z.boolean(),
    summary: SummaryV1,
  })
  .strict();
export type CircuitListSuccessV1 = z.infer<typeof CircuitListSuccessV1>;
export const CircuitListResponseV1 = z.discriminatedUnion('ok', [
  CircuitListSuccessV1,
  McpErrorResponseV1,
]);
export type CircuitListResponseV1 = z.infer<typeof CircuitListResponseV1>;

export const CircuitRecoverSuccessV1 = z
  .object({
    schema_version: z.literal(MCP_SCHEMA_VERSION),
    ok: z.literal(true),
    run_id: RunIdV1,
    state: z.enum(['interrupted', 'cancelled']),
    recovered: z.literal(true),
    cleanup_confirmed: z.literal(true),
    lease_released: z.literal(true),
    summary: SummaryV1,
  })
  .strict();
export type CircuitRecoverSuccessV1 = z.infer<typeof CircuitRecoverSuccessV1>;
export const CircuitRecoverResponseV1 = z.discriminatedUnion('ok', [
  CircuitRecoverSuccessV1,
  McpErrorResponseV1,
]);
export type CircuitRecoverResponseV1 = z.infer<typeof CircuitRecoverResponseV1>;

export const MCP_TOOL_RESPONSE_SCHEMAS = {
  circuit_start: CircuitStartResponseV1,
  circuit_status: CircuitStatusResponseV1,
  circuit_resume: CircuitResumeResponseV1,
  circuit_cancel: CircuitCancelResponseV1,
  circuit_list: CircuitListResponseV1,
  circuit_recover: CircuitRecoverResponseV1,
} as const satisfies Record<McpToolName, z.ZodType>;

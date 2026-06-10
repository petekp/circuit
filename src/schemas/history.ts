import { z } from 'zod';
import { MemoryInputKind, MemoryInputV0, MemoryStalenessStatus } from './memory-input.js';
import { Ref, Sha256 } from './ref.js';
import { RunEnvelopeOutcome } from './run-envelope.js';

export const HISTORY_AUTHORITY_NOTICE =
  'History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.';

export const HistoryWarningCodeV1 = z.enum([
  'run_skipped',
  'report_skipped',
  'trace_skipped',
  'source_unreadable',
  'source_invalid',
  'source_pruned',
  'envelope_missing',
  'recall_report_missing',
  'memory_input_unmatched',
  'content_id_unhashed_source',
  'effect_report_unavailable',
  'pull_log_unavailable',
]);
export type HistoryWarningCodeV1 = z.infer<typeof HistoryWarningCodeV1>;

export const HistoryWarningV1 = z
  .object({
    code: HistoryWarningCodeV1,
    message: z.string().min(1),
    run_folder: z.string().min(1).optional(),
    source_path: z.string().min(1).optional(),
  })
  .strict();
export type HistoryWarningV1 = z.infer<typeof HistoryWarningV1>;

export const HistoryManifestV1 = z
  .object({
    api_version: z.literal('history-index-v1'),
    schema_version: z.literal(1),
    created_at: z.iso.datetime(),
    repo_root: z.string().min(1),
    runs_base: z.string().min(1),
    index_dir: z.string().min(1),
    documents_path: z.literal('documents.v1.jsonl'),
    run_count: z.number().int().nonnegative(),
    document_count: z.number().int().nonnegative(),
    source_fingerprint: z
      .object({
        run_folder_names_sha256: Sha256,
        latest_source_mtime_ms: z.number().int().nonnegative(),
      })
      .strict(),
    warnings: z.array(HistoryWarningV1),
  })
  .strict();
export type HistoryManifestV1 = z.infer<typeof HistoryManifestV1>;

export const HistoryDocumentKindV1 = z.enum(['run', 'report', 'trace', 'checkpoint']);
export type HistoryDocumentKindV1 = z.infer<typeof HistoryDocumentKindV1>;

export const HistoryDocumentV1 = z
  .object({
    api_version: z.literal('history-document-v1'),
    schema_version: z.literal(1),
    doc_id: z.string().min(1),
    doc_kind: HistoryDocumentKindV1,
    run_id: z.string().min(1),
    flow_id: z.string().min(1).optional(),
    run_folder: z.string().min(1),
    source_path: z.string().min(1),
    source_ref: Ref,
    source_sha256: Sha256.optional(),
    source_mtime_ms: z.number().int().nonnegative().optional(),
    report_schema: z.string().min(1).optional(),
    step_id: z.string().min(1).optional(),
    attempt: z.number().int().positive().optional(),
    sequence: z.number().int().nonnegative().optional(),
    recorded_at: z.iso.datetime().optional(),
    outcome: z.string().min(1).optional(),
    title: z.string().min(1),
    summary: z.string().min(1),
    text: z.string(),
    extracted_from: z.array(
      z
        .object({
          json_pointer: z.string().min(1).optional(),
          field_role: z.string().min(1),
        })
        .strict(),
    ),
    facets: z.array(z.string().min(1)),
    memory_safe: z.boolean(),
  })
  .strict();
export type HistoryDocumentV1 = z.infer<typeof HistoryDocumentV1>;

export const HistoryStalenessV1 = z
  .object({
    status: z.enum(['fresh', 'stale', 'unknown']),
    reason_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
    checked_at: z.iso.datetime(),
  })
  .strict()
  .superRefine((staleness, ctx) => {
    if (staleness.status === 'unknown' && !staleness.reason_codes.includes('memory_unverified')) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason_codes'],
        message: 'unknown history staleness requires memory_unverified reason code',
      });
    }
    if (staleness.status === 'stale' && !staleness.reason_codes.includes('memory_stale')) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason_codes'],
        message: 'stale history staleness requires memory_stale reason code',
      });
    }
  });
export type HistoryStalenessV1 = z.infer<typeof HistoryStalenessV1>;

export const HistoryQueryHitV1 = z
  .object({
    rank: z.number().int().positive(),
    score: z.number(),
    doc: HistoryDocumentV1,
    snippet: z.string(),
    matched_terms: z.array(z.string().min(1)),
    ranking_reasons: z.array(z.string().min(1)),
    staleness: HistoryStalenessV1,
  })
  .strict();
export type HistoryQueryHitV1 = z.infer<typeof HistoryQueryHitV1>;

export const HistoryQueryResultV1 = z
  .object({
    api_version: z.literal('history-query-result-v1'),
    schema_version: z.literal(1),
    query: z.string(),
    format: z.literal('json'),
    index_state: z.enum(['fresh', 'possibly_stale']),
    rebuilt: z.boolean(),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    warnings: z.array(HistoryWarningV1),
    results: z.array(HistoryQueryHitV1),
  })
  .strict();
export type HistoryQueryResultV1 = z.infer<typeof HistoryQueryResultV1>;

export const HistoryMemoryInputMatchV1 = z
  .object({
    memory_id: z.string().min(1),
    rank: z.number().int().positive(),
    score: z.number(),
    source_doc_id: z.string().min(1),
    source_ref: Ref,
    snippet: z.string(),
  })
  .strict();
export type HistoryMemoryInputMatchV1 = z.infer<typeof HistoryMemoryInputMatchV1>;

export const HistoryMemoryInputPreviewV1 = z
  .object({
    api_version: z.literal('history-memory-input-preview-v1'),
    schema_version: z.literal(1),
    query: z.string(),
    format: z.literal('memory-input'),
    index_state: z.enum(['fresh', 'possibly_stale']),
    rebuilt: z.boolean(),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    warnings: z.array(HistoryWarningV1),
    memory_inputs: z.array(MemoryInputV0),
    matches: z.array(HistoryMemoryInputMatchV1),
  })
  .strict();
export type HistoryMemoryInputPreviewV1 = z.infer<typeof HistoryMemoryInputPreviewV1>;

export const HistoryRecallStatusV1 = z.enum(['used', 'empty', 'unavailable']);
export type HistoryRecallStatusV1 = z.infer<typeof HistoryRecallStatusV1>;

export const HistoryRecallReportV1 = z
  .object({
    api_version: z.literal('history-recall-report-v1'),
    schema_version: z.literal(1),
    status: HistoryRecallStatusV1,
    query: z.string(),
    index_state: z.enum(['fresh', 'possibly_stale']).optional(),
    rebuilt: z.boolean(),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    memory_input_count: z.number().int().nonnegative(),
    memory_inputs: z.array(MemoryInputV0),
    matches: z.array(HistoryMemoryInputMatchV1),
    warnings: z.array(HistoryWarningV1),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.memory_input_count !== report.memory_inputs.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['memory_input_count'],
        message: 'memory_input_count must equal memory_inputs.length',
      });
    }
    if (report.status === 'used' && report.memory_inputs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: "status 'used' requires at least one memory input",
      });
    }
    if (report.status !== 'used' && report.memory_inputs.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['memory_inputs'],
        message: "only status 'used' may include memory inputs",
      });
    }
    if (report.status === 'unavailable' && report.index_state !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['index_state'],
        message: "status 'unavailable' must not claim an index_state",
      });
    }
  });
export type HistoryRecallReportV1 = z.infer<typeof HistoryRecallReportV1>;

export const HistoryStatusV1 = z
  .object({
    api_version: z.literal('history-status-v1'),
    schema_version: z.literal(1),
    index_exists: z.boolean(),
    index_state: z.enum(['fresh', 'possibly_stale', 'missing', 'corrupt', 'unsupported']),
    runs_base: z.string().min(1),
    index_dir: z.string().min(1),
    manifest: HistoryManifestV1.optional(),
    warnings: z.array(HistoryWarningV1),
  })
  .strict();
export type HistoryStatusV1 = z.infer<typeof HistoryStatusV1>;

export const HistoryErrorCodeV1 = z.enum([
  'invalid_invocation',
  'runs_base_not_found',
  'runs_base_unreadable',
  'index_missing',
  'index_unsupported',
  'index_corrupt',
  'source_unreadable',
  'internal_error',
]);
export type HistoryErrorCodeV1 = z.infer<typeof HistoryErrorCodeV1>;

export const HistoryErrorV1 = z
  .object({
    api_version: z.literal('history-error-v1'),
    schema_version: z.literal(1),
    error: z
      .object({
        code: HistoryErrorCodeV1,
        message: z.string().min(1),
      })
      .strict(),
    runs_base: z.string().min(1).optional(),
    index_dir: z.string().min(1).optional(),
  })
  .strict();
export type HistoryErrorV1 = z.infer<typeof HistoryErrorV1>;

// --- Self-auditing memory, Slice 1: the report-only memory-merge artifact ---
// See docs/ideas/self-auditing-memory-slice-1-spec.md. This is report-only and
// behavior-neutral: it links the memory each run used to that run's objective
// outcome. No judgment is rendered here; effect_status stays 'not_enough_data'
// until Slice 2's cross-run aggregation can populate the other states.

export const MemoryMergeEffectStatusV1 = z.enum([
  'not_enough_data',
  'correlated_positive',
  'correlated_negative',
  'unresolved',
]);
export type MemoryMergeEffectStatusV1 = z.infer<typeof MemoryMergeEffectStatusV1>;

// One memory input as used by one run. content_id is the content-addressed,
// run-independent identity (sha over the cited source ref, excluding any
// run/flow/step scoping). It is null whenever the source cannot be
// content-addressed: the recall report was missing or unreadable, the id was
// absent from it, or the cited source carries no content hash.
export const MemoryMergeInputV1 = z
  .object({
    memory_input_id: z.string().min(1),
    content_id: z.string().min(1).nullable(),
    kind: MemoryInputKind.optional(),
    source_ref: Ref.optional(),
    staleness: MemoryStalenessStatus.optional(),
    resolved_from_recall: z.boolean(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.resolved_from_recall && input.content_id !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content_id'],
        message: 'content_id requires the input to be resolved from the recall report',
      });
    }
  });
export type MemoryMergeInputV1 = z.infer<typeof MemoryMergeInputV1>;

// One row per run that wrote a full run.envelope@v0 record.
export const MemoryMergeRunLinkageV1 = z
  .object({
    run_id: z.string().min(1),
    flow_id: z.string().min(1).optional(),
    operator_intent: z.string().min(1),
    outcome: RunEnvelopeOutcome,
    abort_reason: z.string().min(1).optional(),
    memory_used: z.boolean(),
    memory_inputs: z.array(MemoryMergeInputV1),
  })
  .strict()
  .superRefine((linkage, ctx) => {
    if (!linkage.memory_used && linkage.memory_inputs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memory_inputs'],
        message: 'a run that did not use memory must not list memory inputs',
      });
    }
  });
export type MemoryMergeRunLinkageV1 = z.infer<typeof MemoryMergeRunLinkageV1>;

export const MemoryMergeOutcomeCountV1 = z
  .object({
    outcome: RunEnvelopeOutcome,
    count: z.number().int().positive(),
  })
  .strict();
export type MemoryMergeOutcomeCountV1 = z.infer<typeof MemoryMergeOutcomeCountV1>;

// One row per content-addressed memory item, grouped across every run that used
// it. This is the structure Slice 2 aggregates over. kind/source_ref are a
// representative citation from one member (deterministically the lowest run_id),
// so source_ref may carry that member's run scoping even though the item spans
// runs; the cross-run identity is content_id, not source_ref.
export const MemoryMergeItemV1 = z
  .object({
    group_key: z.string().min(1),
    content_id: z.string().min(1).nullable(),
    memory_input_ids: z.array(z.string().min(1)).min(1),
    kind: MemoryInputKind.optional(),
    source_ref: Ref.optional(),
    used_by_run_ids: z.array(z.string().min(1)).min(1),
    outcome_counts: z.array(MemoryMergeOutcomeCountV1).min(1),
    effect_status: MemoryMergeEffectStatusV1,
    effect_note: z.string().min(1),
  })
  .strict()
  .superRefine((item, ctx) => {
    const total = item.outcome_counts.reduce((sum, entry) => sum + entry.count, 0);
    if (total !== item.used_by_run_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome_counts'],
        message: 'outcome_counts must sum to the number of runs that used the item',
      });
    }
  });
export type MemoryMergeItemV1 = z.infer<typeof MemoryMergeItemV1>;

export const HistoryMemoryMergeV1 = z
  .object({
    api_version: z.literal('history-memory-merge-v1'),
    schema_version: z.literal(1),
    generated_at: z.iso.datetime(),
    runs_base: z.string().min(1),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    run_count: z.number().int().nonnegative(),
    envelope_count: z.number().int().nonnegative(),
    memory_run_count: z.number().int().nonnegative(),
    linkages: z.array(MemoryMergeRunLinkageV1),
    memory_items: z.array(MemoryMergeItemV1),
    warnings: z.array(HistoryWarningV1),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.envelope_count !== report.linkages.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['envelope_count'],
        message: 'envelope_count must equal linkages.length',
      });
    }
    const memoryRuns = report.linkages.filter((linkage) => linkage.memory_used).length;
    if (report.memory_run_count !== memoryRuns) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memory_run_count'],
        message: 'memory_run_count must equal the number of linkages that used memory',
      });
    }
    if (report.run_count < report.envelope_count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['run_count'],
        message: 'run_count must be at least envelope_count',
      });
    }
  });
export type HistoryMemoryMergeV1 = z.infer<typeof HistoryMemoryMergeV1>;

// --- Self-auditing memory, Slice 2: the cross-run effect-aggregation report ---
// See docs/ideas/self-auditing-memory-slice-2-spec.md. This is still report-only
// and behavior-neutral: it aggregates the Slice 1 linkages into per-item and
// per-flow effect estimates and moves the frozen MemoryMergeEffectStatusV1 off
// its Slice 1 floor (not_enough_data) only when the comparable-run evidence
// honestly supports it (both arms reach the sample floor and the separation
// clears the margin). It renders verdicts; it does not act on them (that is
// Slice 3). The schema's job stays "is this well-formed"; the aggregator owns
// "is this verdict earned" (asserted by the unit test, not a schema refine).

// One side of a comparison (the "used this item" / "memory on" arm, or its
// comparable counterpart). Rates are exact count/size rationals; the refines
// pin counts, outcome_counts, and run_ids to size so a rate can never drift
// from its counts. An empty arm (size 0) carries empty arrays and rate 0.
export const MemoryEffectArmV1 = z
  .object({
    run_ids: z.array(z.string().min(1)),
    size: z.number().int().nonnegative(),
    complete_count: z.number().int().nonnegative(),
    adverse_count: z.number().int().nonnegative(),
    neutral_count: z.number().int().nonnegative(),
    outcome_counts: z.array(MemoryMergeOutcomeCountV1),
    complete_rate: z.number().min(0).max(1),
    adverse_rate: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((arm, ctx) => {
    if (arm.complete_count + arm.adverse_count + arm.neutral_count !== arm.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['size'],
        message: 'complete + adverse + neutral counts must equal size',
      });
    }
    const outcomeTotal = arm.outcome_counts.reduce((sum, entry) => sum + entry.count, 0);
    if (outcomeTotal !== arm.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome_counts'],
        message: 'outcome_counts must sum to size',
      });
    }
    if (arm.run_ids.length !== arm.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['run_ids'],
        message: 'run_ids length must equal size',
      });
    }
  });
export type MemoryEffectArmV1 = z.infer<typeof MemoryEffectArmV1>;

// A used-arm-versus-comparable-arm comparison. complete_rate_delta and
// adverse_rate_delta are kept as separate raw fields (no composite score, which
// would invent fake precision). effect_status is populated by the D5 verdict
// rule; effect_note names the gate that fired.
export const MemoryEffectComparisonV1 = z
  .object({
    used_arm: MemoryEffectArmV1,
    comparable_arm: MemoryEffectArmV1,
    complete_rate_delta: z.number(),
    adverse_rate_delta: z.number(),
    effect_status: MemoryMergeEffectStatusV1,
    effect_note: z.string().min(1),
  })
  .strict();
export type MemoryEffectComparisonV1 = z.infer<typeof MemoryEffectComparisonV1>;

// One row per (group_key, flow_id) cohort. The cohort is keyed on the Slice 1
// group_key (content_id, or unresolved:<memory_input_id>) paired with flow_id,
// so the same content item used across two flows yields two rows — preserving
// the same-flow comparability the whole thesis rests on.
export const MemoryEffectItemV1 = z
  .object({
    content_id: z.string().min(1).nullable(),
    group_key: z.string().min(1),
    flow_id: z.string().min(1),
    kind: MemoryInputKind.optional(),
    source_ref: Ref.optional(),
    comparison: MemoryEffectComparisonV1,
  })
  .strict();
export type MemoryEffectItemV1 = z.infer<typeof MemoryEffectItemV1>;

// One row per flow with at least one memory-on run: the memory-on arm versus the
// memory-off arm of the same flow (the validation experiment half).
export const MemoryFlowContrastV1 = z
  .object({
    flow_id: z.string().min(1),
    comparison: MemoryEffectComparisonV1,
  })
  .strict();
export type MemoryFlowContrastV1 = z.infer<typeof MemoryFlowContrastV1>;

// Roll-up so the honest early state (every cohort not_enough_data on a thin
// corpus) is visible at a glance. Flow contrasts get the same four-status
// roll-up as items, so the validation half is as glanceable as the product half.
export const MemoryEffectSummaryV1 = z
  .object({
    items_total: z.number().int().nonnegative(),
    items_not_enough_data: z.number().int().nonnegative(),
    items_unresolved: z.number().int().nonnegative(),
    items_correlated_positive: z.number().int().nonnegative(),
    items_correlated_negative: z.number().int().nonnegative(),
    flow_contrasts_total: z.number().int().nonnegative(),
    flow_contrasts_not_enough_data: z.number().int().nonnegative(),
    flow_contrasts_unresolved: z.number().int().nonnegative(),
    flow_contrasts_correlated_positive: z.number().int().nonnegative(),
    flow_contrasts_correlated_negative: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryEffectSummaryV1 = z.infer<typeof MemoryEffectSummaryV1>;

export const HistoryMemoryEffectV1 = z
  .object({
    api_version: z.literal('history-memory-effect-v1'),
    schema_version: z.literal(1),
    generated_at: z.iso.datetime(),
    runs_base: z.string().min(1),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    // The Q2 sample gate in effect (default 2), echoed so the artifact states
    // its own statistical floor rather than hiding it.
    min_arm_size: z.number().int().min(1),
    // The D5 separation margin (default 0.5). 0 is rejected (a tied comparison
    // would satisfy both the positive and negative condition); above 1 can never
    // fire because complete_rate_delta ranges over [-1, 1].
    margin: z.number().gt(0).max(1),
    source_run_count: z.number().int().nonnegative(),
    source_envelope_count: z.number().int().nonnegative(),
    source_memory_run_count: z.number().int().nonnegative(),
    item_effects: z.array(MemoryEffectItemV1),
    flow_contrasts: z.array(MemoryFlowContrastV1),
    summary: MemoryEffectSummaryV1,
    warnings: z.array(HistoryWarningV1),
  })
  .strict()
  .superRefine((report, ctx) => {
    const items = report.item_effects;
    const itemsWith = (status: MemoryMergeEffectStatusV1): number =>
      items.filter((item) => item.comparison.effect_status === status).length;
    if (report.summary.items_total !== items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'items_total'],
        message: 'items_total must equal item_effects.length',
      });
    }
    for (const status of [
      'not_enough_data',
      'unresolved',
      'correlated_positive',
      'correlated_negative',
    ] as const) {
      const key = `items_${status}` as const;
      if (report.summary[key] !== itemsWith(status)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['summary', key],
          message: `${key} must equal the count of item_effects with that effect_status`,
        });
      }
    }
    const contrasts = report.flow_contrasts;
    const contrastsWith = (status: MemoryMergeEffectStatusV1): number =>
      contrasts.filter((contrast) => contrast.comparison.effect_status === status).length;
    if (report.summary.flow_contrasts_total !== contrasts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', 'flow_contrasts_total'],
        message: 'flow_contrasts_total must equal flow_contrasts.length',
      });
    }
    for (const status of [
      'not_enough_data',
      'unresolved',
      'correlated_positive',
      'correlated_negative',
    ] as const) {
      const key = `flow_contrasts_${status}` as const;
      if (report.summary[key] !== contrastsWith(status)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['summary', key],
          message: `${key} must equal the count of flow_contrasts with that effect_status`,
        });
      }
    }
  });
export type HistoryMemoryEffectV1 = z.infer<typeof HistoryMemoryEffectV1>;

// --- Self-auditing memory, Slice 3: the earned-precision recall audit sidecar ---
// See docs/ideas/self-auditing-memory-slice-3-spec.md. Earned precision changes
// what the agent sees, so the "never a silent meaningful update" rule requires a
// durable record. This sidecar (reports/history/recall-precision.json) records
// every candidate's gate decision so the change is auditable. The frozen recall
// report is NOT extended; this is a separate, additive surface.

export const RecallPrecisionTierV1 = z.enum([
  'suppressed', // verdict correlated_negative — dropped from the push set entirely
  'positive_fresh', // fresh source + correlated_positive
  'neutral_fresh', // fresh source + not_enough_data | unresolved | no_verdict
  'stale', // stale/unknown source (any non-negative verdict) — sinks below fresh
]);
export type RecallPrecisionTierV1 = z.infer<typeof RecallPrecisionTierV1>;

export const RecallPrecisionConsultedStatusV1 = z.union([
  MemoryMergeEffectStatusV1,
  z.literal('no_verdict'),
]);
export type RecallPrecisionConsultedStatusV1 = z.infer<typeof RecallPrecisionConsultedStatusV1>;

export const RecallPrecisionDecisionV1 = z
  .object({
    memory_input_id: z.string().min(1),
    content_id: z.string().min(1).nullable(),
    staleness: MemoryStalenessStatus,
    consulted_effect_status: RecallPrecisionConsultedStatusV1,
    tier: RecallPrecisionTierV1,
    injected: z.boolean(),
  })
  .strict();
export type RecallPrecisionDecisionV1 = z.infer<typeof RecallPrecisionDecisionV1>;

export const HistoryRecallPrecisionV1 = z
  .object({
    api_version: z.literal('history-recall-precision-v1'),
    schema_version: z.literal(1),
    generated_at: z.iso.datetime(),
    flow_id: z.string().min(1).optional(),
    effect_report_available: z.boolean(),
    effect_report_generated_at: z.iso.datetime().optional(),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    budget: z.number().int().nonnegative(),
    indicator: z.string().min(1),
    decisions: z.array(RecallPrecisionDecisionV1),
    warnings: z.array(HistoryWarningV1),
  })
  .strict()
  .superRefine((report, ctx) => {
    const injected = report.decisions.filter((decision) => decision.injected).length;
    if (injected > report.budget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisions'],
        message: 'the number of injected decisions must not exceed the budget',
      });
    }
    for (const [index, decision] of report.decisions.entries()) {
      if (decision.tier === 'suppressed' && decision.injected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'injected'],
          message: 'a suppressed decision must never be injected',
        });
      }
    }
  });
export type HistoryRecallPrecisionV1 = z.infer<typeof HistoryRecallPrecisionV1>;

// --- Self-auditing memory, Slice 4: the gated-pull audit log ---
// See docs/ideas/self-auditing-memory-slice-4-spec.md. The pull is agent-invoked
// at a decision point and reuses the existing query/preview surface verbatim; the
// only net-new contract is this log, appended to the active run folder as a side
// effect of the pull so the loop is fed without a separate "remember to log" step
// (D2). The pull RESULT stays HistoryMemoryInputPreviewV1 — no new query/ranking/
// result schema (D1). content_id reuses the shared contentIdentityOf, so pull-
// sourced and push-sourced memory share one identity space (the property that
// makes the deferred Slice 2 union over pulled hints possible, D5).

// One surfaced memory input (AFTER suppression) recorded against a pull. content_id
// is the shared content-addressed identity (Slice 3 D4): null whenever the cited
// source carries no content hash.
export const PullLogResultV1 = z
  .object({
    memory_input_id: z.string().min(1),
    content_id: z.string().min(1).nullable(),
    staleness: MemoryStalenessStatus,
    source_ref: Ref,
  })
  .strict();
export type PullLogResultV1 = z.infer<typeof PullLogResultV1>;

// One pull. effect_report_available is PER-PULL (not file-level): the log is
// append-mostly across many pulls, and pull #1 may find the effect report while
// pull #2 does not, so false here means THIS pull's suppression ran fail-open.
// result_count / results are AFTER suppression; suppressed_count is the measured-
// negative hints dropped (D3). A file-level refine pins result_count to
// results.length.
export const PullLogEntryV1 = z
  .object({
    pull_id: z.string().min(1),
    recorded_at: z.iso.datetime(),
    decision_point: z.string().min(1),
    query: z.string(),
    flow_id: z.string().min(1),
    result_count: z.number().int().nonnegative(),
    suppressed_count: z.number().int().nonnegative(),
    effect_report_available: z.boolean(),
    effect_report_generated_at: z.iso.datetime().optional(),
    results: z.array(PullLogResultV1),
    authority: z.literal('hint_only'),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.result_count !== entry.results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result_count'],
        message: 'result_count must equal results.length',
      });
    }
  });
export type PullLogEntryV1 = z.infer<typeof PullLogEntryV1>;

// The file-level header plus the append-ordered entries. Per-pull state lives on
// the entry, so the header carries only the four literal/optional top-level fields
// and the shared authority notice. warnings here are FILE-level (e.g. a prior log
// was unreadable and reset); per-pull fail-open is recorded on the entry.
export const HistoryPullLogV1 = z
  .object({
    api_version: z.literal('history-pull-log-v1'),
    schema_version: z.literal(1),
    run_id: z.string().min(1).optional(),
    authority_notice: z.literal(HISTORY_AUTHORITY_NOTICE),
    entries: z.array(PullLogEntryV1),
    warnings: z.array(HistoryWarningV1),
  })
  .strict();
export type HistoryPullLogV1 = z.infer<typeof HistoryPullLogV1>;

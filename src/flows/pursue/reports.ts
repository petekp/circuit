import { z } from 'zod';
import { VerificationCommand, VerificationResult } from '../../schemas/verification.js';
import { resultReportPointer } from '../report-schema-kit.js';

const PURSUIT_RESULT_SCHEMA_BY_REPORT_ID = {
  'pursuit.contract': 'pursuit.contract@v1',
  'pursuit.graph': 'pursuit.graph@v1',
  'pursuit.wave-plan': 'pursuit.wave-plan@v1',
  'pursuit.batch': 'pursuit.batch@v1',
  'pursuit.verification': 'pursuit.verification@v1',
  'pursuit.review': 'pursuit.review@v1',
} as const;

const PURSUIT_RESULT_PATH_BY_REPORT_ID = {
  'pursuit.contract': 'reports/pursuit/contract.json',
  'pursuit.graph': 'reports/pursuit/graph.json',
  'pursuit.wave-plan': 'reports/pursuit/wave-plan.json',
  'pursuit.batch': 'reports/pursuit/batch.json',
  'pursuit.verification': 'reports/pursuit/verification.json',
  'pursuit.review': 'reports/pursuit/review.json',
} as const;

const NonEmptyStringArray = z.array(z.string().min(1)).min(1);
const PursuitId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const PursuitRisk = z.enum(['low', 'medium', 'high']);
export type PursuitRisk = z.infer<typeof PursuitRisk>;

export const PursuitTouchSet = z
  .object({
    paths: z.array(z.string().min(1)),
    symbols: z.array(z.string().min(1)),
    commands: z.array(z.string().min(1)),
    generated_outputs: z.array(z.string().min(1)),
  })
  .strict();
export type PursuitTouchSet = z.infer<typeof PursuitTouchSet>;

export const PursuitContractItem = z
  .object({
    id: PursuitId,
    title: z.string().min(1),
    goal: z.string().min(1),
    scope: z.string().min(1),
    assumptions: z.array(z.string().min(1)),
    estimated_touch_set: PursuitTouchSet,
    proof_plan: NonEmptyStringArray,
    check_in_triggers: NonEmptyStringArray,
    rollback_notes: z.array(z.string().min(1)),
    risk: PursuitRisk,
  })
  .strict();
export type PursuitContractItem = z.infer<typeof PursuitContractItem>;

export const PursuitContract = z
  .object({
    objective: z.string().min(1),
    pursuits: z.array(PursuitContractItem).min(1),
    execution_policy: z
      .object({
        code_writes: z.literal('serial-only'),
        read_only_parallelism: z.literal('allowed'),
        parallel_write_status: z.literal('blocked-until-safe-apply'),
      })
      .strict(),
    verification_command_candidates: z.array(VerificationCommand).min(1),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    for (const [index, pursuit] of contract.pursuits.entries()) {
      if (seen.has(pursuit.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pursuits', index, 'id'],
          message: `duplicate pursuit id: ${pursuit.id}`,
        });
      }
      seen.add(pursuit.id);
    }
  });
export type PursuitContract = z.infer<typeof PursuitContract>;

export const PursuitGraphNode = z
  .object({
    id: PursuitId,
    goal: z.string().min(1),
    estimated_touch_set: PursuitTouchSet,
    risk: PursuitRisk,
    status: z.enum(['ready', 'blocked', 'deferred']),
    reason: z.string().min(1),
  })
  .strict();
export type PursuitGraphNode = z.infer<typeof PursuitGraphNode>;

export const PursuitGraphEdge = z
  .object({
    from: PursuitId,
    to: PursuitId,
    kind: z.enum(['hard-dependency', 'soft-dependency', 'conflict', 'composes-with']),
    reason: z.string().min(1),
  })
  .strict();
export type PursuitGraphEdge = z.infer<typeof PursuitGraphEdge>;

export const PursuitGraphGroup = z
  .object({
    id: PursuitId,
    pursuit_ids: z.array(PursuitId).min(1),
    reason: z.string().min(1),
  })
  .strict();
export type PursuitGraphGroup = z.infer<typeof PursuitGraphGroup>;

export const PursuitGraph = z
  .object({
    verdict: z.literal('accept'),
    nodes: z.array(PursuitGraphNode).min(1),
    edges: z.array(PursuitGraphEdge),
    serial_groups: z.array(PursuitGraphGroup).min(1),
    parallel_read_only_groups: z.array(PursuitGraphGroup).min(1),
    blocked: z.array(
      z
        .object({
          pursuit_id: PursuitId,
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `duplicate node id: ${node.id}`,
        });
      }
      nodeIds.add(node.id);
    }
    for (const [index, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', index, 'from'],
          message: `edge references unknown pursuit id: ${edge.from}`,
        });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', index, 'to'],
          message: `edge references unknown pursuit id: ${edge.to}`,
        });
      }
    }
    for (const [groupIndex, group] of [
      ...graph.serial_groups,
      ...graph.parallel_read_only_groups,
    ].entries()) {
      for (const [index, id] of group.pursuit_ids.entries()) {
        if (!nodeIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['groups', groupIndex, 'pursuit_ids', index],
            message: `group references unknown pursuit id: ${id}`,
          });
        }
      }
    }
    for (const [index, item] of graph.blocked.entries()) {
      if (!nodeIds.has(item.pursuit_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocked', index, 'pursuit_id'],
          message: `blocked item references unknown pursuit id: ${item.pursuit_id}`,
        });
      }
    }
  });
export type PursuitGraph = z.infer<typeof PursuitGraph>;

export const PursuitWave = z
  .object({
    id: PursuitId,
    kind: z.enum(['read-only', 'code-change']),
    pursuit_ids: z.array(PursuitId).min(1),
    execution: z.enum(['parallel', 'serial']),
    reason: z.string().min(1),
    re_ground_after: z.boolean(),
  })
  .strict();
export type PursuitWave = z.infer<typeof PursuitWave>;

export const PursuitWavePlan = z
  .object({
    verdict: z.literal('accept'),
    waves: z.array(PursuitWave).min(1),
    no_parallel_writes_reason: z.string().min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    for (const [index, wave] of plan.waves.entries()) {
      if (wave.kind === 'code-change' && wave.execution !== 'serial') {
        ctx.addIssue({
          code: 'custom',
          path: ['waves', index, 'execution'],
          message: 'code-change waves must execute serially in Pursuits V1',
        });
      }
    }
  });
export type PursuitWavePlan = z.infer<typeof PursuitWavePlan>;

export const PursuitBatchItem = z
  .object({
    pursuit_id: PursuitId,
    status: z.enum(['completed', 'skipped', 'blocked', 'failed']),
    summary: z.string().min(1),
    evidence: z.array(z.string().min(1)),
  })
  .strict();
export type PursuitBatchItem = z.infer<typeof PursuitBatchItem>;

export const PursuitBatch = z
  .object({
    verdict: z.enum(['accept', 'partial', 'blocked']),
    summary: z.string().min(1),
    serialized_execution: z.literal(true),
    completed: z.array(PursuitBatchItem),
    skipped: z.array(PursuitBatchItem),
    blocked: z.array(PursuitBatchItem),
    failed: z.array(PursuitBatchItem),
    actual_touch_set: PursuitTouchSet,
    proof_evidence: NonEmptyStringArray,
  })
  .strict()
  .superRefine((batch, ctx) => {
    for (const [field, expectedStatus] of [
      ['completed', 'completed'],
      ['skipped', 'skipped'],
      ['blocked', 'blocked'],
      ['failed', 'failed'],
    ] as const) {
      for (const [index, item] of batch[field].entries()) {
        if (item.status !== expectedStatus) {
          ctx.addIssue({
            code: 'custom',
            path: [field, index, 'status'],
            message: `status must be '${expectedStatus}' for ${field} items`,
          });
        }
      }
    }
    if (batch.verdict === 'accept' && (batch.blocked.length > 0 || batch.failed.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: "verdict must not be 'accept' when blocked or failed items exist",
      });
    }
    if (batch.verdict === 'accept' && batch.skipped.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: "verdict must not be 'accept' when skipped items exist",
      });
    }
    if (batch.verdict === 'blocked' && batch.blocked.length === 0 && batch.failed.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: "verdict must be backed by blocked or failed items when it is 'blocked'",
      });
    }
    const seen = new Set<string>();
    for (const [field, items] of [
      ['completed', batch.completed],
      ['skipped', batch.skipped],
      ['blocked', batch.blocked],
      ['failed', batch.failed],
    ] as const) {
      for (const [index, item] of items.entries()) {
        if (seen.has(item.pursuit_id)) {
          ctx.addIssue({
            code: 'custom',
            path: [field, index, 'pursuit_id'],
            message: `duplicate pursuit id in batch: ${item.pursuit_id}`,
          });
        }
        seen.add(item.pursuit_id);
      }
    }
  });
export type PursuitBatch = z.infer<typeof PursuitBatch>;

export const PursuitVerification = VerificationResult;
export type PursuitVerification = z.infer<typeof PursuitVerification>;

export const PursuitReviewFinding = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    text: z.string().min(1),
    file_refs: z.array(z.string().min(1)),
  })
  .strict();
export type PursuitReviewFinding = z.infer<typeof PursuitReviewFinding>;

export const PursuitReviewVerdict = z.enum(['clean', 'needs-followup', 'blocked']);
export type PursuitReviewVerdict = z.infer<typeof PursuitReviewVerdict>;

// The shortest genuine attestation ("skipped as planned" is 18) still clears
// this floor, while one- or two-word filler ("ok", "fine", "placeholder" at 11)
// does not. The structural coverage check in result-projection.ts does the heavy
// lifting; this floor stops a per-pursuit entry from being a single empty word.
const MIN_ATTESTATION_LENGTH = 12;

// One entry per contracted pursuit: the reviewer must name the pursuit and state
// what it actually checked, so a blanket "clean / placeholder" review can no
// longer stand in for reviewing the work (the F12 finding from the live surface
// test). Coverage against the contract is enforced at close.
export const PursuitReviewAttestation = z
  .object({
    pursuit_id: PursuitId,
    assessment: z.string().min(MIN_ATTESTATION_LENGTH),
  })
  .strict();
export type PursuitReviewAttestation = z.infer<typeof PursuitReviewAttestation>;

export const PursuitReview = z
  .object({
    verdict: PursuitReviewVerdict,
    summary: z.string().min(1),
    reviewed_pursuits: z.array(PursuitReviewAttestation).min(1),
    findings: z.array(PursuitReviewFinding),
  })
  .strict()
  .superRefine((review, ctx) => {
    const mediumOrHigher = review.findings.filter((finding) =>
      ['critical', 'high', 'medium'].includes(finding.severity),
    );
    if (review.verdict === 'clean' && review.findings.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: "findings must be empty when verdict is 'clean'",
      });
    }
    if (review.verdict !== 'clean' && review.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: `findings must be non-empty when verdict is '${review.verdict}'`,
      });
    }
    if (review.verdict === 'needs-followup' && mediumOrHigher.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message:
          "verdict must be 'blocked' when review findings include medium, high, or critical severity",
      });
    }
    const seen = new Set<string>();
    for (const [index, attestation] of review.reviewed_pursuits.entries()) {
      if (seen.has(attestation.pursuit_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['reviewed_pursuits', index, 'pursuit_id'],
          message: `duplicate reviewed pursuit id: ${attestation.pursuit_id}`,
        });
      }
      seen.add(attestation.pursuit_id);
    }
  });
export type PursuitReview = z.infer<typeof PursuitReview>;

export const PursuitResultReportId = z.enum([
  'pursuit.contract',
  'pursuit.graph',
  'pursuit.wave-plan',
  'pursuit.batch',
  'pursuit.verification',
  'pursuit.review',
]);
export type PursuitResultReportId = z.infer<typeof PursuitResultReportId>;

export const PursuitResultReportPointer = resultReportPointer(
  PursuitResultReportId,
  PURSUIT_RESULT_SCHEMA_BY_REPORT_ID,
  PURSUIT_RESULT_PATH_BY_REPORT_ID,
);
export type PursuitResultReportPointer = z.infer<typeof PursuitResultReportPointer>;

export const PursuitResult = z
  .object({
    summary: z.string().min(1),
    outcome: z.enum(['complete', 'needs_attention', 'blocked', 'failed']),
    verification_status: z.enum(['passed', 'failed']),
    review_verdict: PursuitReviewVerdict,
    total_pursuits: z.number().int().positive(),
    completed_count: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
    blocked_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    serial_code_writes: z.literal(true),
    evidence_links: z.array(PursuitResultReportPointer).length(6),
  })
  .strict()
  .superRefine((result, ctx) => {
    const accounted =
      result.completed_count + result.skipped_count + result.blocked_count + result.failed_count;
    if (accounted !== result.total_pursuits) {
      ctx.addIssue({
        code: 'custom',
        path: ['total_pursuits'],
        message: 'total_pursuits must equal completed + skipped + blocked + failed counts',
      });
    }
    if (result.outcome === 'complete') {
      if (result.verification_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['verification_status'],
          message: "verification_status must be 'passed' when outcome is 'complete'",
        });
      }
      if (result.review_verdict !== 'clean') {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict must be 'clean' when outcome is 'complete'",
        });
      }
      if (result.blocked_count > 0 || result.failed_count > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: "outcome must not be 'complete' when pursuits are blocked or failed",
        });
      }
      if (result.skipped_count > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: "outcome must not be 'complete' when pursuits are skipped",
        });
      }
    }
  });
export type PursuitResult = z.infer<typeof PursuitResult>;

import { z } from 'zod';
import {
  VerificationCommand,
  VerificationCommandResult,
  VerificationResult,
} from '../../schemas/verification.js';
import { resultReportPointer } from '../report-schema-kit.js';

const BUILD_RESULT_SCHEMA_BY_ARTIFACT_ID = {
  'build.brief': 'build.brief@v1',
  'build.plan': 'build.plan@v1',
  'build.implementation': 'build.implementation@v1',
  'build.verification': 'build.verification@v1',
  'build.review': 'build.review@v1',
} as const;

const NonEmptyStringArray = z.array(z.string().min(1)).min(1);

// One ordered unit of implementation work. The researcher decomposes the
// change into these during analyze; under deep rigor the engine implements
// and verifies them one at a time. See docs/ideas/build-slice-decomposition.md.
export const BuildSlice = z
  .object({
    id: z.string().min(1).describe('stable slice id, e.g. "slice-1"'),
    intent: z
      .string()
      .min(1)
      .describe('one concrete, independently-verifiable unit of implementation work'),
    anticipated_file_extensions: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'file extensions this slice is predicted to touch, e.g. ".ts"; empty when no confident prediction',
      ),
  })
  .strict();
export type BuildSlice = z.infer<typeof BuildSlice>;

export const BuildCheckpointPacketChoice = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    route: z
      .object({
        key: z.string().min(1),
        target: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type BuildCheckpointPacketChoice = z.infer<typeof BuildCheckpointPacketChoice>;

export const BuildCheckpointPacket = z
  .object({
    kind: z.literal('build.checkpoint_packet@v1'),
    salience: z
      .object({
        summary: z.string().min(1),
        why_now: NonEmptyStringArray,
        hidden_routine_work: NonEmptyStringArray,
      })
      .strict(),
    decision: z
      .object({
        question: z.string().min(1),
        operator_judgment: z.string().min(1),
      })
      .strict(),
    recommendation: z
      .object({
        choice_id: z.string().min(1),
        label: z.string().min(1),
        rationale: z.string().min(1),
      })
      .strict(),
    artifact: z
      .object({
        title: z.string().min(1),
        preview: z.string().min(1),
        scope: z.string().min(1),
        success_criteria: NonEmptyStringArray,
      })
      .strict(),
    proof: z
      .object({
        status: z.enum(['planned', 'collected', 'missing']),
        summary: z.string().min(1),
        commands: z.array(VerificationCommand).min(1),
        evidence: NonEmptyStringArray,
      })
      .strict(),
    risk: z
      .object({
        summary: z.string().min(1),
        tradeoffs: NonEmptyStringArray,
      })
      .strict(),
    choices: z.array(BuildCheckpointPacketChoice).min(1),
    internal: z
      .object({
        request_path: z.string().min(1),
        response_path: z.string().min(1),
        report_path: z.string().min(1),
        raw_evidence: NonEmptyStringArray,
      })
      .strict(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    const choiceIds = new Set(packet.choices.map((choice) => choice.id));
    if (!choiceIds.has(packet.recommendation.choice_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendation', 'choice_id'],
        message: 'recommendation.choice_id must reference a declared checkpoint choice',
      });
    }
  });
export type BuildCheckpointPacket = z.infer<typeof BuildCheckpointPacket>;

const BuildCheckpointPointer = z
  .object({
    request_path: z.string().min(1),
    response_path: z.string().min(1).optional(),
    allowed_choices: NonEmptyStringArray,
  })
  .strict();

export const BuildBrief = z
  .object({
    objective: z.string().min(1),
    scope: z.string().min(1),
    success_criteria: NonEmptyStringArray,
    verification_command_candidates: z.array(VerificationCommand).min(1),
    checkpoint: BuildCheckpointPointer,
    checkpoint_packet: BuildCheckpointPacket.optional(),
  })
  .strict();
export type BuildBrief = z.infer<typeof BuildBrief>;

export const BuildContextSource = z
  .object({
    kind: z.enum(['file', 'command', 'log', 'operator-note', 'reference']),
    ref: z
      .string()
      .min(1)
      .describe('project-relative path, command id, log line, note id, or external reference'),
    summary: z.string().min(1).describe('one-line summary of what this source contributed'),
  })
  .strict();
export type BuildContextSource = z.infer<typeof BuildContextSource>;

export const BuildContext = z
  .object({
    verdict: z.literal('accept'),
    sources: z.array(BuildContextSource).min(1),
    observations: z.array(z.string().min(1).describe('observation grounded in the sources')).min(1),
    open_questions: z.array(
      z.string().min(1).describe('question still unresolved after gathering context'),
    ),
    anticipated_file_extensions: z
      .array(
        z
          .string()
          .min(1)
          .describe(
            'file extension the implementation is expected to touch, e.g. ".ts" or ".test.ts"',
          ),
      )
      .default([])
      .describe(
        'file extensions the implementation is predicted to touch, inferred from the codebase read; empty when no confident prediction',
      ),
    slices: z
      .array(BuildSlice)
      .default([])
      .describe(
        'ordered units of implementation work the change decomposes into, inferred from the codebase read; empty when the change is a single indivisible unit (the plan then runs one pass)',
      ),
  })
  .strict();
export type BuildContext = z.infer<typeof BuildContext>;

export const BuildPlan = z
  .object({
    objective: z.string().min(1),
    approach: z.string().min(1),
    slices: z
      .array(BuildSlice)
      .min(1)
      .describe(
        'ordered units of implementation work, carried from build.context@v1; always at least one (a single-slice plan runs one implement+verify pass). Under deep rigor the engine implements and verifies these one at a time',
      ),
    anticipated_file_extensions: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'file extensions the implementation is predicted to touch, surfaced from build.context@v1; empty when grounding made no confident prediction',
      ),
    verification: z
      .object({
        commands: z.array(VerificationCommand).min(1),
      })
      .strict(),
  })
  .strict();
export type BuildPlan = z.infer<typeof BuildPlan>;

export const BuildImplementation = z
  .object({
    verdict: z.literal('accept'),
    summary: z.string().min(1),
    changed_files: z.array(z.string().min(1)),
    evidence: NonEmptyStringArray,
  })
  .strict();
export type BuildImplementation = z.infer<typeof BuildImplementation>;

export const BuildVerificationCommand = VerificationCommand;
export type BuildVerificationCommand = z.infer<typeof BuildVerificationCommand>;

export const BuildVerification = VerificationResult;
export type BuildVerification = z.infer<typeof BuildVerification>;

export const BuildVerificationCommandResult = VerificationCommandResult;
export type BuildVerificationCommandResult = z.infer<typeof BuildVerificationCommandResult>;

export const BuildReviewVerdict = z.enum(['accept', 'accept-with-fixes', 'reject']);
export type BuildReviewVerdict = z.infer<typeof BuildReviewVerdict>;

export const BuildReviewFinding = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    text: z.string().min(1),
    file_refs: z.array(z.string().min(1)),
  })
  .strict();
export type BuildReviewFinding = z.infer<typeof BuildReviewFinding>;

export const BuildReview = z
  .object({
    verdict: BuildReviewVerdict,
    summary: z.string().min(1),
    findings: z.array(BuildReviewFinding),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.verdict !== 'accept' && review.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: `findings must be non-empty when verdict is '${review.verdict}'`,
      });
    }
  });
export type BuildReview = z.infer<typeof BuildReview>;

export const BuildResultReportId = z.enum([
  'build.brief',
  'build.plan',
  'build.implementation',
  'build.verification',
  'build.review',
]);
export type BuildResultReportId = z.infer<typeof BuildResultReportId>;

export const BuildResultReportPointer = resultReportPointer(
  BuildResultReportId,
  BUILD_RESULT_SCHEMA_BY_ARTIFACT_ID,
);
export type BuildResultReportPointer = z.infer<typeof BuildResultReportPointer>;

export const BuildResult = z
  .object({
    summary: z.string().min(1),
    outcome: z.enum(['complete', 'needs_attention', 'failed']),
    verification_status: z.enum(['passed', 'failed']),
    review_verdict: BuildReviewVerdict,
    evidence_links: z.array(BuildResultReportPointer).length(5),
  })
  .strict()
  .superRefine((result, ctx) => {
    const seen = new Set<BuildResultReportId>();
    for (const [index, pointer] of result.evidence_links.entries()) {
      if (seen.has(pointer.report_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links', index, 'report_id'],
          message: `duplicate report_id '${pointer.report_id}'`,
        });
      }
      seen.add(pointer.report_id);
    }
    for (const reportId of BuildResultReportId.options) {
      if (!seen.has(reportId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links'],
          message: `missing report_id '${reportId}'`,
        });
      }
    }
    if (result.outcome === 'complete') {
      if (result.verification_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['verification_status'],
          message: "verification_status must be 'passed' when outcome is 'complete'",
        });
      }
      if (result.review_verdict !== 'accept') {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict must be 'accept' when outcome is 'complete'",
        });
      }
    }
    if (result.outcome === 'needs_attention') {
      if (result.verification_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['verification_status'],
          message: "verification_status must be 'passed' when outcome is 'needs_attention'",
        });
      }
      if (result.review_verdict !== 'accept-with-fixes') {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict must be 'accept-with-fixes' when outcome is 'needs_attention'",
        });
      }
    }
  });
export type BuildResult = z.infer<typeof BuildResult>;

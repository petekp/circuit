import { z } from 'zod';
import { CompiledFlowId, StepId } from './ids.js';
import { Ref } from './ref.js';

export const PROCESS_EVIDENCE_RELATIVE_PATH = 'reports/process-evidence.json';

// `stopped` is carried distinctly from `blocked` on purpose. A stopped close is
// a deliberate pause by a process that DID run and DID produce its evidence —
// Review binds an ISSUES_FOUND verdict to it. Folding it into `blocked` (the
// old behavior) both headlined a healthy run as a failure to produce evidence
// and filed it in the failure set (see src/shared/outcome.ts), which is what
// made run history read as mostly-failing.
export const ProcessEvidenceOutcome = z.enum([
  'complete',
  'stopped',
  'blocked',
  'failed',
  'checkpoint_waiting',
  'handoff',
  'aborted',
]);
export type ProcessEvidenceOutcome = z.infer<typeof ProcessEvidenceOutcome>;

const MissingEvidence = z
  .object({
    claim_id: z.string().min(1),
    reason: z.string().min(1),
    next_action: z.string().min(1).optional(),
  })
  .strict();
export type MissingEvidence = z.infer<typeof MissingEvidence>;

export const ProcessEvidenceProjection = z
  .object({
    schema: z.literal('process.evidence@v0'),
    flow_id: CompiledFlowId,
    attempt_id: z.string().min(1),
    outcome: ProcessEvidenceOutcome,
    summary: z.string().min(1),
    child_run_ref: Ref,
    result_ref: Ref.optional(),
    evidence_refs: z.array(Ref),
    declared_report_paths: z.array(z.string().min(1)),
    missing_evidence: z.array(MissingEvidence),
    trace_entries_observed: z.number().int().nonnegative(),
    manifest_hash: z.string().min(1),
    checkpoint: z
      .object({
        step_id: StepId,
        request_ref: Ref,
        allowed_choices: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
    blocked_reason: z.string().min(1).optional(),
    next_action: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((projection, ctx) => {
    if (projection.child_run_ref.kind !== 'trace') {
      ctx.addIssue({
        code: 'custom',
        path: ['child_run_ref', 'kind'],
        message: 'child_run_ref must point to the child run trace',
      });
    }
    if (projection.result_ref !== undefined && projection.result_ref.kind !== 'report') {
      ctx.addIssue({
        code: 'custom',
        path: ['result_ref', 'kind'],
        message: 'result_ref must point to a report',
      });
    }

    for (const [index, ref] of projection.evidence_refs.entries()) {
      if (ref.ref.startsWith('/')) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_refs', index, 'ref'],
          message: 'process evidence refs must be run-relative',
        });
      }
      if (ref.kind === 'report') {
        const allowed = new Set(
          [projection.result_ref?.ref, ...projection.declared_report_paths].filter(
            (path): path is string => path !== undefined,
          ),
        );
        if (!allowed.has(ref.ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidence_refs', index, 'ref'],
            message: 'process report refs must use declared process evidence paths',
          });
        }
      }
      if (ref.kind === 'request' && ref.ref !== projection.checkpoint?.request_ref.ref) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_refs', index, 'ref'],
          message: 'request refs are only allowed for the active checkpoint request',
        });
      }
      if (!['report', 'request', 'operator_input', 'evidence'].includes(ref.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_refs', index, 'kind'],
          message: `process evidence cannot use ${ref.kind} refs`,
        });
      }
    }

    if (projection.outcome === 'checkpoint_waiting') {
      if (projection.result_ref !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['result_ref'],
          message: 'checkpoint_waiting projections must not have a result ref',
        });
      }
      if (projection.checkpoint === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoint'],
          message: 'checkpoint_waiting projections require checkpoint metadata',
        });
      }
      return;
    }

    if (projection.result_ref === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['result_ref'],
        message: 'closed process projections require a result ref',
      });
    }
    if (projection.checkpoint !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint'],
        message: 'closed process projections must not carry checkpoint metadata',
      });
    }
    if (projection.outcome === 'complete' && projection.missing_evidence.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['missing_evidence'],
        message: 'complete process projections cannot have missing evidence',
      });
    }
    if (
      ['stopped', 'blocked', 'failed'].includes(projection.outcome) &&
      projection.blocked_reason === undefined &&
      projection.next_action === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['blocked_reason'],
        message: 'stopped, blocked or failed process projections require a reason or next action',
      });
    }
  });
export type ProcessEvidenceProjection = z.infer<typeof ProcessEvidenceProjection>;

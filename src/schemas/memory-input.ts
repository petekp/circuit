import { z } from 'zod';
import { Ref, Sha256 } from './ref.js';
import { ControlPlaneFileStem } from './scalars.js';

const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
const CONTINUITY_RECORD_REF_PATTERN = /(?:^|\/)continuity\/records\/[a-z0-9][a-z0-9._-]*\.json$/;

export const MemoryInputKind = z.enum([
  'repo',
  'user',
  'project',
  'prior_run',
  'continuity',
  'handoff_brief',
]);
export type MemoryInputKind = z.infer<typeof MemoryInputKind>;

export const MemoryHintAppliesTo = z.enum([
  'context',
  'verification',
  'preference',
  'prior_failure',
  'repo_convention',
  'operator_note',
]);
export type MemoryHintAppliesTo = z.infer<typeof MemoryHintAppliesTo>;

export const MemoryStalenessStatus = z.enum(['fresh', 'stale', 'unknown']);
export type MemoryStalenessStatus = z.infer<typeof MemoryStalenessStatus>;

const MemorySource = z
  .object({
    ref: Ref,
    captured_at: z.iso.datetime(),
    source_updated_at: z.iso.datetime().optional(),
    sha256: Sha256.optional(),
  })
  .strict();

const MemoryHint = z
  .object({
    id: ControlPlaneFileStem,
    text: z.string().min(1),
    applies_to: MemoryHintAppliesTo,
  })
  .strict();

const MemoryStaleness = z
  .object({
    status: MemoryStalenessStatus,
    checked_at: z.iso.datetime(),
    reason_codes: z.array(ReasonCode).min(1),
  })
  .strict();

export const MemoryInputV0 = z
  .object({
    schema_version: z.literal(1),
    memory_id: ControlPlaneFileStem,
    kind: MemoryInputKind,
    source: MemorySource,
    summary: z.string().min(1),
    hints: z.array(MemoryHint).min(1),
    staleness: MemoryStaleness,
    authority: z.literal('hint_only'),
  })
  .strict()
  .superRefine((memory, ctx) => {
    if (
      memory.source.sha256 !== undefined &&
      memory.source.ref.sha256 !== undefined &&
      memory.source.sha256 !== memory.source.ref.sha256
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'sha256'],
        message: 'source.sha256 must match source.ref.sha256 when both are present',
      });
    }

    if (memory.kind === 'continuity' && memory.source.ref.kind !== 'report') {
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'ref', 'kind'],
        message: 'continuity memory must point at a continuity report ref',
      });
    }
    if (
      memory.kind === 'continuity' &&
      !CONTINUITY_RECORD_REF_PATTERN.test(memory.source.ref.ref)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'ref', 'ref'],
        message: 'continuity memory must point at continuity/records/<record>.json',
      });
    }

    if (
      memory.kind === 'handoff_brief' &&
      memory.source.ref.kind !== 'report' &&
      memory.source.ref.kind !== 'context_packet'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'ref', 'kind'],
        message: 'handoff brief memory must point at report or context_packet refs',
      });
    }

    if (
      memory.staleness.status === 'unknown' &&
      !memory.staleness.reason_codes.includes('memory_unverified')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['staleness', 'reason_codes'],
        message: 'unknown memory staleness requires memory_unverified reason code',
      });
    }

    if (
      memory.staleness.status === 'stale' &&
      !memory.staleness.reason_codes.includes('memory_stale')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['staleness', 'reason_codes'],
        message: 'stale memory requires memory_stale reason code',
      });
    }

    const seenHints = new Set<string>();
    for (const [index, hint] of memory.hints.entries()) {
      if (seenHints.has(hint.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['hints', index, 'id'],
          message: `duplicate memory hint id: ${hint.id}`,
        });
      }
      seenHints.add(hint.id);
    }
  });
export type MemoryInputV0 = z.infer<typeof MemoryInputV0>;

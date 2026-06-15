import { z } from 'zod';
import { StageId, StepId } from './ids.js';
import { SelectionOverride } from './selection-policy.js';

export const CanonicalStage = z.enum([
  'frame',
  'analyze',
  'plan',
  'act',
  'verify',
  'review',
  'close',
]);
export type CanonicalStage = z.infer<typeof CanonicalStage>;

// Stage carries an optional `selection: SelectionOverride`, symmetric
// with Step.selection and CompiledFlow.default_selection. `.strict()`
// rejects surplus keys at the Stage level.
export const Stage = z
  .object({
    id: StageId,
    title: z.string().min(1),
    canonical: CanonicalStage.optional(),
    steps: z.array(StepId).min(1),
    selection: SelectionOverride.optional(),
  })
  .strict();
export type Stage = z.infer<typeof Stage>;

export const CANONICAL_STAGES = [
  'frame',
  'analyze',
  'plan',
  'act',
  'verify',
  'review',
  'close',
] as const satisfies readonly CanonicalStage[];

// Minimum length for a partial spine's rationale. Exported so callers that
// pre-check before SpinePolicy.parse (the flow assembler) share the one source
// of truth instead of duplicating the literal.
export const PARTIAL_SPINE_RATIONALE_MIN_LENGTH = 20;

// SpinePolicy is a plain discriminated union (no superRefine on the variants)
// so Zod's discriminated-union machinery can relay on the `mode` literal.
// Structural invariants that span the whole variant — notably, omits must be
// pairwise unique and disjoint from declared canonicals — are enforced in
// the CompiledFlow superRefine where the
// surrounding wf.stages context is available.
export const SpinePolicy = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('strict'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('partial'),
      omits: z.array(CanonicalStage).min(1),
      rationale: z.string().min(PARTIAL_SPINE_RATIONALE_MIN_LENGTH),
    })
    .strict(),
]);
export type SpinePolicy = z.infer<typeof SpinePolicy>;

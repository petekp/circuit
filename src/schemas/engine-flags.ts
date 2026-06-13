import { z } from 'zod';

// Stage 3 (first-class composition): the serialized, snake_case shape of a
// flow's engine-visible behavior flags. One schema, two homes: the authored
// FlowSchematic carries it so a flow (built-in or composed) can DECLARE
// behavior, and the compiled manifest carries it so the engine can READ that
// behavior without a by-id catalog package lookup. It mirrors the in-code
// `CompiledFlowEngineFlags` (camelCase) in src/flows/types.ts; the
// manifest->runtime boundary (`manifestEngineFlagsToInCode`) translates between
// the two. Absent = the flow declares no engine flags.
//
// See docs/ideas/first-class-composition-sequence.md (Stage 3).
export const EngineFlagsManifest = z
  .object({
    binds_execution_depth_to_relay_selection: z.boolean().optional(),
    binds_terminal_outcome_to_primary_result: z.boolean().optional(),
    iterates_slice_loop: z
      .object({
        head_step: z.string().min(1),
        tail_step: z.string().min(1),
        advance_route: z.string().min(1),
        slices_from: z
          .object({
            report: z.string().min(1),
            items_path: z.string().min(1),
          })
          .strict(),
        max_slices: z.number().int().positive(),
        activate_when_depth_at_least: z.literal('high'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EngineFlagsManifest = z.infer<typeof EngineFlagsManifest>;

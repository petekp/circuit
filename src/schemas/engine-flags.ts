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
    // The until loop (a while loop for flows): re-enter [head..tail] once per
    // iteration until max_iterations. Mutually exclusive with iterates_slice_loop
    // (both drive one re-entry counter); the graph runner rejects a flow that
    // sets both. body_steps is the full span head and tail included, because
    // every body step must be iteration-scoped, not just the adjacent head/tail
    // the slice loop scopes. See docs/ideas/until-loop.md.
    iterates_until_condition: z
      .object({
        head_step: z.string().min(1),
        tail_step: z.string().min(1),
        body_steps: z.array(z.string().min(1)).min(1),
        reenter_route: z.string().min(1),
        max_iterations: z.number().int().positive(),
        // Slice 2 (the stop-judge): the tail proposes a goal-met boolean the
        // engine disposes against an evidence floor. report + goal_met_path say
        // where to read the proposal; needs_attention_route is where an exhausted
        // judge-gated loop exits (a non-@complete terminal). Both absent = the
        // slice-1 count-driven form. lesson_path (slice 4) and progress_path
        // (slice 6) are optional dotted paths to a carried lesson and an opaque
        // progress marker the engine disposes; absent = those features off.
        stop_judge: z
          .object({
            report: z.string().min(1),
            goal_met_path: z.string().min(1),
            lesson_path: z.string().min(1).optional(),
            progress_path: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        needs_attention_route: z.string().min(1).optional(),
        // Slice 4 (carried notes): the run-file the engine appends one note to per
        // iteration; the head re-reads it next pass. max_entries caps retained
        // notes (default 20). Absent = no notes carried.
        carried_notes: z
          .object({
            report: z.string().min(1),
            max_entries: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        // Slice 5 (cumulative budget cap, fail-closed): hard spend ceilings summed
        // across iterations from per-relay usage. At or above the cap the loop exits
        // to needs_attention rather than spending more. Absent = no cap.
        cumulative_usd_cap: z.number().positive().optional(),
        cumulative_token_cap: z.number().int().positive().optional(),
        // Slice 6 (no-progress ceiling): consecutive no-progress iterations
        // tolerated before exiting to needs_attention. Requires
        // stop_judge.progress_path. Absent = only the iteration cap bounds the loop.
        no_progress_ceiling: z.number().int().positive().optional(),
        // Slice 7 (per-iteration commit containment, opt-in, default off). When
        // set AND the host injects a commit-containment runner, each iteration
        // is committed to a throwaway branch named `${branch_prefix}-${run_id}`;
        // the operator owns the merge. Absent => the engine makes zero git calls.
        iteration_commit_containment: z
          .object({
            branch_prefix: z.string().min(1),
          })
          .strict()
          .optional(),
        activate_when_depth_at_least: z.literal('autonomous'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EngineFlagsManifest = z.infer<typeof EngineFlagsManifest>;

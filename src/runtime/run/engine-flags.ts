// First-class composition: the seam that resolves a flow's engine-visible
// behavior flags. The engine reads them off the compiled manifest the flow was
// loaded from, so a composed or published custom flow resolves its flags the
// same way a built-in does — there is no by-id catalog package in the path.
//
// Two functions, two jobs:
//   - `manifestEngineFlagsToInCode` translates the snake_case flags carried on
//     the compiled manifest into the in-code camelCase `CompiledFlowEngineFlags`
//     shape. It runs ONCE, at the manifest→runtime boundary (`fromCompiledFlow`),
//     so the rest of the engine never sees the wire shape.
//   - `resolveEngineFlags` returns the runtime flow's flags. Every flow that has
//     engine flags serializes them onto its manifest (Stage 3 + 3b), so this is a
//     direct read; the by-id package fallback it once merged over is gone (M4).
//     Absent = the flow declares none.
//
// See docs/architecture/first-class-composition-optimal-path.md (M4).
import type {
  CompiledFlowEngineFlags,
  SliceLoopEngineFlag,
  UntilLoopEngineFlag,
} from '../../flows/types.js';
import type { CompiledFlowManifestEngineFlags } from '../../schemas/compiled-flow.js';

function translateSliceLoop(
  slice: NonNullable<CompiledFlowManifestEngineFlags['iterates_slice_loop']>,
): SliceLoopEngineFlag {
  return {
    headStep: slice.head_step,
    tailStep: slice.tail_step,
    advanceRoute: slice.advance_route,
    slicesFrom: { report: slice.slices_from.report, itemsPath: slice.slices_from.items_path },
    maxSlices: slice.max_slices,
    activateWhenDepthAtLeast: slice.activate_when_depth_at_least,
  };
}

function translateUntilLoop(
  until: NonNullable<CompiledFlowManifestEngineFlags['iterates_until_condition']>,
): UntilLoopEngineFlag {
  return {
    headStep: until.head_step,
    tailStep: until.tail_step,
    bodySteps: until.body_steps,
    reenterRoute: until.reenter_route,
    maxIterations: until.max_iterations,
    ...(until.stop_judge === undefined
      ? {}
      : {
          stopJudge: {
            report: until.stop_judge.report,
            goalMetPath: until.stop_judge.goal_met_path,
            ...(until.stop_judge.lesson_path === undefined
              ? {}
              : { lessonPath: until.stop_judge.lesson_path }),
            ...(until.stop_judge.progress_path === undefined
              ? {}
              : { progressPath: until.stop_judge.progress_path }),
          },
        }),
    ...(until.needs_attention_route === undefined
      ? {}
      : { needsAttentionRoute: until.needs_attention_route }),
    ...(until.carried_notes === undefined
      ? {}
      : {
          carriedNotes: {
            report: until.carried_notes.report,
            ...(until.carried_notes.max_entries === undefined
              ? {}
              : { maxEntries: until.carried_notes.max_entries }),
          },
        }),
    ...(until.cumulative_usd_cap === undefined
      ? {}
      : { cumulativeUsdCap: until.cumulative_usd_cap }),
    ...(until.cumulative_token_cap === undefined
      ? {}
      : { cumulativeTokenCap: until.cumulative_token_cap }),
    ...(until.no_progress_ceiling === undefined
      ? {}
      : { noProgressCeiling: until.no_progress_ceiling }),
    ...(until.iteration_commit_containment === undefined
      ? {}
      : {
          iterationCommitContainment: {
            branchPrefix: until.iteration_commit_containment.branch_prefix,
          },
        }),
    ...(until.frozen_paths === undefined ? {} : { frozenPaths: until.frozen_paths }),
    activateWhenDepthAtLeast: until.activate_when_depth_at_least,
  };
}

export function manifestEngineFlagsToInCode(
  manifest: CompiledFlowManifestEngineFlags | undefined,
): CompiledFlowEngineFlags | undefined {
  if (manifest === undefined) return undefined;
  const slice = manifest.iterates_slice_loop;
  const until = manifest.iterates_until_condition;
  const result: CompiledFlowEngineFlags = {
    ...(manifest.binds_execution_depth_to_relay_selection === undefined
      ? {}
      : {
          bindsExecutionDepthToRelaySelection: manifest.binds_execution_depth_to_relay_selection,
        }),
    ...(manifest.binds_terminal_outcome_to_primary_result === undefined
      ? {}
      : {
          bindsTerminalOutcomeToPrimaryResult: manifest.binds_terminal_outcome_to_primary_result,
        }),
    ...(manifest.relay_uses_prompt_only_context === undefined
      ? {}
      : { relayUsesPromptOnlyContext: manifest.relay_uses_prompt_only_context }),
    ...(slice === undefined ? {} : { iteratesSliceLoop: translateSliceLoop(slice) }),
    ...(until === undefined ? {} : { iteratesUntilCondition: translateUntilLoop(until) }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

export function resolveEngineFlags(flow: {
  readonly engineFlags?: CompiledFlowEngineFlags;
}): CompiledFlowEngineFlags | undefined {
  return flow.engineFlags;
}

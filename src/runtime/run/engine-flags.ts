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
import type { CompiledFlowEngineFlags, SliceLoopEngineFlag } from '../../flows/types.js';
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

export function manifestEngineFlagsToInCode(
  manifest: CompiledFlowManifestEngineFlags | undefined,
): CompiledFlowEngineFlags | undefined {
  if (manifest === undefined) return undefined;
  const slice = manifest.iterates_slice_loop;
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
    ...(slice === undefined ? {} : { iteratesSliceLoop: translateSliceLoop(slice) }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

export function resolveEngineFlags(flow: {
  readonly engineFlags?: CompiledFlowEngineFlags;
}): CompiledFlowEngineFlags | undefined {
  return flow.engineFlags;
}

// Stage 3 (first-class composition): the seam that resolves a flow's
// engine-visible behavior flags. Today the engine reads them off a catalog
// package looked up by flow id (`findCompiledFlowPackageById`), so a composed
// or published custom flow — which has no package — silently loses them all.
//
// Two functions, two jobs:
//   - `manifestEngineFlagsToInCode` translates the snake_case flags carried on
//     the compiled manifest into the in-code camelCase `CompiledFlowEngineFlags`
//     shape. It runs ONCE, at the manifest→runtime boundary (`fromCompiledFlow`),
//     so the rest of the engine never sees the wire shape.
//   - `resolveEngineFlags` merges the runtime flow's flags (from the manifest)
//     with the by-id package's flags, PER FLAG, manifest winning. A built-in
//     whose manifest carries no flags resolves exactly as before (every flag
//     comes from the package); a composed flow with no package gets its flags
//     from the manifest. The package fallback is removed once every built-in
//     serializes its flags onto the manifest.
//
// See docs/ideas/first-class-composition-sequence.md (Stage 3).
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

export function resolveEngineFlags(
  flow: { readonly engineFlags?: CompiledFlowEngineFlags },
  compiledPackage: { readonly engineFlags?: CompiledFlowEngineFlags } | undefined,
): CompiledFlowEngineFlags | undefined {
  const manifest = flow.engineFlags;
  const pkg = compiledPackage?.engineFlags;
  // No manifest flags: the pre-migration path, returned unchanged so a built-in
  // resolves exactly as before.
  if (manifest === undefined) return pkg;

  const depth =
    manifest.bindsExecutionDepthToRelaySelection ?? pkg?.bindsExecutionDepthToRelaySelection;
  const terminal =
    manifest.bindsTerminalOutcomeToPrimaryResult ?? pkg?.bindsTerminalOutcomeToPrimaryResult;
  const slice = manifest.iteratesSliceLoop ?? pkg?.iteratesSliceLoop;

  const merged: CompiledFlowEngineFlags = {
    ...(depth === undefined ? {} : { bindsExecutionDepthToRelaySelection: depth }),
    ...(terminal === undefined ? {} : { bindsTerminalOutcomeToPrimaryResult: terminal }),
    ...(slice === undefined ? {} : { iteratesSliceLoop: slice }),
  };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

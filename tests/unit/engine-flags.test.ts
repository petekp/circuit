// Stage 3 (first-class composition): the resolver seam plus the manifest→runtime
// translation that lets a flow's engine-visible behavior flags come from its
// compiled manifest, not only from a catalog package looked up by flow id. A
// composed or published custom flow has no catalog package, so today it silently
// loses every engineFlag; once the manifest can carry them and the engine reads
// them through this seam, the same flags work for built-ins (via the package
// fallback) and composed flows (via the manifest), with one shared resolution
// path. See docs/ideas/first-class-composition-sequence.md (Stage 3).
import { describe, expect, it } from 'vitest';
import type { CompiledFlowEngineFlags, SliceLoopEngineFlag } from '../../src/flows/types.js';
import {
  manifestEngineFlagsToInCode,
  resolveEngineFlags,
} from '../../src/runtime/run/engine-flags.js';

const SLICE: SliceLoopEngineFlag = {
  headStep: 'act-step',
  tailStep: 'verify-step',
  advanceRoute: 'advance',
  slicesFrom: { report: 'reports/build/plan.json', itemsPath: 'slices' },
  maxSlices: 12,
  activateWhenDepthAtLeast: 'high',
};

describe('manifestEngineFlagsToInCode (manifest→runtime boundary)', () => {
  it('returns undefined for an absent or empty manifest flag block', () => {
    expect(manifestEngineFlagsToInCode(undefined)).toBeUndefined();
    expect(manifestEngineFlagsToInCode({})).toBeUndefined();
  });

  it('translates booleans from snake_case manifest keys to the in-code shape', () => {
    expect(
      manifestEngineFlagsToInCode({
        binds_execution_depth_to_relay_selection: true,
        binds_terminal_outcome_to_primary_result: true,
      }),
    ).toEqual({
      bindsExecutionDepthToRelaySelection: true,
      bindsTerminalOutcomeToPrimaryResult: true,
    });
  });

  it('translates the slice-loop struct field by field', () => {
    expect(
      manifestEngineFlagsToInCode({
        iterates_slice_loop: {
          head_step: 'act-step',
          tail_step: 'verify-step',
          advance_route: 'advance',
          slices_from: { report: 'reports/build/plan.json', items_path: 'slices' },
          max_slices: 12,
          activate_when_depth_at_least: 'high',
        },
      }),
    ).toEqual({ iteratesSliceLoop: SLICE });
  });
});

describe('resolveEngineFlags', () => {
  it('returns the catalog package flags unchanged when the manifest declares none (built-in path)', () => {
    const pkgFlags: CompiledFlowEngineFlags = {
      bindsExecutionDepthToRelaySelection: true,
      iteratesSliceLoop: SLICE,
    };
    expect(resolveEngineFlags({}, { engineFlags: pkgFlags })).toEqual(pkgFlags);
  });

  it('returns undefined when neither the manifest nor a package carries flags', () => {
    expect(resolveEngineFlags({}, undefined)).toBeUndefined();
  });

  it('reads flags off the manifest when no catalog package resolves (composed flow)', () => {
    expect(
      resolveEngineFlags({ engineFlags: { bindsExecutionDepthToRelaySelection: true } }, undefined),
    ).toEqual({ bindsExecutionDepthToRelaySelection: true });
    expect(resolveEngineFlags({ engineFlags: { iteratesSliceLoop: SLICE } }, undefined)).toEqual({
      iteratesSliceLoop: SLICE,
    });
  });

  it('merges per field: the manifest wins where it declares, the package fills the rest', () => {
    // The migration keeps the by-id resolve as a per-flag fallback. A manifest
    // that sets only the depth bind must not wipe a package-provided slice loop.
    const resolved = resolveEngineFlags(
      { engineFlags: { bindsExecutionDepthToRelaySelection: true } },
      { engineFlags: { iteratesSliceLoop: SLICE } },
    );
    expect(resolved).toEqual({
      bindsExecutionDepthToRelaySelection: true,
      iteratesSliceLoop: SLICE,
    });
  });

  it('lets the manifest override a package flag of the same name', () => {
    const resolved = resolveEngineFlags(
      { engineFlags: { bindsExecutionDepthToRelaySelection: false } },
      { engineFlags: { bindsExecutionDepthToRelaySelection: true } },
    );
    expect(resolved?.bindsExecutionDepthToRelaySelection).toBe(false);
  });
});

// First-class composition: the resolver seam plus the manifest→runtime
// translation that lets a flow's engine-visible behavior flags come from its
// compiled manifest. A built-in and a composed or published custom flow resolve
// their flags the same way — off the manifest — with no by-id catalog package in
// the path (M4 deleted it). See
// docs/architecture/first-class-composition-optimal-path.md.
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
  it('returns the flow manifest flags unchanged', () => {
    const flags: CompiledFlowEngineFlags = {
      bindsExecutionDepthToRelaySelection: true,
      iteratesSliceLoop: SLICE,
    };
    expect(resolveEngineFlags({ engineFlags: flags })).toEqual(flags);
  });

  it('returns undefined when the flow carries no flags', () => {
    expect(resolveEngineFlags({})).toBeUndefined();
  });

  it('reads each flag category off the manifest', () => {
    expect(
      resolveEngineFlags({ engineFlags: { bindsExecutionDepthToRelaySelection: true } }),
    ).toEqual({ bindsExecutionDepthToRelaySelection: true });
    expect(resolveEngineFlags({ engineFlags: { iteratesSliceLoop: SLICE } })).toEqual({
      iteratesSliceLoop: SLICE,
    });
  });
});

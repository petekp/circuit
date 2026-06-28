// First-class composition: the resolver seam plus the manifest→runtime
// translation that lets a flow's engine-visible behavior flags come from its
// compiled manifest. A built-in and a composed or published custom flow resolve
// their flags the same way — off the manifest — with no by-id catalog package in
// the path (M4 deleted it). See
// docs/architecture/first-class-composition-optimal-path.md.
import { describe, expect, it } from 'vitest';
import type {
  CompiledFlowEngineFlags,
  SliceLoopEngineFlag,
  UntilLoopEngineFlag,
} from '../../src/flows/types.js';
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

const UNTIL: UntilLoopEngineFlag = {
  headStep: 'loop-head',
  tailStep: 'loop-tail',
  bodySteps: ['loop-head', 'loop-body', 'loop-tail'],
  reenterRoute: 'reenter',
  maxIterations: 3,
  activateWhenDepthAtLeast: 'autonomous',
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

  it('translates the until-loop struct field by field', () => {
    // Without this, a real flow that authors an until loop onto its manifest
    // loses the flag at the manifest->runtime boundary and runs as a single
    // pass with no error. The in-memory ExecutableFlow.engineFlags path the
    // runtime tests use bypasses this translation; real flows do not.
    expect(
      manifestEngineFlagsToInCode({
        iterates_until_condition: {
          head_step: 'loop-head',
          tail_step: 'loop-tail',
          body_steps: ['loop-head', 'loop-body', 'loop-tail'],
          reenter_route: 'reenter',
          max_iterations: 3,
          activate_when_depth_at_least: 'autonomous',
        },
      }),
    ).toEqual({ iteratesUntilCondition: UNTIL });
  });

  it('translates the slice-2 stop-judge fields when present', () => {
    // The stop-judge form ships report+goal_met_path and a needs_attention_route
    // on the manifest. A real Converge flow authors these, so the translation
    // must carry them onto the in-code shape (snake_case to camelCase) or the
    // judge-gated loop silently degrades to the count-driven form.
    expect(
      manifestEngineFlagsToInCode({
        iterates_until_condition: {
          head_step: 'loop-head',
          tail_step: 'loop-tail',
          body_steps: ['loop-head', 'loop-body', 'loop-tail'],
          reenter_route: 'reenter',
          max_iterations: 3,
          stop_judge: { report: 'reports/judge.json', goal_met_path: 'goal_met' },
          needs_attention_route: 'attention',
          activate_when_depth_at_least: 'autonomous',
        },
      }),
    ).toEqual({
      iteratesUntilCondition: {
        ...UNTIL,
        stopJudge: { report: 'reports/judge.json', goalMetPath: 'goal_met' },
        needsAttentionRoute: 'attention',
      },
    });
  });

  it('translates frozen_paths (the read-only eval surface) to frozenPaths', () => {
    // The frozen-eval guard reads its declared paths off the in-code flag, so the
    // manifest's snake_case array must arrive as camelCase frozenPaths or the
    // guard is never constructed and a tampered eval surface goes uncaught.
    expect(
      manifestEngineFlagsToInCode({
        iterates_until_condition: {
          head_step: 'loop-head',
          tail_step: 'loop-tail',
          body_steps: ['loop-head', 'loop-body', 'loop-tail'],
          reenter_route: 'reenter',
          max_iterations: 3,
          frozen_paths: ['eval.txt', 'tests/expected.json'],
          activate_when_depth_at_least: 'autonomous',
        },
      }),
    ).toEqual({
      iteratesUntilCondition: { ...UNTIL, frozenPaths: ['eval.txt', 'tests/expected.json'] },
    });
  });

  it('leaves frozenPaths absent when the manifest declares no frozen_paths', () => {
    // Absent must stay absent (off, byte-identical): no shipped flow sets this
    // field, so the default translation must not invent it.
    const translated = manifestEngineFlagsToInCode({
      iterates_until_condition: {
        head_step: 'loop-head',
        tail_step: 'loop-tail',
        body_steps: ['loop-head', 'loop-body', 'loop-tail'],
        reenter_route: 'reenter',
        max_iterations: 3,
        activate_when_depth_at_least: 'autonomous',
      },
    });
    expect(translated?.iteratesUntilCondition).not.toHaveProperty('frozenPaths');
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

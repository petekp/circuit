// Stage 3b (first-class composition): proves a real built-in's engine-visible
// behavior flags travel on its compiled MANIFEST, not only on the by-id catalog
// package. `goal` was the first flow rehomed off the package onto the manifest;
// `build` and `prototype` follow. Each declares engine_flags on its schematic,
// the compiler propagates them to the compiled manifest, and fromCompiledFlow
// translates them onto ExecutableFlow.engineFlags. If the schematic field, the
// compiler propagation, or the boundary translation breaks, the flag silently
// vanishes and these tests go red.
//
// The behavior-equivalence block is the load-bearing proof for the rehome: the
// engine reads its flags through resolveEngineFlags(flow, package). Moving the
// flags from the package to the manifest must not change the resolved value the
// engine actually uses, whether or not a by-id package still carries them.
//
// See docs/ideas/first-class-composition-sequence.md (Stage 3).
import { describe, expect, it } from 'vitest';
import { findCompiledFlowPackageById, flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompileResult,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { resolveEngineFlags } from '../../src/runtime/run/engine-flags.js';

function firstCompiledFlow(result: CompileResult) {
  if (result.kind === 'single') return result.flow;
  const first = [...result.flows.values()][0];
  if (first === undefined) throw new Error('per-mode compile produced no flows');
  return first;
}

function compiledFlow(id: string) {
  const definition = flowDefinitions.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`missing ${id} flow definition`);
  return firstCompiledFlow(compileSchematicToCompiledFlow(definition.schematic));
}

describe('engine_flags on the compiled manifest (goal, Stage 3b)', () => {
  it('compiles goal with the terminal-outcome bind carried on the manifest', () => {
    const flow = compiledFlow('goal');
    expect(flow.engine_flags?.binds_terminal_outcome_to_primary_result).toBe(true);
  });

  it('translates the manifest flag onto ExecutableFlow.engineFlags at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledFlow('goal'));
    expect(executable.engineFlags?.bindsTerminalOutcomeToPrimaryResult).toBe(true);
  });
});

describe('engine_flags on the compiled manifest (build, Stage 3b)', () => {
  it('compiles build with the depth bind and slice loop carried on the manifest', () => {
    const flow = compiledFlow('build');
    expect(flow.engine_flags?.binds_execution_depth_to_relay_selection).toBe(true);
    expect(flow.engine_flags?.iterates_slice_loop).toEqual({
      head_step: 'act-step',
      tail_step: 'verify-step',
      advance_route: 'advance',
      slices_from: { report: 'reports/build/plan.json', items_path: 'slices' },
      max_slices: 8,
      activate_when_depth_at_least: 'high',
    });
  });

  it('translates the build flags onto ExecutableFlow.engineFlags at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledFlow('build'));
    expect(executable.engineFlags).toEqual({
      bindsExecutionDepthToRelaySelection: true,
      iteratesSliceLoop: {
        headStep: 'act-step',
        tailStep: 'verify-step',
        advanceRoute: 'advance',
        slicesFrom: { report: 'reports/build/plan.json', itemsPath: 'slices' },
        maxSlices: 8,
        activateWhenDepthAtLeast: 'high',
      },
    });
  });
});

describe('engine_flags on the compiled manifest (prototype, Stage 3b)', () => {
  it('compiles prototype with the depth bind carried on the manifest', () => {
    const flow = compiledFlow('prototype');
    expect(flow.engine_flags?.binds_execution_depth_to_relay_selection).toBe(true);
    expect(flow.engine_flags?.iterates_slice_loop).toBeUndefined();
  });

  it('translates the prototype flag onto ExecutableFlow.engineFlags at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledFlow('prototype'));
    expect(executable.engineFlags).toEqual({ bindsExecutionDepthToRelaySelection: true });
  });
});

describe('behavior-equivalence: the engine resolves the same flags after the rehome', () => {
  // The runtime reads its flags through resolveEngineFlags(flow, package). With
  // the flags now on the manifest and removed from the package, the manifest
  // wins and the package contributes nothing — the resolved value is unchanged.
  // These assertions hold whether or not the package still carries flags, so
  // they stay green through M4 (package read deleted) too.
  it('resolves build to the same depth bind and slice loop the package used to provide', () => {
    const executable = fromCompiledFlow(compiledFlow('build'));
    const resolved = resolveEngineFlags(executable, findCompiledFlowPackageById('build'));
    expect(resolved).toEqual({
      bindsExecutionDepthToRelaySelection: true,
      iteratesSliceLoop: {
        headStep: 'act-step',
        tailStep: 'verify-step',
        advanceRoute: 'advance',
        slicesFrom: { report: 'reports/build/plan.json', itemsPath: 'slices' },
        maxSlices: 8,
        activateWhenDepthAtLeast: 'high',
      },
    });
  });

  it('resolves prototype to the same depth bind the package used to provide', () => {
    const executable = fromCompiledFlow(compiledFlow('prototype'));
    const resolved = resolveEngineFlags(executable, findCompiledFlowPackageById('prototype'));
    expect(resolved).toEqual({ bindsExecutionDepthToRelaySelection: true });
  });
});

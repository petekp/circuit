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
// engine reads its flags through resolveEngineFlags(flow). Moving the flags from
// the package to the manifest, then deleting the by-id package (M4), must not
// change the resolved value the engine actually uses.
//
// See docs/architecture/first-class-composition-optimal-path.md.
import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
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

// The terminal-outcome bind no longer rides an engine flag. Declaring a
// primary result is what arms it, so the primary-result surface is the thing
// that must survive compilation for goal to close honestly.
describe('the primary-result surface on the compiled manifest (goal)', () => {
  it('compiles goal with its primary result carried on the manifest', () => {
    const flow = compiledFlow('goal');
    expect(flow.runtime_surface?.primary_result?.path).toBe('reports/goal-result.json');
  });

  it('translates the primary result onto ExecutableFlow at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledFlow('goal'));
    expect(executable.runtimeSurface?.primaryResult?.path).toBe('reports/goal-result.json');
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

describe('engine_flags on the compiled manifest (review)', () => {
  it('keeps every Review relay limited to the evidence in its prompt', () => {
    const flow = compiledFlow('review');
    expect(flow.engine_flags?.relay_uses_prompt_only_context).toBe(true);
    const executable = fromCompiledFlow(flow);
    expect(executable.engineFlags?.relayUsesPromptOnlyContext).toBe(true);
  });
});

describe('behavior-equivalence: the engine resolves the flags off the manifest', () => {
  // The runtime reads its flags through resolveEngineFlags(flow). With the flags
  // on the manifest and the by-id package deleted (M4), the resolved value the
  // engine uses is exactly what the manifest carries — unchanged from the value
  // the package used to provide before the rehome.
  it('resolves build to the same depth bind and slice loop the package used to provide', () => {
    const executable = fromCompiledFlow(compiledFlow('build'));
    const resolved = resolveEngineFlags(executable);
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
    const resolved = resolveEngineFlags(executable);
    expect(resolved).toEqual({ bindsExecutionDepthToRelaySelection: true });
  });
});

// M4 (first-class composition): the run-start legibility seam after the by-id
// package was dissolved. The compiled manifest is the sole authority, so
// `resolveBindingLegibility` takes only the runtime flow. `manifestBackedBindings`
// reports the catalog-sourced bindings the flow declares on its manifest;
// `reducedBindings` is empty for every flow until composed flows bring a
// block-level needs model (M9). See src/runtime/run/binding-legibility.ts.
import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompileResult,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import {
  type BindingDeclaringFlow,
  CATALOG_SOURCED_BINDINGS,
  resolveBindingLegibility,
} from '../../src/runtime/run/binding-legibility.js';
import { CatalogSourcedBinding } from '../../src/schemas/trace-entry.js';

// A flow whose manifest declares no binding sources at all (the bare composed
// flow). Every field the net inspects is absent.
const NO_DECLARATIONS: BindingDeclaringFlow = {};

function firstCompiledFlow(result: CompileResult) {
  if (result.kind === 'single') return result.flow;
  const first = [...result.flows.values()][0];
  if (first === undefined) throw new Error('per-mode compile produced no flows');
  return first;
}

describe('resolveBindingLegibility (single-source manifest)', () => {
  it('backs nothing, and reduces nothing, for a flow that declares no binding sources', () => {
    const result = resolveBindingLegibility(NO_DECLARATIONS);
    expect(result.manifestBackedBindings).toEqual([]);
    // No package oracle remains, so a missing declaration is an intentional
    // absence, not a loss. Reduced is empty regardless of input.
    expect(result.reducedBindings).toEqual([]);
  });

  it('treats a manifest engine_flags block as authority over all three flag bindings', () => {
    // Category authority, not value authority. A flow that declares engineFlags
    // but leaves slice_loop unset (like Fix) still BACKS slice_loop: the author
    // has taken authority over the engine-flag category, so the omission within
    // it is intentional. Keying on a specific flag's value would falsely strand
    // the omitted ones.
    const flow: BindingDeclaringFlow = {
      engineFlags: { bindsTerminalOutcomeToPrimaryResult: true },
    };
    const result = resolveBindingLegibility(flow);
    expect(result.manifestBackedBindings).toEqual([
      'depth_binding',
      'slice_loop',
      'terminal_outcome_binding',
    ]);
    // The two surface bindings have no manifest source here, but with the package
    // oracle gone there is nothing to call them "lost" — reduced stays empty.
    expect(result.reducedBindings).toEqual([]);
  });

  it('backs every binding when the manifest declares all three categories (even empty)', () => {
    // Field presence = category authority, uniform across all five bindings.
    const flow: BindingDeclaringFlow = {
      engineFlags: {},
      reportFileSurfaces: {},
      runtimeSurface: {},
    };
    const result = resolveBindingLegibility(flow);
    expect(result.manifestBackedBindings).toEqual([...CATALOG_SOURCED_BINDINGS]);
    expect(result.reducedBindings).toEqual([]);
  });

  it('keeps the binding name set in sync with the trace schema enum', () => {
    expect([...CATALOG_SOURCED_BINDINGS]).toEqual([...CatalogSourcedBinding.options]);
    expect([...CATALOG_SOURCED_BINDINGS]).toEqual([
      'edit_file_surfaces',
      'depth_binding',
      'slice_loop',
      'terminal_outcome_binding',
      'primary_result_surface',
    ]);
  });
});

describe('M4 gating proof: the manifest is the sole binding source for every built-in', () => {
  // The standing proof that dissolving the by-id package cost no capability:
  // every real flow resolves its catalog-sourced bindings off the manifest, so
  // no built-in run reports a reduced binding. (The resolved VALUES are pinned
  // equal to the old package values by the manifest-roundtrip drift guards in
  // engine-flags-manifest-roundtrip and execution-declarations-manifest-roundtrip.)
  it('every built-in resolves with an empty reduced set, and the manifests cover all binding categories', () => {
    const backedUnion = new Set<CatalogSourcedBinding>();
    for (const definition of flowDefinitions) {
      const flow = fromCompiledFlow(
        firstCompiledFlow(compileSchematicToCompiledFlow(definition.schematic)),
      );
      const result = resolveBindingLegibility(flow);
      expect(result.reducedBindings, `${definition.id} reduced`).toEqual([]);
      for (const binding of result.manifestBackedBindings) backedUnion.add(binding);
    }
    // Across the built-ins, the manifest path carries every binding category —
    // proof the catalog-sourced bindings really resolve from the manifest now,
    // not from nothing.
    expect([...backedUnion].sort()).toEqual([...CATALOG_SOURCED_BINDINGS].sort());
  });
});

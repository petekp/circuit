// M2 (first-class composition): the run-start legibility seam, now
// declaration-aware. A binding is "lost" only when no declared source provides
// it — neither the runtime flow's manifest declarations nor a by-id catalog
// package. The new `manifestBackedBindings` set is the instrument the linchpin
// (M4) reads to prove a binding survives package removal before deleting the
// fallback. See src/runtime/run/binding-legibility.ts.
import { describe, expect, it } from 'vitest';
import type { CompiledFlowPackage } from '../../src/flows/types.js';
import {
  type BindingDeclaringFlow,
  CATALOG_SOURCED_BINDINGS,
  resolveBindingLegibility,
} from '../../src/runtime/run/binding-legibility.js';
import { CatalogSourcedBinding } from '../../src/schemas/trace-entry.js';

// A flow whose manifest declares no binding sources at all (the bare composed
// flow). Every field the net inspects is absent.
const NO_DECLARATIONS: BindingDeclaringFlow = {};

describe('resolveBindingLegibility', () => {
  it('reports every catalog-sourced binding lost when neither manifest nor package provides them', () => {
    const result = resolveBindingLegibility(NO_DECLARATIONS, undefined);
    expect(result.packageResolved).toBe(false);
    expect(result.reducedBindings).toEqual([...CATALOG_SOURCED_BINDINGS]);
    expect(result.manifestBackedBindings).toEqual([]);
    // A fresh array, not a shared reference to the module constant.
    expect(result.reducedBindings).not.toBe(CATALOG_SOURCED_BINDINGS);
  });

  it('reports no reduction when a catalog package resolves, even one that declares bindings off', () => {
    // Anti-over-fire, unchanged from Stage 1: a resolved package means whatever
    // it declares (present or absent) is intentional, so nothing reads as lost.
    // A built-in like Fix with no slice loop must not read as having lost one.
    const pkg = {} as CompiledFlowPackage;
    const result = resolveBindingLegibility(NO_DECLARATIONS, pkg);
    expect(result.packageResolved).toBe(true);
    expect(result.reducedBindings).toEqual([]);
  });

  it('treats a manifest engine_flags block as authority over all three flag bindings', () => {
    // Category authority, not value authority. A flow that declares engineFlags
    // but leaves slice_loop unset (like Fix) still BACKS slice_loop: the author
    // has taken authority over the engine-flag category, so the omission is
    // intentional, exactly as a package's omission is. Keying on a specific
    // flag's value would falsely strand the omitted ones forever.
    const flow: BindingDeclaringFlow = {
      engineFlags: { bindsTerminalOutcomeToPrimaryResult: true },
    };
    const result = resolveBindingLegibility(flow, undefined);
    expect(result.manifestBackedBindings).toEqual([
      'depth_binding',
      'slice_loop',
      'terminal_outcome_binding',
    ]);
    // The two non-flag bindings have no manifest source here, and no package,
    // so they are the only reduced ones. This is the shrinking property: a
    // composed flow with manifest flags loses 2, not 5.
    expect(result.reducedBindings).toEqual(['edit_file_surfaces', 'primary_result_surface']);
  });

  it('backs the surface bindings when the manifest declares their fields (even empty)', () => {
    // Field presence = category authority, uniform across all five bindings.
    const flow: BindingDeclaringFlow = {
      engineFlags: {},
      reportFileSurfaces: {},
      runtimeSurface: {},
    };
    const result = resolveBindingLegibility(flow, undefined);
    // engineFlags present (block authority) + both surface fields present →
    // every binding is manifest-backed, nothing reduced, even with no package.
    expect(result.manifestBackedBindings).toEqual([...CATALOG_SOURCED_BINDINGS]);
    expect(result.reducedBindings).toEqual([]);
  });

  it('computes manifestBackedBindings independent of package presence (the linchpin readiness signal)', () => {
    // The readiness instrument must report what the MANIFEST guarantees,
    // regardless of whether a package happens to resolve today. M4 deletes a
    // flow's by-id fallback only once this set covers every binding.
    const flow: BindingDeclaringFlow = { engineFlags: {} };
    const pkg = {} as CompiledFlowPackage;
    const result = resolveBindingLegibility(flow, pkg);
    expect(result.packageResolved).toBe(true);
    // Reduced is empty (package present), but the manifest only backs the flag
    // bindings — so this flow is NOT yet ready for fallback removal.
    expect(result.reducedBindings).toEqual([]);
    expect(result.manifestBackedBindings).toEqual([
      'depth_binding',
      'slice_loop',
      'terminal_outcome_binding',
    ]);
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

// Stage 1 (first-class composition): the run-start legibility seam that makes
// silent capability loss visible. A composed or published custom flow whose id
// matches no catalog package loses every catalog-sourced binding today with no
// signal; this function decides what to record on `run.bootstrapped`.
import { describe, expect, it } from 'vitest';
import type { CompiledFlowPackage } from '../../src/flows/types.js';
import {
  CATALOG_SOURCED_BINDINGS,
  resolveBindingLegibility,
} from '../../src/runtime/run/binding-legibility.js';
import { CatalogSourcedBinding } from '../../src/schemas/trace-entry.js';

describe('resolveBindingLegibility', () => {
  it('reports every catalog-sourced binding lost when no package resolves (a composed/custom flow)', () => {
    const result = resolveBindingLegibility(undefined);
    expect(result.packageResolved).toBe(false);
    expect(result.reducedBindings).toEqual([...CATALOG_SOURCED_BINDINGS]);
    // A fresh array, not a shared reference to the module constant.
    expect(result.reducedBindings).not.toBe(CATALOG_SOURCED_BINDINGS);
  });

  it('reports no reduction when a catalog package resolves, even one that declares bindings off', () => {
    // The package's contents are irrelevant: a resolved package means whatever
    // it declares (present or absent) is intentional, so nothing is flagged as
    // lost. This is the anti-over-fire property — a built-in like Fix that has
    // no slice loop must not read as having lost one.
    const pkg = {} as CompiledFlowPackage;
    const result = resolveBindingLegibility(pkg);
    expect(result.packageResolved).toBe(true);
    expect(result.reducedBindings).toEqual([]);
  });

  it('keeps the binding name set in sync with the trace schema enum', () => {
    // The runtime constant and the schema enum must never drift; the former is
    // derived from the latter, and this pins the canonical order too.
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

import type { CompiledFlowPackage } from '../../flows/types.js';
import { CatalogSourcedBinding } from '../../schemas/trace-entry.js';

/**
 * The catalog-sourced bindings, in a stable display order. These are the
 * behaviors the runtime resolves from a flow's compiled package at run start
 * (`findCompiledFlowPackageById`): the edit-file surface table, the
 * depth/slice/terminal-outcome engine flags, and the primary-result surface.
 *
 * When no package resolves for a flow id — a composed or published custom flow
 * whose id is not one of the catalog flows — every one of these falls back to a
 * default today with zero signal: no depth binding, no slice loop, an empty
 * edit-file surface table, and so on. Stage 1 of the first-class composition
 * migration records which ones were lost so the trace and receipt make the
 * degradation legible.
 *
 * Kept as the single source of truth (derived from the schema enum so the two
 * never drift) so later stages — which move these bindings off catalog identity
 * and onto the manifest — can shrink the lost set by teaching
 * `resolveBindingLegibility` to read the new source first.
 */
export const CATALOG_SOURCED_BINDINGS: readonly CatalogSourcedBinding[] =
  CatalogSourcedBinding.options;

export interface BindingLegibility {
  /** Whether a catalog package resolved for this flow id. */
  packageResolved: boolean;
  /** Catalog-sourced bindings unavailable because no package resolved. */
  reducedBindings: CatalogSourcedBinding[];
}

/**
 * Decide which catalog-sourced bindings a run actually got.
 *
 * Today the catalog package is the only source for these bindings, so the rule
 * is simple and honest:
 *
 * - Package resolved → nothing is "reduced". Whatever the package declares,
 *   present or absent, is intentional. This is the key anti-over-fire property:
 *   a built-in flow that legitimately has no slice loop (Fix) is NOT flagged as
 *   having lost one.
 * - Package absent → the whole set fell back to defaults. This is the
 *   composed/custom-flow case, and the only case that produces a non-empty
 *   reduced set.
 *
 * Later stages keep this signature and extend the body: once a binding reads
 * from the manifest, it is only "reduced" when neither the manifest nor a
 * package provides it, so the reduced set naturally shrinks as the migration
 * progresses.
 */
export function resolveBindingLegibility(
  compiledPackage: CompiledFlowPackage | undefined,
): BindingLegibility {
  if (compiledPackage !== undefined) {
    return { packageResolved: true, reducedBindings: [] };
  }
  return { packageResolved: false, reducedBindings: [...CATALOG_SOURCED_BINDINGS] };
}

import type { CompiledFlowEngineFlags, CompiledFlowPackage } from '../../flows/types.js';
import { CatalogSourcedBinding } from '../../schemas/trace-entry.js';

/**
 * The catalog-sourced bindings, in a stable display order. These are the
 * behaviors the runtime resolves at run start: the edit-file surface table, the
 * depth/slice/terminal-outcome engine flags, and the primary-result surface.
 *
 * Originally (Stage 1) every one of these came only from the by-id catalog
 * package (`findCompiledFlowPackageById`); a composed or published custom flow
 * whose id matched no package lost them all silently. The migration moves each
 * binding onto the compiled manifest, so a flow declares its own behavior and
 * the by-id package becomes a fallback the linchpin (M4) can delete.
 *
 * Kept as the single source of truth (derived from the schema enum so the two
 * never drift) so the legibility net can map each binding to its declaration
 * source.
 */
export const CATALOG_SOURCED_BINDINGS: readonly CatalogSourcedBinding[] =
  CatalogSourcedBinding.options;

/**
 * The manifest-side declarations the legibility net inspects. Structural on
 * purpose: today the runtime `ExecutableFlow` carries only `engineFlags` (Stage
 * 3); M3 adds `reportFileSurfaces` and `runtimeSurface` to the manifest and the
 * runtime flow, and they flow through here with no signature change. Anything
 * the manifest does not yet carry reads as undefined, which the net treats as
 * "not manifest-backed" — so the binding still resolves from the package until
 * M3 moves it.
 */
export interface BindingDeclaringFlow {
  readonly engineFlags?: CompiledFlowEngineFlags;
  readonly reportFileSurfaces?: Readonly<Record<string, unknown>>;
  readonly runtimeSurface?: { readonly primaryResult?: unknown };
}

export interface BindingLegibility {
  /** Whether a by-id catalog package resolved for this flow id. */
  packageResolved: boolean;
  /**
   * Catalog-sourced bindings the run got from NO declared source — neither a
   * manifest declaration nor a package. Non-empty only for a flow with no
   * package whose manifest does not declare the binding's source.
   */
  reducedBindings: CatalogSourcedBinding[];
  /**
   * Catalog-sourced bindings the manifest declares, independent of whether a
   * package also resolved. This is the linchpin's readiness instrument: M4 may
   * delete a flow's by-id fallback only once this set covers every binding,
   * because then removing the package loses nothing.
   */
  manifestBackedBindings: CatalogSourcedBinding[];
}

/**
 * Whether the manifest carries the declaration source that owns a binding.
 *
 * Authority is CATEGORY-level, not value-level: an `engineFlags` block backs
 * all three flag bindings even when it leaves one unset, because the author has
 * taken authority over the engine-flag category and an omission is intentional
 * (exactly as a resolved package's omission is intentional). Keying on a
 * specific flag's value would falsely strand the omitted ones forever — Fix,
 * which legitimately has no slice loop, would never count slice_loop as backed
 * and M4 could never delete its fallback. The same field-presence rule applies
 * uniformly to the two surface bindings.
 */
function manifestBacksBinding(flow: BindingDeclaringFlow, binding: CatalogSourcedBinding): boolean {
  switch (binding) {
    case 'depth_binding':
    case 'slice_loop':
    case 'terminal_outcome_binding':
      return flow.engineFlags !== undefined;
    case 'edit_file_surfaces':
      return flow.reportFileSurfaces !== undefined;
    case 'primary_result_surface':
      return flow.runtimeSurface !== undefined;
  }
}

/**
 * Decide which catalog-sourced bindings a run got, and from where.
 *
 * The rule generalizes Stage 1's package-only logic to a two-source model:
 *
 * - A binding is MANIFEST-BACKED when the manifest declares its source. This is
 *   computed regardless of the package, because it answers "does this binding
 *   survive package removal" — the question the linchpin asks.
 * - A binding is REDUCED when neither the manifest nor a package provides it.
 *   With a package resolved the reduced set is empty (anti-over-fire preserved:
 *   a resolved package is authoritative for everything it declares, present or
 *   absent). Without a package, only the bindings the manifest does not back
 *   are reduced — so the set shrinks as M3 moves each binding onto the manifest.
 */
export function resolveBindingLegibility(
  flow: BindingDeclaringFlow,
  compiledPackage: CompiledFlowPackage | undefined,
): BindingLegibility {
  const manifestBackedBindings = CATALOG_SOURCED_BINDINGS.filter((binding) =>
    manifestBacksBinding(flow, binding),
  );
  const packageResolved = compiledPackage !== undefined;
  const reducedBindings = packageResolved
    ? []
    : CATALOG_SOURCED_BINDINGS.filter((binding) => !manifestBacksBinding(flow, binding));
  return { packageResolved, reducedBindings, manifestBackedBindings };
}

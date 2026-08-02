import type { CompiledFlowEngineFlags } from '../../flows/types.js';
import { CatalogSourcedBinding } from '../../schemas/trace-entry.js';

/**
 * The catalog-sourced bindings, in a stable display order. These are the
 * behaviors the runtime resolves at run start: the edit-file surface table, the
 * depth/slice/terminal-outcome engine flags, and the primary-result surface.
 *
 * Originally (Stage 1) every one of these came only from the by-id catalog
 * package; a composed or published custom flow whose id matched no package lost
 * them all silently. The migration moved each binding onto the compiled manifest
 * and M4 deleted the by-id package, so a flow now declares its own behavior and
 * the runtime resolves every binding from the manifest it was loaded from.
 *
 * Kept as the single source of truth (derived from the schema enum so the two
 * never drift) so the legibility net can map each binding to its declaration
 * source.
 */
export const CATALOG_SOURCED_BINDINGS: readonly CatalogSourcedBinding[] =
  CatalogSourcedBinding.options;

/**
 * The manifest-side declarations the legibility net inspects. Structural on
 * purpose: the runtime `ExecutableFlow` carries `engineFlags`,
 * `reportFileSurfaces`, and `runtimeSurface` (Stage 3 + 3b), and each flows
 * through here unchanged. A field the manifest does not carry reads as undefined,
 * which the net treats as "not manifest-backed" for that binding.
 */
export interface BindingDeclaringFlow {
  readonly engineFlags?: CompiledFlowEngineFlags;
  readonly reportFileSurfaces?: Readonly<Record<string, unknown>>;
  readonly runtimeSurface?: { readonly primaryResult?: unknown };
}

export interface BindingLegibility {
  /**
   * Catalog-sourced bindings the flow needs but its manifest does not declare a
   * source for. Empty for every built-in: each one's manifest is a complete,
   * authoritative declaration of its bindings, so dissolving the by-id package
   * (M4) reduced nothing. A non-empty set becomes possible only once composed
   * flows bring a block-level model of what a flow needs (M9); until that oracle
   * exists there is no way to call a missing binding "lost" rather than
   * "intentionally absent", so this stays empty.
   */
  reducedBindings: CatalogSourcedBinding[];
  /**
   * Catalog-sourced bindings the manifest declares. This is an internal
   * readiness/proof instrument, NOT a trace field: the run-start trace records
   * only `reducedBindings` (see RunBootstrappedTraceEntry). Its standing job is
   * the M4 gating proof — the binding-legibility test asserts every built-in
   * backs all its bindings off the manifest — and it is kept for the M9
   * composed-flow needs model. graph-runner computes it but currently surfaces
   * only `reducedBindings`.
   */
  manifestBackedBindings: CatalogSourcedBinding[];
}

/**
 * Whether the manifest carries the declaration source that owns a binding.
 *
 * Authority is CATEGORY-level, not value-level: an `engineFlags` block backs
 * every flag binding even when it leaves one unset, because the author has
 * taken authority over the engine-flag category and an omission within it is
 * intentional. Keying on a specific flag's value would falsely strand the
 * omitted ones — Fix, which legitimately has no slice loop, declares engineFlags
 * yet would never count slice_loop as backed. The same field-presence rule
 * applies uniformly to the two surface bindings.
 *
 * `terminal_outcome_binding` sits under the runtime surface rather than the
 * engine flags: it used to have its own opt-in flag, and the un-opted-in state
 * was the dishonest one (a run closing green over its own `blocked` result), so
 * the flag is gone and declaring a primary result is now what arms the bind.
 * Its declaration source moved with it.
 */
function manifestBacksBinding(flow: BindingDeclaringFlow, binding: CatalogSourcedBinding): boolean {
  switch (binding) {
    case 'depth_binding':
    case 'slice_loop':
      return flow.engineFlags !== undefined;
    case 'terminal_outcome_binding':
      return flow.runtimeSurface !== undefined;
    case 'edit_file_surfaces':
      return flow.reportFileSurfaces !== undefined;
    case 'primary_result_surface':
      return flow.runtimeSurface !== undefined;
  }
}

/**
 * Decide which catalog-sourced bindings a run got from its manifest.
 *
 * Post-M4 the compiled manifest is the sole authority: the by-id package
 * fallback is gone, so a binding the manifest does not declare is authoritatively
 * absent, not lost (exactly as a resolved package's omission used to be). So:
 *
 * - `manifestBackedBindings` reports the bindings the manifest declares. It is an
 *   internal readiness/proof instrument (the M4 gating proof asserts on it), NOT a
 *   trace field — the run-start trace carries only `reducedBindings`.
 * - `reducedBindings` is empty. There is no longer a second source whose absence
 *   could "reduce" a binding, and no oracle yet for "the flow needs a binding its
 *   manifest omits" — that needs the block-level needs model composed flows bring
 *   (M9). Until then a missing declaration is an intentional absence, not a loss.
 */
export function resolveBindingLegibility(flow: BindingDeclaringFlow): BindingLegibility {
  const manifestBackedBindings = CATALOG_SOURCED_BINDINGS.filter((binding) =>
    manifestBacksBinding(flow, binding),
  );
  const reducedBindings: CatalogSourcedBinding[] = [];
  return { reducedBindings, manifestBackedBindings };
}

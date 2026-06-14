// Stage 2 (first-class composition): the single shared entry point for the
// route-aware catalog-compatibility check, bound to the canonical in-process
// block catalog. `docs/flows/block-catalog.json` is generated from
// FLOW_BLOCK_DEFINITIONS, so FLOW_BLOCK_CATALOG is the source of truth; binding
// here means the compile path, the Stage 4 route probe, and the report-only
// baseline test all validate against the same catalog instead of each re-reading
// the JSON and risking drift.
//
// This is REPORT-ONLY by design today. The strong route-aware validator is
// strictly stronger than the compiler's existing producer-existence check
// (`computeReads`), and a probe found 128 issues across six of the eight shipped
// schematics: the block catalog is a coarse model that reuses generic block ids
// for structurally distinct items, and only Fix and runtime-proof were authored
// to satisfy it. Flipping this to a fail-closed compile gate would break the
// build for those six flows, so the flip waits until the block model actually
// describes the built-ins (a block-model decision, not a mechanical edit). The
// recorded baseline and the ratchet that guards it live in
// `tests/contracts/schematic-catalog-check.test.ts`. See
// `docs/ideas/first-class-composition-sequence.md` (Stage 2).
import { isGenericallyLegitRoute } from '../policy/recovery-route-policy.js';
import { FLOW_BLOCK_CATALOG } from '../schemas/flow-block-definitions.js';
import type {
  FlowSchematic,
  FlowSchematicCatalogCompatibilityIssue,
} from '../schemas/flow-schematic.js';
import { validateFlowSchematicCatalogCompatibility } from '../schemas/flow-schematic.js';

export function collectSchematicCatalogIssues(
  schematic: FlowSchematic,
): FlowSchematicCatalogCompatibilityIssue[] {
  // Inject the policy-layer route recognizer here (the flows layer may depend on
  // policy; the schema validator may not, or the top-level import graph gains a
  // schemas <-> policy cycle). Gate-recognition reconciliation: a route that is
  // NORMAL or recovery-bound is legitimate regardless of the block's
  // allowed_routes. See docs/ideas/first-class-composition-sequence.md.
  return validateFlowSchematicCatalogCompatibility(schematic, FLOW_BLOCK_CATALOG, {
    recognizeRoute: isGenericallyLegitRoute,
  });
}

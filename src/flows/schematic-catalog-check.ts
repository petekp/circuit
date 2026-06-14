// Stage 2 (first-class composition): the single shared entry point for the
// route-aware catalog-compatibility check, bound to the canonical in-process
// block catalog. `docs/flows/block-catalog.json` is generated from
// FLOW_BLOCK_DEFINITIONS, so FLOW_BLOCK_CATALOG is the source of truth; binding
// here means the compile path, the Stage 4 route probe, and the per-flow ratchet
// baseline test all validate against the same catalog instead of each re-reading
// the JSON and risking drift.
//
// This seam is the FAIL-CLOSED catalog gate (M5). The route-aware validator is
// strictly stronger than the compiler's producer-existence check (`computeReads`):
// when the seam first landed a probe found 128 issues across six of the eight
// shipped schematics, because the block catalog reused generic block ids for
// structurally distinct items, and only Fix and runtime-proof were authored to
// satisfy it. The block model has since been corrected flow by flow (the
// goal-block split, then the M3a pass for explore, prototype, and review) so
// every shipped schematic reaches zero by correction. With catalog-zero reached
// and the accommodation ledger at zero (the two preconditions M5 required),
// `compileSchematicToCompiledFlow` calls this and throws on any issue. The eight
// built-ins compile clean; the gate's standing job is to stop a composed or
// edited flow that wires an incompatible contract from compiling. The per-flow
// ratchet that proves the built-ins stay at zero lives in
// `tests/contracts/schematic-catalog-check.test.ts`. See
// `docs/architecture/first-class-composition-optimal-path.md` (M5).
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

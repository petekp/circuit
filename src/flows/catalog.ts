// Flow catalog — single source of truth for the engine.
//
// The router, registries (compose, close, verification, checkpoint,
// report-schemas, shape-hints), and emit script all derive their
// state from `flowPackages`. The engine never imports a flow
// module directly.

import { registerHtmlProjector } from '../shared/html/index.js';
import { buildFlowDefinition } from './build/flow.js';
import { buildCheckpointProjector } from './build/writers/checkpoint-html.js';
import { buildRuntimeSurfaceRegistry } from './catalog-derivations.js';
import { exploreFlowDefinition } from './explore/flow.js';
import { exploreTournamentProjector } from './explore/writers/tournament-html.js';
import { fixFlowDefinition } from './fix/flow.js';
import { compileFlowDefinitions } from './flow-definition.js';
import type { FlowDefinition } from './flow-definition.js';
import { goalFlowDefinition } from './goal/flow.js';
import { prototypeFlowDefinition } from './prototype/flow.js';
import { prototypeCheckpointProjector } from './prototype/writers/checkpoint-html.js';
import { pursueFlowDefinition } from './pursue/flow.js';
import { reviewFlowDefinition } from './review/flow.js';
import { reviewResultProjector } from './review/writers/result-html.js';
import { runtimeProofFlowDefinition } from './runtime-proof/flow.js';
import type { CompiledFlowPackage, CompiledFlowRuntimeSurface } from './types.js';

export const flowDefinitions: readonly FlowDefinition[] = [
  reviewFlowDefinition,
  fixFlowDefinition,
  pursueFlowDefinition,
  runtimeProofFlowDefinition,
  prototypeFlowDefinition,
  buildFlowDefinition,
  exploreFlowDefinition,
  goalFlowDefinition,
];

export const flowPackages: readonly CompiledFlowPackage[] = compileFlowDefinitions(flowDefinitions);

// Canonical flow-id list — every id the engine knows about, in catalog
// order. Derived from the single flowPackages aggregation so every runtime
// consumer that reserves or enumerates flow ids (e.g. the custom-flow create
// command's reserved-slug guard) tracks the catalog automatically. The pass also
// enforces the no-duplicate-id invariant the engine relies on: every remaining
// by-id derivation (the runtime-surface registry, the internal-flow set) assumes
// ids are unique. The test layer is deliberately not derived:
// tests/fixtures/retained-flow-ids.ts pins the roster by hand, so adding or
// removing a flow is a reviewed edit there.
export const catalogFlowIds: readonly string[] = (() => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const pkg of flowPackages) {
    if (seen.has(pkg.id)) {
      throw new Error(`duplicate flow package id '${pkg.id}'`);
    }
    seen.add(pkg.id);
    ids.push(pkg.id);
  }
  return ids;
})();

// Flows that ship no host run surface (the frozen internal flows). The CLI
// rejects a host run request for one of these before it loads a manifest, so the
// id set is derived here from the catalog rather than read off a loaded flow.
export const INTERNAL_FLOW_IDS: ReadonlySet<string> = new Set(
  flowPackages.filter((pkg) => pkg.visibility === 'internal').map((pkg) => pkg.id),
);

const RUNTIME_SURFACES = buildRuntimeSurfaceRegistry(flowPackages);

// Register each flow's operator-summary HTML projector into the shared
// registry at module load. This inverts the dependency so shared/html never
// imports a flow module: flows depend on shared, and the catalog (already the
// single point that imports every flow) wires them together.
registerHtmlProjector('build', buildCheckpointProjector);
registerHtmlProjector('explore', exploreTournamentProjector);
registerHtmlProjector('prototype', prototypeCheckpointProjector);
registerHtmlProjector('review', reviewResultProjector);

export function findFlowRuntimeSurfaceById(flowId: string): CompiledFlowRuntimeSurface | undefined {
  return RUNTIME_SURFACES.get(flowId);
}

export type { CompiledFlowPackage } from './types.js';

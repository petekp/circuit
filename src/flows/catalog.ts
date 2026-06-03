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
// order. Derived from the single flowPackages aggregation so a new flow
// is reflected everywhere that reserves or enumerates flow ids (e.g. the
// custom-flow create command's reserved-slug guard) without a second edit.
export const catalogFlowIds: readonly string[] = flowPackages.map((pkg) => pkg.id);

const PACKAGES_BY_ID: ReadonlyMap<string, CompiledFlowPackage> = (() => {
  const map = new Map<string, CompiledFlowPackage>();
  for (const pkg of flowPackages) {
    if (map.has(pkg.id)) {
      throw new Error(`duplicate flow package id '${pkg.id}'`);
    }
    map.set(pkg.id, pkg);
  }
  return map;
})();

const RUNTIME_SURFACES = buildRuntimeSurfaceRegistry(flowPackages);

// Register each flow's operator-summary HTML projector into the shared
// registry at module load. This inverts the dependency so shared/html never
// imports a flow module: flows depend on shared, and the catalog (already the
// single point that imports every flow) wires them together.
registerHtmlProjector('build', buildCheckpointProjector);
registerHtmlProjector('explore', exploreTournamentProjector);
registerHtmlProjector('prototype', prototypeCheckpointProjector);
registerHtmlProjector('review', reviewResultProjector);

// Look up a flow package by id. Used by engine layers that hold
// only a CompiledFlow value and need package-level metadata (e.g. engine
// flags). Returns undefined when no package is registered for the id.
export function findCompiledFlowPackageById(id: string): CompiledFlowPackage | undefined {
  return PACKAGES_BY_ID.get(id);
}

export function findFlowRuntimeSurfaceById(flowId: string): CompiledFlowRuntimeSurface | undefined {
  return RUNTIME_SURFACES.get(flowId);
}

export type { CompiledFlowPackage } from './types.js';

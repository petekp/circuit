// M9-A3 (first-class composition): the static flow.catalog@v1 producer.
//
// The route block consumes flow.catalog@v1 — the set of flows it may choose
// from — and until M9 nothing produced it (the open #15 decision). Pete locked
// the producer as a STATIC registry derived at build/compile time. deriveFlowCatalog
// turns the flow definitions into that registry: the host-runnable (public) flows,
// each as {id, title, purpose}, validated against the typed FlowCatalogShape body
// so an invalid or empty catalog fails closed at derivation. The live catalog is
// the `flowCatalog` constant in src/flows/catalog.ts and is serialized to
// generated/flows/catalog.json by the emit script (drift-guarded in CI).
//
// There is no running route step in any built-in today (the contract layer is
// compile-time only; steps read by path), so this proves the PRODUCER and its
// drift gate, not a live route consumer — which is exactly A3's scope.
import { describe, expect, it } from 'vitest';

import { deriveFlowCatalog } from '../../src/flows/catalog-derivations.js';
import { flowCatalog, flowDefinitions } from '../../src/flows/catalog.js';
import type { CompiledFlowVisibility } from '../../src/flows/types.js';
import { FlowCatalogShape } from '../../src/schemas/routing-contract-schemas.js';
import { RETAINED_FLOW_IDS } from '../fixtures/retained-flow-ids.ts';

// The host-runnable subset of the pinned roster, in catalog order. goal and
// runtime-proof are internal (no host run surface) so a router cannot route to
// them; the catalog is the routing-target set. Derived here from the live
// definitions' visibility so this expectation tracks the one place visibility is
// declared, while RETAINED_FLOW_IDS (hand-pinned) still gates roster drift.
const PUBLIC_ROSTER = flowDefinitions
  .filter((definition) => definition.visibility === 'public')
  .map((definition) => definition.id);

function syntheticSource(
  id: string,
  visibility: CompiledFlowVisibility,
): {
  id: string;
  visibility: CompiledFlowVisibility;
  schematic: { title: string; purpose: string };
} {
  return { id, visibility, schematic: { title: `${id} title`, purpose: `${id} purpose` } };
}

describe('deriveFlowCatalog (M9-A3)', () => {
  it('the live catalog parses against the typed FlowCatalogShape body', () => {
    expect(() => FlowCatalogShape.parse(flowCatalog)).not.toThrow();
  });

  it('lists exactly the host-runnable (public) flows, in catalog order', () => {
    expect(flowCatalog.flows.map((flow) => flow.id)).toEqual(PUBLIC_ROSTER);
  });

  it('the live catalog is the same value derived from the definitions', () => {
    expect(flowCatalog).toEqual(deriveFlowCatalog(flowDefinitions));
  });

  it('excludes the internal flows (no host run surface, not routing targets)', () => {
    const internal = RETAINED_FLOW_IDS.filter((id) => !PUBLIC_ROSTER.includes(id));
    expect(internal).toContain('goal');
    expect(internal).toContain('runtime-proof');
    const catalogIds = new Set(flowCatalog.flows.map((flow) => flow.id));
    for (const id of internal) expect(catalogIds.has(id)).toBe(false);
  });

  it('carries each flow title and purpose straight from its schematic', () => {
    const definitionById = new Map(
      flowDefinitions.map((definition) => [definition.id, definition]),
    );
    for (const entry of flowCatalog.flows) {
      const definition = definitionById.get(entry.id);
      expect(definition).toBeDefined();
      expect(entry.title).toBe(definition?.schematic.title);
      expect(entry.purpose).toBe(definition?.schematic.purpose);
    }
  });

  it('is deterministic — same input yields a deep-equal catalog', () => {
    expect(deriveFlowCatalog(flowDefinitions)).toEqual(deriveFlowCatalog(flowDefinitions));
  });

  it('fails closed when no source flow is host-runnable (empty catalog is invalid)', () => {
    // FlowCatalogShape requires at least one flow; an all-internal source set
    // would mint an empty catalog, so derivation must throw rather than emit one.
    expect(() => deriveFlowCatalog([syntheticSource('only-internal', 'internal')])).toThrow();
  });

  it('fails closed on zero sources', () => {
    expect(() => deriveFlowCatalog([])).toThrow();
  });

  it('keeps source order and shape for a synthetic public/internal mix', () => {
    const catalog = deriveFlowCatalog([
      syntheticSource('alpha', 'public'),
      syntheticSource('beta', 'internal'),
      syntheticSource('gamma', 'public'),
    ]);
    expect(catalog.flows).toEqual([
      { id: 'alpha', title: 'alpha title', purpose: 'alpha purpose' },
      { id: 'gamma', title: 'gamma title', purpose: 'gamma purpose' },
    ]);
  });
});

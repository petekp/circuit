// Stage 4 (first-class composition), sub-task 1: lock the contract-availability
// finding for the `route` block. The block is defined in the catalog
// (flow-block-definitions.ts) but wired into no flow, and its input
// `flow.catalog@v1` has no producer: no catalog block emits it and no shipped
// schematic declares it in initial_contracts. So "defined" is not "compose-able"
// — wiring a route item in fails the Stage 2 route-aware catalog check until a
// producer exists.
//
// These tests record two things the plan depends on:
//   1. The route item's ONLY barrier is the missing flow.catalog@v1 producer —
//      given its inputs, the block is otherwise fully compose-able (zero other
//      catalog-compat issues). This is the regression guard for whoever wires
//      route in next.
//   2. The cheapest sanctioned producer — declaring flow.catalog@v1 in the host
//      flow's initial_contracts as an engine-provided run input, the same model
//      already used for route.decision@v1 — clears the issue completely.
//
// The live-run half of Stage 4 (a run that emits route.decision@v1 through a
// compose writer + the global schema registry) is deferred: it needs the
// sanctioned composed-runtime path that Stage 6 opens. See
// docs/ideas/first-class-composition-sequence.md (Stage 4).
import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';

// A faithful `route` block item built to the block definition: frame stage,
// compose execution (one of the block's allowed kinds), inputs task.intake@v1 +
// flow.catalog@v1, output route.decision@v1, the block's three evidence
// requirements, and routes drawn from the block's allowed_routes.
const ROUTE_ITEM = {
  id: 'probe-route',
  block: 'route',
  title: 'Route',
  stage: 'frame',
  input: { task: 'task.intake@v1', catalog: 'flow.catalog@v1' },
  output: 'route.decision@v1',
  evidence_requirements: ['selected flow', 'selection reason', 'fallback reason when conservative'],
  execution: { kind: 'compose' },
  skill_slots: [],
  routes: { continue: 'clarify-goal', ask: '@stop', stop: '@stop' },
  route_overrides: {},
  protocol: 'probe-route@v1',
  writes: { report_path: 'reports/goal/route.json' },
  check: { pass: ['continue', 'ask', 'stop'] },
} as unknown as FlowSchematic['items'][number];

// Wire the route item into goal's real schematic as the entry step (continue ->
// the old entry) and run the shared Stage 2 catalog check. `initialContracts`
// stands in for the producer decision: with flow.catalog@v1 present it models an
// engine-provided run input; without it, the producer is missing.
function routeItemIssues(initialContracts: readonly string[]): string[] {
  const goal = flowDefinitions.find((definition) => definition.id === 'goal');
  if (goal === undefined) throw new Error('missing goal flow definition');
  const base = structuredClone(goal.schematic) as FlowSchematic;
  const wired = {
    ...base,
    starts_at: 'probe-route',
    initial_contracts: [...initialContracts],
    items: [ROUTE_ITEM, ...base.items],
  } as FlowSchematic;
  return collectSchematicCatalogIssues(wired)
    .filter((issue) => issue.item_id === 'probe-route')
    .map((issue) => issue.message);
}

const WITHOUT_PRODUCER = ['task.intake@v1', 'route.decision@v1', 'flow.question@v1'] as const;
const WITH_PRODUCER = [...WITHOUT_PRODUCER, 'flow.catalog@v1'] as const;

describe('route block contract availability (Stage 4 sub-task 1)', () => {
  it('flags the missing flow.catalog@v1 producer and nothing else', () => {
    const messages = routeItemIssues(WITHOUT_PRODUCER);
    // Exactly one issue, and it is the missing producer — proving the block is
    // otherwise fully compose-able once its input contract is available.
    expect(messages).toEqual([
      'input "catalog" references unavailable contract "flow.catalog@v1" on at least one reachable route',
    ]);
  });

  it('declaring flow.catalog@v1 in initial_contracts clears every route-item issue', () => {
    expect(routeItemIssues(WITH_PRODUCER)).toEqual([]);
  });
});

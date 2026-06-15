// M7 (first-class composition): the route-disjoint correctness guard.
//
// The assembler derives starts_at from the first item, so a dynamic composer
// that hands it a sequence with a consumer ahead of its producer mints a
// path-disjoint read: the first step requires a contract no upstream route has
// produced yet. The assembler does NOT police this (it produces a structurally
// valid FlowSchematic). The M5 fail-closed catalog gate must — assembled flows
// face the SAME route-aware availability check as hand-authored ones, so the
// assembler is not a bypass. These tests pin that: the same two blocks pass the
// gate in producer-first order and are rejected in consumer-first order, and
// the rejection is enforced at compile.
import { describe, expect, it } from 'vitest';

import {
  type FlowSchematicAssemblySpec,
  assembleFlowSchematic,
} from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';
import {
  FlowSchematicCompileError,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';

// gather-context produces the context packet; plan consumes it. The seam is
// typed to the registered actual build.context@v1 (aliased onto the generic
// context.packet@v1 slot, exactly as the build flow authors it) so the M9-A1
// typing gate is satisfied in BOTH orderings — leaving the order of the two
// steps as the ONLY availability variable this test exercises. flow.brief@v1 and
// context.request@v1 are supplied as initial contracts.
const INITIAL_CONTRACTS = ['flow.brief@v1', 'context.request@v1', 'route.decision@v1'];

function produceContext(routes: BlockStepUse['routes']): BlockStepUse {
  return {
    id: 'produce-context',
    title: 'Produce the context packet',
    stage: 'analyze',
    block: 'gather-context',
    input: { brief: 'flow.brief@v1', request: 'context.request@v1' },
    // Typed actual for the context.packet@v1 slot (registered body BuildContext),
    // bound via the spec's contract alias — see header.
    output: 'build.context@v1',
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'produce-context@v1',
    requestPath: 'reports/relay/produce-context.request.json',
    receiptPath: 'reports/relay/produce-context.receipt.txt',
    resultPath: 'reports/relay/produce-context.result.json',
    pass: ['accept'],
    routes,
  };
}

function consumeContext(routes: BlockStepUse['routes']): BlockStepUse {
  return {
    id: 'consume-context',
    title: 'Plan using the context packet',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1', context: 'build.context@v1' },
    // output omitted: defaults to the plan block's plan.strategy@v1.
    execution: { kind: 'compose' },
    protocol: 'consume-context@v1',
    reportPath: 'reports/plan.json',
    required: ['objective'],
    routes,
  };
}

function specFor(items: readonly BlockStepUse[]): FlowSchematicAssemblySpec {
  return {
    id: 'pursue',
    title: 'Route Safety Schematic',
    purpose: 'Exercise the route-aware catalog gate on assembled flows.',
    status: 'candidate',
    items,
    initial_contracts: INITIAL_CONTRACTS,
    contract_aliases: [{ generic: 'context.packet@v1', actual: 'build.context@v1' }],
    stageLabels: {
      analyze: { id: 'analyze-stage', title: 'Analyze' },
      plan: { id: 'plan-stage', title: 'Plan' },
    },
    stagePathRationale:
      'A two-step probe flow that exercises the route-aware availability gate only.',
  };
}

// Producer first: gather-context runs, then plan reads context.packet@v1.
const PRODUCER_FIRST: readonly BlockStepUse[] = [
  produceContext({ continue: 'consume-context', stop: '@stop' }),
  consumeContext({ continue: '@complete', stop: '@stop' }),
];

// Consumer first: plan is starts_at and reads context.packet@v1 before
// gather-context produces it.
const CONSUMER_FIRST: readonly BlockStepUse[] = [
  consumeContext({ continue: 'produce-context', stop: '@stop' }),
  produceContext({ continue: '@complete', stop: '@stop' }),
];

describe('assembleFlowSchematic — route-disjoint correctness guard', () => {
  it('the assembler itself accepts the consumer-first ordering (gate is the enforcer)', () => {
    // assembleFlowSchematic produces a structurally valid schematic; it does not
    // police contract availability. starts_at is derived as the (wrong) first item.
    const assembled = assembleFlowSchematic(specFor(CONSUMER_FIRST));
    expect(assembled.starts_at).toBe('consume-context');
  });

  it('the catalog gate flags the path-disjoint read in consumer-first order', () => {
    const assembled = assembleFlowSchematic(specFor(CONSUMER_FIRST));
    const issues = collectSchematicCatalogIssues(assembled);
    expect(issues).toContainEqual(
      expect.objectContaining({
        item_id: 'consume-context',
        message: expect.stringContaining('build.context@v1'),
      }),
    );
  });

  it('compile is fail-closed: the consumer-first flow throws at the gate', () => {
    const assembled = assembleFlowSchematic(specFor(CONSUMER_FIRST));
    expect(() => compileSchematicToCompiledFlow(assembled)).toThrow(FlowSchematicCompileError);
    expect(() => compileSchematicToCompiledFlow(assembled)).toThrow(/block catalog/);
  });

  it('the same blocks pass the gate in producer-first order (it is the order, not the blocks)', () => {
    const assembled = assembleFlowSchematic(specFor(PRODUCER_FIRST));
    expect(assembled.starts_at).toBe('produce-context');
    expect(collectSchematicCatalogIssues(assembled)).toEqual([]);
  });
});

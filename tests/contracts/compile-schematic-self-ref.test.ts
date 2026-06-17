// Compile-time self-reference reject.
//
// The runtime depth cap and cycle guard bound recursion that is only knowable at
// run time (a chain of distinct flows that happens to re-enter itself). A flow
// that names ITSELF as a sub-run target is a different, statically obvious bug:
// it can never make progress and there is no reason to wait until run time to
// say so. The compiler rejects it up front, before the catalog gate, so the
// error names the most fundamental problem rather than a downstream symptom.
import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';

// The goal flow already declares static sub-run children, so its assembled
// schematic is a faithful starting point: take it and point one of its sub-run
// targets back at the goal flow's own id to manufacture self-reference.
function selfReferentialGoalSchematic(): FlowSchematic {
  const goalDefinition = flowDefinitions.find((definition) => definition.id === 'goal');
  if (goalDefinition === undefined) throw new Error('goal flow missing from catalog');
  const schematic = schematicForFlowDefinition(goalDefinition);

  let mutatedOne = false;
  const items = schematic.items.map((item) => {
    if (!mutatedOne && item.execution.kind === 'sub-run') {
      mutatedOne = true;
      return {
        ...item,
        execution: {
          ...item.execution,
          flow_ref: { ...item.execution.flow_ref, flow_id: schematic.id },
        },
      };
    }
    return item;
  });
  if (!mutatedOne) throw new Error('expected goal schematic to declare at least one sub-run item');
  return { ...schematic, items } as FlowSchematic;
}

// The other child-run edge is a fanout sub-run branch. No built-in declares a
// static sub-run fanout branch (the shipped fanouts are dynamic relay
// tournaments), so manufacture one: take the explore flow's fanout item and
// replace its branches with a single static sub-run branch that targets the
// explore flow's own id. The compiler's self-reference check reads structure
// before any deeper validation, so this faithfully exercises the fanout edge.
function fanoutSelfReferentialSchematic(): FlowSchematic {
  const exploreDefinition = flowDefinitions.find((definition) => definition.id === 'explore');
  if (exploreDefinition === undefined) throw new Error('explore flow missing from catalog');
  const schematic = schematicForFlowDefinition(exploreDefinition);

  let mutatedOne = false;
  const items = schematic.items.map((item) => {
    if (!mutatedOne && item.fanout !== undefined) {
      mutatedOne = true;
      return {
        ...item,
        fanout: {
          ...item.fanout,
          branches: {
            kind: 'static',
            branches: [
              {
                branch_id: 'self',
                flow_ref: { flow_id: schematic.id, entry_mode: 'default' },
                goal: 'recurse into the flow itself',
                depth: 'medium',
              },
            ],
          },
        },
      };
    }
    return item;
  });
  if (!mutatedOne)
    throw new Error('expected explore schematic to declare at least one fanout item');
  return { ...schematic, items } as FlowSchematic;
}

describe('compile-time self-reference reject', () => {
  it('refuses to compile a schematic whose sub-run targets its own flow id', () => {
    const schematic = selfReferentialGoalSchematic();
    expect(() => compileSchematicToCompiledFlow(schematic)).toThrow(
      /refers to itself|self-referenc/i,
    );
  });

  it('refuses to compile a schematic whose fanout branch sub-runs its own flow id', () => {
    const schematic = fanoutSelfReferentialSchematic();
    expect(() => compileSchematicToCompiledFlow(schematic)).toThrow(
      /refers to itself|self-referenc/i,
    );
  });

  it('still compiles the unmodified goal flow (the reject is specific to self-reference)', () => {
    const goalDefinition = flowDefinitions.find((definition) => definition.id === 'goal');
    if (goalDefinition === undefined) throw new Error('goal flow missing from catalog');
    expect(() =>
      compileSchematicToCompiledFlow(schematicForFlowDefinition(goalDefinition)),
    ).not.toThrow();
  });
});

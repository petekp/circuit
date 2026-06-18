// planCompiledFlowFiles lays out a per-mode compiled package across files. The
// manifest the publisher writes blesses exactly one path — circuit.json (see
// src/cli/create.ts, flow_path -> circuit.json) — and the runtime trust gate
// only trusts that path. So circuit.json MUST hold the graph of the 'default'
// axis selection (the mode that runs live), not merely whichever group happens
// to be largest. This suite pins that contract.
import { describe, expect, it } from 'vitest';
import type { CompileResult } from '../../src/flows/compile-schematic-to-flow.js';
import { planCompiledFlowFiles } from '../../src/flows/compiled-flow-file-plan.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';

// planCompiledFlowFiles treats each flow opaquely (it only stringifies them to
// group identical graphs), so a minimal stand-in is enough to exercise the file
// layout without constructing a full compiled flow.
function stubFlow(id: string): CompiledFlow {
  return { id } as unknown as CompiledFlow;
}

describe('planCompiledFlowFiles blesses the default mode into circuit.json', () => {
  it('writes the default-mode graph to circuit.json even when another group is larger', () => {
    const defaultFlow = stubFlow('default-graph');
    const sharedFlow = stubFlow('shared-graph');
    // default is a sole-member group; low+high share a larger (size-2) group.
    const result: CompileResult = {
      kind: 'per-mode',
      flows: new Map([
        ['default', defaultFlow],
        ['low', sharedFlow],
        ['high', sharedFlow],
      ]),
    };

    const plan = planCompiledFlowFiles(result);
    const main = plan.find((file) => file.filename === 'circuit.json');
    expect(main?.flow, 'circuit.json must be the default-mode graph').toBe(defaultFlow);

    // The larger low+high group lands in <mode>.json siblings, never circuit.json.
    const siblings = plan
      .filter((file) => file.filename !== 'circuit.json')
      .map((file) => file.filename)
      .sort();
    expect(siblings).toEqual(['high.json', 'low.json']);
  });

  it('a single-mode result yields exactly circuit.json', () => {
    const result: CompileResult = { kind: 'single', flow: stubFlow('only') };
    expect(planCompiledFlowFiles(result).map((file) => file.filename)).toEqual(['circuit.json']);
  });
});

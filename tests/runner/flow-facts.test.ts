import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import { RETAINED_FLOW_IDS } from '../fixtures/retained-flow-ids.js';
import { schematicForFlow } from '../helpers/in-memory-schematics.js';

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('value-owned retained flow authoring', () => {
  it('keeps retained flow adapters value-owned without legacy facts files', () => {
    for (const flowId of RETAINED_FLOW_IDS) {
      const flowSource = readSource(`src/flows/${flowId}/flow.ts`);
      const dataSource = readSource(`src/flows/${flowId}/data.ts`);

      expect(flowSource, `${flowId} flow adapter should use canonical FlowData`).toContain(
        'defineFlowData',
      );
      expect(flowSource, `${flowId} flow adapter should not use fact authoring`).not.toContain(
        'defineFlowFromFacts',
      );
      expect(flowSource, `${flowId} flow adapter should not own an inline schematic`).not.toContain(
        'schematic:',
      );
      expect(dataSource, `${flowId} FlowData should not import legacy facts`).not.toContain(
        './facts',
      );
      expect(existsSync(`src/flows/${flowId}/facts.ts`), `${flowId} facts file`).toBe(false);
    }
  });

  it('keeps generated schematics in parity with catalog definitions', () => {
    for (const definition of flowDefinitions) {
      const generated = JSON.parse(readSource(`src/flows/${definition.id}/schematic.json`));
      expect(definition.schematic, definition.id).toEqual(generated);
    }
  });

  it('keeps production catalog ids exact', () => {
    const retainedIds = flowDefinitions.map((definition) => definition.id);
    const packageIds = flowPackages.map((pkg) => pkg.id);

    expect(retainedIds).toEqual(RETAINED_FLOW_IDS);
    expect(packageIds).toEqual(retainedIds);
  });

  it('passes connector and selection through Prototype tournament fanout branches', () => {
    // M6: read the in-memory prototype definition, not the generated JSON on disk.
    const prototypeSchematic = schematicForFlow('prototype') as unknown as {
      readonly items: readonly {
        readonly id: string;
        readonly fanout?: {
          readonly branches?: {
            readonly template?: {
              readonly connector?: string;
              readonly selection?: unknown;
            };
          };
        };
      }[];
    };
    const fanoutStep = prototypeSchematic.items.find((item) => item.id === 'variant-fanout-step');

    expect(fanoutStep?.fanout?.branches?.template).toMatchObject({
      connector: '$item.connector_name',
      selection: {
        model: {
          provider: '$item.provider',
          model: '$item.model',
        },
        effort: '$item.effort',
      },
    });
  });
});

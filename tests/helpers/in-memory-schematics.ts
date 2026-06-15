// In-memory schematic access for tests (M6, first-class composition).
//
// src/flows/<id>/schematic.json is a GENERATED, drift-checked snapshot of the
// typed FlowData definition. The single source of truth is the in-memory
// definition (catalog.ts `flowDefinitions`); the committed JSON is regenerated
// and compared by check-flow-drift, and the "generated schematics in parity with
// catalog definitions" test in tests/runner/flow-facts.test.ts asserts disk ===
// memory directly. So a test that wants "the flow's schematic" should read the
// live definition, not the generated file back as if it were source.
//
// These helpers are the in-memory analog of
// `FlowSchematic.parse(JSON.parse(readFileSync('src/flows/<id>/schematic.json')))`.
// Re-parsing the definition returns a fresh deep copy, so a caller may mutate the
// result (the failure-mode tests do, e.g. `act.stage = 'analyze'`) without
// corrupting the shared catalog object — exactly the isolation a fresh disk parse
// used to provide.
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type FlowSchematic,
  FlowSchematic as FlowSchematicSchema,
} from '../../src/schemas/flow-schematic.js';

export function schematicForFlow(id: string): FlowSchematic {
  const definition = flowDefinitions.find((flow) => flow.id === id);
  if (definition === undefined) {
    throw new Error(`no flow definition for id '${id}'`);
  }
  return FlowSchematicSchema.parse(definition.schematic);
}

export function shippedFlowIds(): string[] {
  return flowDefinitions.map((flow) => flow.id).sort();
}

export function shippedFlowSchematics(): FlowSchematic[] {
  return flowDefinitions.map((flow) => FlowSchematicSchema.parse(flow.schematic));
}

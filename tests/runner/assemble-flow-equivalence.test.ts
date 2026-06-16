// M7 (first-class composition): prove-by-equivalence for the assembler.
//
// Each test re-expresses a shipped built-in's BLOCK SEQUENCE (the assembler's
// input — a sparse list of block uses, with no starts_at / stages /
// stage_path_policy) and lets `assembleFlowSchematic` derive the rest. The
// flow-level scaffolding (identity, axes, contract aliases, engine flags,
// report file surfaces, stage labels, omit rationale) is pulled from the
// shipped schematic because it is pass-through, not what M7 derives. The
// assertions then demand that the assembled schematic is byte-equal to the
// shipped one AND compiles to the same CompiledFlow. A transcription slip in
// the block sequence, or a derivation bug, fails these loudly rather than
// passing silently.
//
// Scope note: this does NOT refactor build/pursue onto the assembler — the
// built-ins still hand-author their schematics. Making them the assembler's
// first customers is M9.
import { describe, expect, it } from 'vitest';

import {
  type FlowSchematicAssemblySpec,
  type StageLabelMap,
  assembleFlowSchematic,
} from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';
import { buildBlockItems } from '../../src/flows/build/assembly-spec.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { exploreBlockItems } from '../../src/flows/explore/assembly-spec.js';
import { fixBlockItems } from '../../src/flows/fix/assembly-spec.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import { goalBlockItems } from '../../src/flows/goal/assembly-spec.js';
import { prototypeBlockItems } from '../../src/flows/prototype/assembly-spec.js';
import { pursueBlockItems } from '../../src/flows/pursue/assembly-spec.js';
import { reviewBlockItems } from '../../src/flows/review/assembly-spec.js';
import { runtimeProofBlockItems } from '../../src/flows/runtime-proof/assembly-spec.js';
import type { FlowSchematic as FlowSchematicValue } from '../../src/schemas/flow-schematic.js';

// The catalog (not a per-flow data.ts) is the supported surface for reaching a
// built-in's shipped schematic; schematicForFlowDefinition returns it parsed.
const definitionsById = new Map(flowDefinitions.map((definition) => [definition.id, definition]));

function shippedSchematicFor(flowId: string): FlowSchematicValue {
  const definition = definitionsById.get(flowId);
  if (definition === undefined) {
    throw new Error(`missing FlowDefinition for ${flowId}`);
  }
  return schematicForFlowDefinition(definition);
}

function stageLabelsFrom(schematic: FlowSchematicValue): StageLabelMap {
  const stages = schematic.stages ?? [];
  return Object.fromEntries(
    stages.map((stage) => [stage.canonical, { id: stage.id, title: stage.title }]),
  ) as StageLabelMap;
}

function rationaleFrom(schematic: FlowSchematicValue): string | undefined {
  const policy = schematic.stage_path_policy;
  return policy?.mode === 'partial' ? policy.rationale : undefined;
}

// Scaffolding the assembler passes through verbatim. Pulling it from the shipped
// schematic isolates the test to the one thing M7 adds: assembling items and
// deriving starts_at / stages / stage_path_policy from the sequence.
function scaffoldingFrom(
  schematic: FlowSchematicValue,
  items: readonly BlockStepUse[],
): FlowSchematicAssemblySpec {
  const rationale = rationaleFrom(schematic);
  return {
    id: schematic.id,
    title: schematic.title,
    purpose: schematic.purpose,
    status: schematic.status,
    items,
    stageLabels: stageLabelsFrom(schematic),
    initial_contracts: schematic.initial_contracts,
    contract_aliases: schematic.contract_aliases,
    ...(schematic.version === undefined ? {} : { version: schematic.version }),
    ...(schematic.axes === undefined ? {} : { axes: schematic.axes }),
    ...(schematic.default_selection === undefined
      ? {}
      : { default_selection: schematic.default_selection }),
    ...(schematic.engine_flags === undefined ? {} : { engine_flags: schematic.engine_flags }),
    ...(schematic.report_file_surfaces === undefined
      ? {}
      : { report_file_surfaces: schematic.report_file_surfaces }),
    ...(schematic.required_config === undefined
      ? {}
      : { required_config: schematic.required_config }),
    ...(rationale === undefined ? {} : { stagePathRationale: rationale }),
  };
}

function singleCompiled(schematic: FlowSchematicValue) {
  const result = compileSchematicToCompiledFlow(schematic);
  if (result.kind !== 'single') {
    throw new Error(`expected a single compiled flow, got '${result.kind}'`);
  }
  return result.flow;
}

// Build's full block sequence is now build's production source of truth
// (src/flows/build/assembly-spec.ts → buildBlockItems), consumed by data.ts via
// the assembler (M9). Importing it here keeps ONE copy: this prove-by-
// equivalence test reconstructs build's schematic from the same items the flow
// ships, so a slip in the sequence fails both this test and the live flow.

// Pursue's full block sequence is now pursue's production source of truth
// (src/flows/pursue/assembly-spec.ts → pursueBlockItems), consumed by data.ts
// via the assembler (M9). Importing it here keeps ONE copy: this prove-by-
// equivalence test reconstructs pursue's schematic from the same items the flow
// ships. Pursue leaves the analyze stage empty, so the assembler must derive a
// partial stage path with omits: ['analyze'].

describe('assembleFlowSchematic — prove-by-equivalence', () => {
  it('reconstructs the build schematic from its block sequence (strict stage path)', () => {
    const shipped = shippedSchematicFor('build');
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, buildBlockItems));

    expect(assembled.starts_at).toBe('frame-step');
    expect(assembled.stage_path_policy).toEqual({ mode: 'strict' });
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled build flow to the same CompiledFlow', () => {
    const shipped = shippedSchematicFor('build');
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, buildBlockItems));
    expect(singleCompiled(assembled)).toEqual(singleCompiled(shipped));
  });

  it('reconstructs the pursue schematic from its block sequence (partial stage path)', () => {
    const shipped = shippedSchematicFor('pursue');
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, pursueBlockItems));

    expect(assembled.starts_at).toBe('contract-step');
    expect(assembled.stage_path_policy).toMatchObject({ mode: 'partial', omits: ['analyze'] });
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled pursue flow to the same CompiledFlow', () => {
    const shipped = shippedSchematicFor('pursue');
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, pursueBlockItems));
    expect(singleCompiled(assembled)).toEqual(singleCompiled(shipped));
  });

  // A5: the six remaining built-ins, migrated onto the assembler. Each pair
  // re-expresses the flow's block sequence and proves the assembled schematic is
  // byte-equal to the shipped one AND compiles to the same CompiledFlow.
  const remainingBuiltins: ReadonlyArray<{
    readonly id: string;
    readonly items: readonly BlockStepUse[];
    readonly startsAt: string;
  }> = [
    { id: 'runtime-proof', items: runtimeProofBlockItems, startsAt: 'compose-step' },
    { id: 'review', items: reviewBlockItems, startsAt: 'intake-step' },
    { id: 'goal', items: goalBlockItems, startsAt: 'clarify-goal' },
    { id: 'fix', items: fixBlockItems, startsAt: 'fix-frame' },
    { id: 'prototype', items: prototypeBlockItems, startsAt: 'frame-step' },
    { id: 'explore', items: exploreBlockItems, startsAt: 'frame-step' },
  ];

  for (const { id, items, startsAt } of remainingBuiltins) {
    it(`reconstructs the ${id} schematic from its block sequence`, () => {
      const shipped = shippedSchematicFor(id);
      const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, items));
      expect(assembled.starts_at).toBe(startsAt);
      expect(assembled).toEqual(shipped);
    });

    it(`compiles the assembled ${id} flow to the same CompiledFlow`, () => {
      const shipped = shippedSchematicFor(id);
      const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, items));
      // Compare the whole compile result, not singleCompiled: tournament/depth
      // flows (fix, prototype, explore) compile to a 'per-mode' bundle of
      // variants, not a single flow. Equating the full result proves every
      // compiled variant is byte-identical, not just the single-mode ones.
      expect(compileSchematicToCompiledFlow(assembled)).toEqual(
        compileSchematicToCompiledFlow(shipped),
      );
    });
  }
});

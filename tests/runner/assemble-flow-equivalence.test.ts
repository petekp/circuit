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
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
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

// Pursue's full block sequence. Pursue leaves the analyze stage empty, so the
// assembler must derive a partial stage path with omits: ['analyze'].
const PURSUE_ITEMS: readonly BlockStepUse[] = [
  {
    id: 'contract-step',
    title: 'Frame - create pursuit contract',
    stage: 'frame',
    block: 'pursue',
    input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
    execution: { kind: 'compose' },
    protocol: 'pursuit-contract@v1',
    reportPath: 'reports/pursuit/contract.json',
    required: ['objective', 'pursuits', 'verification_command_candidates'],
    routes: { continue: 'graph-step', stop: '@stop' },
  },
  {
    id: 'graph-step',
    title: 'Coordinate - build pursuit graph',
    stage: 'plan',
    block: 'coordinate-pursuits',
    input: { contract: 'pursuit.contract@v1' },
    execution: { kind: 'compose' },
    protocol: 'pursuit-graph@v1',
    reportPath: 'reports/pursuit/graph.json',
    required: ['nodes', 'serial_groups', 'parallel_read_only_groups'],
    routes: { continue: 'wave-plan-step', stop: '@stop' },
  },
  {
    id: 'wave-plan-step',
    title: 'Plan - order execution waves',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'pursuit.contract@v1', context: 'pursuit.graph@v1' },
    output: 'pursuit.wave-plan@v1',
    execution: { kind: 'compose' },
    protocol: 'pursuit-wave-plan@v1',
    reportPath: 'reports/pursuit/wave-plan.json',
    required: ['waves', 'no_parallel_writes_reason'],
    routes: { continue: 'batch-step', stop: '@stop' },
  },
  {
    id: 'batch-step',
    title: 'Execute - run serialized pursuit batch',
    stage: 'act',
    block: 'batch',
    input: {
      queue: 'pursuit.graph@v1',
      brief: 'pursuit.contract@v1',
      plan: 'pursuit.wave-plan@v1',
    },
    output: 'pursuit.batch@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'pursuit-batch@v1',
    reportPath: 'reports/pursuit/batch.json',
    requestPath: 'reports/relay/pursuit-batch.request.json',
    receiptPath: 'reports/relay/pursuit-batch.receipt.txt',
    resultPath: 'reports/relay/pursuit-batch.result.json',
    pass: ['accept', 'partial'],
    routes: { continue: 'verify-step', retry: 'batch-step', stop: '@stop' },
  },
  {
    id: 'verify-step',
    title: 'Verify - run Pursue proof commands',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      brief: 'pursuit.contract@v1',
      change: 'pursuit.batch@v1',
    },
    output: 'pursuit.verification@v1',
    protocol: 'pursuit-verify@v1',
    reportPath: 'reports/pursuit/verification.json',
    required: ['overall_status', 'commands'],
    routes: { continue: 'review-step', retry: 'batch-step', stop: '@stop' },
  },
  {
    id: 'review-step',
    title: 'Review - check pursuit coordination',
    stage: 'review',
    block: 'review',
    input: {
      brief: 'pursuit.contract@v1',
      change: 'pursuit.batch@v1',
      verification: 'pursuit.verification@v1',
    },
    output: 'pursuit.review@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'pursuit-review@v1',
    reportPath: 'reports/pursuit/review.json',
    requestPath: 'reports/relay/pursuit-review.request.json',
    receiptPath: 'reports/relay/pursuit-review.receipt.txt',
    resultPath: 'reports/relay/pursuit-review.result.json',
    pass: ['clean', 'needs-followup', 'blocked'],
    routes: { continue: 'close-step', retry: 'batch-step', stop: '@stop' },
  },
  {
    id: 'close-step',
    title: 'Close - summarize pursuit result',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'pursuit.contract@v1',
      graph: 'pursuit.graph@v1',
      plan: 'pursuit.wave-plan@v1',
      verification: 'pursuit.verification@v1',
      review: 'pursuit.review@v1',
      batch: 'pursuit.batch@v1',
    },
    output: 'pursuit.result@v1',
    execution: { kind: 'compose' },
    protocol: 'pursuit-close@v1',
    reportPath: 'reports/pursuit-result.json',
    required: ['summary', 'outcome', 'evidence_links'],
    routes: { complete: '@complete', stop: '@stop', handoff: '@handoff', escalate: '@escalate' },
  },
];

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
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, PURSUE_ITEMS));

    expect(assembled.starts_at).toBe('contract-step');
    expect(assembled.stage_path_policy).toMatchObject({ mode: 'partial', omits: ['analyze'] });
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled pursue flow to the same CompiledFlow', () => {
    const shipped = shippedSchematicFor('pursue');
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, PURSUE_ITEMS));
    expect(singleCompiled(assembled)).toEqual(singleCompiled(shipped));
  });
});

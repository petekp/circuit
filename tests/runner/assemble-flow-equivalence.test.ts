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

// Build's full block sequence. Note plan-step: build hand-authors it as a raw
// literal (it would restate the plan block's default evidence), but as a block
// use that OMITS evidenceRequirements the same default fills back in — so the
// assembler reproduces it exactly.
const BUILD_ITEMS: readonly BlockStepUse[] = [
  {
    id: 'frame-step',
    title: 'Frame - confirm Build brief',
    stage: 'frame',
    block: 'frame',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    output: 'build.brief@v1',
    execution: { kind: 'checkpoint' },
    protocol: 'build-frame@v1',
    reportPath: 'reports/build/brief.json',
    checkpointRequestPath: 'reports/checkpoints/frame-step-request.json',
    checkpointResponsePath: 'reports/checkpoints/frame-step-response.json',
    allow: ['continue'],
    checkpointPolicy: {
      prompt: 'Confirm the Build brief before implementation starts.',
      choices: [{ id: 'continue', label: 'Continue' }],
      safe_default_choice: 'continue',
      report_template: {
        scope: 'Make the smallest safe change that satisfies the requested goal.',
        success_criteria: [
          'The requested behavior is implemented',
          'Verification passes',
          'Review completes without a blocking issue',
        ],
      },
    },
    routes: { continue: 'analyze-step', stop: '@stop' },
  },
  {
    id: 'analyze-step',
    title: 'Analyze — read the code before planning',
    stage: 'analyze',
    block: 'gather-context',
    input: { brief: 'build.brief@v1', request: 'context.request@v1' },
    output: 'build.context@v1',
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'build-analyze@v1',
    reportPath: 'reports/build/context.json',
    requestPath: 'reports/relay/build-analyze.request.json',
    receiptPath: 'reports/relay/build-analyze.receipt.txt',
    resultPath: 'reports/relay/build-analyze.result.json',
    pass: ['accept'],
    routes: { continue: 'plan-step', retry: 'analyze-step', ask: '@stop', stop: '@stop' },
  },
  {
    id: 'plan-step',
    title: 'Plan - produce Build plan',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'build.brief@v1', context: 'build.context@v1' },
    output: 'build.plan@v1',
    execution: { kind: 'compose' },
    protocol: 'build-plan@v1',
    reportPath: 'reports/build/plan.json',
    required: ['objective', 'verification'],
    routes: { continue: 'build-baseline', revise: 'plan-step', stop: '@stop' },
  },
  {
    id: 'build-baseline',
    title: 'Verify - snapshot pre-change git state',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1', plan: 'build.plan@v1' },
    output: 'build.baseline-snapshot@v1',
    protocol: 'build-baseline-snapshot@v1',
    reportPath: 'reports/build/baseline-snapshot.json',
    required: ['overall_status'],
    routes: { continue: 'act-step', stop: '@stop' },
  },
  {
    id: 'act-step',
    title: 'Act - implementation relay',
    stage: 'act',
    block: 'act',
    input: { brief: 'build.brief@v1', plan: 'build.plan@v1' },
    output: 'build.implementation@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'build-act@v1',
    reportPath: 'reports/build/implementation.json',
    requestPath: 'reports/relay/build-act.request.json',
    receiptPath: 'reports/relay/build-act.receipt.txt',
    resultPath: 'reports/relay/build-act.result.json',
    pass: ['accept'],
    acceptanceCriteria: {
      checks: [
        {
          kind: 'report_field',
          id: 'changed-files-present',
          path: ['changed_files'],
          predicate: 'present',
        },
        {
          kind: 'report_field',
          id: 'evidence-non-empty',
          path: ['evidence'],
          predicate: 'non_empty',
        },
      ],
      on_failure: { mode: 'retry-with-feedback' },
    },
    routes: { continue: 'verify-step', retry: 'act-step', stop: '@stop' },
  },
  {
    id: 'verify-step',
    title: 'Verify - run Build verification',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      plan: 'build.plan@v1',
      change: 'build.implementation@v1',
    },
    output: 'build.verification@v1',
    protocol: 'build-verify@v1',
    reportPath: 'reports/build/verification.json',
    required: ['overall_status', 'commands'],
    routes: { continue: 'build-touch-area', advance: 'act-step', retry: 'act-step', stop: '@stop' },
  },
  {
    id: 'build-touch-area',
    title: 'Verify - check git-proven touch area',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      plan: 'build.plan@v1',
      baseline: 'build.baseline-snapshot@v1',
      change: 'build.implementation@v1',
    },
    output: 'build.touch-area@v1',
    protocol: 'build-touch-area@v1',
    reportPath: 'reports/build/touch-area.json',
    required: ['overall_status', 'enforcement', 'containment'],
    routes: { continue: 'review-step', stop: '@stop' },
  },
  {
    id: 'review-step',
    title: 'Review - implementation review relay',
    stage: 'review',
    block: 'review',
    input: {
      brief: 'build.brief@v1',
      plan: 'build.plan@v1',
      change: 'build.implementation@v1',
      verification: 'build.verification@v1',
      touch_area: 'build.touch-area@v1',
    },
    output: 'build.review@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'build-review@v1',
    reportPath: 'reports/build/review.json',
    requestPath: 'reports/relay/build-review.request.json',
    receiptPath: 'reports/relay/build-review.receipt.txt',
    resultPath: 'reports/relay/build-review.result.json',
    pass: ['accept', 'accept-with-fixes'],
    routes: { continue: 'close-step', retry: 'act-step', revise: 'act-step', stop: '@stop' },
  },
  {
    id: 'close-step',
    title: 'Close - emit Build result',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'build.brief@v1',
      plan: 'build.plan@v1',
      implementation: 'build.implementation@v1',
      verification: 'build.verification@v1',
      review: 'build.review@v1',
      touch_area: 'build.touch-area@v1',
    },
    output: 'build.result@v1',
    execution: { kind: 'compose' },
    protocol: 'build-close@v1',
    reportPath: 'reports/build-result.json',
    required: ['summary', 'outcome', 'evidence_links'],
    routes: { complete: '@complete', stop: '@stop' },
  },
];

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
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, BUILD_ITEMS));

    expect(assembled.starts_at).toBe('frame-step');
    expect(assembled.stage_path_policy).toEqual({ mode: 'strict' });
    expect(assembled).toEqual(shipped);
  });

  it('compiles the assembled build flow to the same CompiledFlow', () => {
    const shipped = shippedSchematicFor('build');
    const assembled = assembleFlowSchematic(scaffoldingFrom(shipped, BUILD_ITEMS));
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

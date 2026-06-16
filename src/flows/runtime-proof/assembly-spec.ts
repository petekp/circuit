// Runtime Proof's flow assembly spec (first-class composition, A5).
//
// Runtime Proof is the assembler's smallest production customer: a two-step
// proof flow (one compose, one relay) that exercises the runtime boundary. Like
// build (../build/assembly-spec.ts) and pursue (../pursue/assembly-spec.ts),
// data.ts now consumes `assembleFlowSchematic(runtimeProofAssemblySpec)` instead
// of a hand-authored schematic literal. The flow touches only the plan and act
// canonical stages, so the assembler derives a partial stage path that omits the
// other five canonicals; the rationale is supplied via `stagePathRationale`.
//
// compose-step and relay-step both omit `output` and `evidence_requirements`:
// the plan / act blocks default them back to the exact values the flow used to
// restate, so the assembled schematic stays byte-identical to the shipped one.
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const RUNTIME_PROOF_STAGE_PATH_RATIONALE =
  'Runtime Proof is a narrow proof flow; only plan and act are needed to exercise compose and relay through the runtime boundary.';

// Runtime Proof's full block sequence, in route order. It touches only the plan
// and act canonical stages.
export const runtimeProofBlockItems: readonly BlockStepUse[] = [
  {
    id: 'compose-step',
    title: 'Compose runtime proof report',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1' },
    execution: { kind: 'compose' },
    protocol: 'runtime-proof-compose@v1',
    reportPath: 'reports/compose.json',
    required: ['summary'],
    routes: { continue: 'relay-step' },
  },
  {
    id: 'relay-step',
    title: 'Relay dry-run connector',
    stage: 'act',
    block: 'act',
    input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'runtime-proof-relay@v1',
    requestPath: 'reports/relay.request.json',
    receiptPath: 'reports/relay.receipt.json',
    resultPath: 'reports/relay.result.json',
    pass: ['ok'],
    routes: { continue: '@complete' },
  },
];

const runtimeProofStageLabels: StageLabelMap = {
  plan: { id: 'plan-stage', title: 'Plan' },
  act: { id: 'act-stage', title: 'Act' },
};

export const runtimeProofAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'runtime-proof',
  title: 'Runtime Proof Schematic',
  purpose:
    'Runtime Proof flow: exercise one compose step and one relay step end-to-end so the runtime boundary can be observed closing a real run.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['flow.brief@v1'],
  contract_aliases: [],
  axes: {
    allowed_depths: ['medium'],
    supports_tournament: false,
    supports_autonomous: false,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  items: runtimeProofBlockItems,
  stageLabels: runtimeProofStageLabels,
  stagePathRationale: RUNTIME_PROOF_STAGE_PATH_RATIONALE,
};

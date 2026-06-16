import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { runtimeProofAssemblySpec } from './assembly-spec.js';
import { RuntimeProofCompose } from './reports.js';
import { runtimeProofComposeBuilder } from './writers/compose.js';

const runtimeProofPaths = {
  schematic: 'src/flows/runtime-proof/schematic.json',
} satisfies FlowData['paths'];

// First-class composition (A5): runtime-proof is one of the assembler's
// production customers. Its block sequence and scaffolding live in
// ./assembly-spec.ts; `assembleFlowSchematic` derives starts_at / stages /
// stage_path_policy and returns the validated FlowSchematic that used to be a
// hand-authored literal here. The prove-by-equivalence test proves the assembled
// schematic is byte-identical to the former literal (schematic + compiled).
const runtimeProofSchematic = assembleFlowSchematic(
  runtimeProofAssemblySpec,
) satisfies FlowData['schematic'];

const runtimeProofCanonicalStagePolicy = {
  kind: 'exempt',
  reason: 'partial-stage path, recorded',
} satisfies FlowData['canonicalStagePolicy'];

const runtimeProofReports = [
  {
    schemaName: 'runtime-proof.compose@v1',
    channel: 'report',
    schema: RuntimeProofCompose,
    writers: { compose: [runtimeProofComposeBuilder] },
  },
] satisfies NonNullable<FlowData['reports']>;

export const runtimeProofFlowData = {
  id: 'runtime-proof',
  visibility: 'internal',
  paths: runtimeProofPaths,
  schematic: runtimeProofSchematic,
  canonicalStagePolicy: runtimeProofCanonicalStagePolicy,
  reportWriterSchemaAliases: ['plan.strategy@v1'],
  reports: runtimeProofReports,
} satisfies FlowData;

import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { convergeProofAssemblySpec } from './assembly-spec.js';

const convergeProofPaths = {
  schematic: 'src/flows/converge-proof/schematic.json',
} satisfies FlowData['paths'];

// First-class composition: converge-proof is an assembler customer. Its block
// sequence and engine flags live in ./assembly-spec.ts; `assembleFlowSchematic`
// derives starts_at / stages / stage_path_policy and carries the until-loop flag
// through to the returned FlowSchematic. The flow is all-relay (plan, act,
// review) with no compose writers, so data.ts declares no reports.
const convergeProofSchematic = assembleFlowSchematic(
  convergeProofAssemblySpec,
) satisfies FlowData['schematic'];

const convergeProofCanonicalStagePolicy = {
  kind: 'exempt',
  reason: 'partial-stage path, recorded',
} satisfies FlowData['canonicalStagePolicy'];

export const convergeProofFlowData = {
  id: 'converge-proof',
  visibility: 'internal',
  paths: convergeProofPaths,
  schematic: convergeProofSchematic,
  canonicalStagePolicy: convergeProofCanonicalStagePolicy,
} satisfies FlowData;

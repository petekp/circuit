import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { fixUntilGreenAssemblySpec } from './assembly-spec.js';
import { convergeJudgmentRelayShapeHint } from './relay-hints.js';
import { FixUntilGreenPlan, FixUntilGreenVerification } from './reports.js';
import { fixUntilGreenPlanComposeBuilder } from './writers/plan.js';
import { fixUntilGreenVerificationWriter } from './writers/verification.js';

const fixUntilGreenPaths = {
  schematic: 'src/flows/fix-until-green/schematic.json',
} satisfies FlowData['paths'];

// First-class composition: fix-until-green is an assembler customer. Its block
// sequence and the until-loop engine flag live in ./assembly-spec.ts;
// `assembleFlowSchematic` derives starts_at / stages / stage_path_policy and
// carries the until flag through to the returned FlowSchematic.
const fixUntilGreenSchematic = assembleFlowSchematic(
  fixUntilGreenAssemblySpec,
) satisfies FlowData['schematic'];

const fixUntilGreenCanonicalStagePolicy = {
  kind: 'exempt',
  reason: 'partial-stage path, recorded',
} satisfies FlowData['canonicalStagePolicy'];

// fix-until-green owns its own plan and verification schema names so its writers
// do not collide with build's / fix's on the global compose, verification, and
// report-schema registries. The act and judge relays are bare (no typed report),
// so the loop body's only typed report is the verification result.
const fixUntilGreenReports = [
  {
    schemaName: 'fix-until-green.plan@v1',
    channel: 'report',
    schema: FixUntilGreenPlan,
    writers: { compose: [fixUntilGreenPlanComposeBuilder] },
  },
  {
    schemaName: 'fix-until-green.verification@v1',
    channel: 'report',
    schema: FixUntilGreenVerification,
    writers: { verification: [fixUntilGreenVerificationWriter] },
  },
] satisfies NonNullable<FlowData['reports']>;

export const fixUntilGreenFlowData = {
  id: 'fix-until-green',
  visibility: 'internal',
  paths: fixUntilGreenPaths,
  schematic: fixUntilGreenSchematic,
  canonicalStagePolicy: fixUntilGreenCanonicalStagePolicy,
  reports: fixUntilGreenReports,
  // The composed-Converge stop-judge shape hint. It keys on the bound
  // converge.judgment@v1 contract, not on this flow id, so it serves any generated
  // Converge tail; it lives here because fix-until-green is the canonical Converge.
  structuralHints: [convergeJudgmentRelayShapeHint],
} satisfies FlowData;

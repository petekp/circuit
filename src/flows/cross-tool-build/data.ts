import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { crossToolBuildAssemblySpec } from './assembly-spec.js';
import {
  crossToolBuildImplementationShapeHint,
  crossToolBuildProposalReviewShapeHint,
  crossToolBuildProposalShapeHint,
  crossToolBuildSpecReviewShapeHint,
  crossToolBuildSpecShapeHint,
} from './relay-hints.js';
import {
  CrossToolBuildImplementation,
  CrossToolBuildPlan,
  CrossToolBuildProposal,
  CrossToolBuildProposalReview,
  CrossToolBuildResult,
  CrossToolBuildSpec,
  CrossToolBuildSpecReview,
  CrossToolBuildVerification,
} from './reports.js';
import { crossToolBuildCloseBuilder } from './writers/close.js';
import { crossToolBuildPlanComposeBuilder } from './writers/plan.js';
import { crossToolBuildVerificationWriter } from './writers/verification.js';

const crossToolBuildPaths = {
  schematic: 'src/flows/cross-tool-build/schematic.json',
} satisfies FlowData['paths'];

// First-class composition: cross-tool-build is an assembler customer. Its block
// sequence (with the per-step connector pins) lives in ./assembly-spec.ts;
// `assembleFlowSchematic` derives starts_at / stages / stage_path_policy and
// returns the validated FlowSchematic.
const crossToolBuildSchematic = assembleFlowSchematic(
  crossToolBuildAssemblySpec,
) satisfies FlowData['schematic'];

const crossToolBuildCanonicalStagePolicy = {
  kind: 'exempt',
  reason: 'partial-stage path, recorded',
} satisfies FlowData['canonicalStagePolicy'];

// cross-tool-build owns its own schema names so its writers do not collide with
// build's / fix's on the global compose, verification, and report-schema
// registries. The five doer/reviewer relays carry typed reports (proposal, spec,
// the two reviews, implementation); the plan, verification, and result are
// writer-backed. The two reviews share one Zod shape under two names.
const crossToolBuildReports = [
  {
    schemaName: 'cross-tool-build.proposal@v1',
    channel: 'relay',
    schema: CrossToolBuildProposal,
    relayHint: crossToolBuildProposalShapeHint.instruction,
  },
  {
    schemaName: 'cross-tool-build.proposal-review@v1',
    channel: 'relay',
    schema: CrossToolBuildProposalReview,
    relayHint: crossToolBuildProposalReviewShapeHint.instruction,
  },
  {
    schemaName: 'cross-tool-build.spec@v1',
    channel: 'relay',
    schema: CrossToolBuildSpec,
    relayHint: crossToolBuildSpecShapeHint.instruction,
  },
  {
    schemaName: 'cross-tool-build.spec-review@v1',
    channel: 'relay',
    schema: CrossToolBuildSpecReview,
    relayHint: crossToolBuildSpecReviewShapeHint.instruction,
  },
  {
    schemaName: 'cross-tool-build.implementation@v1',
    channel: 'relay',
    schema: CrossToolBuildImplementation,
    relayHint: crossToolBuildImplementationShapeHint.instruction,
  },
  {
    schemaName: 'cross-tool-build.plan@v1',
    channel: 'report',
    schema: CrossToolBuildPlan,
    writers: { compose: [crossToolBuildPlanComposeBuilder] },
  },
  {
    schemaName: 'cross-tool-build.verification@v1',
    channel: 'report',
    schema: CrossToolBuildVerification,
    writers: { verification: [crossToolBuildVerificationWriter] },
  },
  {
    schemaName: 'cross-tool-build.result@v1',
    channel: 'report',
    schema: CrossToolBuildResult,
    writers: { close: [crossToolBuildCloseBuilder] },
  },
] satisfies NonNullable<FlowData['reports']>;

export const crossToolBuildFlowData = {
  id: 'cross-tool-build',
  visibility: 'internal',
  paths: crossToolBuildPaths,
  schematic: crossToolBuildSchematic,
  canonicalStagePolicy: crossToolBuildCanonicalStagePolicy,
  reports: crossToolBuildReports,
  // The close stage's compose writes cross-tool-build.result@v1 to @complete, so
  // the compiler DERIVES this as the run's primary result. Author it explicitly
  // to match (the manifest-roundtrip drift guard requires the package to
  // advertise whatever the manifest derives).
  runtimeSurface: {
    primaryResult: {
      schemaName: 'cross-tool-build.result@v1',
      path: 'reports/cross-tool-build-result.json',
      label: 'Cross-Tool Build result',
    },
  },
} satisfies FlowData;

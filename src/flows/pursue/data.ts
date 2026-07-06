import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { PURSUE_STAGE_POLICY, pursueAssemblySpec } from './assembly-spec.js';
import { pursuitBatchShapeHint, pursuitReviewShapeHint } from './relay-hints.js';
import {
  PursuitBatch,
  PursuitContract,
  PursuitGraph,
  PursuitResult,
  PursuitReview,
  PursuitVerification,
  PursuitWavePlan,
} from './reports.js';
import { pursuitCloseBuilder } from './writers/close.js';
import { pursuitContractComposeBuilder } from './writers/contract.js';
import { pursuitGraphComposeBuilder } from './writers/graph.js';
import { pursuitVerificationWriter } from './writers/verification.js';
import { pursuitWavePlanComposeBuilder } from './writers/wave-plan.js';

export const pursueFlowData = {
  id: 'pursue',
  visibility: 'internal',
  paths: {
    schematic: 'src/flows/pursue/schematic.json',
    contract: 'src/flows/pursue/contract.md',
  },
  // First-class composition (M9): pursue is the assembler's second production
  // customer (after build) and the first with a PARTIAL stage path — it omits
  // analyze. Its block sequence and flow-level scaffolding live in
  // ./assembly-spec.ts; `assembleFlowSchematic` derives starts_at, stages, and
  // stage_path_policy (mode: 'partial', omits: ['analyze']) from the sequence
  // and returns the validated FlowSchematic that used to be hand-authored here.
  // The M7 prove-by-equivalence test pins that the assembled schematic is
  // byte-identical to the former literal; the drift gate proves the generated
  // schematic.json / circuit.json are unchanged.
  schematic: assembleFlowSchematic(pursueAssemblySpec),
  canonicalStagePolicy: PURSUE_STAGE_POLICY.canonicalStagePolicy,
  reports: [
    {
      schemaName: 'pursuit.batch@v1',
      channel: 'relay',
      schema: PursuitBatch,
      relayHint: pursuitBatchShapeHint.instruction,
    },
    {
      schemaName: 'pursuit.review@v1',
      channel: 'relay',
      schema: PursuitReview,
      relayHint: pursuitReviewShapeHint.instruction,
    },
    {
      schemaName: 'pursuit.contract@v1',
      channel: 'report',
      schema: PursuitContract,
      writers: { compose: [pursuitContractComposeBuilder] },
    },
    {
      schemaName: 'pursuit.graph@v1',
      channel: 'report',
      schema: PursuitGraph,
      writers: { compose: [pursuitGraphComposeBuilder] },
    },
    {
      schemaName: 'pursuit.wave-plan@v1',
      channel: 'report',
      schema: PursuitWavePlan,
      writers: { compose: [pursuitWavePlanComposeBuilder] },
    },
    {
      schemaName: 'pursuit.verification@v1',
      channel: 'report',
      schema: PursuitVerification,
      writers: { verification: [pursuitVerificationWriter] },
    },
    {
      schemaName: 'pursuit.result@v1',
      channel: 'report',
      schema: PursuitResult,
      writers: { close: [pursuitCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'pursuit.result@v1',
      path: 'reports/pursuit-result.json',
      label: 'Pursuit result',
    },
    progress: {
      steps: [
        {
          stepId: 'contract-step',
          taskTitle: 'Frame the work',
          activeText: 'Framing the work',
        },
        {
          stepId: 'graph-step',
          taskTitle: 'Coordinate the work',
          activeText: 'Coordinating the work',
        },
        {
          stepId: 'wave-plan-step',
          taskTitle: 'Plan the work',
          activeText: 'Planning the work',
        },
        {
          stepId: 'batch-step',
          taskTitle: 'Make the change',
          activeText: 'Making the change',
          relayRole: 'implementer',
          relayStartedText: 'Asking the specialist to make the change...',
          relayCompletedText: 'Finished the specialist pass.',
        },
        {
          stepId: 'verify-step',
          taskTitle: 'Check the work',
          activeText: 'Checking the work',
        },
        {
          stepId: 'review-step',
          taskTitle: 'Check the result',
          activeText: 'Checking the result',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the result...',
          relayCompletedText: 'Finished checking the result.',
        },
        {
          stepId: 'close-step',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
      ],
    },
  },
} satisfies FlowData;

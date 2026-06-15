import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { buildAssemblySpec } from './assembly-spec.js';
import {
  buildContextShapeHint,
  buildImplementationShapeHint,
  buildReviewShapeHint,
} from './relay-hints.js';
import {
  BuildBaselineSnapshot,
  BuildBrief,
  BuildContext,
  BuildImplementation,
  BuildPlan,
  BuildResult,
  BuildReview,
  BuildTouchArea,
  BuildVerification,
} from './reports.js';
import { buildBaselineSnapshotWriter } from './writers/baseline-snapshot.js';
import { buildBriefCheckpointBuilder } from './writers/checkpoint-brief.js';
import { buildCloseBuilder } from './writers/close.js';
import { buildPlanComposeBuilder } from './writers/plan.js';
import { buildTouchAreaWriter } from './writers/touch-area.js';
import { buildVerificationWriter } from './writers/verification.js';

export const buildFlowData = {
  id: 'build',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/build/schematic.json',
    contract: 'src/flows/build/contract.md',
  },
  // First-class composition (M9): build is the assembler's first production
  // customer. Its block sequence and flow-level scaffolding live in
  // ./assembly-spec.ts; `assembleFlowSchematic` derives the three sequence-level
  // fields (starts_at, stages, stage_path_policy) and returns the validated
  // FlowSchematic that used to be hand-authored as a literal here. The M9 truth
  // test proves the assembled schematic is byte-identical to the former literal
  // (schematic + compiled), and that the assembled-then-compiled build runs to
  // @complete on the shared graph runner. The assembler is now a live producer,
  // not a test-only artifact.
  schematic: assembleFlowSchematic(buildAssemblySpec),
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'analyze', 'plan', 'act', 'verify', 'review', 'close'],
    omits: [],
    optional_canonicals: [],
    variants: [],
    title: 'Frame → Analyze → Plan → Act → Verify → Review → Close',
    authority: 'src/flows/build/contract.md §Build Flow Contract',
  },
  reports: [
    {
      schemaName: 'build.implementation@v1',
      channel: 'relay',
      schema: BuildImplementation,
      relayHint: buildImplementationShapeHint.instruction,
    },
    {
      schemaName: 'build.review@v1',
      channel: 'relay',
      schema: BuildReview,
      relayHint: buildReviewShapeHint.instruction,
    },
    {
      schemaName: 'build.context@v1',
      channel: 'relay',
      schema: BuildContext,
      relayHint: buildContextShapeHint.instruction,
    },
    {
      schemaName: 'build.brief@v1',
      channel: 'report',
      schema: BuildBrief,
      writers: { checkpoint: [buildBriefCheckpointBuilder] },
    },
    {
      schemaName: 'build.plan@v1',
      channel: 'report',
      schema: BuildPlan,
      fileSurface: {
        timing: 'before',
        extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
      },
      writers: { compose: [buildPlanComposeBuilder] },
    },
    {
      schemaName: 'build.verification@v1',
      channel: 'report',
      schema: BuildVerification,
      writers: { verification: [buildVerificationWriter] },
    },
    {
      schemaName: 'build.baseline-snapshot@v1',
      channel: 'report',
      schema: BuildBaselineSnapshot,
      writers: { verification: [buildBaselineSnapshotWriter] },
    },
    {
      schemaName: 'build.touch-area@v1',
      channel: 'report',
      schema: BuildTouchArea,
      writers: { verification: [buildTouchAreaWriter] },
    },
    {
      schemaName: 'build.result@v1',
      channel: 'report',
      schema: BuildResult,
      writers: { close: [buildCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'build.result@v1',
      path: 'reports/build-result.json',
      label: 'Build result',
    },
    progress: {
      steps: [
        {
          stepId: 'frame-step',
          taskTitle: 'Frame the work',
          activeText: 'Framing the work',
        },
        {
          stepId: 'analyze-step',
          taskTitle: 'Read the code',
          activeText: 'Reading the code',
          relayRole: 'researcher',
          relayStartedText: 'Asking the specialist to read the code...',
          relayCompletedText: 'Finished reading the code.',
        },
        {
          stepId: 'plan-step',
          taskTitle: 'Plan the work',
          activeText: 'Planning the work',
        },
        {
          stepId: 'build-baseline',
          taskTitle: 'Note the starting point',
          activeText: 'Noting the starting point',
        },
        {
          stepId: 'act-step',
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
          stepId: 'build-touch-area',
          taskTitle: 'Check what changed',
          activeText: 'Checking what changed',
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

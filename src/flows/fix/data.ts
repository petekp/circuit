import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { fixAssemblySpec } from './assembly-spec.js';
import {
  fixChangeShapeHint,
  fixContextShapeHint,
  fixDiagnosisShapeHint,
  fixReviewShapeHint,
} from './relay-hints.js';
import {
  FixBaselineSnapshot,
  FixBrief,
  FixChange,
  FixChangeSet,
  FixContext,
  FixDiagnosis,
  FixFinalChangeSet,
  FixNoReproDecision,
  FixRegressionProof,
  FixRegressionRerun,
  FixResult,
  FixReview,
  FixVerification,
} from './reports.js';
import { fixBaselineSnapshotWriter } from './writers/baseline-snapshot.js';
import { fixBriefComposeBuilder } from './writers/brief.js';
import { fixChangeSetWriter } from './writers/change-set.js';
import { fixCloseBuilder } from './writers/close.js';
import { fixFinalChangeSetWriter } from './writers/final-change-set.js';
import { fixRegressionBaselineWriter } from './writers/regression-baseline.js';
import { fixRegressionRerunWriter } from './writers/regression-rerun.js';
import { fixVerificationWriter } from './writers/verification.js';

export const fixFlowData = {
  id: 'fix',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/fix/schematic.json',
    contract: 'src/flows/fix/contract.md',
  },
  // First-class composition (A5): fix is one of the assembler's production
  // customers. Its block sequence, scaffolding, and report_file_surfaces live in
  // ./assembly-spec.ts; `assembleFlowSchematic` derives starts_at / stages /
  // stage_path_policy and returns the validated FlowSchematic that used to be a
  // hand-authored literal here. The prove-by-equivalence test proves the
  // assembled schematic is byte-identical to the former literal (schematic +
  // compiled).
  schematic: assembleFlowSchematic(fixAssemblySpec),
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
    omits: ['plan'],
    optional_canonicals: ['review'],
    variants: [],
    title: 'Frame → Diagnose → Fix → Verify → Review → Close',
    authority: 'docs/flows/authoring-model.md §Fix As The Proving Shape',
  },
  reports: [
    {
      schemaName: 'fix.context@v1',
      channel: 'relay',
      schema: FixContext,
      relayHint: fixContextShapeHint.instruction,
    },
    {
      schemaName: 'fix.diagnosis@v1',
      channel: 'relay',
      schema: FixDiagnosis,
      relayHint: fixDiagnosisShapeHint.instruction,
    },
    {
      schemaName: 'fix.change@v1',
      channel: 'relay',
      schema: FixChange,
      relayHint: fixChangeShapeHint.instruction,
    },
    {
      schemaName: 'fix.review@v1',
      channel: 'relay',
      schema: FixReview,
      relayHint: fixReviewShapeHint.instruction,
    },
    {
      schemaName: 'fix.brief@v1',
      channel: 'report',
      schema: FixBrief,
      writers: { compose: [fixBriefComposeBuilder] },
    },
    {
      schemaName: 'fix.no-repro-decision@v1',
      channel: 'report',
      schema: FixNoReproDecision,
    },
    {
      schemaName: 'fix.regression-proof@v1',
      channel: 'report',
      schema: FixRegressionProof,
      writers: { verification: [fixRegressionBaselineWriter] },
    },
    {
      schemaName: 'fix.baseline-snapshot@v1',
      channel: 'report',
      schema: FixBaselineSnapshot,
      writers: { verification: [fixBaselineSnapshotWriter] },
    },
    {
      schemaName: 'fix.verification@v1',
      channel: 'report',
      schema: FixVerification,
      writers: { verification: [fixVerificationWriter] },
    },
    {
      schemaName: 'fix.regression-rerun@v1',
      channel: 'report',
      schema: FixRegressionRerun,
      writers: { verification: [fixRegressionRerunWriter] },
    },
    {
      schemaName: 'fix.change-set@v1',
      channel: 'report',
      schema: FixChangeSet,
      fileSurface: {
        timing: 'after',
        extractor: { kind: 'string-array-field', field: 'observed' },
      },
      writers: { verification: [fixChangeSetWriter] },
    },
    {
      schemaName: 'fix.final-change-set@v1',
      channel: 'report',
      schema: FixFinalChangeSet,
      writers: { verification: [fixFinalChangeSetWriter] },
    },
    {
      schemaName: 'fix.result@v1',
      channel: 'report',
      schema: FixResult,
      writers: { close: [fixCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'fix.result@v1',
      path: 'reports/fix-result.json',
      label: 'Fix result',
    },
    progress: {
      steps: [
        {
          stepId: 'fix-frame',
          taskTitle: 'Frame the work',
          activeText: 'Framing the work',
        },
        {
          stepId: 'fix-gather-context',
          taskTitle: 'Check the context',
          activeText: 'Checking the context',
          relayRole: 'researcher',
          relayStartedText: 'Asking the specialist to gather context...',
          relayCompletedText: 'Finished gathering context.',
        },
        {
          stepId: 'fix-diagnose',
          taskTitle: 'Check the context',
          activeText: 'Checking the context',
          relayRole: 'researcher',
          relayStartedText: 'Asking the specialist to diagnose the cause...',
          relayCompletedText: 'Finished the diagnosis.',
        },
        {
          stepId: 'fix-no-repro-decision',
          taskTitle: 'Check the context',
          activeText: 'Checking the context',
        },
        {
          stepId: 'fix-regression-baseline',
          taskTitle: 'Check the work',
          activeText: 'Checking the work',
        },
        {
          stepId: 'fix-baseline-snapshot',
          taskTitle: 'Check the work',
          activeText: 'Checking the work',
        },
        {
          stepId: 'fix-act',
          taskTitle: 'Make the change',
          activeText: 'Making the change',
          relayRole: 'implementer',
          relayStartedText: 'Asking the specialist to make the change...',
          relayCompletedText: 'Finished the specialist pass.',
        },
        {
          stepId: 'fix-verify',
          taskTitle: 'Check the work',
          activeText: 'Checking the work',
        },
        {
          stepId: 'fix-change-set',
          taskTitle: 'Check the work',
          activeText: 'Checking the work',
        },
        {
          stepId: 'fix-regression-rerun',
          taskTitle: 'Check the work',
          activeText: 'Checking the work',
        },
        {
          stepId: 'fix-review',
          taskTitle: 'Check the result',
          activeText: 'Checking the result',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the result...',
          relayCompletedText: 'Finished checking the result.',
        },
        {
          stepId: 'fix-final-change-set',
          taskTitle: 'Check the final state',
          activeText: 'Checking the final state',
        },
        {
          stepId: 'fix-close-low',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
        {
          stepId: 'fix-close',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
        {
          stepId: 'fix-handoff',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
      ],
    },
  },
} satisfies FlowData;

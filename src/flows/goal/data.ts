import { RunResult } from '../../schemas/result.js';
import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { goalAssemblySpec } from './assembly-spec.js';
import {
  goalClarifiedTaskShapeHint,
  goalGatePassShapeHint,
  goalGateShapeHint,
} from './relay-hints.js';
import {
  GoalAttempt,
  GoalClarifiedTask,
  GoalContract,
  GoalEvidenceEvaluation,
  GoalGate,
  GoalRecovery,
  GoalResult,
} from './reports.js';
import { goalAttemptBuilder } from './writers/attempt.js';
import { goalCloseBuilder } from './writers/close.js';
import { goalContractBuilder } from './writers/contract.js';
import { goalEvidenceEvaluationBuilder } from './writers/evidence-evaluation.js';
import { goalRecoveryBuilder } from './writers/recovery.js';

export const goalFlowData = {
  id: 'goal',
  // S8: frozen to internal. Goal's contract/gate semantics moved into the Run
  // envelope (Phase 13). The flow stays in the catalog and keeps its manifest for
  // reader-compat and explicit/internal runs, but no longer publishes a public
  // host command/skill surface. Classifier selection is gated separately (S9).
  visibility: 'internal',
  paths: {
    schematic: 'src/flows/goal/schematic.json',
  },
  // First-class composition (A5): goal is one of the assembler's production
  // customers, and its generality stress-test. Its block sequence (including the
  // five sub-run child-flow steps), scaffolding, and engine_flags live in
  // ./assembly-spec.ts; `assembleFlowSchematic` derives starts_at / stages /
  // stage_path_policy and returns the validated FlowSchematic that used to be a
  // hand-authored literal here. The prove-by-equivalence test proves byte-
  // identity (schematic + compiled), and the M9 truth test proves the assembled
  // goal RUNS its sub-run path on the shared graph runner.
  schematic: assembleFlowSchematic(goalAssemblySpec),
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'act', 'verify', 'review', 'close'],
    omits: ['analyze', 'plan'],
    optional_canonicals: [],
    variants: [],
    title: 'Frame -> Act -> Verify -> Review -> Close',
    authority: 'docs/specs/goal-block-v1.md §V1 Flow Shape',
  },
  reports: [
    {
      schemaName: 'goal.clarified-task@v1',
      channel: 'relay',
      schema: GoalClarifiedTask,
      relayHint: goalClarifiedTaskShapeHint.instruction,
    },
    {
      schemaName: 'goal.contract@v1',
      channel: 'report',
      schema: GoalContract,
      writers: { compose: [goalContractBuilder] },
    },
    {
      schemaName: 'goal.child-fix-result@v1',
      channel: 'report',
      schema: RunResult,
    },
    {
      schemaName: 'goal.child-build-result@v1',
      channel: 'report',
      schema: RunResult,
    },
    {
      schemaName: 'goal.child-review-result@v1',
      channel: 'report',
      schema: RunResult,
    },
    {
      schemaName: 'goal.child-explore-result@v1',
      channel: 'report',
      schema: RunResult,
    },
    {
      schemaName: 'goal.child-pursue-result@v1',
      channel: 'report',
      schema: RunResult,
    },
    {
      schemaName: 'goal.attempt@v1',
      channel: 'report',
      schema: GoalAttempt,
      writers: { compose: [goalAttemptBuilder] },
    },
    {
      schemaName: 'goal.evidence-evaluation@v1',
      channel: 'report',
      schema: GoalEvidenceEvaluation,
      writers: { compose: [goalEvidenceEvaluationBuilder] },
    },
    {
      schemaName: 'goal.recovery@v1',
      channel: 'report',
      schema: GoalRecovery,
      writers: { compose: [goalRecoveryBuilder] },
    },
    {
      schemaName: 'goal.gate-pass@v1',
      channel: 'relay',
      schema: GoalGate,
      relayHint: goalGatePassShapeHint.instruction,
    },
    {
      schemaName: 'goal.gate@v1',
      channel: 'relay',
      schema: GoalGate,
      relayHint: goalGateShapeHint.instruction,
    },
    {
      schemaName: 'goal.result@v1',
      channel: 'report',
      schema: GoalResult,
      writers: { close: [goalCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'goal.result@v1',
      path: 'reports/goal-result.json',
      label: 'Goal result',
    },
    progress: {
      steps: [
        {
          stepId: 'clarify-goal',
          taskTitle: 'Clarify the goal',
          activeText: 'Clarifying the goal',
          relayRole: 'researcher',
          relayStartedText: 'Asking the researcher to clarify the goal...',
          relayCompletedText: 'Finished clarifying the goal.',
        },
        {
          stepId: 'goal-contract',
          taskTitle: 'Write the goal contract',
          activeText: 'Writing the goal contract',
        },
        { stepId: 'goal-run-fix', taskTitle: 'Run Fix', activeText: 'Running Fix' },
        { stepId: 'goal-run-build', taskTitle: 'Run Build', activeText: 'Running Build' },
        { stepId: 'goal-run-review', taskTitle: 'Run Review', activeText: 'Running Review' },
        { stepId: 'goal-run-explore', taskTitle: 'Run Explore', activeText: 'Running Explore' },
        { stepId: 'goal-run-pursue', taskTitle: 'Run Pursue', activeText: 'Running Pursue' },
        {
          stepId: 'goal-attempt',
          taskTitle: 'Record the attempt',
          activeText: 'Recording the attempt',
        },
        {
          stepId: 'goal-evidence-evaluation',
          taskTitle: 'Evaluate evidence',
          activeText: 'Evaluating evidence',
        },
        { stepId: 'goal-recovery', taskTitle: 'Choose recovery', activeText: 'Choosing recovery' },
        {
          stepId: 'goal-recovery-checkpoint',
          taskTitle: 'Ask for judgment',
          activeText: 'Waiting on judgment',
        },
        {
          stepId: 'goal-gate-pass-1',
          taskTitle: 'Run review pass 1',
          activeText: 'Running review pass 1',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the proof...',
          relayCompletedText: 'Finished review pass 1.',
        },
        {
          stepId: 'goal-gate-pass-2',
          taskTitle: 'Run review pass 2',
          activeText: 'Running review pass 2',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the proof again...',
          relayCompletedText: 'Finished review pass 2.',
        },
        { stepId: 'goal-close', taskTitle: 'Wrap up', activeText: 'Wrapping up' },
      ],
    },
  },
  // Stage 3 (first-class composition): goal's engine flags now live on its
  // schematic (see `schematic.engine_flags` above), so they travel on the
  // compiled manifest. The package intentionally carries no engineFlags; the
  // engine resolves the terminal-outcome bind from the manifest.
} satisfies FlowData;

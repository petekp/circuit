import { RunResult } from '../../schemas/result.js';
import type { FlowData } from '../flow-definition.js';
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

const CHILD_PASS_VERDICTS = [
  'accept',
  'accept-with-fixes',
  'accept-with-fold-ins',
  'NO_ISSUES_FOUND',
  'ISSUES_FOUND',
  'clean',
  'needs-followup',
  'decided',
] as const;

const childGoal =
  'Execute the selected child flow for reports/goal/contract.json. Preserve the operator objective and produce a report-backed proof packet.';

function childRunStep(input: {
  readonly id: string;
  readonly title: string;
  readonly flowId: 'fix' | 'build' | 'review' | 'explore' | 'pursue';
  readonly output: string;
  readonly resultPath: string;
}): FlowData['schematic']['items'][number] {
  return {
    id: input.id,
    title: input.title,
    stage: 'act',
    block: 'goal',
    input: {
      contract: 'goal.contract@v1',
    },
    output: input.output,
    evidence_requirements: ['static child flow target', 'child result file', 'parent trace link'],
    execution: {
      kind: 'sub-run',
      flow_ref: { flow_id: input.flowId, entry_mode: 'default' },
      goal: childGoal,
      depth: 'standard',
    },
    protocol: `${input.id}@v1`,
    writes: {
      result_path: input.resultPath,
    },
    check: {
      pass: [...CHILD_PASS_VERDICTS],
    },
    routes: {
      continue: 'goal-attempt',
      stop: '@stop',
    },
  };
}

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
  schematic: {
    schema_version: '1',
    id: 'goal',
    title: 'Goal Schematic',
    purpose:
      'Goal flow. Circuit writes a bounded goal contract, runs one statically authored child flow target, evaluates evidence, runs a two-pass safety review, and closes from typed Goal reports.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'clarify-goal',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'flow.question@v1'],
    contract_aliases: [
      { generic: 'clarified.task@v1', actual: 'goal.clarified-task@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.child-fix-result@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.child-build-result@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.child-review-result@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.child-explore-result@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.child-pursue-result@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.attempt@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.evidence-evaluation@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.recovery@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.gate-pass@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.gate@v1' },
      { generic: 'goal.contract@v1', actual: 'goal.result@v1' },
    ],
    entry: {
      signals: {
        include: ['goal', 'supervise'],
        exclude: [],
      },
      intent_prefixes: ['goal', 'supervise'],
    },
    axes: {
      allowed_rigors: ['lite', 'standard', 'deep'],
      supports_tournament: false,
      supports_autonomous: true,
      default: {
        rigor: 'standard',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
    },
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan'],
      rationale:
        'Goal supervises a child flow through Frame, Act, Verify, Review, and Close. Analyze and Plan are delegated to the selected static child flow.',
    },
    stages: [
      { id: 'goal-frame-stage', canonical: 'frame', title: 'Frame' },
      { id: 'goal-act-stage', canonical: 'act', title: 'Act' },
      { id: 'goal-verify-stage', canonical: 'verify', title: 'Verify' },
      { id: 'goal-review-stage', canonical: 'review', title: 'Review' },
      { id: 'goal-close-stage', canonical: 'close', title: 'Close' },
    ],
    items: [
      {
        id: 'clarify-goal',
        title: 'Clarify - shape Goal task',
        stage: 'frame',
        block: 'clarify',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        output: 'goal.clarified-task@v1',
        evidence_requirements: [
          'original request',
          'clarified task',
          'desired outcome',
          'proof needed',
          'constraints',
          'scope',
          'assumptions',
          'missing information',
          'stop conditions',
        ],
        execution: { kind: 'relay', role: 'researcher' },
        protocol: 'goal-clarify@v1',
        writes: {
          report_path: 'reports/goal/clarified-task.json',
          request_path: 'reports/relay/goal-clarify.request.json',
          receipt_path: 'reports/relay/goal-clarify.receipt.txt',
          result_path: 'reports/relay/goal-clarify.result.json',
        },
        check: {
          pass: ['continue', 'ask', 'stop'],
        },
        route_from_report: {
          path: ['verdict'],
        },
        routes: {
          continue: 'goal-contract',
          ask: '@stop',
          stop: '@stop',
        },
      },
      {
        id: 'goal-contract',
        title: 'Goal - write contract and select static target',
        stage: 'frame',
        block: 'goal',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
          clarified: 'goal.clarified-task@v1',
        },
        output: 'goal.contract@v1',
        evidence_requirements: [
          'goal contract',
          'done claims',
          'proof requirements',
          'allowed flow targets',
          'recovery routes',
          'safety review policy',
        ],
        execution: { kind: 'compose' },
        protocol: 'goal-contract@v1',
        writes: {
          report_path: 'reports/goal/contract.json',
        },
        check: {
          required: ['schema', 'objective', 'done_when', 'selected_flow_target'],
        },
        route_from_report: {
          path: ['selected_flow_target'],
        },
        routes: {
          continue: 'goal-run-build',
          fix: 'goal-run-fix',
          build: 'goal-run-build',
          review: 'goal-run-review',
          explore: 'goal-run-explore',
          pursue: 'goal-run-pursue',
          ask: 'goal-recovery-checkpoint',
          stop: '@stop',
        },
      },
      childRunStep({
        id: 'goal-run-fix',
        title: 'Child Flow - run Fix',
        flowId: 'fix',
        output: 'goal.child-fix-result@v1',
        resultPath: 'reports/goal/child-results/fix-result.json',
      }),
      childRunStep({
        id: 'goal-run-build',
        title: 'Child Flow - run Build',
        flowId: 'build',
        output: 'goal.child-build-result@v1',
        resultPath: 'reports/goal/child-results/build-result.json',
      }),
      childRunStep({
        id: 'goal-run-review',
        title: 'Child Flow - run Review',
        flowId: 'review',
        output: 'goal.child-review-result@v1',
        resultPath: 'reports/goal/child-results/review-result.json',
      }),
      childRunStep({
        id: 'goal-run-explore',
        title: 'Child Flow - run Explore',
        flowId: 'explore',
        output: 'goal.child-explore-result@v1',
        resultPath: 'reports/goal/child-results/explore-result.json',
      }),
      childRunStep({
        id: 'goal-run-pursue',
        title: 'Child Flow - run Pursue',
        flowId: 'pursue',
        output: 'goal.child-pursue-result@v1',
        resultPath: 'reports/goal/child-results/pursue-result.json',
      }),
      {
        id: 'goal-attempt',
        title: 'Attempt - summarize child result',
        stage: 'act',
        block: 'goal',
        input: {
          contract: 'goal.contract@v1',
        },
        output: 'goal.attempt@v1',
        evidence_requirements: ['child result path', 'child report paths', 'attempt outcome'],
        execution: { kind: 'compose' },
        protocol: 'goal-attempt@v1',
        writes: {
          report_path: 'reports/goal/attempts/attempt-1.json',
        },
        check: {
          required: ['schema', 'attempt_id', 'flow_target', 'outcome'],
        },
        routes: {
          continue: 'goal-evidence-evaluation',
          stop: '@stop',
        },
      },
      {
        id: 'goal-evidence-evaluation',
        title: 'Evaluate - compare attempt evidence to done claims',
        stage: 'verify',
        block: 'goal',
        input: {
          contract: 'goal.contract@v1',
          attempt: 'goal.attempt@v1',
        },
        output: 'goal.evidence-evaluation@v1',
        evidence_requirements: ['claim results', 'evidence gaps', 'next typed route'],
        execution: { kind: 'compose' },
        protocol: 'goal-evidence-evaluation@v1',
        writes: {
          report_path: 'reports/goal/evidence-evaluation.json',
        },
        check: {
          required: ['schema', 'verdict', 'claim_results', 'next_route'],
        },
        route_from_report: {
          path: ['next_route'],
        },
        routes: {
          continue: 'goal-gate-pass-1',
          'completion-gate': 'goal-gate-pass-1',
          'retry-selected-flow': 'goal-recovery',
          'run-fix': 'goal-recovery',
          'run-review': 'goal-recovery',
          'run-explore': 'goal-recovery',
          'split-to-pursue': 'goal-recovery',
          checkpoint: 'goal-recovery',
          handoff: '@handoff',
          blocked: 'goal-recovery',
          stop: '@stop',
        },
      },
      {
        id: 'goal-recovery',
        title: 'Recovery - choose typed next action',
        stage: 'verify',
        block: 'goal',
        input: {
          evaluation: 'goal.evidence-evaluation@v1',
          attempt: 'goal.attempt@v1',
        },
        output: 'goal.recovery@v1',
        evidence_requirements: ['recovery reason', 'selected route', 'operator input need'],
        execution: { kind: 'compose' },
        protocol: 'goal-recovery@v1',
        writes: {
          report_path: 'reports/goal/recovery.json',
        },
        check: {
          required: ['schema', 'reason', 'selected_route', 'rationale'],
        },
        route_from_report: {
          path: ['selected_route'],
        },
        routes: {
          continue: 'goal-recovery-checkpoint',
          'retry-selected-flow': 'goal-recovery-checkpoint',
          'run-fix': 'goal-recovery-checkpoint',
          'run-review': 'goal-recovery-checkpoint',
          'run-explore': 'goal-recovery-checkpoint',
          'split-to-pursue': 'goal-recovery-checkpoint',
          checkpoint: 'goal-recovery-checkpoint',
          blocked: 'goal-close',
          handoff: '@handoff',
          stop: '@stop',
        },
      },
      {
        id: 'goal-recovery-checkpoint',
        title: 'Checkpoint - operator judgment required',
        stage: 'verify',
        block: 'human-decision',
        input: {
          question: 'flow.question@v1',
          evidence: 'goal.recovery@v1',
        },
        output: 'decision.answer@v1',
        evidence_requirements: [
          'question',
          'available options',
          'selected option',
          'answer source',
        ],
        execution: { kind: 'checkpoint' },
        protocol: 'goal-recovery-checkpoint@v1',
        writes: {
          checkpoint_request_path: 'reports/checkpoints/goal-recovery-request.json',
          checkpoint_response_path: 'reports/checkpoints/goal-recovery-response.json',
        },
        check: {
          allow: ['continue', 'blocked', 'handoff'],
        },
        checkpoint_policy: {
          prompt: 'Goal needs operator judgment before continuing.',
          choices: [
            { id: 'continue', label: 'Continue' },
            { id: 'blocked', label: 'Close Blocked' },
            { id: 'handoff', label: 'Hand Off' },
          ],
          safe_default_choice: 'blocked',
        },
        routes: {
          continue: 'goal-close',
          blocked: 'goal-close',
          handoff: '@handoff',
          stop: '@stop',
        },
      },
      {
        id: 'goal-gate-pass-1',
        title: 'Safety review - pass 1',
        stage: 'review',
        block: 'review',
        input: {
          contract: 'goal.contract@v1',
          evaluation: 'goal.evidence-evaluation@v1',
        },
        output: 'goal.gate-pass@v1',
        evidence_requirements: ['safety review pass', 'review lens', 'evidence checked'],
        execution: { kind: 'relay', role: 'reviewer' },
        protocol: 'goal-gate-pass-1@v1',
        writes: {
          report_path: 'reports/goal/gate-pass-1.json',
          request_path: 'reports/relay/goal-gate-pass-1.request.json',
          receipt_path: 'reports/relay/goal-gate-pass-1.receipt.txt',
          result_path: 'reports/relay/goal-gate-pass-1.result.json',
        },
        check: {
          pass: ['gate-pass', 'blocked'],
        },
        route_from_report: {
          path: ['next_route'],
        },
        routes: {
          continue: 'goal-gate-pass-2',
          'run-next-gate-pass': 'goal-gate-pass-2',
          recover: 'goal-recovery',
          retry: 'goal-recovery',
          close: 'goal-recovery',
          stop: '@stop',
        },
      },
      {
        id: 'goal-gate-pass-2',
        title: 'Safety review - pass 2',
        stage: 'review',
        block: 'review',
        input: {
          contract: 'goal.contract@v1',
          evaluation: 'goal.evidence-evaluation@v1',
          gate: 'goal.gate-pass@v1',
        },
        output: 'goal.gate@v1',
        evidence_requirements: ['safety review pass', 'review lens', 'evidence checked'],
        execution: { kind: 'relay', role: 'reviewer' },
        protocol: 'goal-gate-pass-2@v1',
        writes: {
          report_path: 'reports/goal/gate.json',
          request_path: 'reports/relay/goal-gate-pass-2.request.json',
          receipt_path: 'reports/relay/goal-gate-pass-2.receipt.txt',
          result_path: 'reports/relay/goal-gate-pass-2.result.json',
        },
        check: {
          pass: ['gate-pass', 'blocked'],
        },
        route_from_report: {
          path: ['next_route'],
        },
        routes: {
          continue: 'goal-close',
          close: 'goal-close',
          'run-next-gate-pass': 'goal-gate-pass-2',
          recover: 'goal-recovery',
          retry: 'goal-recovery',
          stop: '@stop',
        },
      },
      {
        id: 'goal-close',
        title: 'Close - emit Goal result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          contract: 'goal.contract@v1',
          attempt: 'goal.attempt@v1',
          evaluation: 'goal.evidence-evaluation@v1',
          recovery: 'goal.recovery@v1',
          gate: 'goal.gate@v1',
        },
        output: 'goal.result@v1',
        evidence_requirements: ['outcome', 'evidence pointers', 'residual risks', 'follow-ups'],
        execution: { kind: 'compose' },
        protocol: 'goal-close@v1',
        writes: {
          report_path: 'reports/goal-result.json',
        },
        check: {
          required: ['schema', 'outcome', 'summary', 'evidence_links', 'gate'],
        },
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
      },
    ],
  },
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
  engineFlags: {
    bindsTerminalOutcomeToPrimaryResult: true,
  },
} satisfies FlowData;

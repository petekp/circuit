import { expandBlockStepUse } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
import { defineEnforcedStagePolicy } from '../stage-policy.js';
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

const PURSUE_STAGE_POLICY = defineEnforcedStagePolicy({
  canonicals: ['frame', 'plan', 'act', 'verify', 'review', 'close'],
  omits: ['analyze'],
  rationale:
    'Pursuits V1 folds read-only discovery policy into the coordination graph before acting; a separate Analyze stage can be added when dynamic discovery fanout lands.',
  optional_canonicals: [],
  variants: [],
  title: 'Frame → Coordinate → Execute → Verify → Review → Close',
  authority: 'docs/flows/pursue.md §Flow Shape',
});

export const pursueFlowData = {
  id: 'pursue',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/pursue/schematic.json',
  },
  schematic: {
    schema_version: '1',
    id: 'pursue',
    title: 'Pursue Schematic',
    purpose:
      'Pursue flow: turn one or more rough operator ideas into pursuit contracts, coordinate their order, execute code-changing work serially, verify, review for interference, and close with evidence.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'contract-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'verification.plan@v1'],
    contract_aliases: [
      {
        generic: 'flow.brief@v1',
        actual: 'pursuit.contract@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'pursuit.wave-plan@v1',
      },
      {
        generic: 'work.queue@v1',
        actual: 'pursuit.graph@v1',
      },
      {
        generic: 'batch.result@v1',
        actual: 'pursuit.batch@v1',
      },
      {
        generic: 'change.evidence@v1',
        actual: 'pursuit.batch@v1',
      },
      {
        generic: 'verification.result@v1',
        actual: 'pursuit.verification@v1',
      },
      {
        generic: 'review.verdict@v1',
        actual: 'pursuit.review@v1',
      },
      {
        generic: 'flow.result@v1',
        actual: 'pursuit.result@v1',
      },
    ],
    entry: {
      signals: {
        include: ['pursue', 'pursuit', 'coordinate pursuits', 'multiple autonomous goals'],
        exclude: [],
      },
      intent_prefixes: ['pursue'],
    },
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: true,
      default: {
        rigor: 'standard',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
    },
    stage_path_policy: PURSUE_STAGE_POLICY.stagePathPolicy,
    stages: [
      {
        id: 'frame-stage',
        canonical: 'frame',
        title: 'Frame',
      },
      {
        id: 'plan-stage',
        canonical: 'plan',
        title: 'Coordinate',
      },
      {
        id: 'act-stage',
        canonical: 'act',
        title: 'Execute',
      },
      {
        id: 'verify-stage',
        canonical: 'verify',
        title: 'Verify',
      },
      {
        id: 'review-stage',
        canonical: 'review',
        title: 'Review',
      },
      {
        id: 'close-stage',
        canonical: 'close',
        title: 'Close',
      },
    ],
    items: [
      expandBlockStepUse({
        id: 'contract-step',
        title: 'Frame - create pursuit contract',
        stage: 'frame',
        block: 'pursue',
        input: {
          intake: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        execution: {
          kind: 'compose',
        },
        protocol: 'pursuit-contract@v1',
        reportPath: 'reports/pursuit/contract.json',
        required: ['objective', 'pursuits', 'verification_command_candidates'],
        routes: {
          continue: 'graph-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'graph-step',
        title: 'Coordinate - build pursuit graph',
        stage: 'plan',
        block: 'coordinate-pursuits',
        input: {
          contract: 'pursuit.contract@v1',
        },
        execution: {
          kind: 'compose',
        },
        protocol: 'pursuit-graph@v1',
        reportPath: 'reports/pursuit/graph.json',
        required: ['nodes', 'serial_groups', 'parallel_read_only_groups'],
        routes: {
          continue: 'wave-plan-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'wave-plan-step',
        title: 'Plan - order execution waves',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'pursuit.contract@v1',
          context: 'pursuit.graph@v1',
        },
        output: 'pursuit.wave-plan@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'pursuit-wave-plan@v1',
        reportPath: 'reports/pursuit/wave-plan.json',
        required: ['waves', 'no_parallel_writes_reason'],
        routes: {
          continue: 'batch-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'batch-step',
        title: 'Execute - run serialized pursuit batch',
        stage: 'act',
        block: 'batch',
        input: {
          queue: 'pursuit.graph@v1',
          brief: 'pursuit.contract@v1',
          plan: 'pursuit.wave-plan@v1',
        },
        output: 'pursuit.batch@v1',
        execution: {
          kind: 'relay',
          role: 'implementer',
        },
        protocol: 'pursuit-batch@v1',
        reportPath: 'reports/pursuit/batch.json',
        requestPath: 'reports/relay/pursuit-batch.request.json',
        receiptPath: 'reports/relay/pursuit-batch.receipt.txt',
        resultPath: 'reports/relay/pursuit-batch.result.json',
        pass: ['accept', 'partial'],
        routes: {
          continue: 'verify-step',
          retry: 'batch-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'verify-step',
        title: 'Verify - run Pursue proof commands',
        stage: 'verify',
        block: 'run-verification',
        input: {
          proof: 'verification.plan@v1',
          brief: 'pursuit.contract@v1',
          change: 'pursuit.batch@v1',
        },
        output: 'pursuit.verification@v1',
        protocol: 'pursuit-verify@v1',
        reportPath: 'reports/pursuit/verification.json',
        required: ['overall_status', 'commands'],
        routes: {
          continue: 'review-step',
          retry: 'batch-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'review-step',
        title: 'Review - check pursuit coordination',
        stage: 'review',
        block: 'review',
        input: {
          brief: 'pursuit.contract@v1',
          change: 'pursuit.batch@v1',
          verification: 'pursuit.verification@v1',
        },
        output: 'pursuit.review@v1',
        execution: {
          kind: 'relay',
          role: 'reviewer',
        },
        protocol: 'pursuit-review@v1',
        reportPath: 'reports/pursuit/review.json',
        requestPath: 'reports/relay/pursuit-review.request.json',
        receiptPath: 'reports/relay/pursuit-review.receipt.txt',
        resultPath: 'reports/relay/pursuit-review.result.json',
        pass: ['clean', 'needs-followup', 'blocked'],
        routes: {
          continue: 'close-step',
          retry: 'batch-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'close-step',
        title: 'Close - summarize pursuit result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          brief: 'pursuit.contract@v1',
          graph: 'pursuit.graph@v1',
          plan: 'pursuit.wave-plan@v1',
          verification: 'pursuit.verification@v1',
          review: 'pursuit.review@v1',
          batch: 'pursuit.batch@v1',
        },
        output: 'pursuit.result@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'pursuit-close@v1',
        reportPath: 'reports/pursuit-result.json',
        required: ['summary', 'outcome', 'evidence_links'],
        routes: {
          complete: '@complete',
          stop: '@stop',
          handoff: '@handoff',
          escalate: '@escalate',
        },
      }),
    ],
  },
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

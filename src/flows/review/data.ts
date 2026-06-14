import { composeBlockStep, expandBlockStepUse, relayBlockStep } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
import { reviewRelayShapeHint } from './relay-hints.js';
import { ReviewIntake, ReviewResult } from './reports.js';
import { reviewIntakeComposeBuilder } from './writers/intake.js';
import { reviewResultComposeBuilder } from './writers/result.js';

export const reviewFlowData = {
  id: 'review',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/review/schematic.json',
    contract: 'src/flows/review/contract.md',
  },
  schematic: {
    schema_version: '2',
    id: 'review',
    title: 'Review Schematic',
    purpose:
      'Review flow: frame the audit scope, relay independent review to a reviewer, and close with a verdict report. The schematic uses a compact Intake, Independent Audit, and Verdict shape because Review is audit-only and does not implement or verify a change.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'intake-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1'],
    contract_aliases: [
      {
        generic: 'flow.brief@v1',
        actual: 'review.intake@v1',
      },
      {
        generic: 'review.verdict@v1',
        actual: 'review.verdict@v1',
      },
      {
        generic: 'flow.result@v1',
        actual: 'review.result@v1',
      },
    ],
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
      default: {
        depth: 'medium',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
    },
    stage_path_policy: {
      mode: 'partial',
      omits: ['plan', 'act', 'verify', 'review'],
      rationale:
        'Review is an audit-only flow: Intake frames the scope, Independent Audit performs the reviewer relay, and Verdict aggregates findings. There is no planning stage, no implementation/action stage, no verification rerun, and no nested review stage in this narrowed variant.',
    },
    stages: [
      {
        id: 'intake-stage',
        canonical: 'frame',
        title: 'Intake',
      },
      {
        id: 'audit-stage',
        canonical: 'analyze',
        title: 'Independent Audit',
      },
      {
        id: 'verdict-stage',
        canonical: 'close',
        title: 'Verdict',
      },
    ],
    items: [
      // Review's intake is a structurally distinct frame: it captures the
      // working-tree state to audit against, not the generic scope/constraints/
      // proof-plan a build-style frame produces. It uses the dedicated
      // review-intake block, so its output and evidence are inherited from the
      // block rather than restated here.
      expandBlockStepUse({
        id: 'intake-step',
        title: 'Intake — resolve review scope',
        stage: 'frame',
        block: 'review-intake',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        protocol: 'review-intake@v1',
        reportPath: 'reports/review-intake.json',
        required: ['scope', 'evidence'],
        routes: {
          continue: 'audit-step',
          stop: '@stop',
        },
      }),
      relayBlockStep({
        id: 'audit-step',
        title: 'Independent Audit — reviewer relay',
        stage: 'analyze',
        block: 'review',
        input: {
          brief: 'review.intake@v1',
        },
        role: 'reviewer',
        protocol: 'review-audit@v1',
        requestPath: 'reports/relay/review.request.json',
        receiptPath: 'reports/relay/review.receipt.txt',
        resultPath: 'stages/analyze/review-raw-findings.json',
        pass: ['NO_ISSUES_FOUND', 'ISSUES_FOUND'],
        routes: {
          continue: 'verdict-step',
          retry: 'audit-step',
          stop: '@stop',
        },
      }),
      composeBlockStep({
        id: 'verdict-step',
        title: 'Verdict — emit review.result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          brief: 'review.intake@v1',
          review: 'review.verdict@v1',
        },
        output: 'review.result@v1',
        protocol: 'review-verdict@v1',
        reportPath: 'reports/review-result.json',
        required: ['scope', 'findings', 'verdict'],
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
      }),
    ],
  },
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'analyze', 'close'],
    omits: ['plan', 'act', 'verify', 'review'],
    optional_canonicals: [],
    variants: [],
    title: 'Intake → Independent Audit → Verdict',
    authority: 'src/flows/review/contract.md §Canonical stage policy',
  },
  reports: [
    {
      schemaName: 'review.intake@v1',
      channel: 'report',
      schema: ReviewIntake,
      writers: { compose: [reviewIntakeComposeBuilder] },
    },
    {
      schemaName: 'review.result@v1',
      channel: 'report',
      schema: ReviewResult,
      writers: { compose: [reviewResultComposeBuilder] },
    },
  ],
  structuralHints: [reviewRelayShapeHint],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'review.result@v1',
      path: 'reports/review-result.json',
      label: 'Review result',
    },
    progress: {
      steps: [
        {
          stepId: 'intake-step',
          taskTitle: 'Frame the work',
          activeText: 'Framing the work',
        },
        {
          stepId: 'audit-step',
          taskTitle: 'Check the result',
          activeText: 'Checking the result',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the result...',
          relayCompletedText: 'Finished checking the result.',
        },
        {
          stepId: 'verdict-step',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
      ],
    },
  },
} satisfies FlowData;

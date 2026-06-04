import { expandBlockStepUse } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
import type { CompiledFlowSignal } from '../types.js';
import {
  buildContextShapeHint,
  buildImplementationShapeHint,
  buildReviewShapeHint,
} from './relay-hints.js';
import {
  BuildBrief,
  BuildContext,
  BuildImplementation,
  BuildPlan,
  BuildResult,
  BuildReview,
  BuildVerification,
} from './reports.js';
import { buildBriefCheckpointBuilder } from './writers/checkpoint-brief.js';
import { buildCloseBuilder } from './writers/close.js';
import { buildPlanComposeBuilder } from './writers/plan.js';
import { buildVerificationWriter } from './writers/verification.js';

const BUILD_SIGNALS: readonly CompiledFlowSignal[] = [
  { label: 'develop prefix', pattern: /^\s*develop\s*:/i },
  {
    label: 'build implementation request',
    pattern:
      /^\s*(?:please\s+)?(?:build|implement|develop|add|create|ship)\s+(?:a\s+|an\s+|the\s+|this\s+|that\s+)?(?:new\s+|missing\s+)?(?:feature|change|fix|implementation|endpoint|component|command|tool|integration|helper|export|function|method|behavior)\b/i,
  },
  {
    label: 'missing implementation request',
    pattern:
      /^\s*(?:please\s+)?(?:add|implement|create|ship)\s+(?:the\s+)?missing\s+(?:[\w.-]+\s+)?(?:helper|export|function|method|component|command|endpoint|behavior)\b/i,
  },
  {
    label: 'test-passing implementation request',
    pattern:
      /^\s*(?:please\s+)?(?:add|implement|create|ship|make)\b.*\b(?:helper|export|function|method|component|command|endpoint|behavior)\b.*\b(?:test|tests|check|build|verification)\b.*\b(?:pass|passes|green)\b/i,
  },
  {
    label: 'make change request',
    pattern: /^\s*(?:please\s+)?make\s+(?:a\s+|the\s+|this\s+|that\s+)?(?:focused\s+)?change\b/i,
  },
];

export const buildFlowData = {
  id: 'build',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/build/schematic.json',
    contract: 'src/flows/build/contract.md',
  },
  routing: {
    order: 30,
    signals: BUILD_SIGNALS,
    skipOnPlanningReport: true,
    reasonForMatch(signal) {
      return `matched ${signal.label}; routed to implementation Build flow`;
    },
    inferEntryMode(taskText) {
      if (/^\s*develop\s*:/i.test(taskText)) {
        return {
          name: 'default',
          reason: 'matched develop intent; selected default Build thoroughness',
        };
      }
      return undefined;
    },
  },
  schematic: {
    schema_version: '1',
    id: 'build',
    title: 'Build Schematic',
    purpose:
      'Build flow. Circuit frames a requested change, plans it, relays implementation to a worker, runs verification, relays review to a separate worker, and closes with a Build result file plus evidence.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'frame-step',
    initial_contracts: [
      'task.intake@v1',
      'route.decision@v1',
      'context.request@v1',
      'verification.plan@v1',
    ],
    contract_aliases: [
      {
        generic: 'flow.brief@v1',
        actual: 'build.brief@v1',
      },
      {
        generic: 'context.packet@v1',
        actual: 'build.context@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'build.plan@v1',
      },
      {
        generic: 'change.evidence@v1',
        actual: 'build.implementation@v1',
      },
      {
        generic: 'verification.result@v1',
        actual: 'build.verification@v1',
      },
      {
        generic: 'review.verdict@v1',
        actual: 'build.review@v1',
      },
      {
        generic: 'flow.result@v1',
        actual: 'build.result@v1',
      },
    ],
    entry: {
      signals: {
        include: ['build', 'implement', 'develop', 'change', 'fix', 'add'],
        exclude: [],
      },
      intent_prefixes: ['build', 'implement', 'develop'],
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
      mode: 'strict',
    },
    stages: [
      {
        id: 'frame-stage',
        canonical: 'frame',
        title: 'Frame',
      },
      {
        id: 'analyze-stage',
        canonical: 'analyze',
        title: 'Analyze',
      },
      {
        id: 'plan-stage',
        canonical: 'plan',
        title: 'Plan',
      },
      {
        id: 'act-stage',
        canonical: 'act',
        title: 'Act',
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
        id: 'frame-step',
        title: 'Frame - confirm Build brief',
        stage: 'frame',
        block: 'frame',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        output: 'build.brief@v1',
        execution: {
          kind: 'checkpoint',
        },
        protocol: 'build-frame@v1',
        reportPath: 'reports/build/brief.json',
        checkpointRequestPath: 'reports/checkpoints/frame-step-request.json',
        checkpointResponsePath: 'reports/checkpoints/frame-step-response.json',
        allow: ['continue'],
        checkpointPolicy: {
          prompt: 'Confirm the Build brief before implementation starts.',
          choices: [
            {
              id: 'continue',
              label: 'Continue',
            },
          ],
          safe_default_choice: 'continue',
          report_template: {
            scope: 'Make the smallest safe change that satisfies the requested goal.',
            success_criteria: [
              'The requested behavior is implemented',
              'Verification passes',
              'Review completes without a blocking issue',
            ],
          },
        },
        routes: {
          continue: 'analyze-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'analyze-step',
        title: 'Analyze — read the code before planning',
        stage: 'analyze',
        block: 'gather-context',
        input: {
          brief: 'build.brief@v1',
          request: 'context.request@v1',
        },
        output: 'build.context@v1',
        execution: {
          kind: 'relay',
          role: 'researcher',
        },
        protocol: 'build-analyze@v1',
        reportPath: 'reports/build/context.json',
        requestPath: 'reports/relay/build-analyze.request.json',
        receiptPath: 'reports/relay/build-analyze.receipt.txt',
        resultPath: 'reports/relay/build-analyze.result.json',
        pass: ['accept'],
        routes: {
          continue: 'plan-step',
          retry: 'analyze-step',
          ask: '@stop',
          stop: '@stop',
        },
      }),
      {
        id: 'plan-step',
        title: 'Plan - produce Build plan',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'build.brief@v1',
          context: 'build.context@v1',
        },
        output: 'build.plan@v1',
        evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
        execution: {
          kind: 'compose',
        },
        protocol: 'build-plan@v1',
        writes: {
          report_path: 'reports/build/plan.json',
        },
        check: {
          required: ['objective', 'verification'],
        },
        routes: {
          continue: 'act-step',
          revise: 'plan-step',
          stop: '@stop',
        },
      },
      expandBlockStepUse({
        id: 'act-step',
        title: 'Act - implementation relay',
        stage: 'act',
        block: 'act',
        input: {
          brief: 'build.brief@v1',
          plan: 'build.plan@v1',
        },
        output: 'build.implementation@v1',
        execution: {
          kind: 'relay',
          role: 'implementer',
        },
        protocol: 'build-act@v1',
        reportPath: 'reports/build/implementation.json',
        requestPath: 'reports/relay/build-act.request.json',
        receiptPath: 'reports/relay/build-act.receipt.txt',
        resultPath: 'reports/relay/build-act.result.json',
        pass: ['accept'],
        acceptanceCriteria: {
          checks: [
            {
              kind: 'report_field',
              id: 'changed-files-present',
              path: ['changed_files'],
              predicate: 'present',
            },
            {
              kind: 'report_field',
              id: 'evidence-non-empty',
              path: ['evidence'],
              predicate: 'non_empty',
            },
          ],
          on_failure: { mode: 'retry-with-feedback' },
        },
        routes: {
          continue: 'verify-step',
          retry: 'act-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'verify-step',
        title: 'Verify - run Build verification',
        stage: 'verify',
        block: 'run-verification',
        input: {
          proof: 'verification.plan@v1',
          plan: 'build.plan@v1',
          change: 'build.implementation@v1',
        },
        output: 'build.verification@v1',
        protocol: 'build-verify@v1',
        reportPath: 'reports/build/verification.json',
        required: ['overall_status', 'commands'],
        routes: {
          continue: 'review-step',
          // Slice loop (deep rigor): when this slice's verify passes and
          // more slices remain, the engine selects 'advance' instead of
          // 'continue', re-entering act-step for the next slice. A normal,
          // non-recovery route; see docs/ideas/build-slice-decomposition.md.
          advance: 'act-step',
          retry: 'act-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'review-step',
        title: 'Review - implementation review relay',
        stage: 'review',
        block: 'review',
        input: {
          brief: 'build.brief@v1',
          plan: 'build.plan@v1',
          change: 'build.implementation@v1',
          verification: 'build.verification@v1',
        },
        output: 'build.review@v1',
        execution: {
          kind: 'relay',
          role: 'reviewer',
        },
        protocol: 'build-review@v1',
        reportPath: 'reports/build/review.json',
        requestPath: 'reports/relay/build-review.request.json',
        receiptPath: 'reports/relay/build-review.receipt.txt',
        resultPath: 'reports/relay/build-review.result.json',
        pass: ['accept', 'accept-with-fixes'],
        routes: {
          continue: 'close-step',
          retry: 'act-step',
          revise: 'act-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'close-step',
        title: 'Close - emit Build result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          brief: 'build.brief@v1',
          plan: 'build.plan@v1',
          implementation: 'build.implementation@v1',
          verification: 'build.verification@v1',
          review: 'build.review@v1',
        },
        output: 'build.result@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'build-close@v1',
        reportPath: 'reports/build-result.json',
        required: ['summary', 'outcome', 'evidence_links'],
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
      }),
    ],
  },
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
      writers: { compose: [buildPlanComposeBuilder] },
    },
    {
      schemaName: 'build.verification@v1',
      channel: 'report',
      schema: BuildVerification,
      writers: { verification: [buildVerificationWriter] },
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
  engineFlags: {
    bindsExecutionDepthToRelaySelection: true,
    // Deep rigor implements and verifies the plan's slices one at a time:
    // the engine re-enters act-step for each slice and only advances to
    // review once every slice's verify passes. Lighter rigor runs a single
    // pass. See docs/ideas/build-slice-decomposition.md.
    iteratesSliceLoop: {
      headStep: 'act-step',
      tailStep: 'verify-step',
      advanceRoute: 'advance',
      slicesFrom: {
        report: 'reports/build/plan.json',
        itemsPath: 'slices',
      },
      maxSlices: 8,
      activateWhenDepthAtLeast: 'deep',
    },
  },
} satisfies FlowData;

import { expandBlockStepUse } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
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
  schematic: {
    schema_version: '2',
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
        // build-baseline runs the run-verification block (execution kind
        // verification) to capture a pre-change proof snapshot. Its output is a
        // verification result specialized with git state, so it is build's name
        // for the generic verification.result@v1 at that seam.
        generic: 'verification.result@v1',
        actual: 'build.baseline-snapshot@v1',
      },
      {
        // build-touch-area also runs the run-verification block: it executes
        // containment proof commands and records the result, a verification
        // result specialized with touch-area containment.
        generic: 'verification.result@v1',
        actual: 'build.touch-area@v1',
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
    axes: {
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: false,
      supports_autonomous: true,
      default: {
        depth: 'medium',
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
          continue: 'build-baseline',
          revise: 'plan-step',
          stop: '@stop',
        },
      },
      expandBlockStepUse({
        id: 'build-baseline',
        title: 'Verify - snapshot pre-change git state',
        stage: 'verify',
        block: 'run-verification',
        input: {
          proof: 'verification.plan@v1',
          // Read so the writer can check whether the plan declared an
          // allowed_touch_area: the snapshot only shells out to git when the
          // gate is on, staying inert (and git-free) otherwise.
          plan: 'build.plan@v1',
        },
        output: 'build.baseline-snapshot@v1',
        protocol: 'build-baseline-snapshot@v1',
        reportPath: 'reports/build/baseline-snapshot.json',
        required: ['overall_status'],
        routes: {
          // Captured once before the first slice; the slice loop re-enters
          // act-step (not this step), so the baseline stays a single pre-change
          // reference for the whole run.
          continue: 'act-step',
          stop: '@stop',
        },
      }),
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
          // After the final slice's verify passes, compute the touch-area
          // verdict before review so the reviewer sees git-proven containment.
          continue: 'build-touch-area',
          // Slice loop (deep depth): when this slice's verify passes and
          // more slices remain, the engine selects 'advance' instead of
          // 'continue', re-entering act-step for the next slice. A normal,
          // non-recovery route; see docs/ideas/build-slice-decomposition.md.
          advance: 'act-step',
          retry: 'act-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'build-touch-area',
        title: 'Verify - check git-proven touch area',
        stage: 'verify',
        block: 'run-verification',
        input: {
          proof: 'verification.plan@v1',
          plan: 'build.plan@v1',
          baseline: 'build.baseline-snapshot@v1',
          change: 'build.implementation@v1',
        },
        output: 'build.touch-area@v1',
        protocol: 'build-touch-area@v1',
        reportPath: 'reports/build/touch-area.json',
        required: ['overall_status', 'enforcement', 'containment'],
        routes: {
          // The observation always succeeds (overall_status 'passed'); the
          // containment verdict is recorded here and gated at close, the same
          // close-stage placement the scope gate uses.
          continue: 'review-step',
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
          touch_area: 'build.touch-area@v1',
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
          touch_area: 'build.touch-area@v1',
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
    // Stage 3b (first-class composition): build's engine flags are rehomed off
    // the by-id catalog package onto the schematic, so the compiled manifest
    // carries them and the engine reads them through resolveEngineFlags without
    // a by-id lookup. Mirrors goal's rehome; the package no longer carries them.
    engine_flags: {
      binds_execution_depth_to_relay_selection: true,
      // Deep depth implements and verifies the plan's slices one at a time: the
      // engine re-enters act-step for each slice and only advances to review
      // once every slice's verify passes. Lighter depth runs a single pass.
      // See docs/ideas/build-slice-decomposition.md.
      iterates_slice_loop: {
        head_step: 'act-step',
        tail_step: 'verify-step',
        advance_route: 'advance',
        slices_from: {
          report: 'reports/build/plan.json',
          items_path: 'slices',
        },
        max_slices: 8,
        activate_when_depth_at_least: 'high',
      },
    },
    // Stage 3b (first-class composition): build's report file surfaces ride the
    // schematic onto the compiled manifest, so the engine reads the skill-hook
    // edit-file surface table off the manifest, not the by-id catalog package.
    // Mirrors the package's reports[].fileSurface; a drift-guard test keeps the
    // two in sync until M6 collapses the duplicate authoring.
    report_file_surfaces: {
      'build.plan@v1': {
        timing: 'before',
        extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
      },
    },
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

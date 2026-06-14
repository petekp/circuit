import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER } from '../../policy/rubric.js';
import { expandBlockStepUse } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
import {
  prototypeArtifactShapeHint,
  prototypeVariantArtifactShapeHint,
  prototypeVariantReviewShapeHint,
} from './relay-hints.js';
import {
  PrototypeArtifact,
  PrototypeBrief,
  PrototypePlan,
  PrototypeResult,
  PrototypeVariantAggregate,
  PrototypeVariantArtifact,
  PrototypeVariantChoiceOptions,
  PrototypeVariantOptions,
  PrototypeVariantProviderEvidence,
  PrototypeVariantReview,
  PrototypeVariantVerification,
  PrototypeVerification,
} from './reports.js';
import { prototypeBriefComposeBuilder } from './writers/brief.js';
import { prototypeCloseBuilder } from './writers/close.js';
import { prototypePlanComposeBuilder } from './writers/plan.js';
import { prototypeVariantChoiceOptionsComposeBuilder } from './writers/variant-choice-options.js';
import { prototypeVariantOptionsComposeBuilder } from './writers/variant-options.js';
import { prototypeVariantProviderEvidenceComposeBuilder } from './writers/variant-provider-evidence.js';
import { prototypeVariantVerificationWriter } from './writers/variant-verification.js';
import { prototypeVerificationWriter } from './writers/verification.js';

export const prototypeFlowData = {
  id: 'prototype',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/prototype/schematic.json',
    contract: 'src/flows/prototype/contract.md',
  },
  schematic: {
    schema_version: '2',
    id: 'prototype',
    title: 'Prototype Schematic',
    purpose:
      'Prototype flow. Circuit frames a disposable artifact, plans its local prototype files, either relays one artifact or fans out configured model variants, verifies reported files under prototype_root, asks which local prototype evidence to keep, and closes with evidence. Prototype does not edit production code outside prototype_root or claim deployment, branch previews, screenshots, provider behavior, model behavior, or production readiness.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'frame-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'verification.plan@v1'],
    contract_aliases: [
      {
        generic: 'flow.brief@v1',
        actual: 'prototype.brief@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'prototype.plan@v1',
      },
      {
        generic: 'verification.plan@v1',
        actual: 'prototype.plan@v1',
      },
      {
        generic: 'change.evidence@v1',
        actual: 'prototype.artifact@v1',
      },
      {
        generic: 'verification.result@v1',
        actual: 'prototype.verification@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'prototype.variant-options@v1',
      },
      {
        generic: 'change.evidence@v1',
        actual: 'prototype.variant-aggregate@v1',
      },
      {
        generic: 'flow.evidence@v1',
        actual: 'prototype.variant-aggregate@v1',
      },
      {
        generic: 'verification.result@v1',
        actual: 'prototype.variant-verification@v1',
      },
      {
        generic: 'review.verdict@v1',
        actual: 'prototype.variant-review@v1',
      },
      {
        generic: 'review.verdict@v1',
        actual: 'prototype.variant-choice-options@v1',
      },
      {
        generic: 'flow.question@v1',
        actual: 'prototype.variant-choice-options@v1',
      },
      {
        generic: 'flow.result@v1',
        actual: 'prototype.result@v1',
      },
    ],
    axes: {
      allowed_depths: ['medium', 'high'],
      supports_tournament: true,
      supports_autonomous: true,
      default: {
        depth: 'medium',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
      tournament_fan_out_stage: 'act-stage',
    },
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze'],
      rationale:
        'Prototype follows Frame, Plan, Act, Verify, Review, Close. Analyze is omitted because V1 frames enough context to build a small disposable artifact; research-first work should use Explore.',
    },
    stages: [
      {
        id: 'frame-stage',
        canonical: 'frame',
        title: 'Frame',
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
        title: 'Frame - define Prototype boundary',
        stage: 'frame',
        block: 'frame',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        output: 'prototype.brief@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'prototype-frame@v1',
        reportPath: 'reports/prototype/brief.json',
        required: ['objective', 'prototype_root', 'claim_limits'],
        routes: {
          continue: 'plan-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'plan-step',
        title: 'Plan - choose disposable artifact files',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'prototype.brief@v1',
        },
        output: 'prototype.plan@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'prototype-plan@v1',
        reportPath: 'reports/prototype/plan.json',
        required: ['objective', 'files_to_create', 'verification'],
        routes: {
          continue: 'act-step',
          stop: '@stop',
        },
        routeOverrides: {
          continue: {
            tournament: 'variant-options-step',
          },
        },
      }),
      expandBlockStepUse({
        id: 'act-step',
        title: 'Act - create disposable prototype artifact',
        stage: 'act',
        block: 'act',
        input: {
          brief: 'prototype.brief@v1',
          plan: 'prototype.plan@v1',
        },
        output: 'prototype.artifact@v1',
        execution: {
          kind: 'relay',
          role: 'implementer',
        },
        protocol: 'prototype-act@v1',
        reportPath: 'reports/prototype/artifact.json',
        requestPath: 'reports/relay/prototype-act.request.json',
        receiptPath: 'reports/relay/prototype-act.receipt.txt',
        resultPath: 'reports/relay/prototype-act.result.json',
        pass: ['accept'],
        routes: {
          continue: 'verify-step',
          stop: 'close-step',
        },
      }),
      expandBlockStepUse({
        id: 'variant-options-step',
        title: 'Plan - resolve Prototype model variants',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'prototype.brief@v1',
          plan: 'prototype.plan@v1',
        },
        output: 'prototype.variant-options@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'prototype-variant-options@v1',
        reportPath: 'reports/prototype/variant-options.json',
        required: ['variants', 'variant_count'],
        routes: {
          continue: 'variant-fanout-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'variant-fanout-step',
        title: 'Act - create model-comparison Prototype variants',
        stage: 'act',
        block: 'act',
        input: {
          brief: 'prototype.brief@v1',
          plan: 'prototype.plan@v1',
          options: 'prototype.variant-options@v1',
        },
        output: 'prototype.variant-aggregate@v1',
        execution: {
          kind: 'fanout',
        },
        protocol: 'prototype-variant-fanout@v1',
        reportPath: 'reports/prototype/variant-aggregate.json',
        branchesDirPath: 'reports/prototype/variant-branches',
        pass: ['accept'],
        fanout: {
          branches: {
            kind: 'dynamic',
            source_report: 'reports/prototype/variant-options.json',
            items_path: 'variants',
            template: {
              branch_id: '$item.variant_id',
              execution: {
                kind: 'relay',
                role: 'implementer',
                goal: '$item.goal',
                report_schema: 'prototype.variant-artifact@v1',
                provenance_field: 'variant_id',
              },
              connector: '$item.connector_name',
              selection: {
                model: {
                  provider: '$item.provider',
                  model: '$item.model',
                },
                effort: '$item.effort',
              },
            },
            max_branches: { kind: 'axis', axis: 'tournament_n' },
            required_count: { kind: 'axis', axis: 'tournament_n' },
          },
          concurrency: {
            kind: 'bounded',
            max: 2,
          },
          on_child_failure: 'continue-others',
          join: {
            policy: 'aggregate-survivors',
          },
          rubric: {
            model_judgments_path: 'rubric_model_judgments',
            ordered_dims: [...THREE_AXIS_RUBRIC_TIE_BREAK_ORDER],
            runtime_signals: {
              evidence_rigor: { kind: 'non_empty_array', path: 'evidence' },
              actionability: { kind: 'non_empty_array', path: 'entry_points' },
              coverage_adequacy: { kind: 'non_empty_string', path: 'summary' },
              scope_discipline: { kind: 'constant', signal: 'met' },
              honest_calibration: { kind: 'non_empty_array', path: 'claim_limits' },
              project_specificity: { kind: 'non_empty_string', path: 'variant_root' },
              insight_density: { kind: 'constant', signal: 'n/a' },
              branch_distinctness: { kind: 'constant', signal: 'n/a' },
            },
          },
        },
        routes: {
          continue: 'variant-provider-evidence-step',
          stop: '@stop',
        },
      }),
      // A verify-stage compose that captures provider evidence for the variants
      // before they are verified. It is not a flow close, so it uses the
      // dedicated prototype-variant-evidence block; its output and evidence are
      // inherited from the block rather than restated here.
      expandBlockStepUse({
        id: 'variant-provider-evidence-step',
        title: 'Verify - capture variant provider evidence',
        stage: 'verify',
        block: 'prototype-variant-evidence',
        input: {
          brief: 'prototype.brief@v1',
          options: 'prototype.variant-options@v1',
          aggregate: 'prototype.variant-aggregate@v1',
        },
        protocol: 'prototype-variant-provider-evidence@v1',
        reportPath: 'reports/prototype/variant-provider-evidence.json',
        required: ['captured_count', 'variants'],
        routes: {
          complete: 'variant-verification-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'variant-verification-step',
        title: 'Verify - check Prototype variants',
        stage: 'verify',
        block: 'run-verification',
        input: {
          plan: 'prototype.plan@v1',
          aggregate: 'prototype.variant-aggregate@v1',
          provider_evidence: 'prototype.variant-provider-evidence@v1',
        },
        output: 'prototype.variant-verification@v1',
        protocol: 'prototype-variant-verify@v1',
        reportPath: 'reports/prototype/variant-verification.json',
        required: ['overall_status', 'commands', 'variant_results'],
        routes: {
          continue: 'variant-review-step',
          stop: 'close-model-comparison-step',
        },
      }),
      expandBlockStepUse({
        id: 'variant-review-step',
        title: 'Review - compare Prototype variants',
        stage: 'review',
        block: 'review',
        input: {
          brief: 'prototype.brief@v1',
          options: 'prototype.variant-options@v1',
          aggregate: 'prototype.variant-aggregate@v1',
          provider_evidence: 'prototype.variant-provider-evidence@v1',
          verification: 'prototype.variant-verification@v1',
        },
        output: 'prototype.variant-review@v1',
        execution: {
          kind: 'relay',
          role: 'reviewer',
        },
        protocol: 'prototype-variant-review@v1',
        reportPath: 'reports/prototype/variant-review.json',
        requestPath: 'reports/relay/prototype-variant-review.request.json',
        receiptPath: 'reports/relay/prototype-variant-review.receipt.txt',
        resultPath: 'reports/relay/prototype-variant-review.result.json',
        pass: ['recommend', 'no-clear-winner', 'needs-operator'],
        routes: {
          continue: 'variant-choice-options-step',
          stop: 'close-model-comparison-step',
        },
      }),
      expandBlockStepUse({
        id: 'variant-choice-options-step',
        title: 'Review - prepare variant checkpoint choices',
        stage: 'review',
        block: 'review',
        input: {
          brief: 'prototype.brief@v1',
          aggregate: 'prototype.variant-aggregate@v1',
          provider_evidence: 'prototype.variant-provider-evidence@v1',
          verification: 'prototype.variant-verification@v1',
          review: 'prototype.variant-review@v1',
        },
        output: 'prototype.variant-choice-options@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'prototype-variant-choice-options@v1',
        reportPath: 'reports/prototype/variant-choice-options.json',
        required: ['choices', 'recommended_variant_id'],
        routes: {
          continue: 'prototype-variant-checkpoint-step',
          stop: 'close-model-comparison-step',
        },
      }),
      expandBlockStepUse({
        id: 'prototype-variant-checkpoint-step',
        title: 'Review - choose Prototype variant',
        stage: 'review',
        block: 'human-decision',
        input: {
          choices: 'prototype.variant-choice-options@v1',
          aggregate: 'prototype.variant-aggregate@v1',
        },
        protocol: 'prototype-variant-checkpoint@v1',
        checkpointRequestPath: 'reports/checkpoints/prototype-variant-choice-request.json',
        checkpointResponsePath: 'reports/checkpoints/prototype-variant-choice-response.json',
        allowFrom: { kind: 'policy_choices' },
        checkpointPolicy: {
          prompt:
            'Choose which local Prototype variant Circuit should keep. This checkpoint does not run Build or claim deployment.',
          choices_from: {
            kind: 'report_items',
            source_report: 'reports/prototype/variant-choice-options.json',
            items_path: 'choices',
            id_path: 'id',
            label_path: 'label',
            description_path: 'description',
          },
          auto_resolution: {
            policy: 'highest-score',
            source_report: 'reports/prototype/variant-aggregate.json',
            branches_path: 'branches',
            id_path: 'branch_id',
            rubric_result_path: 'rubric_result',
          },
        },
        routes: {
          continue: 'close-model-comparison-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'close-model-comparison-step',
        title: 'Close - emit Prototype model-comparison result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          brief: 'prototype.brief@v1',
          plan: 'prototype.plan@v1',
          options: 'prototype.variant-options@v1',
          aggregate: 'prototype.variant-aggregate@v1',
          provider_evidence: 'prototype.variant-provider-evidence@v1',
          verification: 'prototype.variant-verification@v1',
        },
        output: 'prototype.result@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'prototype-close-model-comparison@v1',
        reportPath: 'reports/prototype-result.json',
        required: ['summary', 'outcome', 'evidence_links'],
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'verify-step',
        title: 'Verify - check Prototype artifact integrity',
        stage: 'verify',
        block: 'run-verification',
        input: {
          plan: 'prototype.plan@v1',
          artifact: 'prototype.artifact@v1',
        },
        output: 'prototype.verification@v1',
        protocol: 'prototype-verify@v1',
        reportPath: 'reports/prototype/verification.json',
        required: ['overall_status', 'commands'],
        routes: {
          continue: 'prototype-checkpoint-step',
          stop: 'close-step',
        },
      }),
      // A checkpoint over a built and verified artifact (inputs {artifact,
      // verification}), not the generic question/evidence human-decision shape.
      // It uses the dedicated prototype-checkpoint block, whose generic input
      // contracts the flow's existing change.evidence and verification.result
      // aliases already satisfy.
      expandBlockStepUse({
        id: 'prototype-checkpoint-step',
        title: 'Review - decide Prototype disposition',
        stage: 'review',
        block: 'prototype-checkpoint',
        input: {
          artifact: 'prototype.artifact@v1',
          verification: 'prototype.verification@v1',
        },
        protocol: 'prototype-checkpoint@v1',
        checkpointRequestPath: 'reports/checkpoints/prototype-review-request.json',
        checkpointResponsePath: 'reports/checkpoints/prototype-review-response.json',
        allow: ['keep-prototype', 'save-build-input', 'discard-prototype'],
        checkpointPolicy: {
          prompt: 'Decide what to do with this verified Prototype artifact.',
          choices: [
            {
              id: 'keep-prototype',
              label: 'Keep Prototype',
              description: 'Save the prototype as useful evidence and stop here.',
            },
            {
              id: 'save-build-input',
              label: 'Save Build Input',
              description: 'Close with a Build-ready follow-up prompt, without running Build.',
            },
            {
              id: 'discard-prototype',
              label: 'Discard Prototype',
              description: 'Mark the prototype as discarded while keeping the evidence trail.',
            },
          ],
          safe_default_choice: 'keep-prototype',
        },
        routes: {
          continue: 'close-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'close-step',
        title: 'Close - emit Prototype result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          brief: 'prototype.brief@v1',
          plan: 'prototype.plan@v1',
          artifact: 'prototype.artifact@v1',
        },
        output: 'prototype.result@v1',
        execution: {
          kind: 'compose',
        },
        protocol: 'prototype-close@v1',
        reportPath: 'reports/prototype-result.json',
        required: ['summary', 'outcome', 'evidence_links'],
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
      }),
    ],
    // Stage 3b (first-class composition): prototype's engine flag is rehomed
    // off the by-id catalog package onto the schematic, so the compiled manifest
    // carries it and the engine reads it through resolveEngineFlags without a
    // by-id lookup. Mirrors goal's rehome; the package no longer carries it.
    engine_flags: {
      binds_execution_depth_to_relay_selection: true,
    },
    // Stage 3b (first-class composition): prototype's up-front config gate rides
    // the schematic onto the compiled manifest, so the CLI validates the
    // requirement off the loaded flow, not the by-id catalog package. Mirrors the
    // package's requiredConfig; a drift-guard test keeps the two in sync until M6
    // collapses the duplicate authoring.
    required_config: [
      {
        axis: 'tournament',
        path: 'circuits.prototype.variant_models',
        message:
          "prototype --tournament requires 'circuits.prototype.variant_models' in your Circuit config (one variant model per tournament branch). Add it under circuits.prototype.variant_models, or run prototype without --tournament.",
      },
    ],
  },
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'plan', 'act', 'verify', 'review', 'close'],
    omits: ['analyze'],
    optional_canonicals: [],
    variants: [],
    title: 'Frame -> Plan -> Act -> Verify -> Review -> Close',
    authority: 'src/flows/prototype/contract.md Prototype Flow Contract',
  },
  reports: [
    {
      schemaName: 'prototype.artifact@v1',
      channel: 'relay',
      schema: PrototypeArtifact,
      relayHint: prototypeArtifactShapeHint.instruction,
    },
    {
      schemaName: 'prototype.variant-artifact@v1',
      channel: 'relay',
      schema: PrototypeVariantArtifact,
      relayHint: prototypeVariantArtifactShapeHint.instruction,
    },
    {
      schemaName: 'prototype.variant-review@v1',
      channel: 'relay',
      schema: PrototypeVariantReview,
      relayHint: prototypeVariantReviewShapeHint.instruction,
    },
    {
      schemaName: 'prototype.brief@v1',
      channel: 'report',
      schema: PrototypeBrief,
      writers: { compose: [prototypeBriefComposeBuilder] },
    },
    {
      schemaName: 'prototype.plan@v1',
      channel: 'report',
      schema: PrototypePlan,
      writers: { compose: [prototypePlanComposeBuilder] },
    },
    {
      schemaName: 'prototype.variant-options@v1',
      channel: 'report',
      schema: PrototypeVariantOptions,
      writers: { compose: [prototypeVariantOptionsComposeBuilder] },
    },
    {
      schemaName: 'prototype.variant-aggregate@v1',
      channel: 'report',
      schema: PrototypeVariantAggregate,
    },
    {
      schemaName: 'prototype.variant-provider-evidence@v1',
      channel: 'report',
      schema: PrototypeVariantProviderEvidence,
      writers: { compose: [prototypeVariantProviderEvidenceComposeBuilder] },
    },
    {
      schemaName: 'prototype.variant-verification@v1',
      channel: 'report',
      schema: PrototypeVariantVerification,
      writers: { verification: [prototypeVariantVerificationWriter] },
    },
    {
      schemaName: 'prototype.variant-choice-options@v1',
      channel: 'report',
      schema: PrototypeVariantChoiceOptions,
      writers: { compose: [prototypeVariantChoiceOptionsComposeBuilder] },
    },
    {
      schemaName: 'prototype.verification@v1',
      channel: 'report',
      schema: PrototypeVerification,
      writers: { verification: [prototypeVerificationWriter] },
    },
    {
      schemaName: 'prototype.result@v1',
      channel: 'report',
      schema: PrototypeResult,
      writers: { close: [prototypeCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'prototype.result@v1',
      path: 'reports/prototype-result.json',
      label: 'Prototype result',
    },
    progress: {
      steps: [
        {
          stepId: 'frame-step',
          taskTitle: 'Frame the prototype',
          activeText: 'Framing the prototype',
        },
        {
          stepId: 'plan-step',
          taskTitle: 'Plan the artifact',
          activeText: 'Planning the artifact',
        },
        {
          stepId: 'act-step',
          taskTitle: 'Create the prototype',
          activeText: 'Creating the prototype',
          relayRole: 'implementer',
          relayStartedText: 'Asking the specialist to create the prototype...',
          relayCompletedText: 'Finished creating the prototype.',
        },
        {
          stepId: 'variant-options-step',
          taskTitle: 'Resolve model variants',
          activeText: 'Resolving model variants',
        },
        {
          stepId: 'variant-fanout-step',
          taskTitle: 'Create prototype variants',
          activeText: 'Creating prototype variants',
        },
        {
          stepId: 'variant-provider-evidence-step',
          taskTitle: 'Capture provider evidence',
          activeText: 'Capturing provider evidence',
        },
        {
          stepId: 'variant-verification-step',
          taskTitle: 'Check prototype variants',
          activeText: 'Checking prototype variants',
        },
        {
          stepId: 'variant-review-step',
          taskTitle: 'Compare prototype variants',
          activeText: 'Comparing prototype variants',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to compare the variants...',
          relayCompletedText: 'Finished comparing the variants.',
        },
        {
          stepId: 'variant-choice-options-step',
          taskTitle: 'Prepare variant choices',
          activeText: 'Preparing variant choices',
        },
        {
          stepId: 'prototype-variant-checkpoint-step',
          taskTitle: 'Choose variant',
          activeText: 'Waiting on the Prototype variant checkpoint',
        },
        {
          stepId: 'close-model-comparison-step',
          taskTitle: 'Wrap up model comparison',
          activeText: 'Wrapping up model comparison',
        },
        {
          stepId: 'verify-step',
          taskTitle: 'Check the artifact',
          activeText: 'Checking the artifact',
        },
        {
          stepId: 'prototype-checkpoint-step',
          taskTitle: 'Choose what to do next',
          activeText: 'Waiting on the Prototype checkpoint',
        },
        {
          stepId: 'close-step',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
      ],
    },
  },
  // The tournament axis fans out one relay per configured model variant, so it
  // cannot run without operator-provided variant models. Declare the
  // prerequisite so the CLI rejects up-front (exit 2, no run folder) instead of
  // aborting at the variant-options step after framing and planning work. The
  // variant-options writer keeps its own check as a last line of defense.
  requiredConfig: [
    {
      axis: 'tournament',
      path: 'circuits.prototype.variant_models',
      message:
        "prototype --tournament requires 'circuits.prototype.variant_models' in your Circuit config (one variant model per tournament branch). Add it under circuits.prototype.variant_models, or run prototype without --tournament.",
    },
  ],
} satisfies FlowData;

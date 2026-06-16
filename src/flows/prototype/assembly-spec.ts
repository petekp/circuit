// Prototype's flow assembly spec (first-class composition, A5).
//
// Prototype is the assembler's fanout / tournament stress-test: 14 items with a
// dynamic-fanout variant branch, two checkpoints (artifact disposition and
// variant choice), a NON-MONOTONIC item order (the variant act/verify/review/
// close branch is authored after the single-artifact act step), an
// execution-depth bind, and an up-front required-config gate. Like build
// (../build/assembly-spec.ts) and pursue (../pursue/assembly-spec.ts), data.ts
// now consumes `assembleFlowSchematic(prototypeAssemblySpec)` instead of a hand-
// authored literal.
//
// The non-monotonic item order is invisible to byte-identity: the assembler
// derives `stages` by filtering CANONICAL_STAGES (always monotonic) and
// `stage_path_policy` by absence, regardless of item order. Prototype omits the
// analyze canonical stage, so the assembler derives omits: ['analyze']; the
// rationale is supplied via `stagePathRationale`. engine_flags
// (binds_execution_depth_to_relay_selection) and required_config ride the
// schematic as pass-through scaffolding.
import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER } from '../../policy/rubric.js';
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const PROTOTYPE_STAGE_PATH_RATIONALE =
  'Prototype follows Frame, Plan, Act, Verify, Review, Close. Analyze is omitted because V1 frames enough context to build a small disposable artifact; research-first work should use Explore.';

// Prototype's full block sequence. The single-artifact path (frame, plan, act,
// verify, checkpoint, close) and the tournament/variant path
// (variant-options through close-model-comparison) are interleaved in route
// order; the assembler does not care about item order.
export const prototypeBlockItems: readonly BlockStepUse[] = [
  {
    id: 'frame-step',
    title: 'Frame - define Prototype boundary',
    stage: 'frame',
    block: 'frame',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    output: 'prototype.brief@v1',
    execution: { kind: 'compose' },
    protocol: 'prototype-frame@v1',
    writes: { report_path: 'reports/prototype/brief.json' },
    check: { required: ['objective', 'prototype_root', 'claim_limits'] },
    routes: { continue: 'plan-step', stop: '@stop' },
  },
  {
    id: 'plan-step',
    title: 'Plan - choose disposable artifact files',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'prototype.brief@v1' },
    output: 'prototype.plan@v1',
    execution: { kind: 'compose' },
    protocol: 'prototype-plan@v1',
    writes: { report_path: 'reports/prototype/plan.json' },
    check: { required: ['objective', 'files_to_create', 'verification'] },
    routeOverrides: { continue: { tournament: 'variant-options-step' } },
    routes: { continue: 'act-step', stop: '@stop' },
  },
  {
    id: 'act-step',
    title: 'Act - create disposable prototype artifact',
    stage: 'act',
    block: 'act',
    input: { brief: 'prototype.brief@v1', plan: 'prototype.plan@v1' },
    output: 'prototype.artifact@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'prototype-act@v1',
    writes: {
      report_path: 'reports/prototype/artifact.json',
      request_path: 'reports/relay/prototype-act.request.json',
      receipt_path: 'reports/relay/prototype-act.receipt.txt',
      result_path: 'reports/relay/prototype-act.result.json',
    },
    check: { pass: ['accept'] },
    skillSlots: [
      {
        id: 'prototype-rapid-build',
        description:
          'A skill for quickly building a disposable prototype that demonstrates the idea, optimizing for speed over polish.',
      },
    ],
    routes: { continue: 'verify-step', stop: 'close-step' },
  },
  {
    id: 'variant-options-step',
    title: 'Plan - resolve Prototype model variants',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'prototype.brief@v1', plan: 'prototype.plan@v1' },
    output: 'prototype.variant-options@v1',
    execution: { kind: 'compose' },
    protocol: 'prototype-variant-options@v1',
    writes: { report_path: 'reports/prototype/variant-options.json' },
    check: { required: ['variants', 'variant_count'] },
    routes: { continue: 'variant-fanout-step', stop: '@stop' },
  },
  {
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
    execution: { kind: 'fanout' },
    protocol: 'prototype-variant-fanout@v1',
    writes: {
      report_path: 'reports/prototype/variant-aggregate.json',
      branches_dir_path: 'reports/prototype/variant-branches',
    },
    check: { pass: ['accept'] },
    routes: { continue: 'variant-provider-evidence-step', stop: '@stop' },
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
            model: { provider: '$item.provider', model: '$item.model' },
            effort: '$item.effort',
          },
        },
        max_branches: { kind: 'axis', axis: 'tournament_n' },
        required_count: { kind: 'axis', axis: 'tournament_n' },
      },
      concurrency: { kind: 'bounded', max: 2 },
      on_child_failure: 'continue-others',
      join: { policy: 'aggregate-survivors' },
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
  },
  {
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
    writes: { report_path: 'reports/prototype/variant-provider-evidence.json' },
    check: { required: ['captured_count', 'variants'] },
    routes: { complete: 'variant-verification-step', stop: '@stop' },
  },
  {
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
    writes: { report_path: 'reports/prototype/variant-verification.json' },
    check: { required: ['overall_status', 'commands', 'variant_results'] },
    routes: { continue: 'variant-review-step', stop: 'close-model-comparison-step' },
  },
  {
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
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'prototype-variant-review@v1',
    writes: {
      report_path: 'reports/prototype/variant-review.json',
      request_path: 'reports/relay/prototype-variant-review.request.json',
      receipt_path: 'reports/relay/prototype-variant-review.receipt.txt',
      result_path: 'reports/relay/prototype-variant-review.result.json',
    },
    check: { pass: ['recommend', 'no-clear-winner', 'needs-operator'] },
    skillSlots: [
      {
        id: 'prototype-variant-comparison',
        description:
          'A skill for comparing prototype variants on their evidence and naming which one the operator should carry forward.',
      },
    ],
    routes: { continue: 'variant-choice-options-step', stop: 'close-model-comparison-step' },
  },
  {
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
    execution: { kind: 'compose' },
    protocol: 'prototype-variant-choice-options@v1',
    writes: { report_path: 'reports/prototype/variant-choice-options.json' },
    check: { required: ['choices', 'recommended_variant_id'] },
    routes: { continue: 'prototype-variant-checkpoint-step', stop: 'close-model-comparison-step' },
  },
  {
    id: 'prototype-variant-checkpoint-step',
    title: 'Review - choose Prototype variant',
    stage: 'review',
    block: 'human-decision',
    input: {
      choices: 'prototype.variant-choice-options@v1',
      aggregate: 'prototype.variant-aggregate@v1',
    },
    protocol: 'prototype-variant-checkpoint@v1',
    writes: {
      checkpoint_request_path: 'reports/checkpoints/prototype-variant-choice-request.json',
      checkpoint_response_path: 'reports/checkpoints/prototype-variant-choice-response.json',
    },
    check: { allow_from: { kind: 'policy_choices' } },
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
    routes: { continue: 'close-model-comparison-step', stop: '@stop' },
  },
  {
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
    execution: { kind: 'compose' },
    protocol: 'prototype-close-model-comparison@v1',
    writes: { report_path: 'reports/prototype-result.json' },
    check: { required: ['summary', 'outcome', 'evidence_links'] },
    routes: { complete: '@complete', stop: '@stop' },
  },
  {
    id: 'verify-step',
    title: 'Verify - check Prototype artifact integrity',
    stage: 'verify',
    block: 'run-verification',
    input: { plan: 'prototype.plan@v1', artifact: 'prototype.artifact@v1' },
    output: 'prototype.verification@v1',
    protocol: 'prototype-verify@v1',
    writes: { report_path: 'reports/prototype/verification.json' },
    check: { required: ['overall_status', 'commands'] },
    routes: { continue: 'prototype-checkpoint-step', stop: 'close-step' },
  },
  {
    id: 'prototype-checkpoint-step',
    title: 'Review - decide Prototype disposition',
    stage: 'review',
    block: 'prototype-checkpoint',
    input: { artifact: 'prototype.artifact@v1', verification: 'prototype.verification@v1' },
    protocol: 'prototype-checkpoint@v1',
    writes: {
      checkpoint_request_path: 'reports/checkpoints/prototype-review-request.json',
      checkpoint_response_path: 'reports/checkpoints/prototype-review-response.json',
    },
    check: { allow: ['keep-prototype', 'save-build-input', 'discard-prototype'] },
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
    routes: { continue: 'close-step', stop: '@stop' },
  },
  {
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
    execution: { kind: 'compose' },
    protocol: 'prototype-close@v1',
    writes: { report_path: 'reports/prototype-result.json' },
    check: { required: ['summary', 'outcome', 'evidence_links'] },
    routes: { complete: '@complete', stop: '@stop' },
  },
];

const prototypeStageLabels: StageLabelMap = {
  frame: { id: 'frame-stage', title: 'Frame' },
  plan: { id: 'plan-stage', title: 'Plan' },
  act: { id: 'act-stage', title: 'Act' },
  verify: { id: 'verify-stage', title: 'Verify' },
  review: { id: 'review-stage', title: 'Review' },
  close: { id: 'close-stage', title: 'Close' },
};

export const prototypeAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'prototype',
  title: 'Prototype Schematic',
  purpose:
    'Prototype flow. Circuit frames a disposable artifact, plans its local prototype files, either relays one artifact or fans out configured model variants, verifies reported files under prototype_root, asks which local prototype evidence to keep, and closes with evidence. Prototype does not edit production code outside prototype_root or claim deployment, branch previews, screenshots, provider behavior, model behavior, or production readiness.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['task.intake@v1', 'route.decision@v1', 'verification.plan@v1'],
  contract_aliases: [
    { generic: 'flow.brief@v1', actual: 'prototype.brief@v1' },
    { generic: 'plan.strategy@v1', actual: 'prototype.plan@v1' },
    { generic: 'verification.plan@v1', actual: 'prototype.plan@v1' },
    { generic: 'change.evidence@v1', actual: 'prototype.artifact@v1' },
    { generic: 'verification.result@v1', actual: 'prototype.verification@v1' },
    { generic: 'plan.strategy@v1', actual: 'prototype.variant-options@v1' },
    { generic: 'change.evidence@v1', actual: 'prototype.variant-aggregate@v1' },
    { generic: 'flow.evidence@v1', actual: 'prototype.variant-aggregate@v1' },
    { generic: 'verification.result@v1', actual: 'prototype.variant-verification@v1' },
    { generic: 'review.verdict@v1', actual: 'prototype.variant-review@v1' },
    { generic: 'review.verdict@v1', actual: 'prototype.variant-choice-options@v1' },
    { generic: 'flow.question@v1', actual: 'prototype.variant-choice-options@v1' },
    { generic: 'flow.result@v1', actual: 'prototype.result@v1' },
  ],
  axes: {
    allowed_depths: ['medium', 'high'],
    supports_tournament: true,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
    tournament_fan_out_stage: 'act-stage',
  },
  // Stage 3b (first-class composition): prototype's engine flag rides the
  // schematic onto the compiled manifest, so the engine reads it through
  // resolveEngineFlags without a by-id lookup.
  engine_flags: {
    binds_execution_depth_to_relay_selection: true,
  },
  // Stage 3b (first-class composition): prototype's up-front config gate rides
  // the schematic onto the compiled manifest, so the CLI validates the
  // requirement off the loaded flow, not the by-id catalog package.
  required_config: [
    {
      axis: 'tournament',
      path: 'circuits.prototype.variant_models',
      message:
        "prototype --tournament requires 'circuits.prototype.variant_models' in your Circuit config (one variant model per tournament branch). Add it under circuits.prototype.variant_models, or run prototype without --tournament.",
    },
  ],
  items: prototypeBlockItems,
  stageLabels: prototypeStageLabels,
  stagePathRationale: PROTOTYPE_STAGE_PATH_RATIONALE,
};

// Explore's flow assembly spec (first-class composition, A5).
//
// Explore is the assembler's most irregular customer: a four-canonical partial
// spine (Frame, Analyze, Plan/Decision, Close — act/verify/review all omitted)
// where the synthesize/review act+review archetypes and the whole decision
// tournament are folded INSIDE the canonical Plan stage. Its items are
// non-monotonic (the tournament branch is authored after the linear
// synthesize/review/close branch), it has a dynamic proposal fanout, a tradeoff
// checkpoint, a custom diagnose block at analyze, a forward-read optional input
// (synthesize reads review-step's verdict, present only on rework), and two
// distinct close steps (linear vs tournament) that share the explore.result@v1
// output. Like build/pursue/prototype, data.ts now consumes
// `assembleFlowSchematic(exploreAssemblySpec)` instead of a hand-authored literal.
//
// Three plan-stage canonical groupings (synthesize/review, decision-options/
// fanout/stress/checkpoint/decision) all map to the single `decision-stage`
// {id,title}; the assembler emits exactly one stage entry per canonical, which
// is what the shipped schematic has, so byte-identity holds. The assembler
// derives omits: ['act','verify','review'] from the absent canonicals; the
// rationale rides via `stagePathRationale`.
import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER } from '../../policy/rubric.js';
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const EXPLORE_STAGE_PATH_RATIONALE =
  'Explore is an investigation and decision flow. Synthesize, critique, and tournament stress review are all embedded inside the canonical Plan/Decision stage. Verify is omitted because Explore output is not executable and uses evidence/seam proof rather than mechanical command verification. See src/flows/explore/contract.md §Canonical stage set for the full rationale.';

export const exploreBlockItems: readonly BlockStepUse[] = [
  {
    id: 'frame-step',
    title: 'Frame — produce explore.brief',
    stage: 'frame',
    block: 'frame',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    output: 'explore.brief@v1',
    execution: { kind: 'compose' },
    protocol: 'explore-frame@v1',
    writes: { report_path: 'reports/brief.json' },
    check: { required: ['subject', 'success_condition'] },
    routes: { continue: 'analyze-step', stop: '@stop' },
  },
  {
    id: 'analyze-step',
    title: 'Analyze — produce explore.analysis',
    stage: 'analyze',
    block: 'diagnose',
    input: { brief: 'explore.brief@v1', context: 'context.packet@v1' },
    output: 'explore.analysis@v1',
    execution: { kind: 'compose' },
    protocol: 'explore-analyze@v1',
    writes: { report_path: 'reports/analysis.json' },
    check: { required: ['aspects'] },
    routeOverrides: { continue: { tournament: 'decision-options-step' } },
    routes: { continue: 'synthesize-step', retry: 'analyze-step', stop: '@stop' },
  },
  {
    id: 'synthesize-step',
    title: 'Synthesize — produce explore.compose (connector-bound relay)',
    stage: 'plan',
    block: 'act',
    input: {
      brief: 'explore.brief@v1',
      diagnosis: 'explore.analysis@v1',
      // Forward read: written by review-step, so it is absent on the first pass
      // (rendered as a reads-unavailable placeholder) and present on a rework
      // pass after a reject. Declared optional because it is route-disjoint.
      review: 'explore.review-verdict@v1',
    },
    optional_inputs: ['review'],
    output: 'explore.compose@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'explore-synthesize@v1',
    writes: {
      report_path: 'reports/compose.json',
      request_path: 'reports/relay/synthesize.request.json',
      receipt_path: 'reports/relay/synthesize.receipt.txt',
      result_path: 'reports/relay/synthesize.result.json',
    },
    check: { pass: ['accept'] },
    skillSlots: [
      {
        id: 'explore-synthesis',
        description:
          'A skill for turning analysis into a clear, well-argued recommendation a reader can act on.',
      },
    ],
    routes: { continue: 'review-step', retry: 'synthesize-step', stop: '@stop' },
  },
  {
    id: 'review-step',
    title: 'Review — adversarial pass over compose (connector-bound relay)',
    stage: 'plan',
    block: 'review',
    input: {
      brief: 'explore.brief@v1',
      diagnosis: 'explore.analysis@v1',
      change: 'explore.compose@v1',
    },
    output: 'explore.review-verdict@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'explore-review@v1',
    writes: {
      report_path: 'reports/review-verdict.json',
      request_path: 'reports/relay/review.request.json',
      receipt_path: 'reports/relay/review.receipt.txt',
      result_path: 'reports/relay/review.result.json',
    },
    check: { pass: ['accept', 'accept-with-fold-ins'] },
    skillSlots: [
      {
        id: 'explore-adversarial-review',
        description:
          'A skill for adversarially testing a recommendation: probing its weakest claims and unstated assumptions.',
      },
    ],
    routes: {
      continue: 'close-step',
      retry: 'synthesize-step',
      revise: 'synthesize-step',
      stop: '@stop',
    },
  },
  {
    id: 'decision-options-step',
    title: 'Decision — draft tournament options',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'explore.brief@v1', diagnosis: 'explore.analysis@v1' },
    output: 'explore.decision-options@v1',
    execution: { kind: 'compose' },
    protocol: 'explore-decision-options@v1',
    writes: { report_path: 'reports/decision-options.json' },
    check: { required: ['decision_question', 'options'] },
    routes: { continue: 'proposal-fanout-step', stop: '@stop' },
  },
  {
    id: 'proposal-fanout-step',
    title: 'Decision — fan out option cases',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'explore.brief@v1', options: 'explore.decision-options@v1' },
    output: 'explore.tournament-aggregate@v1',
    execution: { kind: 'fanout' },
    protocol: 'explore-proposal-fanout@v1',
    writes: {
      report_path: 'reports/tournament-aggregate.json',
      branches_dir_path: 'reports/tournament-branches',
    },
    check: { pass: ['accept'] },
    routes: { continue: 'stress-proposals-step', stop: '@stop' },
    fanout: {
      branches: {
        kind: 'dynamic',
        source_report: 'reports/decision-options.json',
        items_path: 'options',
        template: {
          branch_id: '$item.id',
          execution: {
            kind: 'relay',
            role: 'researcher',
            goal: '$item.best_case_prompt',
            report_schema: 'explore.tournament-proposal@v1',
            provenance_field: 'option_id',
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
          evidence_rigor: { kind: 'non_empty_array', path: 'evidence_refs' },
          actionability: { kind: 'non_empty_string', path: 'next_action' },
          coverage_adequacy: { kind: 'non_empty_string', path: 'case_summary' },
          scope_discipline: { kind: 'constant', signal: 'met' },
          honest_calibration: { kind: 'constant', signal: 'n/a' },
          project_specificity: { kind: 'constant', signal: 'n/a' },
          insight_density: { kind: 'constant', signal: 'n/a' },
          branch_distinctness: { kind: 'constant', signal: 'n/a' },
        },
      },
    },
  },
  {
    id: 'stress-proposals-step',
    title: 'Decision — stress proposals',
    stage: 'plan',
    block: 'plan',
    input: {
      brief: 'explore.brief@v1',
      options: 'explore.decision-options@v1',
      aggregate: 'explore.tournament-aggregate@v1',
    },
    output: 'explore.tournament-review@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'explore-stress-proposals@v1',
    writes: {
      report_path: 'reports/tournament-review.json',
      request_path: 'reports/relay/tournament-review.request.json',
      receipt_path: 'reports/relay/tournament-review.receipt.txt',
      result_path: 'reports/relay/tournament-review.result.json',
    },
    check: { pass: ['recommend', 'no-clear-winner', 'needs-operator'] },
    skillSlots: [
      {
        id: 'explore-proposal-stress-test',
        description:
          'A skill for stress-testing competing proposals against each other and naming the strongest on the evidence.',
      },
    ],
    routes: {
      continue: 'tradeoff-checkpoint-step',
      revise: 'decision-options-step',
      stop: '@stop',
    },
  },
  {
    id: 'tradeoff-checkpoint-step',
    title: 'Decision — tradeoff checkpoint',
    stage: 'plan',
    block: 'human-decision',
    input: {
      question: 'explore.tournament-review@v1',
      evidence: 'explore.tournament-aggregate@v1',
    },
    output: 'explore.tradeoff-selection@v1',
    protocol: 'explore-tradeoff-checkpoint@v1',
    writes: {
      checkpoint_request_path: 'reports/checkpoints/tradeoff-request.json',
      checkpoint_response_path: 'reports/checkpoints/tradeoff-response.json',
    },
    check: { allow_from: { kind: 'policy_choices' } },
    checkpointPolicy: {
      prompt:
        'Choose the option Circuit should close with. This checkpoint only supports final option choices; ask-for-more-evidence and stop routes are intentionally not encoded until the runtime has executable route semantics for them.',
      choices_from: {
        kind: 'report_items',
        source_report: 'reports/tournament-aggregate.json',
        items_path: 'branches',
        filter: { kind: 'path_equals', path: 'child_outcome', value: 'complete' },
        id_path: 'branch_id',
        label_path: 'result_body.option_label',
        description_path: 'result_body.case_summary',
      },
      safe_default_choice: 'option-1',
      auto_resolution: {
        policy: 'highest-score',
        source_report: 'reports/tournament-aggregate.json',
        branches_path: 'branches',
        id_path: 'branch_id',
        rubric_result_path: 'rubric_result',
      },
    },
    routes: { continue: 'decision-step', stop: '@stop' },
  },
  {
    id: 'decision-step',
    title: 'Decision — compose final choice',
    stage: 'plan',
    block: 'plan',
    input: {
      brief: 'explore.brief@v1',
      options: 'explore.decision-options@v1',
      aggregate: 'explore.tournament-aggregate@v1',
      review: 'explore.tournament-review@v1',
    },
    output: 'explore.decision@v1',
    execution: { kind: 'compose' },
    protocol: 'explore-decision@v1',
    writes: { report_path: 'reports/decision.json' },
    check: { required: ['decision', 'selected_option_id', 'rationale'] },
    routes: { continue: 'close-tournament-step', stop: '@stop' },
  },
  {
    id: 'close-tournament-step',
    title: 'Close — emit tournament result file',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'explore.brief@v1',
      options: 'explore.decision-options@v1',
      aggregate: 'explore.tournament-aggregate@v1',
      review: 'explore.tournament-review@v1',
      decision: 'explore.decision@v1',
    },
    output: 'explore.result@v1',
    execution: { kind: 'compose' },
    protocol: 'explore-close-tournament@v1',
    writes: { report_path: 'reports/explore-result.json' },
    check: { required: ['summary', 'verdict_snapshot'] },
    routes: { complete: '@complete', stop: '@stop' },
  },
  {
    id: 'close-step',
    title: 'Close — emit final result file',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'explore.brief@v1',
      compose: 'explore.compose@v1',
      review: 'explore.review-verdict@v1',
    },
    output: 'explore.result@v1',
    execution: { kind: 'compose' },
    protocol: 'explore-close@v1',
    writes: { report_path: 'reports/explore-result.json' },
    check: { required: ['summary', 'verdict_snapshot'] },
    routes: { complete: '@complete', stop: '@stop' },
  },
];

const exploreStageLabels: StageLabelMap = {
  frame: { id: 'frame-stage', title: 'Frame' },
  analyze: { id: 'analyze-stage', title: 'Analyze' },
  plan: { id: 'decision-stage', title: 'Plan or Decision' },
  close: { id: 'close-stage', title: 'Close' },
};

export const exploreAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'explore',
  title: 'Explore Schematic',
  purpose:
    'Explore flow: frame the investigation, analyze the subject, either synthesize and critique findings or run a decision tournament, then close with findings plus evidence. All modes use Frame, Analyze, Plan or Decision, and Close; critique is embedded inside the Plan/Decision stage rather than exposed as a separate canonical Review stage.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['task.intake@v1', 'route.decision@v1', 'context.packet@v1'],
  contract_aliases: [
    { generic: 'flow.brief@v1', actual: 'explore.brief@v1' },
    { generic: 'diagnosis.result@v1', actual: 'explore.analysis@v1' },
    { generic: 'change.evidence@v1', actual: 'explore.compose@v1' },
    { generic: 'review.verdict@v1', actual: 'explore.review-verdict@v1' },
    { generic: 'plan.strategy@v1', actual: 'explore.decision-options@v1' },
    { generic: 'plan.strategy@v1', actual: 'explore.tournament-aggregate@v1' },
    { generic: 'plan.strategy@v1', actual: 'explore.tournament-review@v1' },
    { generic: 'plan.strategy@v1', actual: 'explore.decision@v1' },
    { generic: 'flow.question@v1', actual: 'explore.tournament-review@v1' },
    { generic: 'flow.evidence@v1', actual: 'explore.tournament-aggregate@v1' },
    { generic: 'decision.answer@v1', actual: 'explore.tradeoff-selection@v1' },
    { generic: 'flow.result@v1', actual: 'explore.result@v1' },
  ],
  axes: {
    allowed_depths: ['low', 'medium', 'high'],
    supports_tournament: true,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
    tournament_fan_out_stage: 'decision-stage',
  },
  items: exploreBlockItems,
  stageLabels: exploreStageLabels,
  stagePathRationale: EXPLORE_STAGE_PATH_RATIONALE,
};

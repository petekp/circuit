import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER } from '../../policy/rubric.js';
import { expandBlockStepUse } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
import {
  exploreComposeShapeHint,
  exploreReviewVerdictShapeHint,
  exploreTournamentProposalShapeHint,
  exploreTournamentReviewShapeHint,
} from './relay-hints.js';
import {
  ExploreAnalysis,
  ExploreBrief,
  ExploreCompose,
  ExploreDecision,
  ExploreDecisionOptions,
  ExploreResult,
  ExploreReviewVerdict,
  ExploreTournamentAggregate,
  ExploreTournamentProposal,
  ExploreTournamentReview,
} from './reports.js';
import { exploreAnalysisComposeBuilder } from './writers/analysis.js';
import { exploreBriefComposeBuilder } from './writers/brief.js';
import { exploreCloseBuilder } from './writers/close.js';
import { exploreDecisionOptionsComposeBuilder } from './writers/decision-options.js';
import { exploreDecisionComposeBuilder } from './writers/decision.js';

export const exploreFlowData = {
  id: 'explore',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/explore/schematic.json',
    contract: 'src/flows/explore/contract.md',
  },
  schematic: {
    schema_version: '1',
    id: 'explore',
    title: 'Explore Schematic',
    purpose:
      'Explore flow: frame the investigation, analyze the subject, either synthesize and critique findings or run a decision tournament, then close with findings plus evidence. All modes use Frame, Analyze, Plan or Decision, and Close; critique is embedded inside the Plan/Decision stage rather than exposed as a separate canonical Review stage.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'frame-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'context.packet@v1'],
    contract_aliases: [
      {
        generic: 'flow.brief@v1',
        actual: 'explore.brief@v1',
      },
      {
        generic: 'diagnosis.result@v1',
        actual: 'explore.analysis@v1',
      },
      {
        generic: 'change.evidence@v1',
        actual: 'explore.compose@v1',
      },
      {
        generic: 'review.verdict@v1',
        actual: 'explore.review-verdict@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'explore.decision-options@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'explore.tournament-aggregate@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'explore.tournament-review@v1',
      },
      {
        generic: 'plan.strategy@v1',
        actual: 'explore.decision@v1',
      },
      {
        generic: 'flow.question@v1',
        actual: 'explore.tournament-review@v1',
      },
      {
        generic: 'flow.evidence@v1',
        actual: 'explore.tournament-aggregate@v1',
      },
      {
        generic: 'decision.answer@v1',
        actual: 'explore.tradeoff-selection@v1',
      },
      {
        generic: 'flow.result@v1',
        actual: 'explore.result@v1',
      },
    ],
    entry: {
      signals: {
        include: ['explore', 'investigate', 'research', 'understand'],
        exclude: [],
      },
      intent_prefixes: ['explore', 'investigate', 'decide'],
    },
    axes: {
      allowed_rigors: ['lite', 'standard', 'deep'],
      supports_tournament: true,
      supports_autonomous: true,
      default: {
        rigor: 'standard',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
      tournament_fan_out_stage: 'decision-stage',
    },
    stage_path_policy: {
      mode: 'partial',
      omits: ['act', 'verify', 'review'],
      rationale:
        'Explore is an investigation and decision flow. Synthesize, critique, and tournament stress review are all embedded inside the canonical Plan/Decision stage. Verify is omitted because Explore output is not executable and uses evidence/seam proof rather than mechanical command verification. See src/flows/explore/contract.md §Canonical stage set for the full rationale.',
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
        id: 'decision-stage',
        canonical: 'plan',
        title: 'Plan or Decision',
      },
      {
        id: 'close-stage',
        canonical: 'close',
        title: 'Close',
      },
    ],
    items: [
      {
        id: 'frame-step',
        title: 'Frame — produce explore.brief',
        stage: 'frame',
        block: 'frame',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        output: 'explore.brief@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: {
          kind: 'compose',
        },
        protocol: 'explore-frame@v1',
        writes: {
          report_path: 'reports/brief.json',
        },
        check: {
          required: ['subject', 'success_condition'],
        },
        routes: {
          continue: 'analyze-step',
          stop: '@stop',
        },
      },
      {
        id: 'analyze-step',
        title: 'Analyze — produce explore.analysis',
        stage: 'analyze',
        block: 'diagnose',
        input: {
          brief: 'explore.brief@v1',
          context: 'context.packet@v1',
        },
        output: 'explore.analysis@v1',
        evidence_requirements: [
          'cause hypothesis',
          'confidence',
          'reproduction status',
          'diagnostic path',
        ],
        execution: {
          kind: 'compose',
        },
        protocol: 'explore-analyze@v1',
        writes: {
          report_path: 'reports/analysis.json',
        },
        check: {
          required: ['aspects'],
        },
        routes: {
          continue: 'synthesize-step',
          retry: 'analyze-step',
          stop: '@stop',
        },
        route_overrides: {
          continue: {
            tournament: 'decision-options-step',
          },
        },
      },
      expandBlockStepUse({
        id: 'synthesize-step',
        title: 'Synthesize — produce explore.compose (connector-bound relay)',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explore.brief@v1',
          diagnosis: 'explore.analysis@v1',
        },
        output: 'explore.compose@v1',
        evidenceRequirements: ['changed files', 'change rationale', 'declared follow-up proof'],
        execution: {
          kind: 'relay',
          role: 'implementer',
        },
        protocol: 'explore-synthesize@v1',
        reportPath: 'reports/compose.json',
        requestPath: 'reports/relay/synthesize.request.json',
        receiptPath: 'reports/relay/synthesize.receipt.txt',
        resultPath: 'reports/relay/synthesize.result.json',
        pass: ['accept'],
        routes: {
          continue: 'review-step',
          retry: 'synthesize-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
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
        execution: {
          kind: 'relay',
          role: 'reviewer',
        },
        protocol: 'explore-review@v1',
        reportPath: 'reports/review-verdict.json',
        requestPath: 'reports/relay/review.request.json',
        receiptPath: 'reports/relay/review.receipt.txt',
        resultPath: 'reports/relay/review.result.json',
        pass: ['accept', 'accept-with-fold-ins'],
        routes: {
          continue: 'close-step',
          retry: 'synthesize-step',
          revise: 'synthesize-step',
          stop: '@stop',
        },
      }),
      {
        id: 'decision-options-step',
        title: 'Decision — draft tournament options',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explore.brief@v1',
          diagnosis: 'explore.analysis@v1',
        },
        output: 'explore.decision-options@v1',
        evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
        execution: {
          kind: 'compose',
        },
        protocol: 'explore-decision-options@v1',
        writes: {
          report_path: 'reports/decision-options.json',
        },
        check: {
          required: ['decision_question', 'options'],
        },
        routes: {
          continue: 'proposal-fanout-step',
          stop: '@stop',
        },
      },
      expandBlockStepUse({
        id: 'proposal-fanout-step',
        title: 'Decision — fan out option cases',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explore.brief@v1',
          options: 'explore.decision-options@v1',
        },
        output: 'explore.tournament-aggregate@v1',
        execution: {
          kind: 'fanout',
        },
        protocol: 'explore-proposal-fanout@v1',
        reportPath: 'reports/tournament-aggregate.json',
        branchesDirPath: 'reports/tournament-branches',
        pass: ['accept'],
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
        routes: {
          continue: 'stress-proposals-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
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
        execution: {
          kind: 'relay',
          role: 'reviewer',
        },
        protocol: 'explore-stress-proposals@v1',
        reportPath: 'reports/tournament-review.json',
        requestPath: 'reports/relay/tournament-review.request.json',
        receiptPath: 'reports/relay/tournament-review.receipt.txt',
        resultPath: 'reports/relay/tournament-review.result.json',
        pass: ['recommend', 'no-clear-winner', 'needs-operator'],
        routes: {
          continue: 'tradeoff-checkpoint-step',
          revise: 'decision-options-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
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
        checkpointRequestPath: 'reports/checkpoints/tradeoff-request.json',
        checkpointResponsePath: 'reports/checkpoints/tradeoff-response.json',
        check: {
          allow_from: { kind: 'policy_choices' },
        },
        checkpointPolicy: {
          prompt:
            'Choose the option Circuit should close with. This checkpoint only supports final option choices; ask-for-more-evidence and stop routes are intentionally not encoded until the runtime has executable route semantics for them.',
          choices_from: {
            kind: 'report_items',
            source_report: 'reports/tournament-aggregate.json',
            items_path: 'branches',
            filter: {
              kind: 'path_equals',
              path: 'child_outcome',
              value: 'complete',
            },
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
        routes: {
          continue: 'decision-step',
          stop: '@stop',
        },
      }),
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
        evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
        execution: {
          kind: 'compose',
        },
        protocol: 'explore-decision@v1',
        writes: {
          report_path: 'reports/decision.json',
        },
        check: {
          required: ['decision', 'selected_option_id', 'rationale'],
        },
        routes: {
          continue: 'close-tournament-step',
          stop: '@stop',
        },
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
        evidence_requirements: ['outcome', 'evidence pointers', 'residual risks', 'follow-ups'],
        execution: {
          kind: 'compose',
        },
        protocol: 'explore-close-tournament@v1',
        writes: {
          report_path: 'reports/explore-result.json',
        },
        check: {
          required: ['summary', 'verdict_snapshot'],
        },
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
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
        evidence_requirements: ['outcome', 'evidence pointers', 'residual risks', 'follow-ups'],
        execution: {
          kind: 'compose',
        },
        protocol: 'explore-close@v1',
        writes: {
          report_path: 'reports/explore-result.json',
        },
        check: {
          required: ['summary', 'verdict_snapshot'],
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
    canonicals: ['frame', 'analyze', 'plan', 'close'],
    omits: ['act', 'verify', 'review'],
    optional_canonicals: [],
    variants: [],
    title: 'Frame → Analyze → Plan or Decision → Close',
    authority: 'src/flows/explore/contract.md §Canonical stage set',
  },
  reports: [
    {
      schemaName: 'explore.compose@v1',
      channel: 'relay',
      schema: ExploreCompose,
      relayHint: exploreComposeShapeHint.instruction,
    },
    {
      schemaName: 'explore.review-verdict@v1',
      channel: 'relay',
      schema: ExploreReviewVerdict,
      relayHint: exploreReviewVerdictShapeHint.instruction,
    },
    {
      schemaName: 'explore.tournament-proposal@v1',
      channel: 'relay',
      schema: ExploreTournamentProposal,
      relayHint: exploreTournamentProposalShapeHint.instruction,
    },
    {
      schemaName: 'explore.tournament-review@v1',
      channel: 'relay',
      schema: ExploreTournamentReview,
      relayHint: exploreTournamentReviewShapeHint.instruction,
    },
    {
      schemaName: 'explore.brief@v1',
      channel: 'report',
      schema: ExploreBrief,
      writers: { compose: [exploreBriefComposeBuilder] },
    },
    {
      schemaName: 'explore.analysis@v1',
      channel: 'report',
      schema: ExploreAnalysis,
      writers: { compose: [exploreAnalysisComposeBuilder] },
    },
    {
      schemaName: 'explore.decision-options@v1',
      channel: 'report',
      schema: ExploreDecisionOptions,
      writers: { compose: [exploreDecisionOptionsComposeBuilder] },
    },
    {
      schemaName: 'explore.tournament-aggregate@v1',
      channel: 'report',
      schema: ExploreTournamentAggregate,
    },
    {
      schemaName: 'explore.decision@v1',
      channel: 'report',
      schema: ExploreDecision,
      writers: { compose: [exploreDecisionComposeBuilder] },
    },
    {
      schemaName: 'explore.result@v1',
      channel: 'report',
      schema: ExploreResult,
      writers: { close: [exploreCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'explore.result@v1',
      path: 'reports/explore-result.json',
      label: 'Explore result',
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
          taskTitle: 'Check the context',
          activeText: 'Checking the context',
        },
        {
          stepId: 'synthesize-step',
          taskTitle: 'Draft the recommendation',
          activeText: 'Drafting the recommendation',
          relayRole: 'implementer',
          relayStartedText: 'Asking the specialist to draft the recommendation...',
          relayCompletedText: 'Finished drafting the recommendation.',
        },
        {
          stepId: 'review-step',
          taskTitle: 'Check the recommendation',
          activeText: 'Checking the recommendation',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the recommendation...',
          relayCompletedText: 'Finished checking the recommendation.',
        },
        {
          stepId: 'decision-options-step',
          taskTitle: 'Draft the options',
          activeText: 'Drafting the options',
        },
        {
          stepId: 'proposal-fanout-step',
          taskTitle: 'Compare the options',
          activeText: 'Comparing the options',
        },
        {
          stepId: 'stress-proposals-step',
          taskTitle: 'Check the options',
          activeText: 'Checking the options',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check the recommendation...',
          relayCompletedText: 'Finished checking the recommendation.',
        },
        {
          stepId: 'tradeoff-checkpoint-step',
          taskTitle: 'Compare the options',
          activeText: 'Comparing the options',
        },
        {
          stepId: 'decision-step',
          taskTitle: 'Draft the recommendation',
          activeText: 'Drafting the recommendation',
        },
        {
          stepId: 'close-tournament-step',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
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

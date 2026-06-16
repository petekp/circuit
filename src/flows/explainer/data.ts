// Explainer (paper-to-site) flow data.
//
// Hand-authored fixed flow that codifies the operator's real research-paper ->
// interactive-site pipeline: a lossless digest, persona-lensed ideation, a
// six-criteria tournament, an adversarial fidelity hardening pass, an operator
// PICK among the survivors, a house-style spec, a child build run, mechanical
// verification, an operator SIGN-OFF (fidelity gate AND publish authorization),
// and an honest close. It rides the manifest like every built-in: generic
// blocks + contract_aliases, no engine edits. The closest structural model is
// explore (tournament + dynamic checkpoint); the sub-run and static checkpoint
// follow goal. See docs/ideas/paper-to-site-flow-brief.md.

import { RunResult } from '../../schemas/result.js';
import { expandBlockStepUse } from '../block-step-expansion.js';
import type { FlowData } from '../flow-definition.js';
import {
  explainerHardeningShapeHint,
  explainerTournamentProposalShapeHint,
} from './relay-hints.js';
import {
  EXPLAINER_RUBRIC_DIMS,
  ExplainerCheckpointResponse,
  ExplainerDigest,
  ExplainerHardening,
  ExplainerIdeas,
  ExplainerIntake,
  ExplainerResult,
  ExplainerSpec,
  ExplainerTournamentAggregate,
  ExplainerTournamentProposal,
  ExplainerVerification,
} from './reports.js';
import { explainerCloseBuilder } from './writers/close.js';
import { explainerDigestComposeBuilder } from './writers/digest.js';
import { explainerIdeasComposeBuilder } from './writers/ideas.js';
import { explainerIntakeComposeBuilder } from './writers/intake.js';
import { explainerSpecComposeBuilder } from './writers/spec.js';
import { explainerVerificationWriter } from './writers/verification.js';

// The build child's static goal. The actual concept + house-style direction
// travels in reports/explainer/spec.json (read by the build connector); the
// sub-run goal is static because flow_ref and goal are authored, not derived.
const BUILD_CHILD_GOAL =
  'Build the interactive web explainer described in reports/explainer/spec.json. Honor the house-style specs and teach the paper’s actual driver, never the seductive wrong one. Produce a locally building site; do not deploy.';

// Verdicts a child build RunResult may close with that count as an admissible
// attempt (mirrors goal's child-run pass set).
const BUILD_PASS_VERDICTS = [
  'accept',
  'accept-with-fixes',
  'accept-with-fold-ins',
  'clean',
  'needs-followup',
  'decided',
  'NO_ISSUES_FOUND',
  'ISSUES_FOUND',
] as const;

export const explainerFlowData = {
  id: 'explainer',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/explainer/schematic.json',
    contract: 'src/flows/explainer/contract.md',
  },
  schematic: {
    schema_version: '2',
    id: 'explainer',
    title: 'Explainer Schematic',
    purpose:
      'Explainer flow: turn a research paper into an interactive web explainer. Frame the subject, build a lossless digest, ideate persona-lensed concepts, run a six-criteria tournament, harden the survivors against teaching the wrong driver, take an operator pick, write a house-style spec, run a child build, verify the site, take an operator fidelity sign-off, and close honestly.',
    status: 'active',
    version: '0.1.0',
    starts_at: 'intake-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'context.packet@v1'],
    contract_aliases: [
      // Output-matching: each generic block output binds to this flow's real
      // report. plan.strategy@v1 maps to four actuals (ideas, tournament,
      // hardening, spec) the way explore maps it to four — never consumed by the
      // generic name, so the anti-widening gate stays inert.
      { generic: 'flow.brief@v1', actual: 'explainer.intake@v1' },
      { generic: 'diagnosis.result@v1', actual: 'explainer.digest@v1' },
      { generic: 'plan.strategy@v1', actual: 'explainer.ideas@v1' },
      { generic: 'plan.strategy@v1', actual: 'explainer.tournament-aggregate@v1' },
      { generic: 'plan.strategy@v1', actual: 'explainer.hardening@v1' },
      { generic: 'plan.strategy@v1', actual: 'explainer.spec@v1' },
      { generic: 'verification.result@v1', actual: 'explainer.verification@v1' },
      { generic: 'goal.child-run@v1', actual: 'explainer.build-result@v1' },
      { generic: 'flow.result@v1', actual: 'explainer.result@v1' },
      // Two checkpoints emit distinct actuals (single-producer-per-contract is on
      // the actual id, so they cannot both output decision.answer@v1). Read via
      // their response files, never consumed by name.
      { generic: 'decision.answer@v1', actual: 'explainer.selection@v1' },
      { generic: 'decision.answer@v1', actual: 'explainer.signoff@v1' },
      // Input-side: lets the checkpoint/sub-run/verify steps bind their declared
      // actuals to the block's generic input contracts. flow.question@v1 and
      // flow.evidence@v1 each map to two actuals (one per checkpoint); inert
      // because the steps read the actual names, not the generic.
      { generic: 'flow.question@v1', actual: 'explainer.hardening@v1' },
      { generic: 'flow.evidence@v1', actual: 'explainer.tournament-aggregate@v1' },
      { generic: 'flow.question@v1', actual: 'explainer.verification@v1' },
      { generic: 'flow.evidence@v1', actual: 'explainer.build-result@v1' },
      { generic: 'goal.contract@v1', actual: 'explainer.spec@v1' },
      { generic: 'verification.plan@v1', actual: 'explainer.spec@v1' },
      { generic: 'change.evidence@v1', actual: 'explainer.build-result@v1' },
    ],
    axes: {
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: true,
      supports_autonomous: true,
      default: {
        depth: 'medium',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
      tournament_fan_out_stage: 'plan-stage',
    },
    stage_path_policy: {
      mode: 'strict',
    },
    stages: [
      { id: 'frame-stage', canonical: 'frame', title: 'Frame' },
      { id: 'analyze-stage', canonical: 'analyze', title: 'Digest' },
      { id: 'plan-stage', canonical: 'plan', title: 'Ideate & Choose' },
      { id: 'act-stage', canonical: 'act', title: 'Build' },
      { id: 'verify-stage', canonical: 'verify', title: 'Verify' },
      { id: 'review-stage', canonical: 'review', title: 'Sign Off' },
      { id: 'close-stage', canonical: 'close', title: 'Close' },
    ],
    items: [
      {
        id: 'intake-step',
        title: 'Frame — produce explainer.intake',
        stage: 'frame',
        block: 'frame',
        input: {
          task: 'task.intake@v1',
          route: 'route.decision@v1',
        },
        output: 'explainer.intake@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: { kind: 'compose' },
        protocol: 'explainer-intake@v1',
        writes: {
          report_path: 'reports/intake.json',
        },
        check: {
          required: ['subject', 'success_condition'],
        },
        routes: {
          continue: 'digest-step',
          stop: '@stop',
        },
      },
      {
        id: 'digest-step',
        title: 'Digest — produce the lossless outline',
        stage: 'analyze',
        block: 'diagnose',
        input: {
          brief: 'explainer.intake@v1',
          context: 'context.packet@v1',
        },
        output: 'explainer.digest@v1',
        evidence_requirements: [
          'cause hypothesis',
          'confidence',
          'reproduction status',
          'diagnostic path',
        ],
        execution: { kind: 'compose' },
        protocol: 'explainer-digest@v1',
        writes: {
          report_path: 'reports/digest.json',
        },
        check: {
          required: ['lossless_principle', 'outline_sections'],
        },
        routes: {
          continue: 'ideas-step',
          stop: '@stop',
        },
      },
      {
        id: 'ideas-step',
        title: 'Ideate — draft persona-lensed concepts',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explainer.intake@v1',
          diagnosis: 'explainer.digest@v1',
        },
        output: 'explainer.ideas@v1',
        evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
        execution: { kind: 'compose' },
        protocol: 'explainer-ideas@v1',
        writes: {
          report_path: 'reports/ideas.json',
        },
        check: {
          required: ['brief_question', 'concepts'],
        },
        routes: {
          continue: 'tournament-step',
          stop: '@stop',
        },
      },
      expandBlockStepUse({
        id: 'tournament-step',
        title: 'Tournament — fan out one advocate per concept',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explainer.intake@v1',
          ideas: 'explainer.ideas@v1',
        },
        output: 'explainer.tournament-aggregate@v1',
        execution: { kind: 'fanout' },
        protocol: 'explainer-tournament@v1',
        reportPath: 'reports/tournament-aggregate.json',
        branchesDirPath: 'reports/tournament-branches',
        pass: ['accept'],
        fanout: {
          branches: {
            kind: 'dynamic',
            source_report: 'reports/ideas.json',
            items_path: 'concepts',
            template: {
              branch_id: '$item.id',
              execution: {
                kind: 'relay',
                role: 'researcher',
                goal: '$item.scoped_prompt',
                report_schema: 'explainer.tournament-proposal@v1',
                provenance_field: 'concept_id',
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
            ordered_dims: [...EXPLAINER_RUBRIC_DIMS],
            // Keys must exactly equal ordered_dims. Two dims have a deterministic
            // runtime signal that can veto the model's self-score: fidelity
            // requires outline-anchored evidence (the "teach the right driver"
            // kill-shot), build_feasibility requires a concrete next action. The
            // rest rely on model judgment (n/a = no veto).
            runtime_signals: {
              fidelity: { kind: 'non_empty_array', path: 'fidelity_evidence' },
              memetic_potential: { kind: 'constant', signal: 'n/a' },
              entertainment: { kind: 'constant', signal: 'n/a' },
              cross_audience_reach: { kind: 'constant', signal: 'n/a' },
              build_feasibility: { kind: 'non_empty_string', path: 'next_action' },
              novelty: { kind: 'constant', signal: 'n/a' },
            },
          },
        },
        routes: {
          continue: 'hardening-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'hardening-step',
        title: 'Harden — adversarial fidelity pass over survivors',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explainer.intake@v1',
          ideas: 'explainer.ideas@v1',
          aggregate: 'explainer.tournament-aggregate@v1',
        },
        output: 'explainer.hardening@v1',
        execution: {
          kind: 'relay',
          role: 'reviewer',
        },
        protocol: 'explainer-hardening@v1',
        reportPath: 'reports/hardening.json',
        requestPath: 'reports/relay/hardening.request.json',
        receiptPath: 'reports/relay/hardening.receipt.txt',
        resultPath: 'reports/relay/hardening.result.json',
        pass: ['recommend', 'no-clear-winner', 'needs-operator'],
        skillSlots: [
          {
            id: 'explainer-fidelity-audit',
            description:
              'A skill for adversarially checking each finalist concept against the paper, catching any that would teach the seductive wrong driver instead of the real one.',
          },
        ],
        routes: {
          continue: 'pick-checkpoint-step',
          stop: '@stop',
        },
      }),
      expandBlockStepUse({
        id: 'pick-checkpoint-step',
        title: 'Pick — operator chooses a concept to build',
        stage: 'plan',
        block: 'human-decision',
        input: {
          question: 'explainer.hardening@v1',
          evidence: 'explainer.tournament-aggregate@v1',
        },
        output: 'explainer.selection@v1',
        protocol: 'explainer-pick-checkpoint@v1',
        checkpointRequestPath: 'reports/checkpoints/pick-request.json',
        checkpointResponsePath: 'reports/checkpoints/pick-response.json',
        allowFrom: { kind: 'policy_choices' },
        checkpointPolicy: {
          prompt:
            'Choose the concept Circuit should build into the explainer site. The hardening pass recommends one survivor; you decide. This checkpoint only records a concept choice.',
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
            label_path: 'result_body.concept_label',
            description_path: 'result_body.case_summary',
          },
          safe_default_choice: 'concept-1',
          auto_resolution: {
            policy: 'highest-score',
            source_report: 'reports/tournament-aggregate.json',
            branches_path: 'branches',
            id_path: 'branch_id',
            rubric_result_path: 'rubric_result',
          },
        },
        routes: {
          continue: 'spec-step',
          stop: '@stop',
        },
      }),
      {
        id: 'spec-step',
        title: 'Spec — assemble the house-style build law',
        stage: 'plan',
        block: 'plan',
        input: {
          brief: 'explainer.intake@v1',
          ideas: 'explainer.ideas@v1',
          aggregate: 'explainer.tournament-aggregate@v1',
          hardening: 'explainer.hardening@v1',
        },
        output: 'explainer.spec@v1',
        evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
        execution: { kind: 'compose' },
        protocol: 'explainer-spec@v1',
        writes: {
          report_path: 'reports/explainer/spec.json',
        },
        check: {
          required: ['concept_id', 'build_brief', 'fidelity_citations'],
        },
        routes: {
          continue: 'build-step',
          stop: '@stop',
        },
      },
      {
        id: 'build-step',
        title: 'Build — run the child build flow on the spec',
        stage: 'act',
        block: 'goal-child-run',
        input: {
          contract: 'explainer.spec@v1',
        },
        output: 'explainer.build-result@v1',
        evidence_requirements: [
          'static child flow target',
          'child result file',
          'parent trace link',
        ],
        execution: {
          kind: 'sub-run',
          flow_ref: { flow_id: 'build', entry_mode: 'default' },
          goal: BUILD_CHILD_GOAL,
          depth: 'medium',
        },
        protocol: 'explainer-build@v1',
        writes: {
          result_path: 'reports/explainer/build-result.json',
        },
        check: {
          pass: [...BUILD_PASS_VERDICTS],
        },
        routes: {
          continue: 'verify-step',
          stop: '@stop',
        },
      },
      {
        id: 'verify-step',
        title: 'Verify — prove the built site',
        stage: 'verify',
        block: 'run-verification',
        input: {
          plan: 'explainer.spec@v1',
          change: 'explainer.build-result@v1',
        },
        output: 'explainer.verification@v1',
        evidence_requirements: ['command list', 'exit status', 'bounded output', 'pass or fail'],
        execution: { kind: 'verification' },
        protocol: 'explainer-verify@v1',
        writes: {
          report_path: 'reports/explainer/verification.json',
        },
        check: {
          required: ['overall_status', 'commands'],
        },
        routes: {
          continue: 'signoff-checkpoint-step',
          retry: 'verify-step',
          stop: '@stop',
        },
      },
      expandBlockStepUse({
        id: 'signoff-checkpoint-step',
        title: 'Sign off — operator fidelity gate and publish authorization',
        stage: 'review',
        block: 'human-decision',
        input: {
          question: 'explainer.verification@v1',
          evidence: 'explainer.build-result@v1',
        },
        output: 'explainer.signoff@v1',
        protocol: 'explainer-signoff-checkpoint@v1',
        checkpointRequestPath: 'reports/checkpoints/signoff-request.json',
        checkpointResponsePath: 'reports/checkpoints/signoff-response.json',
        allow: ['continue', 'blocked', 'handoff'],
        checkpointPolicy: {
          prompt:
            'Final fidelity gate. Does the built explainer teach the paper’s actual driver, honor the house style, and pass verification? Authorize publishing only if yes. The default holds — Circuit does not publish without your explicit authorization.',
          choices: [
            { id: 'continue', label: 'Authorize publish' },
            { id: 'blocked', label: 'Hold — fidelity or quality not met' },
            { id: 'handoff', label: 'Hand off' },
          ],
          safe_default_choice: 'blocked',
        },
        routes: {
          continue: 'close-step',
          blocked: 'close-step',
          handoff: '@handoff',
          stop: '@stop',
        },
      }),
      {
        id: 'close-step',
        title: 'Close — emit the explainer result',
        stage: 'close',
        block: 'close-with-evidence',
        input: {
          intake: 'explainer.intake@v1',
          spec: 'explainer.spec@v1',
          verification: 'explainer.verification@v1',
          build: 'explainer.build-result@v1',
        },
        output: 'explainer.result@v1',
        evidence_requirements: ['outcome', 'evidence pointers', 'residual risks', 'follow-ups'],
        execution: { kind: 'compose' },
        protocol: 'explainer-close@v1',
        writes: {
          report_path: 'reports/explainer-result.json',
        },
        check: {
          required: ['outcome', 'summary', 'evidence_pointers'],
        },
        routes: {
          complete: '@complete',
          stop: '@stop',
        },
      },
    ],
    engine_flags: {
      binds_terminal_outcome_to_primary_result: true,
    },
  },
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'analyze', 'plan', 'act', 'verify', 'review', 'close'],
    omits: [],
    optional_canonicals: [],
    variants: [],
    title: 'Frame → Digest → Ideate & Choose → Build → Verify → Sign Off → Close',
    authority: 'src/flows/explainer/contract.md §Canonical stage set',
  },
  reports: [
    {
      schemaName: 'explainer.tournament-proposal@v1',
      channel: 'relay',
      schema: ExplainerTournamentProposal,
      relayHint: explainerTournamentProposalShapeHint.instruction,
    },
    {
      schemaName: 'explainer.hardening@v1',
      channel: 'relay',
      schema: ExplainerHardening,
      relayHint: explainerHardeningShapeHint.instruction,
    },
    {
      schemaName: 'explainer.intake@v1',
      channel: 'report',
      schema: ExplainerIntake,
      writers: { compose: [explainerIntakeComposeBuilder] },
    },
    {
      schemaName: 'explainer.digest@v1',
      channel: 'report',
      schema: ExplainerDigest,
      writers: { compose: [explainerDigestComposeBuilder] },
    },
    {
      schemaName: 'explainer.ideas@v1',
      channel: 'report',
      schema: ExplainerIdeas,
      writers: { compose: [explainerIdeasComposeBuilder] },
    },
    {
      schemaName: 'explainer.tournament-aggregate@v1',
      channel: 'report',
      schema: ExplainerTournamentAggregate,
    },
    {
      schemaName: 'explainer.spec@v1',
      channel: 'report',
      schema: ExplainerSpec,
      writers: { compose: [explainerSpecComposeBuilder] },
    },
    {
      schemaName: 'explainer.build-result@v1',
      channel: 'report',
      schema: RunResult,
    },
    {
      schemaName: 'explainer.verification@v1',
      channel: 'report',
      schema: ExplainerVerification,
      writers: { verification: [explainerVerificationWriter] },
    },
    {
      schemaName: 'explainer.result@v1',
      channel: 'report',
      schema: ExplainerResult,
      writers: { close: [explainerCloseBuilder] },
    },
    // The two operator checkpoints reuse the generic human-decision block, so
    // both produce decision.answer@v1 — a multi-actual generic this flow aliases
    // to two flow-scoped actuals. Registering the engine-written checkpoint
    // response shape behind each actual lets the body-divergence probe prove the
    // two checkpoints share one body (uniform). No writer: the checkpoint
    // executor writes these, not a flow writer.
    {
      schemaName: 'explainer.selection@v1',
      channel: 'report',
      schema: ExplainerCheckpointResponse,
    },
    {
      schemaName: 'explainer.signoff@v1',
      channel: 'report',
      schema: ExplainerCheckpointResponse,
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'explainer.result@v1',
      path: 'reports/explainer-result.json',
      label: 'Explainer result',
    },
    progress: {
      steps: [
        {
          stepId: 'intake-step',
          taskTitle: 'Frame the paper',
          activeText: 'Framing the paper',
        },
        {
          stepId: 'digest-step',
          taskTitle: 'Build the digest',
          activeText: 'Building the digest',
        },
        {
          stepId: 'ideas-step',
          taskTitle: 'Draft the concepts',
          activeText: 'Drafting the concepts',
        },
        {
          stepId: 'tournament-step',
          taskTitle: 'Compare the concepts',
          activeText: 'Comparing the concepts',
        },
        {
          stepId: 'hardening-step',
          taskTitle: 'Check fidelity',
          activeText: 'Checking fidelity',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to check fidelity...',
          relayCompletedText: 'Finished checking fidelity.',
        },
        {
          stepId: 'pick-checkpoint-step',
          taskTitle: 'Pick a concept',
          activeText: 'Waiting on the pick',
        },
        {
          stepId: 'spec-step',
          taskTitle: 'Write the build spec',
          activeText: 'Writing the build spec',
        },
        {
          stepId: 'build-step',
          taskTitle: 'Build the site',
          activeText: 'Building the site',
        },
        {
          stepId: 'verify-step',
          taskTitle: 'Check the site',
          activeText: 'Checking the site',
        },
        {
          stepId: 'signoff-checkpoint-step',
          taskTitle: 'Sign off',
          activeText: 'Waiting on sign-off',
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

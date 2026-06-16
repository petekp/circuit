import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { exploreAssemblySpec } from './assembly-spec.js';
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
  // First-class composition (A5): explore is the assembler's most irregular
  // production customer — a four-canonical partial spine with the act/review
  // archetypes and the full decision tournament folded inside the canonical
  // Plan stage, non-monotonic items, a dynamic proposal fanout, a tradeoff
  // checkpoint, a custom diagnose block, a forward-read optional input, and two
  // close steps sharing one result output. Its block sequence + scaffolding
  // live in ./assembly-spec.ts; `assembleFlowSchematic` derives starts_at /
  // stages / stage_path_policy and returns the validated FlowSchematic that used
  // to be a hand-authored literal here. The prove-by-equivalence test proves
  // byte-identity (schematic + compiled).
  schematic: assembleFlowSchematic(exploreAssemblySpec),
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

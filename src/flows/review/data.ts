import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { reviewAssemblySpec } from './assembly-spec.js';
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
  // First-class composition (A5): review is one of the assembler's production
  // customers. Its block sequence and scaffolding live in ./assembly-spec.ts;
  // `assembleFlowSchematic` derives starts_at / stages / stage_path_policy and
  // returns the validated FlowSchematic that used to be a hand-authored literal
  // here. The prove-by-equivalence test proves the assembled schematic is
  // byte-identical to the former literal (schematic + compiled).
  schematic: assembleFlowSchematic(reviewAssemblySpec),
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

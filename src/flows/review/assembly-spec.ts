// Review's flow assembly spec (first-class composition, A5).
//
// Review is an audit-only flow: Intake frames the scope, Independent Audit
// performs the reviewer relay, and Verdict closes with a result. Like build
// (../build/assembly-spec.ts) and pursue (../pursue/assembly-spec.ts), data.ts
// now consumes `assembleFlowSchematic(reviewAssemblySpec)` instead of a
// hand-authored schematic literal. The flow touches only the frame, analyze, and
// close canonical stages, so the assembler derives a partial stage path that
// omits plan / act / verify / review; the rationale is supplied via
// `stagePathRationale`.
//
// intake-step and audit-step omit `output` / `evidence_requirements` because the
// review-intake / review blocks default them back. verdict-step KEEPS `output`
// (review.result@v1 differs from close-with-evidence's flow.result@v1 default)
// but omits evidence (it matches the close block default), so the assembled
// schematic stays byte-identical to the shipped one.
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const REVIEW_STAGE_PATH_RATIONALE =
  'Review is an audit-only flow: Intake frames the scope, Independent Audit performs the reviewer relay, and Verdict aggregates findings. There is no planning stage, no implementation/action stage, no verification rerun, and no nested review stage in this narrowed variant.';

// Review's full block sequence, in route order. It touches only the frame,
// analyze, and close canonical stages.
export const reviewBlockItems: readonly BlockStepUse[] = [
  // Review's intake is a structurally distinct frame: it captures the
  // working-tree state to audit against, not the generic scope/constraints/
  // proof-plan a build-style frame produces. It uses the dedicated
  // review-intake block, so its output and evidence are inherited from the
  // block rather than restated here.
  {
    id: 'intake-step',
    title: 'Intake — resolve review scope',
    stage: 'frame',
    block: 'review-intake',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    protocol: 'review-intake@v1',
    reportPath: 'reports/review-intake.json',
    required: ['scope', 'evidence'],
    routes: { continue: 'audit-step', stop: '@stop' },
  },
  {
    id: 'audit-step',
    title: 'Independent Audit — reviewer relay',
    stage: 'analyze',
    block: 'review',
    input: { brief: 'review.intake@v1' },
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'review-audit@v1',
    requestPath: 'reports/relay/review.request.json',
    receiptPath: 'reports/relay/review.receipt.txt',
    resultPath: 'stages/analyze/review-raw-findings.json',
    pass: ['NO_ISSUES_FOUND', 'ISSUES_FOUND'],
    skillSlots: [
      {
        id: 'review-independent-audit',
        description:
          'A skill for independently auditing code or a change for correctness, regressions, and scope creep.',
      },
    ],
    routes: { continue: 'verdict-step', retry: 'audit-step', stop: '@stop' },
  },
  {
    id: 'verdict-step',
    title: 'Verdict — emit review.result',
    stage: 'close',
    block: 'close-with-evidence',
    input: { brief: 'review.intake@v1', review: 'review.verdict@v1' },
    output: 'review.result@v1',
    execution: { kind: 'compose' },
    protocol: 'review-verdict@v1',
    reportPath: 'reports/review-result.json',
    required: ['scope', 'findings', 'verdict'],
    routes: { complete: '@complete', stop: '@stop' },
  },
];

const reviewStageLabels: StageLabelMap = {
  frame: { id: 'intake-stage', title: 'Intake' },
  analyze: { id: 'audit-stage', title: 'Independent Audit' },
  close: { id: 'verdict-stage', title: 'Verdict' },
};

export const reviewAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'review',
  title: 'Review Schematic',
  purpose:
    'Review flow: frame the audit scope, relay independent review to a reviewer, and close with a verdict report. The schematic uses a compact Intake, Independent Audit, and Verdict shape because Review is audit-only and does not implement or verify a change.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['task.intake@v1', 'route.decision@v1'],
  contract_aliases: [
    { generic: 'flow.brief@v1', actual: 'review.intake@v1' },
    { generic: 'review.verdict@v1', actual: 'review.verdict@v1' },
    { generic: 'flow.result@v1', actual: 'review.result@v1' },
  ],
  axes: {
    allowed_depths: ['medium'],
    supports_tournament: false,
    supports_autonomous: false,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  // Review DECLARES the terminal-outcome bind on its schematic; the compiler
  // propagates it to the compiled manifest and the engine reads it through
  // `resolveEngineFlags`. This is what makes an honest ISSUES_FOUND verdict
  // (which the verdict step writes as review.result.outcome = 'stopped') bind
  // the run's terminal outcome to 'stopped' rather than a green 'complete'.
  engine_flags: {
    binds_terminal_outcome_to_primary_result: true,
  },
  items: reviewBlockItems,
  stageLabels: reviewStageLabels,
  stagePathRationale: REVIEW_STAGE_PATH_RATIONALE,
};

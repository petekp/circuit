// Cross-Tool Build's flow assembly spec.
//
// This flow codifies a recurring two-tool process the operator runs by hand: one
// connector (the "doer") proposes, revises into a spec, and implements; a second
// connector (the adversarial "reviewer") reviews the proposal and the spec. The
// per-step worker pin (execution.connector) makes that split a property of the
// flow, not of operator config — the doer steps are pinned to one connector and
// the review steps to the other, so the cross-tool routing is intrinsic.
//
// Topology (linear, forward-carry):
//   plan-step          (compose)            — resolve the verification commands.
//   propose-step       (relay, doer)        — author a proposal.
//   review-proposal    (relay, reviewer)    — adversarially review the proposal.
//   spec-step          (relay, doer)        — revise the proposal per the review,
//                                             then author a comprehensive spec.
//   review-spec        (relay, reviewer)    — adversarially review the spec.
//   implement-step     (relay, doer)        — revise per the review, implement
//                                             end-to-end, manually test, fix.
//   verify-step        (run-verification)   — run the verification commands.
//   close-step         (compose)            — emit the result + evidence links.
//
// FORWARD-CARRY, NOT LOOP-BACK. The operator's process has each review feed the
// NEXT doer step, which revises against it ("provide that review to Codex and
// have it revise the proposal and then create a spec"). So the reviews are not
// blocking gates: both verdicts ('accept'/'revise') pass the relay check and
// route continue, and the review's verdict + findings are a typed input the next
// doer step consumes. The one hard gate is verification: a red verify routes
// back to implement-step (bounded by max_attempts_per_step), and the run cannot
// close 'complete' unless the verification passed.
//
// PER-STEP CONNECTOR PINS. The doer steps set execution.connector to 'codex' and
// the review steps to 'claude-code'. In production each pinned relay resolves its
// own connector independently, so the doer always runs on one tool and the
// reviewer on the other. See src/schemas/flow-schematic.ts (RelayStepExecution
// .connector) and the runtime relay path (relay-guidance: stepConnector).
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

// The doer and reviewer connectors. Named once so the intent reads clearly and a
// re-pin (e.g. swapping which tool reviews) is a one-line change.
const DOER = 'codex';
const REVIEWER = 'claude-code';

const CROSS_TOOL_BUILD_STAGE_PATH_RATIONALE =
  'Cross-Tool Build is a linear propose/review/spec/review/implement/verify pipeline; plan, review, act, verify, and close are the canonical stages it uses. Frame and analyze are omitted: the goal is the brief, and the doer reads the codebase as part of proposing.';

export const crossToolBuildBlockItems: readonly BlockStepUse[] = [
  {
    id: 'plan-step',
    title: 'Plan the verification',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1' },
    output: 'cross-tool-build.plan@v1',
    execution: { kind: 'compose' },
    protocol: 'cross-tool-build-plan@v1',
    reportPath: 'reports/cross-tool-build/plan.json',
    required: ['objective', 'verification'],
    routes: { continue: 'propose-step', stop: '@stop' },
  },
  {
    id: 'propose-step',
    title: 'Propose how to implement the feature',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1' },
    output: 'cross-tool-build.proposal@v1',
    execution: { kind: 'relay', role: 'researcher', connector: DOER },
    protocol: 'cross-tool-build-propose@v1',
    reportPath: 'reports/cross-tool-build/proposal.json',
    requestPath: 'reports/relay/cross-tool-build-propose.request.json',
    receiptPath: 'reports/relay/cross-tool-build-propose.receipt.txt',
    resultPath: 'reports/relay/cross-tool-build-propose.result.json',
    pass: ['accept'],
    routes: { continue: 'review-proposal-step', retry: 'propose-step', stop: '@stop' },
  },
  {
    id: 'review-proposal-step',
    title: 'Adversarially review the proposal',
    stage: 'review',
    block: 'review',
    input: { brief: 'flow.brief@v1', proposal: 'cross-tool-build.proposal@v1' },
    output: 'cross-tool-build.proposal-review@v1',
    execution: { kind: 'relay', role: 'reviewer', connector: REVIEWER },
    protocol: 'cross-tool-build-review-proposal@v1',
    reportPath: 'reports/cross-tool-build/proposal-review.json',
    requestPath: 'reports/relay/cross-tool-build-review-proposal.request.json',
    receiptPath: 'reports/relay/cross-tool-build-review-proposal.receipt.txt',
    resultPath: 'reports/relay/cross-tool-build-review-proposal.result.json',
    // Both verdicts pass: the review is forward-carry, not a blocking gate. The
    // verdict + findings ride forward as a typed input to spec-step.
    pass: ['accept', 'revise'],
    routes: { continue: 'spec-step', retry: 'review-proposal-step', stop: '@stop' },
  },
  {
    id: 'spec-step',
    title: 'Revise the proposal and write the implementation spec',
    stage: 'plan',
    block: 'plan',
    input: {
      brief: 'flow.brief@v1',
      proposal: 'cross-tool-build.proposal@v1',
      proposal_review: 'cross-tool-build.proposal-review@v1',
    },
    output: 'cross-tool-build.spec@v1',
    execution: { kind: 'relay', role: 'researcher', connector: DOER },
    protocol: 'cross-tool-build-spec@v1',
    reportPath: 'reports/cross-tool-build/spec.json',
    requestPath: 'reports/relay/cross-tool-build-spec.request.json',
    receiptPath: 'reports/relay/cross-tool-build-spec.receipt.txt',
    resultPath: 'reports/relay/cross-tool-build-spec.result.json',
    pass: ['accept'],
    routes: { continue: 'review-spec-step', retry: 'spec-step', stop: '@stop' },
  },
  {
    id: 'review-spec-step',
    title: 'Adversarially review the spec',
    stage: 'review',
    block: 'review',
    input: { brief: 'flow.brief@v1', spec: 'cross-tool-build.spec@v1' },
    output: 'cross-tool-build.spec-review@v1',
    execution: { kind: 'relay', role: 'reviewer', connector: REVIEWER },
    protocol: 'cross-tool-build-review-spec@v1',
    reportPath: 'reports/cross-tool-build/spec-review.json',
    requestPath: 'reports/relay/cross-tool-build-review-spec.request.json',
    receiptPath: 'reports/relay/cross-tool-build-review-spec.receipt.txt',
    resultPath: 'reports/relay/cross-tool-build-review-spec.result.json',
    pass: ['accept', 'revise'],
    routes: { continue: 'implement-step', retry: 'review-spec-step', stop: '@stop' },
  },
  {
    id: 'implement-step',
    title: 'Implement the spec end-to-end and manually test',
    stage: 'act',
    block: 'act',
    input: {
      brief: 'flow.brief@v1',
      spec: 'cross-tool-build.spec@v1',
      spec_review: 'cross-tool-build.spec-review@v1',
    },
    output: 'cross-tool-build.implementation@v1',
    execution: { kind: 'relay', role: 'implementer', connector: DOER },
    protocol: 'cross-tool-build-implement@v1',
    reportPath: 'reports/cross-tool-build/implementation.json',
    requestPath: 'reports/relay/cross-tool-build-implement.request.json',
    receiptPath: 'reports/relay/cross-tool-build-implement.receipt.txt',
    resultPath: 'reports/relay/cross-tool-build-implement.result.json',
    pass: ['accept'],
    routes: { continue: 'verify-step', retry: 'implement-step', stop: '@stop' },
  },
  {
    id: 'verify-step',
    title: 'Run the verification',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      plan: 'cross-tool-build.plan@v1',
      change: 'cross-tool-build.implementation@v1',
    },
    output: 'cross-tool-build.verification@v1',
    protocol: 'cross-tool-build-verify@v1',
    reportPath: 'reports/cross-tool-build/verification.json',
    required: ['overall_status', 'commands'],
    // continue on a green verify. A red verify routes back to implement-step so
    // the doer addresses the failures; the loop is bounded by the step's
    // max_attempts_per_step, after which exhaustion advances to close with the
    // failing verification recorded — the run stops without claiming complete.
    routes: { continue: 'close-step', retry: 'implement-step', stop: '@stop' },
    exhaustion_route: 'continue',
  },
  {
    id: 'close-step',
    title: 'Emit the result',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'flow.brief@v1',
      implementation: 'cross-tool-build.implementation@v1',
      verification: 'cross-tool-build.verification@v1',
      proposal_review: 'cross-tool-build.proposal-review@v1',
      spec_review: 'cross-tool-build.spec-review@v1',
    },
    output: 'cross-tool-build.result@v1',
    execution: { kind: 'compose' },
    protocol: 'cross-tool-build-close@v1',
    reportPath: 'reports/cross-tool-build-result.json',
    required: ['summary', 'outcome', 'verification_status', 'evidence_links'],
    routes: { complete: '@complete', stop: '@stop' },
  },
];

const crossToolBuildStageLabels: StageLabelMap = {
  plan: { id: 'plan-stage', title: 'Plan' },
  review: { id: 'review-stage', title: 'Review' },
  act: { id: 'act-stage', title: 'Act' },
  verify: { id: 'verify-stage', title: 'Verify' },
  close: { id: 'close-stage', title: 'Close' },
};

export const crossToolBuildAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'cross-tool-build',
  title: 'Cross-Tool Build Schematic',
  purpose:
    'Cross-Tool Build flow: one connector proposes a feature implementation, a second adversarially reviews it, the first revises it into a spec, the second reviews the spec, and the first implements it end-to-end and verifies. The per-step worker pin routes the doer steps and the review steps to different connectors, so the two-tool split is a property of the flow.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['flow.brief@v1', 'verification.plan@v1'],
  contract_aliases: [
    { generic: 'plan.strategy@v1', actual: 'cross-tool-build.plan@v1' },
    { generic: 'plan.strategy@v1', actual: 'cross-tool-build.proposal@v1' },
    { generic: 'plan.strategy@v1', actual: 'cross-tool-build.spec@v1' },
    { generic: 'review.verdict@v1', actual: 'cross-tool-build.proposal-review@v1' },
    { generic: 'review.verdict@v1', actual: 'cross-tool-build.spec-review@v1' },
    { generic: 'change.evidence@v1', actual: 'cross-tool-build.implementation@v1' },
    { generic: 'verification.result@v1', actual: 'cross-tool-build.verification@v1' },
    { generic: 'flow.result@v1', actual: 'cross-tool-build.result@v1' },
  ],
  axes: {
    allowed_depths: ['low', 'medium', 'high'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  items: crossToolBuildBlockItems,
  stageLabels: crossToolBuildStageLabels,
  stagePathRationale: CROSS_TOOL_BUILD_STAGE_PATH_RATIONALE,
};

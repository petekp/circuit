// Pursue's flow assembly spec (first-class composition, M9).
//
// Like build (see ../build/assembly-spec.ts), pursue is one of the assembler's
// production customers: data.ts consumes `assembleFlowSchematic(pursueAssemblySpec)`
// instead of hand-authoring the schematic literal. Pursue is the second built-in
// on the shared assembly path and the first with a PARTIAL stage path — it omits
// the analyze stage — so it proves the assembler derives `stage_path_policy`
// (mode: 'partial', omits: ['analyze']) from the block sequence in production,
// not just for build's strict 7-stage path.
//
// The assembler derives the three sequence-level fields (`starts_at`, `stages`,
// `stage_path_policy`) from `pursueBlockItems`; everything else is scaffolding it
// passes through verbatim. The rationale for the omitted analyze stage is the one
// thing the assembler cannot infer, so it is supplied via `stagePathRationale`
// from the single shared source (`PURSUE_STAGE_PATH_RATIONALE`) that also feeds
// `PURSUE_STAGE_POLICY` (data.ts's `canonicalStagePolicy`).
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';
import { defineEnforcedStagePolicy } from '../stage-policy.js';

// One source of truth for why pursue omits the analyze stage: it feeds both the
// derived schematic `stage_path_policy.rationale` (via the assembly spec) and the
// `canonicalStagePolicy.rationale` (via PURSUE_STAGE_POLICY).
const PURSUE_STAGE_PATH_RATIONALE =
  'Pursuits V1 folds read-only discovery policy into the coordination graph before acting; a separate Analyze stage can be added when dynamic discovery fanout lands.';

export const PURSUE_STAGE_POLICY = defineEnforcedStagePolicy({
  canonicals: ['frame', 'plan', 'act', 'verify', 'review', 'close'],
  omits: ['analyze'],
  rationale: PURSUE_STAGE_PATH_RATIONALE,
  optional_canonicals: [],
  variants: [],
  title: 'Frame → Coordinate → Execute → Verify → Review → Close',
  authority: 'docs/flows/pursue.md §Flow Shape',
});

// Pursue's full block sequence, in route order. Pursue leaves the analyze stage
// empty, so the assembler derives a partial stage path with omits: ['analyze'].
export const pursueBlockItems: readonly BlockStepUse[] = [
  {
    id: 'contract-step',
    title: 'Frame - create pursuit contract',
    stage: 'frame',
    block: 'pursue',
    input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
    execution: { kind: 'compose' },
    protocol: 'pursuit-contract@v1',
    reportPath: 'reports/pursuit/contract.json',
    required: ['objective', 'pursuits', 'verification_command_candidates'],
    routes: { continue: 'graph-step', stop: '@stop' },
  },
  {
    id: 'graph-step',
    title: 'Coordinate - build pursuit graph',
    stage: 'plan',
    block: 'coordinate-pursuits',
    input: { contract: 'pursuit.contract@v1' },
    execution: { kind: 'compose' },
    protocol: 'pursuit-graph@v1',
    reportPath: 'reports/pursuit/graph.json',
    required: ['nodes', 'serial_groups', 'parallel_read_only_groups'],
    routes: { continue: 'wave-plan-step', stop: '@stop' },
  },
  {
    id: 'wave-plan-step',
    title: 'Plan - order execution waves',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'pursuit.contract@v1', context: 'pursuit.graph@v1' },
    output: 'pursuit.wave-plan@v1',
    execution: { kind: 'compose' },
    protocol: 'pursuit-wave-plan@v1',
    reportPath: 'reports/pursuit/wave-plan.json',
    required: ['waves', 'no_parallel_writes_reason'],
    routes: { continue: 'batch-step', stop: '@stop' },
  },
  {
    id: 'batch-step',
    title: 'Execute - run serialized pursuit batch',
    stage: 'act',
    block: 'batch',
    input: {
      queue: 'pursuit.graph@v1',
      brief: 'pursuit.contract@v1',
      plan: 'pursuit.wave-plan@v1',
    },
    output: 'pursuit.batch@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'pursuit-batch@v1',
    reportPath: 'reports/pursuit/batch.json',
    requestPath: 'reports/relay/pursuit-batch.request.json',
    receiptPath: 'reports/relay/pursuit-batch.receipt.txt',
    resultPath: 'reports/relay/pursuit-batch.result.json',
    pass: ['accept', 'partial'],
    // The single longest relay in the recorded corpus: a median of about 20
    // minutes and a tail of 28, against a 60-minute connector backstop. Unlike
    // most relays this one is a serialized batch, so its duration scales with the
    // size of the queue handed to it — the median is already a third of the cap
    // and a larger batch walks straight into it.
    //
    // Wall clock only, for the reason given on build's act-step: the inactivity
    // bound is what catches a wedged worker, and it is left at the default.
    budgets: { wall_clock_ms: 7_200_000 },
    skillSlots: [
      {
        id: 'pursuit-serial-execution',
        description:
          'A skill for executing a queue of related goals one at a time, verifying each before moving to the next.',
      },
    ],
    routes: { continue: 'verify-step', retry: 'batch-step', stop: '@stop' },
  },
  {
    id: 'verify-step',
    title: 'Verify - run Pursue proof commands',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      brief: 'pursuit.contract@v1',
      change: 'pursuit.batch@v1',
    },
    output: 'pursuit.verification@v1',
    protocol: 'pursuit-verify@v1',
    reportPath: 'reports/pursuit/verification.json',
    required: ['overall_status', 'commands'],
    routes: { continue: 'review-step', retry: 'batch-step', stop: '@stop' },
  },
  {
    id: 'review-step',
    title: 'Review - check pursuit coordination',
    stage: 'review',
    block: 'review',
    input: {
      brief: 'pursuit.contract@v1',
      change: 'pursuit.batch@v1',
      verification: 'pursuit.verification@v1',
    },
    output: 'pursuit.review@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'pursuit-review@v1',
    reportPath: 'reports/pursuit/review.json',
    requestPath: 'reports/relay/pursuit-review.request.json',
    receiptPath: 'reports/relay/pursuit-review.receipt.txt',
    resultPath: 'reports/relay/pursuit-review.result.json',
    pass: ['clean', 'needs-followup', 'blocked'],
    skillSlots: [
      {
        id: 'pursuit-coordination-audit',
        description:
          'A skill for checking that a multi-goal pursuit stayed coordinated: no goal left half-done and no cross-goal regression.',
      },
    ],
    routes: { continue: 'close-step', retry: 'batch-step', stop: '@stop' },
  },
  {
    id: 'close-step',
    title: 'Close - summarize pursuit result',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'pursuit.contract@v1',
      graph: 'pursuit.graph@v1',
      plan: 'pursuit.wave-plan@v1',
      verification: 'pursuit.verification@v1',
      review: 'pursuit.review@v1',
      batch: 'pursuit.batch@v1',
    },
    output: 'pursuit.result@v1',
    execution: { kind: 'compose' },
    protocol: 'pursuit-close@v1',
    reportPath: 'reports/pursuit-result.json',
    required: ['summary', 'outcome', 'evidence_links'],
    routes: { complete: '@complete', stop: '@stop', handoff: '@handoff', escalate: '@escalate' },
  },
];

// Author-facing stage labels. The assembler decides WHICH canonicals appear and
// in what order from the item sequence; the id + title for each are supplied here.
const pursueStageLabels: StageLabelMap = {
  frame: { id: 'frame-stage', title: 'Frame' },
  plan: { id: 'plan-stage', title: 'Coordinate' },
  act: { id: 'act-stage', title: 'Execute' },
  verify: { id: 'verify-stage', title: 'Verify' },
  review: { id: 'review-stage', title: 'Review' },
  close: { id: 'close-stage', title: 'Close' },
};

export const pursueAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'pursue',
  title: 'Pursue Schematic',
  purpose:
    'Pursue flow: turn one or more rough operator ideas into pursuit contracts, coordinate their order, execute code-changing work serially, verify, review for interference, and close with evidence.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['task.intake@v1', 'route.decision@v1', 'verification.plan@v1'],
  contract_aliases: [
    { generic: 'flow.brief@v1', actual: 'pursuit.contract@v1' },
    { generic: 'plan.strategy@v1', actual: 'pursuit.wave-plan@v1' },
    { generic: 'work.queue@v1', actual: 'pursuit.graph@v1' },
    { generic: 'batch.result@v1', actual: 'pursuit.batch@v1' },
    { generic: 'change.evidence@v1', actual: 'pursuit.batch@v1' },
    { generic: 'verification.result@v1', actual: 'pursuit.verification@v1' },
    { generic: 'review.verdict@v1', actual: 'pursuit.review@v1' },
    { generic: 'flow.result@v1', actual: 'pursuit.result@v1' },
  ],
  axes: {
    allowed_depths: ['medium'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  items: pursueBlockItems,
  stageLabels: pursueStageLabels,
  stagePathRationale: PURSUE_STAGE_PATH_RATIONALE,
};

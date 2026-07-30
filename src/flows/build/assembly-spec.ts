import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
// Build's flow assembly spec (first-class composition, M9).
//
// This is build's schematic expressed as the assembler's input: a raw block
// sequence (`buildBlockItems`) plus the flow-level scaffolding the assembler
// passes through verbatim, with per-canonical-stage labels. Feeding it to
// `assembleFlowSchematic` derives the three sequence-level fields that used to
// be hand-kept in sync with the item list (`starts_at`, `stages`,
// `stage_path_policy`) and produces build's FlowSchematic.
//
// Why this module exists: M7 built the assembler and proved (by equivalence)
// that build's shipped schematic can be reconstructed from its block sequence.
// M9 makes that the production path — build becomes the assembler's first
// customer (data.ts consumes `assembleFlowSchematic(buildAssemblySpec)`), so
// the assembler is a live producer rather than a test-only artifact. Lifting
// the block sequence here gives ONE source of truth shared by the production
// schematic, the M7 prove-by-equivalence test, and the M9 truth-test run.
//
// Each entry in `buildBlockItems` is a `BlockStepUse`: the assembler expands it
// via `expandBlockStepUse`, defaulting output/evidence/execution from the block
// definition. plan-step omits `evidence_requirements` on purpose — the plan
// block's default fills back the exact list build used to hand-author, so the
// assembled schematic is byte-identical to the shipped one.
import type { BlockStepUse } from '../block-step-expansion.js';

// Build's full block sequence, in route order.
export const buildBlockItems: readonly BlockStepUse[] = [
  {
    id: 'frame-step',
    title: 'Frame - confirm Build brief',
    stage: 'frame',
    block: 'frame',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    output: 'build.brief@v1',
    execution: { kind: 'checkpoint' },
    protocol: 'build-frame@v1',
    reportPath: 'reports/build/brief.json',
    checkpointRequestPath: 'reports/checkpoints/frame-step-request.json',
    checkpointResponsePath: 'reports/checkpoints/frame-step-response.json',
    allow: ['continue'],
    checkpointPolicy: {
      prompt: 'Confirm the Build brief before implementation starts.',
      choices: [{ id: 'continue', label: 'Continue' }],
      safe_default_choice: 'continue',
      report_template: {
        scope: 'Make the smallest safe change that satisfies the requested goal.',
        success_criteria: [
          'The requested behavior is implemented',
          'Verification passes',
          'Review completes without a blocking issue',
        ],
      },
    },
    routes: { continue: 'analyze-step', stop: '@stop' },
  },
  {
    id: 'analyze-step',
    title: 'Analyze — read the code before planning',
    stage: 'analyze',
    block: 'gather-context',
    input: { brief: 'build.brief@v1', request: 'context.request@v1' },
    output: 'build.context@v1',
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'build-analyze@v1',
    reportPath: 'reports/build/context.json',
    requestPath: 'reports/relay/build-analyze.request.json',
    receiptPath: 'reports/relay/build-analyze.receipt.txt',
    resultPath: 'reports/relay/build-analyze.result.json',
    pass: ['accept'],
    skillSlots: [
      {
        id: 'build-codebase-search',
        description:
          'A skill for reading the codebase and tracing the call paths a change will touch before any plan is written.',
      },
    ],
    routes: { continue: 'plan-step', retry: 'analyze-step', ask: '@stop', stop: '@stop' },
  },
  {
    id: 'plan-step',
    title: 'Plan - produce Build plan',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'build.brief@v1', context: 'build.context@v1' },
    output: 'build.plan@v1',
    execution: { kind: 'compose' },
    protocol: 'build-plan@v1',
    reportPath: 'reports/build/plan.json',
    required: ['objective', 'verification'],
    routes: { continue: 'build-baseline', revise: 'plan-step', stop: '@stop' },
  },
  {
    id: 'build-baseline',
    title: 'Verify - snapshot pre-change git state',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1', plan: 'build.plan@v1' },
    output: 'build.baseline-snapshot@v1',
    protocol: 'build-baseline-snapshot@v1',
    reportPath: 'reports/build/baseline-snapshot.json',
    required: ['overall_status'],
    routes: { continue: 'act-step', stop: '@stop' },
  },
  {
    id: 'act-step',
    title: 'Act - implementation relay',
    stage: 'act',
    block: 'act',
    input: { brief: 'build.brief@v1', plan: 'build.plan@v1' },
    output: 'build.implementation@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'build-act@v1',
    reportPath: 'reports/build/implementation.json',
    requestPath: 'reports/relay/build-act.request.json',
    receiptPath: 'reports/relay/build-act.receipt.txt',
    resultPath: 'reports/relay/build-act.result.json',
    pass: ['accept'],
    // The longest-running relay in this flow by a wide margin: across 19 recorded
    // executions the median is about six minutes and the tail reaches 21, against
    // a connector wall-clock backstop of 60. That tail is a change big enough to
    // need a long implementation pass, which is exactly the run whose work is most
    // expensive to throw away, and the headroom is under 3x.
    //
    // Only the wall clock is raised. The inactivity bound stays at the connector
    // default, because inactivity is what actually detects a wedged worker — a
    // stuck process goes quiet, while a slow one keeps streaming. Raising the
    // backstop therefore costs very little: the idle bound still reclaims a hung
    // relay in ten minutes.
    budgets: { wall_clock_ms: 7_200_000 },
    acceptanceCriteria: {
      checks: [
        {
          kind: 'report_field',
          id: 'changed-files-present',
          path: ['changed_files'],
          predicate: 'present',
        },
        {
          kind: 'report_field',
          id: 'changed-files-on-disk',
          path: ['changed_files'],
          predicate: 'changed_on_disk',
        },
        {
          kind: 'report_field',
          id: 'evidence-non-empty',
          path: ['evidence'],
          predicate: 'non_empty',
        },
      ],
      on_failure: { mode: 'retry-with-feedback' },
    },
    skillSlots: [
      {
        id: 'build-implementation',
        description:
          'A skill for implementing the planned change in the existing code style, keeping edits scoped to the plan.',
      },
    ],
    routes: { continue: 'verify-step', retry: 'act-step', stop: '@stop' },
  },
  {
    id: 'verify-step',
    title: 'Verify - run Build verification',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      plan: 'build.plan@v1',
      change: 'build.implementation@v1',
    },
    output: 'build.verification@v1',
    protocol: 'build-verify@v1',
    reportPath: 'reports/build/verification.json',
    required: ['overall_status', 'commands'],
    routes: { continue: 'build-touch-area', advance: 'act-step', retry: 'act-step', stop: '@stop' },
    // A failing verification selects `retry` back into act-step. When that
    // budget is spent, exhaustion advances via `continue` instead of aborting:
    // the failing verification report is already honest evidence, so the
    // touch-area check, review, and close still run, close-with-evidence emits
    // a non-clean result, and `binds_terminal_outcome_to_primary_result` maps
    // it to 'stopped' — the work is preserved and the run can never read as
    // success.
    exhaustion_route: 'continue',
  },
  {
    id: 'build-touch-area',
    title: 'Verify - check git-proven touch area',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      plan: 'build.plan@v1',
      baseline: 'build.baseline-snapshot@v1',
      change: 'build.implementation@v1',
    },
    output: 'build.touch-area@v1',
    protocol: 'build-touch-area@v1',
    reportPath: 'reports/build/touch-area.json',
    required: ['overall_status', 'enforcement', 'containment'],
    routes: { continue: 'review-step', stop: '@stop' },
  },
  {
    id: 'review-step',
    title: 'Review - implementation review relay',
    stage: 'review',
    block: 'review',
    input: {
      brief: 'build.brief@v1',
      plan: 'build.plan@v1',
      change: 'build.implementation@v1',
      verification: 'build.verification@v1',
      touch_area: 'build.touch-area@v1',
    },
    output: 'build.review@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'build-review@v1',
    reportPath: 'reports/build/review.json',
    requestPath: 'reports/relay/build-review.request.json',
    receiptPath: 'reports/relay/build-review.receipt.txt',
    resultPath: 'reports/relay/build-review.result.json',
    // Every valid reviewer verdict flows FORWARD to close, mirroring the Review
    // flow's verdict step. A 'reject' on a green, verified build is an honest
    // needs-attention finding, not a contract violation: routing it back to
    // act-step re-implemented the whole change and, when the reviewer held its
    // objection, exhausted max_attempts and aborted a working build. With
    // 'reject' in the pass set it takes `continue` to close, the verdict is
    // recorded in the Build result (reject -> outcome 'failed'), and
    // `binds_terminal_outcome_to_primary_result` maps that honest result onto
    // the run's terminal outcome ('stopped').
    //
    // The retry/revise routes are KEPT: they recover a genuinely invalid relay
    // OUTPUT (a body that fails the build.review@v1 schema, e.g. accept-with-fixes
    // with no findings), which is a real contract failure distinct from an
    // honest reject verdict. A valid reject is in `pass` and never takes retry,
    // so the exhaustion-abort bug cannot recur.
    pass: ['accept', 'accept-with-fixes', 'reject'],
    skillSlots: [
      {
        id: 'build-change-audit',
        description:
          'A skill for independently auditing a change for correctness, scope creep, and regressions.',
      },
    ],
    routes: { continue: 'close-step', retry: 'act-step', revise: 'act-step', stop: '@stop' },
  },
  {
    id: 'close-step',
    title: 'Close - emit Build result',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'build.brief@v1',
      plan: 'build.plan@v1',
      implementation: 'build.implementation@v1',
      verification: 'build.verification@v1',
      review: 'build.review@v1',
      touch_area: 'build.touch-area@v1',
    },
    output: 'build.result@v1',
    execution: { kind: 'compose' },
    protocol: 'build-close@v1',
    reportPath: 'reports/build-result.json',
    required: ['summary', 'outcome', 'evidence_links'],
    routes: { complete: '@complete', stop: '@stop' },
  },
];

// Author-facing stage labels. The assembler decides WHICH canonicals appear and
// in what order from the item sequence; the id + title for each are not
// derivable, so they are supplied here.
const buildStageLabels: StageLabelMap = {
  frame: { id: 'frame-stage', title: 'Frame' },
  analyze: { id: 'analyze-stage', title: 'Analyze' },
  plan: { id: 'plan-stage', title: 'Plan' },
  act: { id: 'act-stage', title: 'Act' },
  verify: { id: 'verify-stage', title: 'Verify' },
  review: { id: 'review-stage', title: 'Review' },
  close: { id: 'close-stage', title: 'Close' },
};

export const buildAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'build',
  title: 'Build Schematic',
  purpose:
    'Build flow. Circuit frames a requested change, plans it, relays implementation to a worker, runs verification, relays review to a separate worker, and closes with a Build result file plus evidence.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: [
    'task.intake@v1',
    'route.decision@v1',
    'context.request@v1',
    'verification.plan@v1',
  ],
  contract_aliases: [
    { generic: 'flow.brief@v1', actual: 'build.brief@v1' },
    { generic: 'context.packet@v1', actual: 'build.context@v1' },
    { generic: 'plan.strategy@v1', actual: 'build.plan@v1' },
    { generic: 'change.evidence@v1', actual: 'build.implementation@v1' },
    { generic: 'verification.result@v1', actual: 'build.verification@v1' },
    { generic: 'verification.result@v1', actual: 'build.baseline-snapshot@v1' },
    { generic: 'verification.result@v1', actual: 'build.touch-area@v1' },
    { generic: 'review.verdict@v1', actual: 'build.review@v1' },
    { generic: 'flow.result@v1', actual: 'build.result@v1' },
  ],
  axes: {
    allowed_depths: ['low', 'medium', 'high'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  engine_flags: {
    binds_execution_depth_to_relay_selection: true,
    // The reviewer's verdict is the Build's honest terminal signal: an
    // accept green-lights a 'complete' close, while accept-with-fixes or a
    // reject bind the run to the Build result's needs-attention/failed
    // outcome ('stopped') instead of a green 'complete'. See the review-step
    // note on why every verdict flows forward rather than reworking.
    binds_terminal_outcome_to_primary_result: true,
    iterates_slice_loop: {
      head_step: 'act-step',
      tail_step: 'verify-step',
      advance_route: 'advance',
      slices_from: { report: 'reports/build/plan.json', items_path: 'slices' },
      max_slices: 8,
      activate_when_depth_at_least: 'high',
    },
  },
  report_file_surfaces: {
    'build.plan@v1': {
      timing: 'before',
      extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
    },
  },
  items: buildBlockItems,
  stageLabels: buildStageLabels,
};

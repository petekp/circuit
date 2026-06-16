// Goal's flow assembly spec (first-class composition, A5).
//
// Goal is the assembler's generality stress-test: 14 items spanning a clarify
// relay, a contract compose, five sub-run child-flow steps (the only built-in
// that composes whole flows as steps), a checkpoint, a two-pass safety-review
// gate, recovery, and a close that binds the terminal outcome to its primary
// result. Like build (../build/assembly-spec.ts) and pursue
// (../pursue/assembly-spec.ts), data.ts now consumes
// `assembleFlowSchematic(goalAssemblySpec)` instead of a hand-authored literal.
//
// Goal touches frame, act, verify, review, and close — it delegates analyze and
// plan to the selected static child flow — so the assembler derives a partial
// stage path that omits analyze / plan; the rationale is supplied via
// `stagePathRationale`. Goal's engine_flags (binds_terminal_outcome_to_primary_result)
// travel on the schematic and are passed through verbatim.
//
// Each item omits output / evidence_requirements / execution wherever it equals
// the block default (the assembler defaults them back). The child-run steps KEEP
// their per-flow output (goal.child-<flow>-result@v1 differs from the
// goal-child-run block's goal.child-run@v1 default) and their sub-run execution
// (it carries flow_ref / goal / depth beyond the bare kind). The M9 truth test
// (tests/runner/m9-truth-test-assembled-goal.test.ts) proves the assembled goal
// RUNS its sub-run path on the real graph runner, not just compiles.
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const GOAL_STAGE_PATH_RATIONALE =
  'Goal supervises a child flow through Frame, Act, Verify, Review, and Close. Analyze and Plan are delegated to the selected static child flow.';

// Pass verdicts a child flow's result may carry; shared by every child-run step.
const CHILD_PASS_VERDICTS = [
  'accept',
  'accept-with-fixes',
  'accept-with-fold-ins',
  'NO_ISSUES_FOUND',
  'ISSUES_FOUND',
  'clean',
  'needs-followup',
  'decided',
] as const;

const childGoal =
  'Execute the selected child flow for reports/goal/contract.json. Preserve the operator objective and produce a report-backed proof packet.';

// One child-run step. The goal-child-run block defaults output to
// goal.child-run@v1, but each child target writes a distinct typed result, so
// `output` is kept. Evidence matches the block default and is omitted. The
// sub-run execution carries flow_ref / goal / depth, so it is kept in full.
function childRunStep(input: {
  readonly id: string;
  readonly title: string;
  readonly flowId: 'fix' | 'build' | 'review' | 'explore' | 'pursue';
  readonly output: string;
  readonly resultPath: string;
}): BlockStepUse {
  return {
    id: input.id,
    title: input.title,
    stage: 'act',
    block: 'goal-child-run',
    input: { contract: 'goal.contract@v1' },
    output: input.output,
    execution: {
      kind: 'sub-run',
      flow_ref: { flow_id: input.flowId, entry_mode: 'default' },
      goal: childGoal,
      depth: 'medium',
    },
    protocol: `${input.id}@v1`,
    writes: { result_path: input.resultPath },
    check: { pass: [...CHILD_PASS_VERDICTS] },
    routes: { continue: 'goal-attempt', stop: '@stop' },
  };
}

// Goal's full block sequence, in route order.
export const goalBlockItems: readonly BlockStepUse[] = [
  {
    id: 'clarify-goal',
    title: 'Clarify - shape Goal task',
    stage: 'frame',
    block: 'clarify',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    output: 'goal.clarified-task@v1',
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'goal-clarify@v1',
    writes: {
      report_path: 'reports/goal/clarified-task.json',
      request_path: 'reports/relay/goal-clarify.request.json',
      receipt_path: 'reports/relay/goal-clarify.receipt.txt',
      result_path: 'reports/relay/goal-clarify.result.json',
    },
    check: { pass: ['continue', 'ask', 'stop'] },
    route_from_report: { path: ['verdict'] },
    routes: { continue: 'goal-contract', ask: '@stop', stop: '@stop' },
  },
  {
    id: 'goal-contract',
    title: 'Goal - write contract and select static target',
    stage: 'frame',
    block: 'goal',
    input: {
      task: 'task.intake@v1',
      route: 'route.decision@v1',
      clarified: 'goal.clarified-task@v1',
    },
    execution: { kind: 'compose' },
    protocol: 'goal-contract@v1',
    writes: { report_path: 'reports/goal/contract.json' },
    check: { required: ['schema', 'objective', 'done_when', 'selected_flow_target'] },
    route_from_report: { path: ['selected_flow_target'] },
    routes: {
      continue: 'goal-run-build',
      fix: 'goal-run-fix',
      build: 'goal-run-build',
      review: 'goal-run-review',
      explore: 'goal-run-explore',
      pursue: 'goal-run-pursue',
      stop: '@stop',
    },
  },
  childRunStep({
    id: 'goal-run-fix',
    title: 'Child Flow - run Fix',
    flowId: 'fix',
    output: 'goal.child-fix-result@v1',
    resultPath: 'reports/goal/child-results/fix-result.json',
  }),
  childRunStep({
    id: 'goal-run-build',
    title: 'Child Flow - run Build',
    flowId: 'build',
    output: 'goal.child-build-result@v1',
    resultPath: 'reports/goal/child-results/build-result.json',
  }),
  childRunStep({
    id: 'goal-run-review',
    title: 'Child Flow - run Review',
    flowId: 'review',
    output: 'goal.child-review-result@v1',
    resultPath: 'reports/goal/child-results/review-result.json',
  }),
  childRunStep({
    id: 'goal-run-explore',
    title: 'Child Flow - run Explore',
    flowId: 'explore',
    output: 'goal.child-explore-result@v1',
    resultPath: 'reports/goal/child-results/explore-result.json',
  }),
  childRunStep({
    id: 'goal-run-pursue',
    title: 'Child Flow - run Pursue',
    flowId: 'pursue',
    output: 'goal.child-pursue-result@v1',
    resultPath: 'reports/goal/child-results/pursue-result.json',
  }),
  {
    id: 'goal-attempt',
    title: 'Attempt - summarize child result',
    stage: 'act',
    block: 'goal-attempt',
    input: { contract: 'goal.contract@v1' },
    protocol: 'goal-attempt@v1',
    writes: { report_path: 'reports/goal/attempts/attempt-1.json' },
    check: { required: ['schema', 'attempt_id', 'flow_target', 'outcome'] },
    routes: { continue: 'goal-evidence-evaluation', stop: '@stop' },
  },
  {
    id: 'goal-evidence-evaluation',
    title: 'Evaluate - compare attempt evidence to done claims',
    stage: 'verify',
    block: 'goal-evaluate',
    input: { contract: 'goal.contract@v1', attempt: 'goal.attempt@v1' },
    protocol: 'goal-evidence-evaluation@v1',
    writes: { report_path: 'reports/goal/evidence-evaluation.json' },
    check: { required: ['schema', 'verdict', 'claim_results', 'next_route'] },
    route_from_report: { path: ['next_route'] },
    routes: {
      continue: 'goal-gate-pass-1',
      'completion-gate': 'goal-gate-pass-1',
      'retry-selected-flow': 'goal-recovery',
      'run-fix': 'goal-recovery',
      'run-review': 'goal-recovery',
      'run-explore': 'goal-recovery',
      'split-to-pursue': 'goal-recovery',
      checkpoint: 'goal-recovery',
      handoff: '@handoff',
      blocked: 'goal-recovery',
      stop: '@stop',
    },
  },
  {
    id: 'goal-recovery',
    title: 'Recovery - choose typed next action',
    stage: 'verify',
    block: 'goal-recover',
    input: { evaluation: 'goal.evidence-evaluation@v1', attempt: 'goal.attempt@v1' },
    protocol: 'goal-recovery@v1',
    writes: { report_path: 'reports/goal/recovery.json' },
    check: { required: ['schema', 'reason', 'selected_route', 'rationale'] },
    route_from_report: { path: ['selected_route'] },
    routes: {
      continue: 'goal-recovery-checkpoint',
      'retry-selected-flow': 'goal-recovery-checkpoint',
      'run-fix': 'goal-recovery-checkpoint',
      'run-review': 'goal-recovery-checkpoint',
      'run-explore': 'goal-recovery-checkpoint',
      'split-to-pursue': 'goal-recovery-checkpoint',
      checkpoint: 'goal-recovery-checkpoint',
      blocked: 'goal-close',
      handoff: '@handoff',
      stop: '@stop',
    },
  },
  {
    id: 'goal-recovery-checkpoint',
    title: 'Checkpoint - operator judgment required',
    stage: 'verify',
    block: 'goal-checkpoint',
    input: { question: 'flow.question@v1', evidence: 'goal.recovery@v1' },
    output: 'decision.answer@v1',
    protocol: 'goal-recovery-checkpoint@v1',
    writes: {
      checkpoint_request_path: 'reports/checkpoints/goal-recovery-request.json',
      checkpoint_response_path: 'reports/checkpoints/goal-recovery-response.json',
    },
    check: { allow: ['continue', 'blocked', 'handoff'] },
    checkpointPolicy: {
      prompt: 'Goal needs operator judgment before continuing.',
      choices: [
        { id: 'continue', label: 'Close as-is' },
        { id: 'blocked', label: 'Close Blocked' },
        { id: 'handoff', label: 'Hand Off' },
      ],
      safe_default_choice: 'blocked',
    },
    routes: { continue: 'goal-close', blocked: 'goal-close', handoff: '@handoff', stop: '@stop' },
  },
  {
    id: 'goal-gate-pass-1',
    title: 'Safety review - pass 1',
    stage: 'review',
    block: 'goal-gate-review',
    input: { contract: 'goal.contract@v1', evaluation: 'goal.evidence-evaluation@v1' },
    output: 'goal.gate-pass@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'goal-gate-pass-1@v1',
    writes: {
      report_path: 'reports/goal/gate-pass-1.json',
      request_path: 'reports/relay/goal-gate-pass-1.request.json',
      receipt_path: 'reports/relay/goal-gate-pass-1.receipt.txt',
      result_path: 'reports/relay/goal-gate-pass-1.result.json',
    },
    check: { pass: ['gate-pass', 'blocked'] },
    route_from_report: { path: ['next_route'] },
    routes: {
      continue: 'goal-gate-pass-2',
      'run-next-gate-pass': 'goal-gate-pass-2',
      recover: 'goal-recovery',
      retry: 'goal-recovery',
      close: 'goal-recovery',
      stop: '@stop',
    },
  },
  {
    id: 'goal-gate-pass-2',
    title: 'Safety review - pass 2',
    stage: 'review',
    block: 'goal-gate-review',
    input: {
      contract: 'goal.contract@v1',
      evaluation: 'goal.evidence-evaluation@v1',
      gate: 'goal.gate-pass@v1',
    },
    output: 'goal.gate@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'goal-gate-pass-2@v1',
    writes: {
      report_path: 'reports/goal/gate.json',
      request_path: 'reports/relay/goal-gate-pass-2.request.json',
      receipt_path: 'reports/relay/goal-gate-pass-2.receipt.txt',
      result_path: 'reports/relay/goal-gate-pass-2.result.json',
    },
    check: { pass: ['gate-pass', 'blocked'] },
    route_from_report: { path: ['next_route'] },
    routes: {
      continue: 'goal-close',
      close: 'goal-close',
      'run-next-gate-pass': 'goal-gate-pass-2',
      recover: 'goal-recovery',
      retry: 'goal-recovery',
      stop: '@stop',
    },
  },
  {
    id: 'goal-close',
    title: 'Close - emit Goal result',
    stage: 'close',
    block: 'goal-close',
    input: {
      contract: 'goal.contract@v1',
      attempt: 'goal.attempt@v1',
      evaluation: 'goal.evidence-evaluation@v1',
      recovery: 'goal.recovery@v1',
      gate: 'goal.gate@v1',
    },
    // recovery and gate arrive on disjoint routes: the gate path
    // (gate-pass-2 -> close) never runs recovery, and the recovery path
    // (recovery/checkpoint -> close) never runs the second gate pass. The close
    // writer already reads both with `optional: true`, so declaring them optional
    // lifts that runtime truth into the model: each is valid as long as some
    // reachable route produces it.
    optional_inputs: ['recovery', 'gate'],
    protocol: 'goal-close@v1',
    writes: { report_path: 'reports/goal-result.json' },
    check: { required: ['schema', 'outcome', 'summary', 'evidence_links', 'gate'] },
    routes: { complete: '@complete', stop: '@stop' },
  },
];

const goalStageLabels: StageLabelMap = {
  frame: { id: 'goal-frame-stage', title: 'Frame' },
  act: { id: 'goal-act-stage', title: 'Act' },
  verify: { id: 'goal-verify-stage', title: 'Verify' },
  review: { id: 'goal-review-stage', title: 'Review' },
  close: { id: 'goal-close-stage', title: 'Close' },
};

export const goalAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'goal',
  title: 'Goal Schematic',
  purpose:
    'Goal flow. Circuit writes a bounded goal contract, runs one statically authored child flow target, evaluates evidence, runs a two-pass safety review, and closes from typed Goal reports.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['task.intake@v1', 'route.decision@v1', 'flow.question@v1'],
  contract_aliases: [
    { generic: 'clarified.task@v1', actual: 'goal.clarified-task@v1' },
    // First-class composition (goal split): per-role goal blocks own synthetic
    // output contracts so each block has a unique typed output. These aliases
    // let the re-homed items bind generics to those real report outputs. Every
    // generic below is referenced by no other item, so it cannot mask an
    // unrelated mismatch.
    //
    // M8.3 removed 11 legacy goal.contract@v1 aliases that mapped that name onto
    // every other goal report. Each goal report is already the unique
    // output_contract of its own goal block, so each item matches its block by
    // identity without an alias, and the items that CONSUME goal.contract@v1
    // (recovery, gate, close) bind to the real goal-contract producer upstream.
    { generic: 'goal.child-run@v1', actual: 'goal.child-fix-result@v1' },
    { generic: 'goal.child-run@v1', actual: 'goal.child-build-result@v1' },
    { generic: 'goal.child-run@v1', actual: 'goal.child-review-result@v1' },
    { generic: 'goal.child-run@v1', actual: 'goal.child-explore-result@v1' },
    { generic: 'goal.child-run@v1', actual: 'goal.child-pursue-result@v1' },
    { generic: 'goal.gate-review@v1', actual: 'goal.gate-pass@v1' },
    { generic: 'goal.gate-review@v1', actual: 'goal.gate@v1' },
    { generic: 'goal.checkpoint@v1', actual: 'decision.answer@v1' },
  ],
  axes: {
    allowed_depths: ['low', 'medium', 'high'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  // Stage 3 (first-class composition): goal DECLARES the terminal-outcome bind on
  // its schematic; the compiler propagates it to the compiled manifest and the
  // engine reads it through `resolveEngineFlags`.
  engine_flags: {
    binds_terminal_outcome_to_primary_result: true,
  },
  items: goalBlockItems,
  stageLabels: goalStageLabels,
  stagePathRationale: GOAL_STAGE_PATH_RATIONALE,
};

// Sweep's flow assembly spec.
//
// Sweep is the fan-out-over-a-set cousin of Fix Until Green. Where Fix Until
// Green loops one fix-attempt body until a single verification command passes,
// Sweep loops a body that PARTITIONS a whole backlog of one mechanical finding,
// fans a worker out per partition unit, re-scans with a pinned oracle, and lets
// a judge decide whether the backlog is clear. The scanner's zero-finding exit
// is the oracle, not a judge's prose.
//
// Topology (census preamble, then a four-step loop body). Blocks are chosen for
// the canonical stage each is legal at: census and partition ride the `plan`
// block (both are planning steps, and `plan` is the only compose-or-fanout block
// that accepts a brief-only input at the preamble), fan-out rides the `act` block
// (the one that permits a fanout execution at the act stage), then run-verification
// and review close the loop.
//   census-step  (plan, runs once) — compose. Pins the scanner and the
//     suppression audit into VerificationCommands the rescan re-runs each wave,
//     and records the opening backlog, the suppression baseline, and the config
//     surface. Runs before the loop, so its pinned commands are stable input.
//   Loop body (head -> fanout -> rescan -> tail):
//     partition-step (plan, HEAD) — compose. Re-scans, so it sees only the
//       survivors, and groups them into file-disjoint units. Carried judge
//       lessons fold into each unit's fix prompt (the compounding path).
//     fanout-step   (act) — one implementer worker per unit, file-isolated so
//       the wave is safe to run concurrently. aggregate-only join: the fanout is
//       a work dispatch, not a decision — the rescan floor decides, so every
//       honest worker verdict (fixed / partial / blocked) is admitted.
//     rescan-step   (verify) — run-verification. Re-runs the PINNED scanner and
//       suppression audit; overall_status is the evidence floor.
//     judge-step    (review, TAIL) — reviewer relay. Proposes goal_met, backed
//       by the rescan the floor already disposed, and leaves a lesson.
//
// THE RED-VERIFY ROUTING DECISION is the same as Fix Until Green's: a rescan on
// a still-red scanner does not take a normal forward route, so the verify step
// declares BOTH `continue` (green, forward to the judge) and `revise` (red,
// narrow_scope recovery to the SAME judge). Either way control reaches the
// judge; on red the floor blocks the goal_met claim and the loop re-enters with
// the lesson carried. The judge's exhausted exit (`close`) is a NORMAL route so
// an exhausted clean pass does not trip the no-failure-evidence guard.
//
// TWO HONESTY FLOORS beyond the scanner exit. `frozen_paths: ['tsconfig.json']`
// latches the honesty ledger if a worker edits the config the scanner reads, so
// a run cannot close clean by relaxing the rules instead of fixing the code. The
// pinned rescan commands (engine change 2) refuse to run if a worker narrows the
// scan in its plan or rewrites the `scan`/`audit` package-script body between
// waves. Both block a clean close; neither can be laundered from inside a worker.
//
// The loop RE-ENTERS only at `autonomous` depth. Below it the body runs once,
// but the tail still disposes goal_met against the evidence floor: a one-pass
// run never launders a red scan into @complete.
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';
import {
  SWEEP_CARRIED_NOTES_PATH,
  SWEEP_CENSUS_REPORT_PATH,
  SWEEP_FLOW_FROZEN_PATHS,
  SWEEP_JUDGE_RECEIPT_PATH,
  SWEEP_JUDGE_REPORT_PATH,
  SWEEP_JUDGE_REQUEST_PATH,
  SWEEP_JUDGE_RESULT_PATH,
  SWEEP_PARTITION_REPORT_PATH,
  SWEEP_RESCAN_REPORT_PATH,
  SWEEP_WAVE_AGGREGATE_PATH,
  SWEEP_WAVE_BRANCHES_DIR,
} from './paths.js';

const SWEEP_STAGE_PATH_RATIONALE =
  'Sweep is a fan-out-over-a-set Converge flow: it plans the sweep (census plus partition), acts on it (the fan-out wave), verifies with a pinned rescan, and reviews whether the backlog is clear, looping the body until the scanner exits clean.';

export const sweepBlockItems: readonly BlockStepUse[] = [
  {
    id: 'census-step',
    title: 'Census the backlog',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1' },
    output: 'sweep.census@v1',
    execution: { kind: 'compose' },
    protocol: 'sweep-census@v1',
    reportPath: SWEEP_CENSUS_REPORT_PATH,
    required: ['objective', 'scanner', 'suppression_audit', 'findings'],
    routes: { continue: 'partition-step', stop: '@stop' },
  },
  {
    id: 'partition-step',
    title: 'Partition the survivors',
    stage: 'plan',
    block: 'plan',
    // Reads the brief and the census. The carried-notes file is wired into this
    // head step's reads by the schematic assembler, so each pass the partition
    // writer can fold the accumulated judge lessons into the unit fix prompts.
    input: { brief: 'flow.brief@v1', census: 'sweep.census@v1' },
    output: 'sweep.partition@v1',
    execution: { kind: 'compose' },
    protocol: 'sweep-partition@v1',
    reportPath: SWEEP_PARTITION_REPORT_PATH,
    required: ['units'],
    routes: { continue: 'fanout-step', stop: '@stop' },
  },
  {
    id: 'fanout-step',
    title: 'Fix each unit',
    stage: 'act',
    block: 'act',
    input: { brief: 'flow.brief@v1', partition: 'sweep.partition@v1' },
    output: 'sweep.wave-aggregate@v1',
    execution: { kind: 'fanout' },
    protocol: 'sweep-fanout@v1',
    writes: {
      report_path: SWEEP_WAVE_AGGREGATE_PATH,
      branches_dir_path: SWEEP_WAVE_BRANCHES_DIR,
    },
    // Every honest worker verdict is admitted: the fanout is a work dispatch,
    // and the rescan floor — not this check — decides whether the backlog is
    // clear. A `blocked` worker simply leaves its findings for the next wave.
    check: { pass: ['fixed', 'partial', 'blocked'] },
    routes: { continue: 'rescan-step', stop: '@stop' },
    fanout: {
      branches: {
        kind: 'dynamic',
        source_report: SWEEP_PARTITION_REPORT_PATH,
        items_path: 'units',
        template: {
          branch_id: '$item.unit_id',
          execution: {
            kind: 'relay',
            role: 'implementer',
            goal: '$item.fix_prompt',
            report_schema: 'sweep.unit-fix@v1',
            // The worker's report unit_id must equal the branch_id (the unit it
            // was assigned), so a worker cannot report progress on another unit.
            provenance_field: 'unit_id',
          },
        },
        max_branches: 16,
      },
      concurrency: { kind: 'bounded', max: 4 },
      // A single crashed worker does not abort the wave; the rescan catches
      // whatever it failed to fix and the loop re-enters.
      on_child_failure: 'continue-others',
      join: { policy: 'aggregate-only' },
    },
  },
  {
    id: 'rescan-step',
    title: 'Re-scan for remaining findings',
    stage: 'verify',
    block: 'run-verification',
    // proof is the run-verification block's required initial contract; census
    // carries the pinned scanner and suppression-audit command list.
    input: { proof: 'verification.plan@v1', census: 'sweep.census@v1' },
    output: 'sweep.verification@v1',
    protocol: 'sweep-rescan@v1',
    reportPath: SWEEP_RESCAN_REPORT_PATH,
    required: ['overall_status', 'commands'],
    // continue: the green forward route to the judge. revise: the red recovery
    // route to the SAME judge (narrow_scope, allowed for cause failed_check), so
    // a still-red scan reaches the judge WITH failure evidence and the floor
    // blocks a premature stop.
    routes: { continue: 'judge-step', revise: 'judge-step', stop: '@stop' },
  },
  {
    id: 'judge-step',
    title: 'Judge whether the backlog is clear',
    stage: 'review',
    block: 'review',
    input: { brief: 'flow.brief@v1' },
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'sweep-review@v1',
    // Bound to the strict judgment contract, exactly as Fix Until Green's judge:
    // the typed report carries goal_met + lesson, which the until corridor reads.
    output: 'converge.judgment@v1',
    requestPath: SWEEP_JUDGE_REQUEST_PATH,
    receiptPath: SWEEP_JUDGE_RECEIPT_PATH,
    resultPath: SWEEP_JUDGE_RESULT_PATH,
    reportPath: SWEEP_JUDGE_REPORT_PATH,
    pass: ['accept', 'accept-with-fixes', 'reject'],
    // continue: clean stop to @complete. advance: the loop re-entry back to the
    // head (partition). close: the exhausted exit — a NORMAL route so an
    // exhausted clean pass does not trip the no-failure-evidence guard.
    routes: { continue: '@complete', advance: 'partition-step', close: '@stop' },
  },
];

const sweepStageLabels: StageLabelMap = {
  plan: { id: 'plan-stage', title: 'Census and partition' },
  act: { id: 'act-stage', title: 'Fix' },
  verify: { id: 'verify-stage', title: 'Rescan' },
  review: { id: 'review-stage', title: 'Review' },
};

export const sweepAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'sweep',
  title: 'Sweep Schematic',
  purpose:
    'Sweep flow: clear a whole backlog of one mechanical finding by partitioning it into file-disjoint units, fanning a worker out per unit, and re-scanning with a pinned oracle each wave until the scanner exits clean or the iteration cap is hit.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['flow.brief@v1', 'verification.plan@v1'],
  contract_aliases: [
    // Each block output override needs a generic->actual alias so the compiled
    // step's output is compatible with the block's default output_contract.
    { generic: 'plan.strategy@v1', actual: 'sweep.census@v1' },
    { generic: 'plan.strategy@v1', actual: 'sweep.partition@v1' },
    { generic: 'change.evidence@v1', actual: 'sweep.wave-aggregate@v1' },
    { generic: 'verification.result@v1', actual: 'sweep.verification@v1' },
    { generic: 'review.verdict@v1', actual: 'converge.judgment@v1' },
  ],
  axes: {
    allowed_depths: ['medium'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  engine_flags: {
    iterates_until_condition: {
      head_step: 'partition-step',
      tail_step: 'judge-step',
      body_steps: ['partition-step', 'fanout-step', 'rescan-step', 'judge-step'],
      reenter_route: 'advance',
      max_iterations: 5,
      stop_judge: {
        report: SWEEP_JUDGE_REPORT_PATH,
        goal_met_path: 'goal_met',
        lesson_path: 'lesson',
      },
      needs_attention_route: 'close',
      carried_notes: { report: SWEEP_CARRIED_NOTES_PATH },
      // The scanner's config surface. A worker that edits it to silence a
      // finding latches the honesty ledger, so the run cannot close clean by
      // relaxing the rules instead of fixing the code.
      frozen_paths: [...SWEEP_FLOW_FROZEN_PATHS],
      activate_when_depth_at_least: 'autonomous',
    },
  },
  items: sweepBlockItems,
  stageLabels: sweepStageLabels,
  stagePathRationale: SWEEP_STAGE_PATH_RATIONALE,
};

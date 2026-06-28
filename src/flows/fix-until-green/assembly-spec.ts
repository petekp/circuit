// Fix Until Green's flow assembly spec — the first real production Converge flow.
//
// converge-proof is the smallest flow that opts into the until-loop engine flag,
// but its loop body is three bare relays with no real verification: its judge's
// goal_met claim always clears the evidence floor because the flow declares no
// proof. Fix Until Green is the version with teeth. Its loop body runs a REAL
// verification command (run-verification) every iteration, so when the tests are
// still red the proof assessment is `contradicted`, the close-proof gap stays
// open, and a judge that claims goal_met is BLOCKED from stopping clean — the loop
// re-enters instead. Only a green verify clears the floor.
//
// Topology:
//   Preamble (runs once): plan-step (compose) resolves the verification commands
//   into a typed plan report (fix-until-green.plan@v1).
//   Loop body (head -> verify -> tail):
//     act-step (head)    — implementer relay; makes the fix attempt. It declares
//                          the carried-notes path in `reads` so each iteration the
//                          prompt composer re-inlines the lessons the judge left,
//                          which is the compounding mechanism.
//     verify-step        — run-verification; reads the plan, runs the command(s),
//                          emits the verification report + proof assessment.
//     judge-step (tail)  — reviewer relay; proposes goal_met and writes a lesson.
//
// THE RED-VERIFY ROUTING DECISION. A run-verification step on a FAILED command
// does not take a normal forward route; it calls recoveryRouteForFailure(cause:
// failed_check) and routes to a bound recovery route. We NEED a red verify to
// reach the judge so the judge reflects (writes a lesson) and the tail seam
// carries that lesson forward (appendCarriedNote fires only at the tail seam on a
// reenter disposition). So the verify step declares BOTH a normal forward route
// to the judge (continue, taken on a green verify) AND a recovery route to the
// same judge (revise, which binds as narrow_scope recovery for cause
// failed_check, taken on a red verify). Either way control reaches the judge: on
// green the floor confirms and the loop stops clean; on red the floor blocks the
// goal_met claim, the loop re-enters, and the lesson carries.
//
// The judge's exhausted/needs-attention exit (close) MUST be a NORMAL route, not a
// recovery route like escalate. An exhausted iteration exits on a CLEAN judge pass
// with no failure evidence, and a recovery route there would trip the WorkContract
// "selected recovery route without failure evidence" guard and abort. `close` is
// in NORMAL_ROUTE_IDS, so the run exits `stopped` via @stop as intended.
//
// Each loop-body relay is BARE: no typed report on the relay (protocol inline,
// generic shape, no report-schema validation), exactly like converge-proof's
// relays. The judge's free goal_met / lesson fields ride along on its unvalidated
// result. The verify step is the only typed report in the body.
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const FIX_UNTIL_GREEN_STAGE_PATH_RATIONALE =
  'Fix Until Green is a narrow Converge flow; plan, act, verify, and review are the canonical stages needed to loop a fix-attempt body until verification passes.';

// The carried-notes run-file the engine maintains across iterations. The act
// (head) step lists it in `reads` so each pass re-inlines the accumulated lessons.
const CARRIED_NOTES_PATH = 'reports/fix-until-green/carried-notes.json';
const JUDGE_RESULT_PATH = 'reports/fix-until-green/judgment.result.json';

export const fixUntilGreenBlockItems: readonly BlockStepUse[] = [
  {
    id: 'plan-step',
    title: 'Plan the verification',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1' },
    output: 'fix-until-green.plan@v1',
    execution: { kind: 'compose' },
    protocol: 'fix-until-green-plan@v1',
    reportPath: 'reports/fix-until-green/plan.json',
    required: ['objective', 'verification'],
    routes: { continue: 'act-step', stop: '@stop' },
  },
  {
    id: 'act-step',
    title: 'Attempt the fix',
    stage: 'act',
    block: 'act',
    // Reads the brief and the plan. The carried-notes file is wired into this
    // step's reads by the schematic assembler (see the note on
    // carriedNotesHeadReadPath in the assembly spec below), so each pass re-inlines
    // the lessons the judge left on prior iterations, framed as data. That re-inline
    // is the compounding mechanism: each attempt starts from what the last learned.
    input: { brief: 'flow.brief@v1', plan: 'fix-until-green.plan@v1' },
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'fix-until-green-act@v1',
    requestPath: 'reports/fix-until-green/act.request.json',
    receiptPath: 'reports/fix-until-green/act.receipt.txt',
    resultPath: 'reports/fix-until-green/act.result.json',
    pass: ['ok'],
    routes: { continue: 'verify-step' },
  },
  {
    id: 'verify-step',
    title: 'Run the verification',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1', plan: 'fix-until-green.plan@v1' },
    output: 'fix-until-green.verification@v1',
    protocol: 'fix-until-green-verify@v1',
    reportPath: 'reports/fix-until-green/verification.json',
    required: ['overall_status', 'commands'],
    // continue: the green-verify forward route to the judge.
    // revise: the red-verify recovery route to the judge. revise binds as
    //   narrow_scope recovery (allowed for cause failed_check), so a failed
    //   command routes forward to the judge WITH failure evidence present (the
    //   proof assessment), rather than failing the step. The judge then reflects,
    //   the floor blocks its goal_met claim on the open proof gap, and the tail
    //   seam carries the lesson on re-enter.
    routes: { continue: 'judge-step', revise: 'judge-step', stop: '@stop' },
  },
  {
    id: 'judge-step',
    title: 'Judge whether the goal is met',
    stage: 'review',
    block: 'review',
    // Brief-only input (a registered initial contract). The judge's decision rides
    // on its unvalidated relay result (goal_met + lesson), which the engine reads
    // from the result path; it does not need a typed read of the verification.
    input: { brief: 'flow.brief@v1' },
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'fix-until-green-review@v1',
    requestPath: 'reports/fix-until-green/judgment.request.json',
    receiptPath: 'reports/fix-until-green/judgment.receipt.txt',
    resultPath: JUDGE_RESULT_PATH,
    pass: ['ok'],
    // continue: clean stop to @complete. advance: the loop re-entry edge back to
    // the head. close: the exhausted exit to the non-complete @stop terminal — a
    // NORMAL route (not a recovery route) so an exhausted clean pass does not trip
    // the no-failure-evidence guard.
    routes: { continue: '@complete', advance: 'act-step', close: '@stop' },
  },
];

const fixUntilGreenStageLabels: StageLabelMap = {
  plan: { id: 'plan-stage', title: 'Plan' },
  act: { id: 'act-stage', title: 'Act' },
  verify: { id: 'verify-stage', title: 'Verify' },
  review: { id: 'review-stage', title: 'Review' },
};

export const fixUntilGreenAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'fix-until-green',
  title: 'Fix Until Green Schematic',
  purpose:
    'Fix Until Green flow: loop a fix-attempt body (act, verify, judge) until a real verification command passes or the iteration cap is hit, so the until-loop primitive runs with a true evidence floor and a judge that leaves a lesson for the next pass.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['flow.brief@v1', 'verification.plan@v1'],
  contract_aliases: [
    { generic: 'plan.strategy@v1', actual: 'fix-until-green.plan@v1' },
    { generic: 'verification.result@v1', actual: 'fix-until-green.verification@v1' },
  ],
  axes: {
    allowed_depths: ['medium'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  engine_flags: {
    iterates_until_condition: {
      head_step: 'act-step',
      tail_step: 'judge-step',
      body_steps: ['act-step', 'verify-step', 'judge-step'],
      reenter_route: 'advance',
      max_iterations: 3,
      stop_judge: {
        report: JUDGE_RESULT_PATH,
        goal_met_path: 'goal_met',
        lesson_path: 'lesson',
      },
      needs_attention_route: 'close',
      carried_notes: { report: CARRIED_NOTES_PATH },
      activate_when_depth_at_least: 'autonomous',
    },
  },
  items: fixUntilGreenBlockItems,
  stageLabels: fixUntilGreenStageLabels,
  stagePathRationale: FIX_UNTIL_GREEN_STAGE_PATH_RATIONALE,
};

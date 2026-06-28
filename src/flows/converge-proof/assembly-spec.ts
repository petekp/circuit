// Converge Proof's flow assembly spec — the until-loop's end-to-end customer.
//
// Converge Proof is the smallest flow that opts into the until-loop engine flag
// (`iterates_until_condition`), so the until-loop primitive travels the full
// real stack: catalog entry -> assembled schematic -> emitted manifest ->
// compiled circuit.json -> fromCompiledFlow -> live activation. Every other
// until-loop test hand-constructs the ExecutableFlow and skips that manifest
// boundary; this flow exists to close that gap.
//
// Shape: a three-relay body (plan -> act -> review) wired as a loop. The review
// (tail) step is the stop-judge: its result carries `goal_met`, which the engine
// reads to decide whether to re-enter the loop (goal not met, under the cap) or
// stop clean (goal met + evidence floor clear). On cap exhaustion the loop exits
// to needs-attention, never to @complete. The loop activates only at the
// `autonomous` depth; at every other depth the flow runs once, top to bottom,
// byte-identical to a non-loop flow.
//
// Each relay omits `output` so the block default fills it back, and declares no
// report_path: a relay producer's downstream read-path falls back to its
// result_path (compile-schematic-to-flow.ts), so the plan -> act -> review
// contract chain resolves with no typed report. With no report_path the result
// body is unvalidated, so the judge's free `goal_met` field rides along on the
// review result the stop-judge reads.
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const CONVERGE_PROOF_STAGE_PATH_RATIONALE =
  'Converge Proof is a narrow until-loop proof flow; only plan, act, and review are needed to exercise a multi-step body that re-enters until the judge confirms the goal.';

// Converge Proof's loop body, in route order: plan (head) -> act (intermediate)
// -> review (tail / judge). The judge declares three routes, all NORMAL (never
// recovery) keys: continue (the clean stop to @complete), advance (the loop
// re-entry edge back to the head, the same key the slice loop re-enters on), and
// close (the exhausted exit to the non-complete @stop terminal). The exhausted
// exit must be a NORMAL route, not a recovery route like `escalate`: an exhausted
// iteration takes its exit on a CLEAN pass (the judge completed its check), so a
// recovery route would trip the WorkContract "selected recovery route without
// failure evidence" guard and abort. `close` carries no recovery binding (it is
// in NORMAL_ROUTE_IDS), so the run exits `stopped` via @stop as intended.
export const convergeProofBlockItems: readonly BlockStepUse[] = [
  {
    id: 'head-step',
    title: 'Plan the next iteration',
    stage: 'plan',
    block: 'plan',
    input: { brief: 'flow.brief@v1' },
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'converge-proof-plan@v1',
    requestPath: 'reports/converge/plan.request.json',
    receiptPath: 'reports/converge/plan.receipt.txt',
    resultPath: 'reports/converge/plan.result.json',
    pass: ['ok'],
    routes: { continue: 'work-step' },
  },
  {
    id: 'work-step',
    title: 'Act on the plan',
    stage: 'act',
    block: 'act',
    input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'converge-proof-act@v1',
    requestPath: 'reports/converge/act.request.json',
    receiptPath: 'reports/converge/act.receipt.txt',
    resultPath: 'reports/converge/act.result.json',
    pass: ['ok'],
    routes: { continue: 'judge-step' },
  },
  {
    id: 'judge-step',
    title: 'Judge whether the goal is met',
    stage: 'review',
    block: 'review',
    // Reads brief only (a registered initial contract). The review block admits
    // a brief-only input; reading work-step's change.evidence@v1 would force the
    // generic contract to carry a registered Zod body it does not have, and the
    // loop's behavior never depends on the judge reading the act result anyway.
    input: { brief: 'flow.brief@v1' },
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'converge-proof-review@v1',
    requestPath: 'reports/converge/judgment.request.json',
    receiptPath: 'reports/converge/judgment.receipt.txt',
    resultPath: 'reports/converge/judgment.result.json',
    pass: ['ok'],
    routes: { continue: '@complete', advance: 'head-step', close: '@stop' },
  },
];

const convergeProofStageLabels: StageLabelMap = {
  plan: { id: 'plan-stage', title: 'Plan' },
  act: { id: 'act-stage', title: 'Act' },
  review: { id: 'review-stage', title: 'Review' },
};

export const convergeProofAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'converge-proof',
  title: 'Converge Proof Schematic',
  purpose:
    'Converge Proof flow: re-enter a three-relay body (plan, act, review) until the review judge confirms the goal is met, so the until-loop primitive can be observed end-to-end through the runtime boundary.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: ['flow.brief@v1'],
  contract_aliases: [],
  axes: {
    allowed_depths: ['medium'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  engine_flags: {
    iterates_until_condition: {
      head_step: 'head-step',
      tail_step: 'judge-step',
      body_steps: ['head-step', 'work-step', 'judge-step'],
      reenter_route: 'advance',
      max_iterations: 3,
      stop_judge: {
        report: 'reports/converge/judgment.result.json',
        goal_met_path: 'goal_met',
        lesson_path: 'lesson',
      },
      needs_attention_route: 'close',
      activate_when_depth_at_least: 'autonomous',
    },
  },
  items: convergeProofBlockItems,
  stageLabels: convergeProofStageLabels,
  stagePathRationale: CONVERGE_PROOF_STAGE_PATH_RATIONALE,
};

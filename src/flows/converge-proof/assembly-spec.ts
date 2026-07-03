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
// (tail) step is the stop-judge: it is bound to the strict converge.judgment@v1
// report schema, so its result must carry a verdict from the schema's enum
// (accept / accept-with-fixes / reject), the load-bearing `goal_met` boolean, a
// carried `lesson`, and an operator `summary`. The judge's check.pass admits ALL
// THREE schema verdicts — the verdict says "the judge did its job", while
// `goal_met` (disposed against the evidence floor) decides whether the loop
// stops clean, re-enters, or exhausts to needs-attention. An honest "reject, not
// done" is a valid relay response, never a failed check. The live surface test
// proved both halves of the old shape wrong: an unvalidated judge was PROMPTED
// into the bare `{"verdict":"ok"}` rubber stamp, and an honest off-vocabulary
// verdict crashed the run instead of looping (see
// docs/release/proofs/live-runs/LEDGER.md, F13).
//
// The loop RE-ENTERS only at the `autonomous` depth. Below it the flow runs the
// body once — but the tail still disposes its goal_met proposal against the
// evidence floor: a met claim the floor confirms completes, anything else exits
// via the needs-attention route. One-pass mode never launders an unmet goal
// into @complete.
//
// The head and act relays omit `output` so the block default fills it back, and
// declare no report_path: a relay producer's downstream read-path falls back to
// its result_path (compile-schematic-to-flow.ts), so the plan -> act contract
// chain resolves with no typed report.
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
    // The stop-judge is bound to the strict judgment contract: the typed report
    // is what the until corridor reads (stop_judge.report below), and the bound
    // schema is what the shape-hint registry keys on, so the judge's prompt
    // teaches exactly the shape the validator enforces. A bare acknowledgment
    // body fails schema validation and can never close the loop.
    output: 'converge.judgment@v1',
    requestPath: 'reports/converge/judgment.request.json',
    receiptPath: 'reports/converge/judgment.receipt.txt',
    resultPath: 'reports/converge/judgment.result.json',
    reportPath: 'reports/converge/judgment.report.json',
    // All three schema verdicts are admissible: the verdict reports that the
    // judge did its job; goal_met carries the judgment. An honest "reject" must
    // route through the loop's disposition, not fail the relay check.
    pass: ['accept', 'accept-with-fixes', 'reject'],
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
  // The judge-step overrides the review block's generic output with the strict
  // judgment contract; the alias is what makes that override block-compatible
  // (contractIsCompatible admits generic -> declared actual).
  contract_aliases: [{ generic: 'review.verdict@v1', actual: 'converge.judgment@v1' }],
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
        // Read the TYPED report, not the raw result: the report file exists only
        // when the body passed converge.judgment@v1 validation, so the corridor
        // always disposes a schema-checked goal_met.
        report: 'reports/converge/judgment.report.json',
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

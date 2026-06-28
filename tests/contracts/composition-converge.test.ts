// Flow-shape composition (experimental, default-OFF): the Converge shape.
//
// The composer could emit a line and a bounded back-edge (composition-loop), but
// it could never emit a CONVERGE: an until-loop that re-enters a body until a
// stop-judge proposes the goal is met AND an evidence floor confirms it. That is
// Circuit's whole differentiator over an unbounded "never stop" loop — a
// generated Converge MUST inherit the same evidence floor the hand-authored
// fix-until-green flow runs on, and fail closed when the body has no real
// verification to check the judge's claim.
//
// These tests lock that capability, gated so the composer can only emit a
// Converge when the role set actually contains a run-verification body step (the
// evidence floor). A role set carries `convergeUntil` to ask for the shape; the
// composer maps it onto the fix-until-green engine-flag shape
// (engine_flags.iterates_until_condition) and wires the reviewer tail's
// continue/advance/close routes. Omitting `convergeUntil` is byte-stable: the
// composer emits no engine flags, exactly as before.
//
// Proof boundary (read before extending). These tests prove the EMISSION: the
// gate fails closed, the flag maps onto the right step ids and routes, the
// emitted flag is structurally coherent by the runtime's own validator
// (assertUntilFlagCoherent), and a mutation turns that validator red. They do NOT
// drive the composed flow through the runtime, and emission shape alone is not the
// same as routing behavior: the composed Converge once emitted a verify step with
// only { continue, stop }, which passed every check here yet routed a RED verify to
// @stop, stopping the run at the verify step before the tail judge — a one-shot. A
// composed flow can therefore be structurally coherent and still mis-route. The
// red-verify routing is driven LIVE in composition-converge-live.test.ts: a real
// composed Converge run against a red `npm run verify` takes the verify step's
// `revise` route to the reviewer tail. The emitted stop_judge.report path matches
// the relay result path by the single `reports/relay/<step>.result.json` convention
// the composer uses for every relay (composer.ts) and the engine reads
// (readUntilJudgeReport, graph-runner.ts).
//
// The full green path — a composed Converge running all the way to a clean green
// @complete — is now PROVEN, not deferred. The composer rebinds the reviewer tail to
// the dedicated `converge.judgment@v1` contract (verdict/goal_met/lesson/summary)
// instead of the family's strict `build.review@v1`, so the tail carries the
// stop-judge's goal_met/lesson WITHOUT downgrading to failed_check. The green live
// test in composition-converge-live.test.ts drives a real composed Converge through a
// red->green verification to outcome === 'complete', with the loop re-entering once
// on the red iteration. The tail-contract assertion below locks that rebind.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import {
  type GraphExecutionOutcome,
  executeExecutableFlowOutcome,
} from '../../src/runtime/run/graph-runner.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

// The canonical Converge: a plan preamble that runs ONCE (it produces the
// strategy the act reads and the command list the verification sources), then a
// looped body — an implementer act (loop head), a run-verification step (the
// evidence floor), and a reviewer review (loop tail / stop-judge) — closing with
// evidence. `convergeUntil` asks the composer to fold the act/verify/review body
// into an until-loop. This mirrors fix-until-green's real topology, whose
// plan-step likewise sits outside the loop body.
const CONVERGE_FULL: CompositionRoleSet = {
  id: 'converge-full',
  title: 'Converge until verified',
  purpose:
    'Plan the work, then attempt the change, run a real verification, and judge whether the goal is met — looping the act/verify/judge body until the verification passes and the judge agrees, or the iteration cap is hit. A composed Converge: the generated analog of fix-until-green.',
  convergeUntil: { maxIterations: 3 },
  roles: [
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// The SAME role set with the run-verification body step removed: act + judge, no
// evidence floor. The gate must wall this — a Converge whose judge's goal-met
// claim is checked against nothing is exactly the unbounded loop the whole shape
// exists to prevent.
const CONVERGE_NO_VERIFY: CompositionRoleSet = {
  id: 'converge-no-verify',
  title: 'Converge with no evidence floor (must wall)',
  purpose:
    'A Converge role set missing its run-verification body step. The gate must refuse to emit a loop with no floor to check the judge.',
  convergeUntil: { maxIterations: 3 },
  roles: [
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

function reason(outcome: GraphExecutionOutcome): string {
  return outcome.kind === 'rejected' ? outcome.reason : `(not rejected: ${outcome.kind})`;
}

// Drive a composed Converge spec through the SAME runtime entry the engine runs:
// assemble -> compile -> fromCompiledFlow -> executeExecutableFlowOutcome at
// autonomous depth. The until-flag coherence check (assertUntilFlagCoherent) runs
// during setup, before any step executes, so a mis-wired flag rejects here with an
// "until loop ..." message regardless of whether the body steps can actually run.
async function runAtAutonomous(
  flow: ExecutableFlow,
  runDir: string,
): Promise<GraphExecutionOutcome> {
  return executeExecutableFlowOutcome(flow, {
    runDir,
    runId: '90000000-0000-0000-0000-0000000000c0',
    goal: 'drive the composed Converge far enough to clear the until-flag coherence gate',
    depth: 'autonomous',
    now: deterministicNow(Date.UTC(2026, 5, 28, 12, 0, 0)),
    // No executors: the coherence check fires before any step runs, so the step
    // bodies never need to execute for this proof.
    executors: {},
  });
}

describe('flow-shape composition — Converge (until-loop emission)', () => {
  const converge = composeFlow(CONVERGE_FULL, { definitions: flowDefinitions });

  it('walls a Converge role set with no run-verification body (the evidence-floor gate)', () => {
    const outcome = composeFlow(CONVERGE_NO_VERIFY, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The reason must name the missing verification so a repair pass can act.
      expect(outcome.walls.some((w) => /verif/i.test(w.reason))).toBe(true);
    }
  });

  it('emits engine_flags.iterates_until_condition mapped onto the fix-until-green shape', () => {
    if (!converge.ok) {
      throw new Error(
        `composer walled: ${converge.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    const flag = converge.spec.engine_flags?.iterates_until_condition;
    expect(flag).toBeDefined();
    if (flag === undefined) throw new Error('no until flag');

    // The real assigned step ids: each block appears once, so stepId === block id.
    const act = converge.spec.items.find((it) => String(it.block) === 'act');
    const verify = converge.spec.items.find((it) => String(it.block) === 'run-verification');
    const review = converge.spec.items.find((it) => String(it.block) === 'review');
    if (!act || !verify || !review) throw new Error('missing body step');

    // The reviewer tail is rebound to the dedicated stop-judge contract, NOT the
    // family's strict build.review@v1. This is what lets the tail carry the
    // goal_met/lesson the until-loop reads without downgrading to failed_check; the
    // green live test drives that all the way to @complete. The head/verify/close
    // steps are untouched.
    expect(String(review.output)).toBe('converge.judgment@v1');
    const act2 = converge.spec.items.find((it) => String(it.block) === 'act');
    expect(String(act2?.output)).not.toBe('converge.judgment@v1');

    expect(flag.head_step).toBe(String(act.id));
    expect(flag.tail_step).toBe(String(review.id));
    expect(flag.body_steps).toEqual([String(act.id), String(verify.id), String(review.id)]);
    expect(flag.reenter_route).toBe('advance');
    expect(flag.needs_attention_route).toBe('close');
    expect(flag.max_iterations).toBe(3);
    expect(flag.activate_when_depth_at_least).toBe('autonomous');
    // The stop-judge reads the reviewer relay's result report.
    expect(flag.stop_judge?.report).toBe(`reports/relay/${String(review.id)}.result.json`);
    expect(flag.stop_judge?.goal_met_path).toBe('goal_met');
    expect(flag.stop_judge?.lesson_path).toBe('lesson');

    // The reviewer tail's routes wire the loop:
    //   - continue: the clean-stop forward route. Unlike hand-authored
    //     fix-until-green (whose judge IS terminal and routes continue ->
    //     @complete), the composed Converge has a close-with-evidence step after
    //     the reviewer, so the clean stop flows THROUGH it — the close soaks the
    //     evidence and binds the primary result, then routes to @complete.
    //   - advance: the re-enter edge back to the loop head.
    //   - close: the exhausted exit to @stop (the needs_attention_route).
    const close = converge.spec.items.find((it) => String(it.block) === 'close-with-evidence');
    if (!close) throw new Error('no close step');
    expect(review.routes.continue).toBe(String(close.id));
    expect(review.routes.advance).toBe(String(act.id));
    expect(review.routes.close).toBe('@stop');
    // The close step is the terminal that reaches @complete on the clean stop.
    expect(close.routes.complete).toBe('@complete');
  });

  it('the emitted flag is COHERENT by the runtime validator (assertUntilFlagCoherent accepts it)', async () => {
    if (!converge.ok) throw new Error('compose failed');
    const validity = evaluateValidity(converge.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    if (!flow) throw new Error('no compiled flow');

    const executable = fromCompiledFlow(flow);
    // The flag survives the manifest -> in-code translation onto the executable.
    expect(executable.engineFlags?.iteratesUntilCondition).toBeDefined();

    // Drive it through the real runtime entry at autonomous depth. The coherence
    // check runs in setup; a coherent flag is NOT rejected with an "until loop"
    // message (it may stop later for an unrelated reason, but never for an
    // incoherent flag).
    const outcome = await runAtAutonomous(executable, '/tmp/circuit-converge-coherent');
    expect(reason(outcome)).not.toMatch(/until loop/i);
  });

  it('a MIS-WIRED flag turns the validator red (mutation proof)', async () => {
    if (!converge.ok) throw new Error('compose failed');
    const validity = evaluateValidity(converge.spec);
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    if (!flow) throw new Error('no compiled flow');
    const executable = fromCompiledFlow(flow);
    const until = executable.engineFlags?.iteratesUntilCondition;
    if (until === undefined) throw new Error('no until flag');

    // Corrupt the flag: drop the head step from bodySteps. A coherent flag listed
    // the full [head..tail] span; this mutation must be caught upfront.
    const mutated: ExecutableFlow = {
      ...executable,
      engineFlags: {
        ...executable.engineFlags,
        iteratesUntilCondition: {
          ...until,
          bodySteps: until.bodySteps.filter((id) => id !== until.headStep),
        },
      },
    };
    const outcome = await runAtAutonomous(mutated, '/tmp/circuit-converge-mutated');
    expect(outcome.kind).toBe('rejected');
    expect(reason(outcome)).toMatch(/until loop/i);
    expect(reason(outcome)).toMatch(/omits headStep/i);
  });
});

describe('flow-shape composition — Converge byte-stability', () => {
  it('a role set WITHOUT convergeUntil emits no engine flags (unchanged from today)', () => {
    const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');
    expect(outcome.spec.engine_flags).toBeUndefined();
  });

  it('the same body WITHOUT convergeUntil composes a plain line (no until flag, no tail loop routes)', () => {
    const plain: CompositionRoleSet = { ...CONVERGE_FULL, id: 'converge-body-plain' };
    // Strip the convergeUntil directive; the body is otherwise identical.
    const { convergeUntil, ...rest } = plain;
    void convergeUntil;
    const outcome = composeFlow(rest, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');
    expect(outcome.spec.engine_flags).toBeUndefined();
    const review = outcome.spec.items.find((it) => String(it.block) === 'review');
    // The reviewer is not the terminal, so it keeps the plain forward route to the
    // close step — no advance/close loop routes.
    expect(review?.routes.advance).toBeUndefined();
    expect(review?.routes.close).toBeUndefined();
  });
});

describe('flow-shape composition — Converge frozen eval surface', () => {
  // A generated Converge can declare a frozen eval surface: paths the loop body must
  // not mutate (the source under measurement and the gate that scores it). The
  // composer threads `convergeUntil.frozenPaths` into the until flag's `frozen_paths`,
  // where the runtime's FrozenEvalGuard reads it (engine-flags.ts maps frozen_paths ->
  // frozenPaths; graph-runner builds the guard from it). Without this a generated
  // Converge could only declare a metric, never protect it — a loop free to edit its
  // own benchmark. This is the generate-path analog of fix-until-green's frozen eval.
  it('emits frozen_paths in the until flag when the directive declares them', () => {
    const frozen = ['src/runtime/run/until-budget.ts', 'scripts/converge-gate.mjs'];
    const withFrozen: CompositionRoleSet = {
      ...CONVERGE_FULL,
      id: 'converge-frozen',
      convergeUntil: { maxIterations: 3, frozenPaths: frozen },
    };
    const outcome = composeFlow(withFrozen, { definitions: flowDefinitions });
    if (!outcome.ok) {
      throw new Error(`composer walled: ${outcome.walls.map((w) => w.reason).join(' | ')}`);
    }
    const flag = outcome.spec.engine_flags?.iterates_until_condition;
    expect(flag?.frozen_paths).toEqual(frozen);
  });

  it('omits frozen_paths when the directive declares none (byte-stable)', () => {
    // CONVERGE_FULL sets convergeUntil without frozenPaths; the flag must not carry an
    // empty or undefined frozen_paths key — exactly as before this field existed.
    const plain = composeFlow(CONVERGE_FULL, { definitions: flowDefinitions });
    if (!plain.ok) throw new Error('compose failed');
    const flag = plain.spec.engine_flags?.iterates_until_condition;
    expect(flag).toBeDefined();
    expect(flag && 'frozen_paths' in flag).toBe(false);
  });
});

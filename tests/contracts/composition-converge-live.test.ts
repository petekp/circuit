// Flow-shape composition (experimental, default-OFF): a composed CONVERGE driven
// LIVE through a real RED verification — the proof that the generated Converge's
// red-verify route reaches the stop-judge, which the emission tests in
// composition-converge.test.ts deliberately do NOT drive.
//
// THE BUG THIS LOCKS. A run-verification step on a FAILED command does not take its
// forward `continue` route; the executor calls recoveryRouteForFailure(cause:
// failed_check) and routes to a bound RECOVERY route. The composer originally gave
// the composed verify step only `{ continue, stop }`, so the one recovery-eligible
// route a red verify could take was `stop` -> @stop: the run STOPPED at the verify
// step on the first red command and never reached the reviewer tail judge, so the
// until corridor (which re-enters only at the tail seam) never re-entered. The
// composed Converge was a one-shot. The fix mirrors fix-until-green: the composer
// adds a `revise` route on the verify step pointing at the tail judge, ordered
// before `stop` so the work-contract projection's narrow_scope binding (which
// accepts failed_check) wins over stop_unsafe. A red verify then routes FORWARD to
// the judge with the failure evidence present.
//
// WHAT THIS DRIVES, AND WHAT IT DOES NOT. This test compiles a real composed
// Converge, serializes it, and drives it through the SAME `runCompiledFlow` entry
// the CLI uses, against a project whose `npm run verify` is RED. It asserts the
// routing the fix changes: the red verify reaches the reviewer (`run-verification`
// completes via `revise`, and the `review` tail step is entered). Pre-fix the run
// stopped at the verify step and `review` was never entered.
//
// The SECOND describe block drives the composed flow ALL the way to a green
// @complete — the proof that the strict-reviewer gap is closed. The composer now
// rebinds the reviewer tail to the dedicated `converge.judgment@v1` contract
// (verdict/goal_met/lesson/summary) instead of the family's strict
// `build.review@v1`, so the tail carries the stop-judge's goal_met/lesson without
// downgrading to failed_check. The green test drives a red->green verification: the
// red iteration re-enters (the floor blocks goal_met on the open proof gap), and the
// green iteration stops clean and closes @complete. Pre-fix the typed strict reviewer
// downgraded to failed_check the instant it carried the judgment, so the loop could
// never read goal_met and the run aborted on the unbound advance recovery route.
//
// The role set adds a `frame` checkpoint ahead of the generic `plan`. The build plan
// compose writer (which the composer binds for the generic plan block) has a
// REQUIRED read of build.brief@v1; only the frame produces it. Without the frame the
// run aborts at the plan step before act/verify ever run — an upstream composition
// limit orthogonal to the routing bug, and the frame is the minimal honest way past
// it so the verify step is actually reached.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { planCompiledFlowFiles } from '../../src/flows/compiled-flow-file-plan.js';
import { type CompositionRoleSet, composeFlow } from '../../src/flows/composition/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

// A composed Converge with a frame preamble (grounds the plan), a looped
// act/verify/review body, and a close. `convergeUntil` folds the body into the
// until-loop. The frame is required so the build plan writer's build.brief@v1 read
// resolves (see the file header).
const CONVERGE_FRAMED: CompositionRoleSet = {
  id: 'converge-framed-live',
  title: 'Converge until verified (framed)',
  purpose:
    'Frame the work, plan it, then attempt the change, run a real verification, and judge whether the goal is met — looping the act/verify/judge body until the verification passes and the judge agrees, or the iteration cap is hit.',
  convergeUntil: { maxIterations: 3 },
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'checkpoint' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

function convergeBytes(): Uint8Array {
  const composed = composeFlow(CONVERGE_FRAMED, { definitions: flowDefinitions });
  if (!composed.ok) {
    throw new Error(`compose walled: ${composed.walls.map((w) => w.reason).join(' | ')}`);
  }
  const schematic = assembleFlowSchematic(composed.spec);
  const compiled = compileSchematicToCompiledFlow(schematic);
  const main = planCompiledFlowFiles(compiled).find((f) => f.filename === 'circuit.json');
  if (!main) throw new Error('no circuit.json in compiled file plan');
  return Buffer.from(JSON.stringify(main.flow));
}

// A project root whose `verify` script ALWAYS exits 1 (no marker is ever written),
// so the composed run-verification step's command (lifted from the brief into the
// plan as `npm run verify`) goes RED on every iteration.
function makeRedProject(base: string): string {
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      private: true,
      name: 'converge-live-fixture',
      scripts: { verify: 'node -e "process.exit(1)"' },
    })}\n`,
  );
  return projectRoot;
}

// A project root whose `verify` script exits 0 iff a marker file exists, mirroring
// fix-until-green's red->green fixture. The composed run-verification step runs
// `npm run verify` each iteration, so iteration 0 (no marker) verifies RED and the
// fixing iteration (marker written by the act) verifies GREEN. This drives the loop
// through one genuine red re-enter, then a clean stop — the same shape a real
// converge loop has.
function makeMarkerProject(base: string): { projectRoot: string; markerPath: string } {
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const markerPath = join(projectRoot, 'GREEN_MARKER');
  const escaped = markerPath.replace(/\\/g, '\\\\');
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      private: true,
      name: 'converge-live-green-fixture',
      scripts: { verify: `node -e "process.exit(require('fs').existsSync('${escaped}')?0:1)"` },
    })}\n`,
  );
  return { projectRoot, markerPath };
}

// The fake connector for the GREEN scenario. The act (implementer) writes the marker
// on its FIXING call (`writeMarkerOnActCall`, 2 = iteration 1), so iteration 0
// verifies red and iteration 1 verifies green. The reviewer (stop-judge) emits a
// `converge.judgment@v1` body — exactly { verdict, goal_met, lesson, summary } — the
// shape the dedicated judge contract validates. It proposes goal_met=true every pass;
// the evidence floor disposes the claim against the real verification, so iteration
// 0's claim is blocked (verify red) and iteration 1's is honored (verify green).
function greenConvergeRelayer(input: { readonly markerPath: string }): RelayFn {
  let actCalls = 0;
  return {
    connectorName: 'claude-code',
    relay: async (relayInput: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const prompt = relayInput.prompt;
      const isAct = /Step:\s*act\b/.test(prompt);
      const isReview = /Step:\s*review\b/.test(prompt);
      let body: unknown;
      if (isReview) {
        body = {
          verdict: 'accept',
          goal_met: true,
          lesson: `attempt ${actCalls}: marker present=${existsSync(input.markerPath)}`,
          summary: 'judged the change against the verification',
        };
      } else if (isAct) {
        actCalls += 1;
        // The act writes the marker on its second call, so iteration 1 verifies green.
        if (actCalls >= 2) writeFileSync(input.markerPath, 'fixed');
        body = {
          verdict: 'accept',
          summary: 'attempted the change',
          changed_files: [],
          evidence: ['ran the relay; wrote the marker on the fixing pass'],
        };
      } else {
        const verdict = prompt.match(/Accepted verdicts:\s*([^\n,]+)/i)?.[1]?.trim() ?? 'accept';
        body = { verdict, ok: true };
      }
      return {
        request_payload: prompt,
        receipt_id: 'stub',
        result_body: JSON.stringify(body),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

// The fake connector for the composed act (implementer) and review (reviewer)
// relays. The verify step is the REAL run-verification executor. The act body is
// forged to validate against build.implementation@v1. The reviewer body is the
// `converge.judgment@v1` shape — { verdict, goal_met, lesson, summary } — the
// composed tail now validates against. The verify here is ALWAYS red, so the floor
// blocks the goal_met claim every pass and the loop re-enters until it exhausts the
// cap. This test proves the red verify ROUTES to the reviewer (the revise fix); the
// green @complete path is proven by the second describe block below.
function framedConvergeRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (relayInput: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const prompt = relayInput.prompt;
      const isAct = /Step:\s*act\b/.test(prompt);
      const isReview = /Step:\s*review\b/.test(prompt);
      let body: unknown;
      if (isReview) {
        body = {
          verdict: 'accept',
          goal_met: true,
          lesson: 'verify is still red; keep going',
          summary: 'judged the change; verification has not passed yet',
        };
      } else if (isAct) {
        body = {
          verdict: 'accept',
          summary: 'attempted the change',
          changed_files: [],
          evidence: ['ran the relay; no edits were needed this pass'],
        };
      } else {
        const verdict = prompt.match(/Accepted verdicts:\s*([^\n,]+)/i)?.[1]?.trim() ?? 'accept';
        body = { verdict, ok: true };
      }
      return {
        request_payload: prompt,
        receipt_id: 'stub',
        result_body: JSON.stringify(body),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

// The act makes no real edits, so the worktree is only ever set up, never diffed.
function stubWorktreeRunner() {
  return {
    add() {},
    remove() {},
    changedFiles() {
      return [] as string[];
    },
  };
}

interface TraceRow {
  readonly kind: string;
  readonly step_id?: string | undefined;
  readonly route_taken?: string | undefined;
}

function enteredCount(trace: readonly TraceRow[], stepId: string): number {
  return trace.filter((e) => e.kind === 'step.entered' && e.step_id === stepId).length;
}

function routeTaken(trace: readonly TraceRow[], stepId: string): string | undefined {
  return trace.find((e) => e.kind === 'step.completed' && e.step_id === stepId)?.route_taken;
}

function routesTaken(trace: readonly TraceRow[], stepId: string): (string | undefined)[] {
  return trace
    .filter((e) => e.kind === 'step.completed' && e.step_id === stepId)
    .map((e) => e.route_taken);
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-converge-live-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('flow-shape composition — composed Converge red-verify routes to the stop-judge', () => {
  it('a red verify routes FORWARD to the reviewer tail (via revise), not to @stop', async () => {
    const projectRoot = makeRedProject(base);
    const runFolder = join(base, 'red-verify');

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-00000000c001',
      goal: 'converge: drive the composed body against a red verification',
      depth: 'autonomous',
      unattended: true,
      now: deterministicNow(Date.UTC(2026, 5, 28, 9, 0, 0)),
      relayer: framedConvergeRelayer(),
      worktreeRunner: stubWorktreeRunner(),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    // The composed run-verification step ran a REAL command and went red.
    const verifyCommand = trace.find((e) => e.kind === 'verification.command_evaluated') as
      | (TraceRow & { status?: string; exit_code?: number })
      | undefined;
    expect(verifyCommand?.status).toBe('failed');

    // The fix: each red verify completes via the `revise` recovery route (narrow_scope,
    // which accepts failed_check), NOT `stop`. Pre-fix the only failed_check-eligible
    // route was `stop`, so the verify step routed to @stop and the run ended at the
    // FIRST red command, before the reviewer was ever reached.
    expect(routeTaken(trace, 'run-verification')).toBe('revise');
    expect(routesTaken(trace, 'run-verification').every((r) => r === 'revise')).toBe(true);

    // And control reaches the reviewer tail (the stop-judge). With a valid judgment
    // body the loop genuinely re-enters: the verify is always red, so the floor blocks
    // the goal_met claim every pass and the body runs to the iteration cap (3) before
    // exhausting to needs-attention. Pre-fix `review` was never entered at all.
    expect(enteredCount(trace, 'act')).toBe(3);
    expect(enteredCount(trace, 'run-verification')).toBe(3);
    expect(enteredCount(trace, 'review')).toBe(3);

    // The first two reviewer passes re-enter via `advance`; the exhausted third exits
    // via the needs-attention route (`close` -> @stop). The run never reads as success.
    expect(routesTaken(trace, 'review')).toEqual(['advance', 'advance', 'close']);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();
  }, 90_000);
});

describe('flow-shape composition — composed Converge runs to a green @complete', () => {
  it('re-enters on a red verify, stops clean once green, and closes @complete (the strict-reviewer gap is closed)', async () => {
    const { projectRoot, markerPath } = makeMarkerProject(base);
    const runFolder = join(base, 'green-complete');

    // Iteration 0 verifies RED (no marker): the judge proposes goal_met=true but the
    // evidence floor blocks it on the contradicted proof, so the loop re-enters. The
    // act's second call writes the marker, so iteration 1 verifies GREEN and the floor
    // honors the claim — the tail clean-stops and the close binds the primary result.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-00000000c002',
      goal: 'converge: drive the composed body until the real verification passes',
      depth: 'autonomous',
      unattended: true,
      now: deterministicNow(Date.UTC(2026, 5, 28, 11, 0, 0)),
      relayer: greenConvergeRelayer({ markerPath }),
      worktreeRunner: stubWorktreeRunner(),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    // The whole point: the composed Converge reaches a clean green @complete. Pre-fix
    // the typed strict `build.review@v1` reviewer downgraded to failed_check the moment
    // it carried goal_met/lesson, so the loop could never read its judgment and the run
    // never closed clean. The dedicated `converge.judgment@v1` contract carries those
    // fields, so the tail passes and the loop reads goal_met.
    expect(result.outcome).toBe('complete');

    // The loop RE-ENTERED: the body ran exactly twice (a red iteration, then a green
    // one). No step aborted — a red verify carried to the judge via revise, the floor
    // blocked the claim, and the loop advanced rather than stopping or laundering.
    expect(enteredCount(trace, 'act')).toBe(2);
    expect(enteredCount(trace, 'run-verification')).toBe(2);
    expect(enteredCount(trace, 'review')).toBe(2);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // Iteration 0's judge re-entered the head via `advance`; iteration 1's judge took
    // the clean-stop forward route (the runtime success edge, `pass`), not advance/close.
    const reviewRoutes = routesTaken(trace, 'review');
    expect(reviewRoutes).toHaveLength(2);
    expect(reviewRoutes[0]).toBe('advance');
    expect(reviewRoutes[1]).not.toBe('advance');
    expect(reviewRoutes[1]).not.toBe('close');

    // The run reached the close step (the terminal that binds the primary result and
    // routes to @complete on the clean stop).
    expect(enteredCount(trace, 'close-with-evidence')).toBe(1);
  }, 30_000);
});

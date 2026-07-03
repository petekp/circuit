import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// The until loop's end-to-end test. Every other until-loop test (until-corridor,
// until-loop-runtime, until-budget) hand-builds the flow — either an
// ExecutableFlow literal with `engineFlags.iteratesUntilCondition` set directly,
// or a `CompiledFlow.parse(manifest)` literal — and drives it through
// `executeExecutableFlow` with EXECUTOR-REGISTRY stubs that replace the whole
// compose/relay executor. None of them exercises the until loop as a REAL flow:
// an authored catalog entry, emitted to generated/flows/converge-proof/circuit.json
// by `npm run emit-flows`, driven through `runCompiledFlow` (the CLI-adjacent
// entry that crosses `fromCompiledFlow`, builds the work-contract projection, the
// equipment reshaper, and the context puller) and the `relayer` seam (the real
// relay executor runs — verdict checks and the honesty-ledger evidence floor are
// live; only the connector call is faked).
//
// This test closes that gap. `converge-proof` is a three-relay loop (plan -> act
// -> review). The review tail is the stop-judge: its result body carries
// `goal_met`, which the engine reads to dispose the iteration. The loop converges
// when the judge proposes done AND the real default evidence floor confirms it,
// re-enters when it does not, and exits to needs-attention (never @complete) on
// cap exhaustion. Below the autonomous depth the loop never re-enters (a single
// pass), but the tail still disposes its goal_met proposal honestly: an unmet
// goal exits needs-attention rather than riding the forward route to @complete.
//
// Coverage boundary (deliberate). This e2e drives the real default evidence floor
// (defaultUntilEvidenceFloor) and proves two of its three propose-vs-dispose
// directions end-to-end on faked connector output: the judge proposes done and the
// floor CONFIRMS (clean stop -> @complete, case 1), and the cap exhausts with the
// goal never proposed (needs-attention -> stopped, case 2). It does NOT drive the
// floor's BLOCKING branch — a goal_met=true proposal the floor REJECTS — and that
// is structural, not an omission. The floor blocks on two terms:
//   - An open overclaim latch (honestyLedger.hasOpenLatches). A latch clears when
//     its body step re-runs clean (graph-runner.ts latch-clear), and reaching a
//     clean judge pass in this LINEAR head -> act -> judge body requires every
//     prior step to pass first, which clears their latches. So a latch can never
//     be open at the judge's clean-stop in this flow shape: here the latch term is
//     defense-in-depth, not a reachable clean-stop blocker. The latch OPEN/re-enter
//     and finalize-chokepoint paths are covered by tests/runner/until-loop-runtime
//     and tests/unit/honesty-ledger.
//   - A close-proof gap (completeCloseProofGap). This flow declares no proof_policy
//     on purpose — that absence is exactly why case 1 stops clean — so there is no
//     proof gap to leave open. A proof-gated until flow would exercise this term;
//     converge-proof intentionally is not one.
// In short: case 1 proves the floor CONFIRMS, case 2 proves the cap STOPS, and the
// floor's two rejection terms are proven where they can actually fire — not faked
// here behind a non-default floor override, which would test a floor the shipped
// flow never runs.

const FIXTURE_PATH = resolve('generated/flows/converge-proof/circuit.json');

function convergeProofBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

// A deterministic fake connector for the three converge-proof relays. Head and
// act always pass with the bare `{verdict:"ok"}` the result_verdict check admits
// (no changed_files claim, so the implementer relay latches no overclaim). The
// review tail is bound to the strict converge.judgment@v1 report schema, so it
// answers with the full judgment shape: a verdict from the schema's enum
// (accept/accept-with-fixes/reject — all admitted by the judge's check.pass, so
// an honest "reject, not done" is a valid relay response, never a crash), the
// load-bearing `goal_met`, a carried `lesson`, and an operator `summary`. The
// prompt the real relay executor composes always leads with `Step: <id>`
// (composeRelayPrompt), so the stub routes on that.
function convergeRelayer(goalMetByJudgeCall: (judgeCall: number) => boolean): RelayFn {
  let judgeCalls = 0;
  return makeStubRelayer((input) => {
    if (input.prompt.includes('Step: judge-step')) {
      const met = goalMetByJudgeCall(judgeCalls);
      judgeCalls += 1;
      return JSON.stringify({
        verdict: met ? 'accept' : 'reject',
        goal_met: met,
        lesson: `pass ${judgeCalls}`,
        summary: met ? 'goal met and verified' : 'goal not met yet',
      });
    }
    return '{"verdict":"ok"}';
  });
}

function enteredCount(
  trace: readonly { readonly kind: string; readonly step_id?: string | undefined }[],
  stepId: string,
): number {
  return trace.filter((e) => e.kind === 'step.entered' && e.step_id === stepId).length;
}

function judgeRoutesTaken(
  trace: readonly {
    readonly kind: string;
    readonly step_id?: string | undefined;
    readonly route_taken?: string | undefined;
  }[],
): (string | undefined)[] {
  return trace
    .filter((e) => e.kind === 'step.completed' && e.step_id === 'judge-step')
    .map((e) => e.route_taken);
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-converge-proof-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('converge-proof: the until loop drives a real emitted flow end-to-end', () => {
  it('re-enters the three-relay body until the judge confirms the goal, then stops clean via @complete', async () => {
    const runFolder = join(runFolderBase, 'converges');
    // Not done on iteration 0, done on iteration 1.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeProofBytes(),
      runId: '70000000-0000-0000-0000-0000000000c1',
      goal: 'converge-proof loops until the judge confirms the goal is met',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 9, 0, 0)),
      // No untilEvidenceFloor override: the REAL default floor runs. With honest
      // relays (no open overclaim latch) and no proof_policy (no close-proof gap),
      // a goal_met=true proposal clears the floor and the run stops clean.
      relayer: convergeRelayer((judgeCall) => judgeCall >= 1),
    });
    const trace = await new TraceStore(runFolder).load();

    expect(result.outcome).toBe('complete');
    expect(result.flow_id).toBe('converge-proof');

    // Two iterations: every body step — head, the INTERMEDIATE act step, and the
    // judge — re-entered exactly twice. The intermediate step re-entering with no
    // cycle-guard abort is the proof the iteration-scoped count key spans the whole
    // body, surviving the full manifest -> fromCompiledFlow -> corridor path.
    expect(enteredCount(trace, 'head-step')).toBe(2);
    expect(enteredCount(trace, 'work-step')).toBe(2);
    expect(enteredCount(trace, 'judge-step')).toBe(2);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // Iteration 0 re-entered the head via the loop's `advance` route; iteration 1
    // took the clean-stop forward route (`pass` -> @complete).
    expect(judgeRoutesTaken(trace)).toEqual(['advance', 'pass']);
  });

  it('exhausts to the needs-attention exit, never @complete, when the judge never confirms the goal', async () => {
    const runFolder = join(runFolderBase, 'never-converges');
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeProofBytes(),
      runId: '70000000-0000-0000-0000-0000000000c2',
      goal: 'a loop that never converges must exit needs-attention, not complete',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 9, 30, 0)),
      relayer: convergeRelayer(() => false),
    });
    const trace = await new TraceStore(runFolder).load();

    // The cap (max_iterations 3) routes the exhausted run to the needs-attention
    // terminal (@stop), which closes the run `stopped`. Exhaustion can never read
    // as success (@complete), and it is a clean stop, not an abort.
    expect(result.outcome).not.toBe('complete');
    expect(result.outcome).toBe('stopped');
    expect(enteredCount(trace, 'head-step')).toBe(3);
    expect(enteredCount(trace, 'work-step')).toBe(3);
    expect(enteredCount(trace, 'judge-step')).toBe(3);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // Two re-enters via `advance`, then the exhausted iteration exits via the
    // declared needs-attention route (`close` -> @stop).
    expect(judgeRoutesTaken(trace)).toEqual(['advance', 'advance', 'close']);
  });

  it('below the autonomous floor the body runs once and the tail still disposes honestly: an unmet goal exits needs-attention, never @complete', async () => {
    const runFolder = join(runFolderBase, 'below-floor');
    // Below the autonomous depth the corridor never RE-ENTERS (single pass, no
    // loop), but the tail is still a stop-judge: its goal_met proposal is disposed
    // against the evidence floor exactly once. A judge that says "not met" must
    // exit via the needs-attention route (`close` -> @stop, outcome stopped) — the
    // one-pass mode can never launder an unmet goal into @complete. This is the
    // honest one-pass floor the live surface test (t48b) showed was missing.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeProofBytes(),
      runId: '70000000-0000-0000-0000-0000000000c3',
      goal: 'below autonomous depth the flow runs once and an unmet goal exits needs-attention',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 27, 10, 0, 0)),
      relayer: convergeRelayer(() => false),
    });
    const trace = await new TraceStore(runFolder).load();

    expect(result.outcome).toBe('stopped');
    expect(result.flow_id).toBe('converge-proof');
    // Still a single pass: no loop edge below the floor.
    expect(enteredCount(trace, 'head-step')).toBe(1);
    expect(enteredCount(trace, 'work-step')).toBe(1);
    expect(enteredCount(trace, 'judge-step')).toBe(1);
    expect(judgeRoutesTaken(trace)).toEqual(['close']);
    // The one-pass disposition is stamped on the trace like any judged iteration.
    const judgment = trace.find((e) => e.kind === 'run.until-judgment') as
      | { disposition?: string; goal_proposed?: boolean }
      | undefined;
    expect(judgment?.disposition).toBe('needs-attention');
    expect(judgment?.goal_proposed).toBe(false);
  });

  it('below the autonomous floor an honestly met goal still completes in a single pass', async () => {
    const runFolder = join(runFolderBase, 'below-floor-met');
    // The honest one-pass floor must not break the one-pass happy path: a judge
    // that proposes goal_met=true, with the evidence floor clear, keeps the tail's
    // forward route (`pass` -> @complete) exactly as before.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeProofBytes(),
      runId: '70000000-0000-0000-0000-0000000000c4',
      goal: 'below autonomous depth a met goal completes in one pass',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 27, 10, 30, 0)),
      relayer: convergeRelayer(() => true),
    });
    const trace = await new TraceStore(runFolder).load();

    expect(result.outcome).toBe('complete');
    expect(enteredCount(trace, 'head-step')).toBe(1);
    expect(enteredCount(trace, 'work-step')).toBe(1);
    expect(enteredCount(trace, 'judge-step')).toBe(1);
    expect(judgeRoutesTaken(trace)).toEqual(['pass']);
    const judgment = trace.find((e) => e.kind === 'run.until-judgment') as
      | { disposition?: string; goal_proposed?: boolean }
      | undefined;
    expect(judgment?.disposition).toBe('stop-clean');
    expect(judgment?.goal_proposed).toBe(true);
  });

  it('a judge that answers with a bare verdict cannot close the loop: the run exhausts stopped, never complete', async () => {
    const runFolder = join(runFolderBase, 'bare-verdict');
    // The rubber-stamp seam from the live surface test (t48b): a judge answering
    // the bare `{"verdict":"ok"}` acknowledgment. With the judgment schema bound
    // and the check.pass vocabulary aligned to it, 'ok' is not an admissible judge
    // verdict, so the attempt fails its check. Under an active corridor the
    // abort-intercept latches the overclaim and re-enters fresh iterations up to
    // the cap, then exits stopped — the bare verdict can never reach @complete.
    const bareOkRelayer = makeStubRelayer(() => '{"verdict":"ok"}');
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: convergeProofBytes(),
      runId: '70000000-0000-0000-0000-0000000000c5',
      goal: 'a bare-verdict judge must never close the loop complete',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 11, 0, 0)),
      relayer: bareOkRelayer,
    });
    const trace = await new TraceStore(runFolder).load();

    expect(result.outcome).not.toBe('complete');
    expect(result.outcome).toBe('stopped');
    // The exhausted exit names the judge and the unresolved overclaim, so the
    // stop is legible: the operator sees WHICH step failed its contract.
    const abortReasons = trace
      .filter((e) => e.kind === 'step.aborted')
      .map((e) => (e as { reason?: string }).reason ?? '');
    expect(
      abortReasons.some((reason) =>
        reason.includes("until loop exhausted with an unresolved overclaim on 'judge-step'"),
      ),
    ).toBe(true);
  });
});

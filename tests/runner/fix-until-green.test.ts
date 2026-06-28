import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, stubRelayResult } from '../helpers/runtime-fixtures.js';

// fix-until-green's end-to-end test — the first REAL Converge flow driven the
// full way: an authored catalog entry emitted to
// generated/flows/fix-until-green/circuit.json by `npm run emit-flows`, driven
// through `runCompiledFlow` (the CLI-adjacent entry that crosses
// `fromCompiledFlow`, the work-contract projection, the equipment reshaper, the
// context puller) and the `relayer` seam (the real relay executor and the real
// run-verification executor run — verdict checks, the proof assessment, and the
// honesty-ledger evidence floor are all live; only the connector model call is
// faked).
//
// What this adds over converge-proof. converge-proof is three bare relays with no
// real verification, so its judge's goal_met claim always clears the evidence
// floor (no proof_policy => no close-proof gap). fix-until-green's loop body runs
// a REAL run-verification command every iteration. When the command is red the
// proof assessment is `contradicted`, the until evidence floor blocks the judge's
// goal_met claim, and the loop re-enters — so the floor has teeth. Only a green
// verify clears the floor and lets the loop stop clean.
//
// The red->green mechanism. The verify command is FIXED across iterations: a node
// one-liner that exits 0 iff a marker file exists. The fake act relayer writes the
// marker only on the FIXING iteration (its second call, iteration index >= 1), so
// iteration 0 verifies red and iteration 1 verifies green. This drives the loop
// through one genuine red re-enter, then a green clean stop, with the same command
// each pass — exactly the shape a real fix loop has.

const FIXTURE_PATH = join('generated', 'flows', 'fix-until-green', 'circuit.json');

function fixUntilGreenBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

interface TraceRow {
  readonly kind: string;
  readonly step_id?: string | undefined;
  readonly route_taken?: string | undefined;
}

function enteredCount(trace: readonly TraceRow[], stepId: string): number {
  return trace.filter((e) => e.kind === 'step.entered' && e.step_id === stepId).length;
}

function judgeRoutesTaken(trace: readonly TraceRow[]): (string | undefined)[] {
  return trace
    .filter((e) => e.kind === 'step.completed' && e.step_id === 'judge-step')
    .map((e) => e.route_taken);
}

// A project root whose `verify` script exits 0 iff the marker file exists. The
// fix-until-green plan compose writer resolves this script into the loop's
// verification command via the shared verification resolver (npm run verify), so
// the command the run-verification step runs each iteration is exactly this check.
function makeProjectWithMarker(base: string): { projectRoot: string; markerPath: string } {
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const markerPath = join(projectRoot, 'GREEN_MARKER');
  const escaped = markerPath.replace(/\\/g, '\\\\');
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      private: true,
      scripts: { verify: `node -e "process.exit(require('fs').existsSync('${escaped}')?0:1)"` },
    })}\n`,
  );
  return { projectRoot, markerPath };
}

// The fake connector for fix-until-green's two relays (the verify step is the real
// run-verification executor, not a relay). The act relayer writes the marker on
// its fixing call; `writeMarkerOnActCall` decides which act call fixes (>=2 means
// iteration 1). The judge always proposes goal_met=true and carries a lesson that
// records whether the marker was present — so the carried lesson is observable in
// the next iteration's act prompt, proving the loop compounds.
function fixUntilGreenRelayer(input: {
  readonly markerPath: string;
  readonly writeMarkerOnActCall: number | undefined;
}): RelayFn {
  let actCalls = 0;
  return {
    connectorName: 'claude-code',
    relay: async (relayInput) => {
      if (relayInput.prompt.includes('Step: act-step')) {
        actCalls += 1;
        if (input.writeMarkerOnActCall !== undefined && actCalls >= input.writeMarkerOnActCall) {
          writeFileSync(input.markerPath, 'fixed');
        }
        return stubRelayResult({
          request_payload: relayInput.prompt,
          result_body: '{"verdict":"ok"}',
        });
      }
      if (relayInput.prompt.includes('Step: judge-step')) {
        return stubRelayResult({
          request_payload: relayInput.prompt,
          result_body: JSON.stringify({
            verdict: 'ok',
            goal_met: true,
            lesson: `attempt ${actCalls}: marker present=${existsSync(input.markerPath)}`,
          }),
        });
      }
      return stubRelayResult({
        request_payload: relayInput.prompt,
        result_body: '{"verdict":"ok"}',
      });
    },
  };
}

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-fix-until-green-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('fix-until-green: the until loop drives a real verification body end-to-end', () => {
  it('re-enters on a red verify (the floor blocks the goal_met claim) and stops clean once green; the judge lesson carries forward', async () => {
    const { projectRoot, markerPath } = makeProjectWithMarker(base);
    const runFolder = join(base, 'converges');

    // The judge proposes goal_met=true every iteration, but iteration 0 verifies
    // RED (no marker yet). The real evidence floor reads the contradicted proof and
    // blocks the claim, so the loop re-enters. The act's second call writes the
    // marker, so iteration 1 verifies GREEN and the floor confirms -> clean stop.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: fixUntilGreenBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-0000000000f1',
      goal: 'fix until the project verify script passes',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 9, 0, 0)),
      relayer: fixUntilGreenRelayer({ markerPath, writeMarkerOnActCall: 2 }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).toBe('complete');
    expect(result.flow_id).toBe('fix-until-green');

    // Two iterations: the body re-entered exactly twice. A red verify did NOT abort
    // the run (the revise route carried it to the judge with failure evidence), and
    // it did NOT stop clean (the floor blocked the goal_met claim on the open proof
    // gap) — it re-entered. Iteration 1 verified green and stopped clean.
    expect(enteredCount(trace, 'act-step')).toBe(2);
    expect(enteredCount(trace, 'verify-step')).toBe(2);
    expect(enteredCount(trace, 'judge-step')).toBe(2);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // Iteration 0's judge re-entered the head via `advance`; iteration 1's judge
    // took the clean-stop forward route (`pass` -> @complete).
    expect(judgeRoutesTaken(trace)).toEqual(['advance', 'pass']);

    // Compounding (the most important assertion): the lesson the judge wrote on the
    // failed iteration reaches the next iteration's act. The engine appends it to
    // the carried-notes file at the tail seam on re-enter, and the act head re-reads
    // that file (the compiler injects the carried-notes path into the head's reads),
    // so the prompt composer inlines it. The second act request must therefore carry
    // iteration 0's lesson verbatim.
    const carriedNotesPath = join(runFolder, 'reports/fix-until-green/carried-notes.json');
    expect(existsSync(carriedNotesPath)).toBe(true);
    const carried = JSON.parse(readFileSync(carriedNotesPath, 'utf8')) as Array<{
      iteration: number;
      lesson: string;
    }>;
    expect(carried).toHaveLength(1);
    expect(carried[0]?.lesson).toBe('attempt 1: marker present=false');

    // The act request file is the composed relay prompt (plain text, not JSON). The
    // second pass overwrites it with iteration 1's prompt, which the prompt composer
    // builds by inlining every reads-declared file — including the carried-notes file
    // the compiler wired into the head's reads. So iteration 0's lesson appears in
    // iteration 1's act prompt verbatim: the loop compounds.
    const actRequest = readFileSync(
      join(runFolder, 'reports/fix-until-green/act.request.json'),
      'utf8',
    );
    expect(actRequest).toContain('attempt 1: marker present=false');
    // Real-subprocess e2e: each iteration spawns a live verification command, so
    // the default 5s timeout is too tight under the full suite's parallel load
    // (isolated this case runs in well under 1s). 30s matches the repo idiom for
    // subprocess-driven tests (see cli-router, cli-autonomous-loop).
  }, 30_000);

  it('exhausts to needs-attention, never @complete, when the verify never goes green', async () => {
    const { projectRoot, markerPath } = makeProjectWithMarker(base);
    const runFolder = join(base, 'never-green');

    // The marker is never written, so every verify is red. The judge proposes
    // goal_met=true each pass, but the floor blocks all three, so the loop exhausts
    // the cap (max_iterations 3) and exits via the needs-attention route. Exhaustion
    // can never read as success.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: fixUntilGreenBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-0000000000f2',
      goal: 'a fix loop whose verify never passes must exit needs-attention',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 9, 30, 0)),
      relayer: fixUntilGreenRelayer({ markerPath, writeMarkerOnActCall: undefined }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).not.toBe('complete');
    expect(result.outcome).toBe('stopped');
    expect(enteredCount(trace, 'act-step')).toBe(3);
    expect(enteredCount(trace, 'verify-step')).toBe(3);
    expect(enteredCount(trace, 'judge-step')).toBe(3);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // Two re-enters via `advance`, then the exhausted iteration exits via the
    // declared needs-attention route (`close` -> @stop).
    expect(judgeRoutesTaken(trace)).toEqual(['advance', 'advance', 'close']);
    // Three real verify subprocesses (the cap is 3); generous timeout for load.
  }, 30_000);

  it('is a single pass below the autonomous floor: the loop is inert at medium depth', async () => {
    const { projectRoot, markerPath } = makeProjectWithMarker(base);
    const runFolder = join(base, 'below-floor');

    // Below autonomous depth the until corridor never engages, so the body runs once
    // and the tail's forward route is honored directly — even though the verify is
    // red and the judge proposes goal_met. This is the byte-identical default: the
    // engine flag changes nothing until autonomous depth.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: fixUntilGreenBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-0000000000f3',
      goal: 'below autonomous depth the until flag is inert and the flow runs once',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 27, 10, 0, 0)),
      relayer: fixUntilGreenRelayer({ markerPath, writeMarkerOnActCall: undefined }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.flow_id).toBe('fix-until-green');
    expect(enteredCount(trace, 'act-step')).toBe(1);
    expect(enteredCount(trace, 'verify-step')).toBe(1);
    expect(enteredCount(trace, 'judge-step')).toBe(1);
    // No loop edge was taken: the single judge completion went to its forward route.
    expect(judgeRoutesTaken(trace)).toEqual(['pass']);
    // One real verify subprocess; generous timeout to stay green under load.
  }, 30_000);
});

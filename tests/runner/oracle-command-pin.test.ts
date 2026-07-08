import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, stubRelayResult } from '../helpers/runtime-fixtures.js';

// Engine change 2 (oracle-command pin + script-body fingerprint).
//
// fix-until-green's loop body re-reads its verification command list from
// `plan.json` in the worker-editable run folder each wave, and resolves
// `npm run verify` against `package.json`'s `scripts.verify` at spawn time.
// Both live inside the worker's tree, so a dishonest worker can make a red
// oracle look green two ways:
//   1. narrow the command in `plan.json` (drop the real scan, run a no-op),
//   2. rewrite `scripts.verify` to a no-op while the argv stays byte-identical.
// The pin snapshots the resolved command at loop entry and serves it every
// later wave (closing vector 1), and fingerprints the referenced script body
// and rejects a drift (closing vector 2). This file drives both vectors end to
// end through the real Converge until-loop.

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

// A project whose `verify` script exits 0 iff the marker file exists. The plan
// preamble resolves `npm run verify` from these scripts; the loop body runs it
// each wave. The marker is never written in these tests, so an honest verify is
// always red — only tampering can fake a green.
function makeProjectWithMarker(base: string): {
  projectRoot: string;
  markerPath: string;
  packageJsonPath: string;
} {
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const markerPath = join(projectRoot, 'GREEN_MARKER');
  const packageJsonPath = join(projectRoot, 'package.json');
  const escaped = markerPath.replace(/\\/g, '\\\\');
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify({
      private: true,
      scripts: { verify: `node -e "process.exit(require('fs').existsSync('${escaped}')?0:1)"` },
    })}\n`,
  );
  return { projectRoot, markerPath, packageJsonPath };
}

function judgeReply(actCalls: number): string {
  return JSON.stringify({
    verdict: 'accept',
    goal_met: true,
    lesson: `attempt ${actCalls}`,
    summary: `judged attempt ${actCalls}`,
  });
}

// A relayer that runs a mutation on the act step's N-th call, simulating a
// worker that tampers between waves. The judge always proposes goal_met=true;
// only the evidence floor (and now the pin) decides whether that stands.
function tamperingRelayer(input: {
  readonly mutateOnActCall: number;
  readonly mutate: () => void;
}): RelayFn {
  let actCalls = 0;
  return {
    connectorName: 'claude-code',
    relay: async (relayInput) => {
      if (relayInput.prompt.includes('Step: act-step')) {
        actCalls += 1;
        if (actCalls >= input.mutateOnActCall) input.mutate();
        return stubRelayResult({
          request_payload: relayInput.prompt,
          result_body: '{"verdict":"ok"}',
        });
      }
      if (relayInput.prompt.includes('Step: judge-step')) {
        return stubRelayResult({
          request_payload: relayInput.prompt,
          result_body: judgeReply(actCalls),
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
  base = mkdtempSync(join(tmpdir(), 'circuit-oracle-pin-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('oracle-command pin: a rewritten oracle cannot launder a red run into complete', () => {
  it('rejects a script-body swap: rewriting scripts.verify to a no-op aborts instead of closing complete', async () => {
    const { projectRoot, packageJsonPath } = makeProjectWithMarker(base);
    const runFolder = join(base, 'script-swap');

    // Wave 0 verifies red (no marker). On the second act call (wave 1) the
    // "worker" rewrites scripts.verify to an always-green no-op while the argv
    // the plan pinned (`npm run verify`) stays byte-identical. Without the
    // script-body fingerprint this closes @complete with debt intact; with it,
    // the drift is caught and the run aborts.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: fixUntilGreenBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-0000000000a1',
      goal: 'fix until the project verify script passes',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 11, 0, 0)),
      relayer: tamperingRelayer({
        mutateOnActCall: 2,
        mutate: () => {
          writeFileSync(
            packageJsonPath,
            `${JSON.stringify({ private: true, scripts: { verify: 'node -e "process.exit(0)"' } })}\n`,
          );
        },
      }),
    });

    expect(result.outcome).not.toBe('complete');
    expect(result.reason ?? '').toMatch(/oracle|script|changed|drift/i);
  }, 30_000);

  it('ignores a plan-argv narrowing: the pinned command still runs so the loop stays honest', async () => {
    const { projectRoot } = makeProjectWithMarker(base);
    const runFolder = join(base, 'plan-narrow');
    const planPath = join(runFolder, 'reports', 'fix-until-green', 'plan.json');

    // Wave 0 verifies red and pins `npm run verify`. On the second act call the
    // "worker" narrows plan.json's command to an always-green no-op. Without the
    // pin, wave 1 re-reads the narrowed plan and closes @complete; with the pin,
    // wave 1 serves the snapshotted `npm run verify` (still red), so the loop
    // re-enters and exhausts to needs-attention — never @complete.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: fixUntilGreenBytes(),
      projectRoot,
      runId: '70000000-0000-0000-0000-0000000000a2',
      goal: 'fix until the project verify script passes',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 5, 27, 11, 30, 0)),
      relayer: tamperingRelayer({
        mutateOnActCall: 2,
        mutate: () => {
          if (!existsSync(planPath)) return;
          const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
            verification: { commands: Array<Record<string, unknown>> };
          };
          plan.verification.commands = plan.verification.commands.map((command) => ({
            ...command,
            argv: ['node', '-e', 'process.exit(0)'],
          }));
          writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
        },
      }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).not.toBe('complete');
    expect(result.outcome).toBe('stopped');
    // The pinned command ran every wave: the loop exhausted its cap (3) on a
    // genuinely red oracle rather than accepting the narrowed no-op.
    expect(enteredCount(trace, 'verify-step')).toBe(3);
  }, 30_000);
});

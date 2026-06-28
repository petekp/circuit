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
// It does NOT drive the composed flow all the way to a green @complete. That is
// blocked by a SEPARATE, orthogonal gap, documented in
// composition-converge.test.ts's proof-boundary note: the composer binds the review
// block to the family's typed `build.review@v1` schema, which is `.strict()` and
// rejects the extra `goal_met`/`lesson` fields the stop-judge reads from the relay
// result. Both hand-authored Converge flows (converge-proof, fix-until-green) make
// their stop-judge a BARE relay precisely so those free fields ride along
// unvalidated; a composed Converge with a typed strict reviewer cannot, so its
// reviewer downgrades to a failed_check before the loop can read goal_met. That is a
// reviewer-shape gap in the generated-Converge path, not a routing gap, and is out
// of scope for this routing fix.
//
// The role set adds a `frame` checkpoint ahead of the generic `plan`. The build plan
// compose writer (which the composer binds for the generic plan block) has a
// REQUIRED read of build.brief@v1; only the frame produces it. Without the frame the
// run aborts at the plan step before act/verify ever run — an upstream composition
// limit orthogonal to the routing bug, and the frame is the minimal honest way past
// it so the verify step is actually reached.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// The fake connector for the composed act (implementer) and review (reviewer)
// relays. The verify step is the REAL run-verification executor. The act body is
// forged to validate against build.implementation@v1. The reviewer body is forged
// to validate against build.review@v1 AND carry the stop-judge's goal_met/lesson;
// the strict review schema rejects those extra keys (the documented separate gap),
// but the reviewer is reached only AFTER the red verify routes to it — which is
// exactly the routing this test proves.
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
          summary: 'reviewed the change',
          findings: [],
          alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
          goal_met: true,
          lesson: 'verify is still red; keep going',
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

    // The fix: the red verify completes via the `revise` recovery route (narrow_scope,
    // which accepts failed_check), NOT `stop`. Pre-fix the only failed_check-eligible
    // route was `stop`, so the verify step routed to @stop and the run ended here.
    expect(routeTaken(trace, 'run-verification')).toBe('revise');

    // And control reaches the reviewer tail (the stop-judge). Pre-fix `review` was
    // never entered, because the run stopped at the verify step.
    expect(enteredCount(trace, 'act')).toBe(1);
    expect(enteredCount(trace, 'run-verification')).toBe(1);
    expect(enteredCount(trace, 'review')).toBe(1);
  }, 30_000);
});

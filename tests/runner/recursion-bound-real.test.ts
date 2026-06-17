// Real-recursion cycle guard.
//
// Sister to `sub-run-real-recursion.test.ts`, which proves a parent can recurse
// into a child through the real `runCompiledFlow` path (no stubbed childRunner).
// This test pins the cycle guard under that same real path: flow A sub-runs flow
// B, and flow B sub-runs flow A. Without the bound this is an infinite descent
// (A -> B -> A -> B -> ...) that ends only when the process dies — which is
// precisely why it cannot be run as a red test before the fix. With the bound,
// the second entry into A is refused on the first repeat.
//
// Why a real recursive run rather than the executor-level test: only this path
// exercises the link that carries the recursion state across a genuine run
// boundary (the child's runCompiledFlow seeding its graph-runner from the
// forwarded depth + ancestor chain). A unit test with an injected context cannot
// catch a missing forward there; this test would.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ChildCompiledFlowResolver } from '../../src/runtime/run/child-runner.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const FLOW_A_ID = 'recursion-a';
const FLOW_B_ID = 'recursion-b';

// A flow whose only step sub-runs `target`. Two of these wired at each other
// form the A -> B -> A cycle.
function buildSubRunOnlyFlow(id: string, target: string): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '3',
    id: id as unknown as string,
    version: '0.1.0',
    purpose: `cycle-guard test flow '${id}' — its only step sub-runs '${target}'.`,
    axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
    starts_at: 'sub-run-step',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['sub-run-step'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'narrow cycle-guard test flow — one sub-run step.',
    },
    steps: [
      {
        id: 'sub-run-step',
        title: `Sub-run into '${target}'`,
        protocol: 'recursion-cycle@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'sub-run',
        flow_ref: { flow_id: target as unknown as string, entry_mode: 'default' },
        goal: `recurse into ${target}`,
        depth: 'medium',
        writes: { result: 'reports/child-result.json' },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: ['accept'],
        },
      },
    ],
  });
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'recursion-bound-real-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

describe('recursion bound — real A -> B -> A cycle', () => {
  it('refuses the second entry into A on the first repeat (real recursive run)', async () => {
    const aBytes = Buffer.from(JSON.stringify(buildSubRunOnlyFlow(FLOW_A_ID, FLOW_B_ID)));
    const bBytes = Buffer.from(JSON.stringify(buildSubRunOnlyFlow(FLOW_B_ID, FLOW_A_ID)));

    const resolver: ChildCompiledFlowResolver = (ref) => {
      if (ref.flowId === FLOW_A_ID) return { flowBytes: aBytes };
      if (ref.flowId === FLOW_B_ID) return { flowBytes: bBytes };
      throw new Error(`unexpected child flow id '${ref.flowId}'`);
    };

    const topRunId = '33333333-3333-3333-3333-333333333333';
    const topRunFolder = join(runFolderBase, topRunId);

    // No childRunner field: the runner defaults to runCompiledFlow, so each
    // sub-run recurses through the real runner and the bound must accumulate
    // across run boundaries on its own.
    const outcome = await runCompiledFlow({
      runDir: topRunFolder,
      flowBytes: aBytes,
      runId: topRunId,
      goal: 'top run — exercise the real cycle guard',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 27, 0, 0, 0)),
      childCompiledFlowResolver: resolver,
    });

    // The cycle is refused, so the run does not complete. The top flow had no
    // stop route, so the refusal propagates up as an abort.
    expect(outcome.outcome).toBe('aborted');

    // A (top) ran and started B; B ran but its re-entry into A was refused
    // before any grandchild started. So exactly two run folders exist — never a
    // third for the refused grandchild.
    const runFolders = readdirSync(runFolderBase);
    expect(runFolders.length).toBe(2);

    // Walk the linkage: A's trace records the sub-run into B.
    const aTrace = await readTrace(topRunFolder);
    const aStarted = aTrace.find((e) => e.kind === 'sub_run.started');
    if (aStarted?.kind !== 'sub_run.started')
      throw new Error('expected A to start a sub-run into B');
    const bRunId = aStarted.child_run_id;
    if (bRunId === undefined) throw new Error('expected a child run id for B');
    expect(aStarted.child_flow_id).toBe(FLOW_B_ID);

    // B ran, but its sub-run into A was refused by the cycle guard before it
    // could start: B's trace carries the cycle failure and NO sub_run.started.
    const bTrace = await readTrace(join(runFolderBase, bRunId));
    const bStarted = bTrace.find((e) => e.kind === 'sub_run.started');
    expect(bStarted).toBeUndefined();
    const cycleFail = bTrace.find(
      (e) =>
        e.kind === 'check.evaluated' &&
        e.outcome === 'fail' &&
        typeof e.reason === 'string' &&
        e.reason.includes('already in the recursion ancestor chain'),
    );
    if (cycleFail?.kind !== 'check.evaluated')
      throw new Error('expected a cycle check failure in B');
    expect(cycleFail.reason).toContain(FLOW_A_ID);
    // The chain names how the cycle was reached: A is the ancestor, B re-enters A.
    expect(cycleFail.reason).toContain(`${FLOW_A_ID} -> ${FLOW_B_ID}`);
  });
});

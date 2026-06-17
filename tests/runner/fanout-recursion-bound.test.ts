// Recursion bound on the fanout sub-run branch edge.
//
// The single-child sub-run executor is not the only place a run begets another
// run: a fanout step with sub-run branches spawns a child run per branch through
// the same childRunner path (see executeSubRunFanoutBranch). That edge must carry
// the same bound, or a fanout of sub-runs would recurse unbounded even while the
// single-child path is guarded.
//
// These tests inject the recursion state at the top-level run and target a simple
// non-recursing leaf, so the guard can be exercised without an actual infinite
// descent: when the leaf is already an ancestor (cycle) or the next level exceeds
// the cap, the branch is refused before its childRunner is ever called — proven by
// the absence of a leaf run folder. The injection also exercises the forward that
// carries the recursion state from the top-level options into the fanout branch.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { RECURSION_DEPTH_CAP } from '../../src/runtime/executors/sub-run.js';
import type {
  ChildCompiledFlowResolver,
  WorktreeRunner,
} from '../../src/runtime/run/child-runner.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const PARENT_ID = 'fanout-bound-parent';
const LEAF_ID = 'fanout-bound-leaf';

function acceptingRelayer(): RelayFn {
  return makeStubRelayer(JSON.stringify({ verdict: 'accept' }), {
    receipt_id: 'stub-receipt-fanout-bound',
  });
}

function stubWorktreeRunner(): WorktreeRunner {
  return {
    add: ({ worktreePath }) => {
      mkdirSync(worktreePath, { recursive: true });
    },
    remove: () => {},
    changedFiles: () => [],
  };
}

// A simple leaf: one relay step that admits accept. It never sub-runs, so it
// cannot itself recurse — the only recursion under test is the parent's branch
// into it.
function buildLeafFlow(): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '3',
    id: LEAF_ID as unknown as string,
    version: '0.1.0',
    purpose: 'fanout recursion-bound test leaf — single relay step admits accept.',
    axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
    starts_at: 'leaf-relay',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['leaf-relay'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'narrow fanout recursion-bound test leaf — only act stage carries relay.',
    },
    steps: [
      {
        id: 'leaf-relay',
        title: 'Leaf relay — admits accept',
        protocol: 'fanout-bound-leaf@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'worker',
        kind: 'relay',
        role: 'implementer',
        writes: {
          request: 'reports/relay.request.json',
          receipt: 'reports/relay.receipt.json',
          result: 'reports/relay.result.json',
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: ['accept'],
        },
      },
    ],
  });
}

// Parent: one fanout step, one sub-run branch into the leaf.
function buildParentFlow(): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '3',
    id: PARENT_ID as unknown as string,
    version: '0.1.0',
    purpose: 'fanout recursion-bound test parent — one sub-run branch into the leaf.',
    axes: { allowed_depths: ['medium'], supports_tournament: false, supports_autonomous: false },
    starts_at: 'fanout-step',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['fanout-step'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'narrow fanout recursion-bound test parent — only act stage carries the fanout.',
    },
    steps: [
      {
        id: 'fanout-step',
        title: 'Fanout — one sub-run branch',
        protocol: 'fanout-bound-parent@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'fanout',
        branches: {
          kind: 'static',
          branches: [
            {
              branch_id: 'only',
              flow_ref: { flow_id: LEAF_ID as unknown as string, entry_mode: 'default' },
              goal: 'branch goal',
              depth: 'medium',
            },
          ],
        },
        concurrency: { kind: 'bounded', max: 1 },
        on_child_failure: 'abort-all',
        writes: {
          branches_dir: 'reports/branches',
          aggregate: { path: 'reports/aggregate.json', schema: 'fanout-aggregate@v1' },
        },
        check: {
          kind: 'fanout_aggregate',
          source: { kind: 'fanout_results', ref: 'aggregate' },
          join: { policy: 'aggregate-only' },
          verdicts: { admit: ['accept'] },
        },
      },
    ],
  });
}

let runFolderBase: string;
let projectRoot: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'fanout-recursion-bound-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'fanout-recursion-bound-project-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

const resolver: ChildCompiledFlowResolver = () => ({
  flowBytes: Buffer.from(JSON.stringify(buildLeafFlow())),
});

async function runParent(
  runFolderBaseLocal: string,
  projectRootLocal: string,
  recursion: { recursionDepth?: number; recursionAncestors?: ReadonlySet<string> },
) {
  const parentRunId = '44444444-4444-4444-4444-444444444444';
  const parentRunFolder = join(runFolderBaseLocal, parentRunId);
  const outcome = await runCompiledFlow({
    runDir: parentRunFolder,
    flowBytes: Buffer.from(JSON.stringify(buildParentFlow())),
    runId: parentRunId,
    goal: 'parent run — exercise the fanout recursion bound',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 3, 27, 0, 0, 0)),
    relayer: acceptingRelayer(),
    projectRoot: projectRootLocal,
    childCompiledFlowResolver: resolver,
    worktreeRunner: stubWorktreeRunner(),
    ...recursion,
  });
  return { outcome, parentRunId, parentRunFolder };
}

describe('recursion bound — fanout sub-run branch', () => {
  it('refuses a branch whose target is already an ancestor (cycle), before calling childRunner', async () => {
    const { outcome, parentRunId, parentRunFolder } = await runParent(runFolderBase, projectRoot, {
      recursionAncestors: new Set([LEAF_ID]),
    });

    expect(outcome.outcome).toBe('aborted');

    // The refused branch never called childRunner: no leaf run folder exists, so
    // the parent's run folder is the only one under the runs base.
    expect(readdirSync(runFolderBase)).toEqual([parentRunId]);

    const entries = await readTrace(parentRunFolder);
    const joined = entries.find((e) => e.kind === 'fanout.joined');
    if (joined?.kind !== 'fanout.joined') throw new Error('expected fanout.joined');
    expect(joined.branches_completed).toBe(0);
    expect(joined.branches_failed).toBe(1);

    // The cycle surfaces as the run's close reason (the join policy lifts the
    // refused branch's failure reason).
    expect(outcome.reason).toContain('already in the recursion ancestor chain');
    expect(outcome.reason).toContain(LEAF_ID);
  });

  it('refuses a branch when the next level would exceed the depth cap', async () => {
    const { outcome, parentRunId } = await runParent(runFolderBase, projectRoot, {
      recursionDepth: RECURSION_DEPTH_CAP,
    });

    expect(outcome.outcome).toBe('aborted');
    expect(readdirSync(runFolderBase)).toEqual([parentRunId]);
    expect(outcome.reason).toContain(`exceed the recursion depth cap of ${RECURSION_DEPTH_CAP}`);
  });

  it('runs the branch normally when neither guard trips (the bound is inert below the cap)', async () => {
    const { outcome, parentRunId } = await runParent(runFolderBase, projectRoot, {});

    expect(outcome.outcome).toBe('complete');
    // The branch ran a real leaf child: a second run folder exists alongside the parent.
    const folders = readdirSync(runFolderBase);
    expect(folders).toContain(parentRunId);
    expect(folders.length).toBe(2);
  });
});

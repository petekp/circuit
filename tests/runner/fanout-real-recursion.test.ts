// Real recursion integration test for fanout.
//
// Complements `tests/runtime/fanout.test.ts` (which exercises the
// fanout executor in isolation) and `sub-run-real-recursion.test.ts`
// (the same no-stub approach for the single-child sub-run case). This
// test extends real-recursion coverage to the multi-child fanout substrate.
//
// What's specific to fanout: each branch produces its own child run
// with its own run-folder, run_id, and trace. The handler also
// drives a worktreeRunner per branch. When `childRunner` is undefined
// on the runtime invocation, the runner defaults to `runCompiledFlow`
// itself, so each branch recurses
// through the real runner end-to-end.
//
// Hermetic, fast (~50ms): a stub worktreeRunner creates the branch
// directories without invoking git; a fake `acceptingRelayer`
// serves all branch children.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import type {
  ChildCompiledFlowResolver,
  WorktreeRunner,
} from '../../src/runtime/run/child-runner.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const PARENT_WORKFLOW_ID = 'parent-fanout-recursion-test';
const CHILD_WORKFLOW_ID = 'child-fanout-recursion-test';

// Fake relayer serves every branch child's single relay step.
function acceptingRelayer(): RelayFn {
  return makeStubRelayer(JSON.stringify({ verdict: 'accept' }), {
    receipt_id: 'stub-receipt-fanout-real-recursion',
  });
}

// Stub worktree runner — the fanout handler invokes `add` to
// provision a branch directory and `remove` to release it. The real
// runner creates real git worktrees; for hermetic recursion it's
// enough to mkdir the path so the child run-folder nests beneath it
// correctly.
function stubWorktreeRunner(): WorktreeRunner {
  return {
    add: ({ worktreePath }) => {
      mkdirSync(worktreePath, { recursive: true });
    },
    remove: () => {
      // No-op — the real runner removes the worktree dir, but the
      // test's afterEach rmSync covers cleanup.
    },
    changedFiles: () => [],
  };
}

function buildChildCompiledFlow(): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '3',
    id: CHILD_WORKFLOW_ID as unknown as string,
    version: '0.1.0',
    purpose:
      'real-recursion fanout test child — single relay step admits an accept verdict via the fake relayer.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'child-relay',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['child-relay'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'narrow real-recursion fanout test child — only act stage carries relay.',
    },
    steps: [
      {
        id: 'child-relay',
        title: 'Child relay — admits accept',
        protocol: 'real-recursion-fanout-child@v1',
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

function buildParentCompiledFlow(): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '3',
    id: PARENT_WORKFLOW_ID as unknown as string,
    version: '0.1.0',
    purpose:
      'real-recursion fanout test parent — two branches, each recurses into the child via real runCompiledFlow.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'fanout-step',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['fanout-step'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale:
        'narrow real-recursion fanout test parent — only act stage carries the fanout step.',
    },
    steps: [
      {
        id: 'fanout-step',
        title: 'Fanout — two branches, real recursion',
        protocol: 'real-recursion-fanout-parent@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'fanout',
        branches: {
          kind: 'static',
          branches: [
            {
              branch_id: 'a',
              flow_ref: {
                flow_id: CHILD_WORKFLOW_ID as unknown as string,
                entry_mode: 'default',
              },
              goal: 'branch-a goal',
              depth: 'standard',
            },
            {
              branch_id: 'b',
              flow_ref: {
                flow_id: CHILD_WORKFLOW_ID as unknown as string,
                entry_mode: 'default',
              },
              goal: 'branch-b goal',
              depth: 'standard',
            },
          ],
        },
        concurrency: { kind: 'bounded', max: 2 },
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
  runFolderBase = mkdtempSync(join(tmpdir(), 'fanout-real-recursion-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'fanout-real-recursion-project-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

describe('fanout real recursion', () => {
  it('runs each branch via real runCompiledFlow (no childRunner stub) and admits via aggregate-only', async () => {
    const parentCompiledFlow = buildParentCompiledFlow();
    const parentBytes = Buffer.from(JSON.stringify(parentCompiledFlow));
    const childCompiledFlow = buildChildCompiledFlow();
    const childBytes = Buffer.from(JSON.stringify(childCompiledFlow));

    const childResolver: ChildCompiledFlowResolver = () => ({ flowBytes: childBytes });

    const parentRunId = '33333333-3333-3333-3333-333333333333';
    const parentRunFolder = join(runFolderBase, parentRunId);

    // KEY: NO `childRunner` field — runner defaults to `runCompiledFlow`
    // itself, so each branch recurses through the real runner.
    const outcome = await runCompiledFlow({
      runDir: parentRunFolder,
      flowBytes: parentBytes,
      runId: parentRunId,
      goal: 'parent run goal — exercise fanout real recursion',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 27, 0, 0, 0)),
      relayer: acceptingRelayer(),
      projectRoot,
      childCompiledFlowResolver: childResolver,
      worktreeRunner: stubWorktreeRunner(),
    });

    expect(outcome.outcome).toBe('complete');

    // Fanout audit linkage on the parent's trace.
    const parentTraceEntries = await readTraceEntries(parentRunFolder);
    const fanoutStarted = parentTraceEntries.find((e) => e.kind === 'fanout.started');
    if (fanoutStarted?.kind !== 'fanout.started') throw new Error('expected fanout.started');
    expect(fanoutStarted.branch_ids).toEqual(['a', 'b']);

    const branchStarted = parentTraceEntries.filter((e) => e.kind === 'fanout.branch_started');
    const branchCompleted = parentTraceEntries.filter((e) => e.kind === 'fanout.branch_completed');
    expect(branchStarted).toHaveLength(2);
    expect(branchCompleted).toHaveLength(2);

    const fanoutJoined = parentTraceEntries.find((e) => e.kind === 'fanout.joined');
    if (fanoutJoined?.kind !== 'fanout.joined') throw new Error('expected fanout.joined');
    expect(fanoutJoined.policy).toBe('aggregate-only');
    expect(fanoutJoined.branches_completed).toBe(2);
    expect(fanoutJoined.branches_failed).toBe(0);

    // Each branch produced a child run with its own fresh run_id.
    const branchChildRunIds: string[] = [];
    for (const ev of branchCompleted) {
      if (ev.kind !== 'fanout.branch_completed') continue;
      if (ev.child_run_id === undefined) throw new Error('expected branch child run id');
      branchChildRunIds.push(ev.child_run_id);
    }
    expect(branchChildRunIds).toHaveLength(2);
    expect(new Set(branchChildRunIds).size).toBe(2); // distinct
    for (const id of branchChildRunIds) {
      expect(id).not.toBe(parentRunId);
    }

    // Each branch child has its own trace, with every trace_entry
    // carrying that branch's child_run_id and relay lifecycle
    // trace_entries firing — proof real recursion ran each branch.
    for (const branchChildRunId of branchChildRunIds) {
      const branchChildRoot = findChildRunFolder(runFolderBase, branchChildRunId);
      const trace_entriesRaw = readFileSync(join(branchChildRoot, 'trace.ndjson'), 'utf8');
      const traceEntryLines = trace_entriesRaw.split('\n').filter((l) => l.length > 0);
      expect(traceEntryLines.length).toBeGreaterThan(0);
      const kinds = new Set<string>();
      for (const line of traceEntryLines) {
        const parsed = JSON.parse(line) as { run_id: string; kind: string };
        expect(parsed.run_id).toBe(branchChildRunId);
        expect(parsed.run_id).not.toBe(parentRunId);
        kinds.add(parsed.kind);
      }
      expect(kinds.has('relay.started')).toBe(true);
      expect(kinds.has('relay.completed')).toBe(true);
      expect(kinds.has('check.evaluated')).toBe(true);

      // Each branch child's result.json was authored via the real
      // result-writer.
      const childResult = JSON.parse(
        readFileSync(join(branchChildRoot, 'reports', 'result.json'), 'utf8'),
      ) as { run_id: string; verdict: string; outcome: string };
      expect(childResult.run_id).toBe(branchChildRunId);
      expect(childResult.verdict).toBe('accept');
      expect(childResult.outcome).toBe('complete');
    }

    // The aggregate report was materialized at the parent's
    // declared path.
    const aggregatePath = join(parentRunFolder, 'reports', 'aggregate.json');
    const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as {
      branches: ReadonlyArray<{ branch_id: string; admitted: boolean }>;
    };
    expect(aggregate.branches.map((b) => b.branch_id).sort()).toEqual(['a', 'b']);
  });
});

// Branch children's run-folders may live as siblings under runFolderBase
// OR under a per-branch worktree directory provisioned by the
// worktreeRunner stub. Both tree shapes are valid; the test scans
// both to find the run-folder for a known child run_id.
function findChildRunFolder(runFolderBase: string, childRunId: string): string {
  for (const entry of readdirSync(runFolderBase)) {
    if (entry === childRunId) return join(runFolderBase, entry);
    // Worktree-style: branch dir contains the child run-folder inside it.
    const candidate = join(runFolderBase, entry, childRunId);
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // Not a directory — try the next entry.
    }
  }
  // Fallback — walk one level deeper for any branch-specific layout.
  for (const entry of readdirSync(runFolderBase)) {
    const sub = join(runFolderBase, entry);
    try {
      for (const inner of readdirSync(sub)) {
        if (inner === childRunId) return join(sub, inner);
      }
    } catch {
      // Not a directory — skip.
    }
  }
  throw new Error(`child run-folder for ${childRunId} not found under ${runFolderBase}`);
}

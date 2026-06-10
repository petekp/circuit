import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStubRelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import type { CompiledFlowRunOptions } from '../../src/runtime/run/child-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import { RunResult } from '../../src/schemas/result.js';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-runtime-sub-run-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function parentFlow(
  pass: readonly string[] = ['accept'],
  options: { readonly reportPath?: string; readonly stopRoute?: boolean } = {},
): ExecutableFlow {
  return {
    id: 'parent-test',
    version: '0.1.0',
    entry: 'child-step',
    stages: [{ id: 'act', stepIds: ['child-step'] }],
    steps: [
      {
        id: 'child-step',
        kind: 'sub-run',
        title: 'Run child',
        protocol: 'sub-run-test@v1',
        routes: {
          pass: { kind: 'terminal', target: '@complete' },
          ...(options.stopRoute === true
            ? { stop: { kind: 'terminal', target: '@stop' as const } }
            : {}),
        },
        flowRef: 'child-test',
        entryMode: 'default',
        goal: 'child goal',
        depth: 'standard',
        writes: {
          result: { path: 'reports/child-result.json' },
          ...(options.reportPath === undefined ? {} : { report: { path: options.reportPath } }),
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: [...pass],
        },
      },
    ],
  };
}

function childFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'child-test',
      version: '0.1.0',
      purpose: 'runtime sub-run child',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow runtime child fixture',
      },
      steps: [
        {
          id: 'close',
          title: 'Close',
          protocol: 'child-close@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'compose',
          writes: { report: { path: 'reports/child.json', schema: 'child.result@v1' } },
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['summary'],
          },
        },
      ],
    }),
  );
}

function stubChildRunner(verdict: string, outcome: 'complete' | 'aborted' = 'complete') {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const resultPath = join(options.runDir, 'reports', 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: 'child-test',
      goal: options.goal,
      outcome,
      summary: 'child summary',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      verdict,
    });
    await writeFile(resultPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return {
      schema_version: 1,
      run_id: body.run_id,
      flow_id: body.flow_id,
      goal: body.goal,
      outcome: body.outcome,
      summary: body.summary,
      closed_at: body.closed_at,
      trace_entries_observed: body.trace_entries_observed,
      manifest_hash: body.manifest_hash,
      verdict,
      resultPath,
    };
  };
}

function stubChildRunnerWithResultBody(body: {
  readonly outcome?: 'complete' | 'aborted' | 'stopped' | 'handoff' | 'escalated';
  readonly verdict?: string;
}) {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const resultPath = join(options.runDir, 'reports', 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    const parsed = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: 'child-test',
      goal: options.goal,
      outcome: body.outcome ?? 'complete',
      summary: 'child summary',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      ...(body.verdict === undefined ? {} : { verdict: body.verdict }),
    });
    await writeFile(resultPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return {
      schema_version: parsed.schema_version,
      run_id: parsed.run_id,
      flow_id: parsed.flow_id,
      goal: parsed.goal,
      outcome: parsed.outcome,
      summary: parsed.summary,
      closed_at: parsed.closed_at,
      trace_entries_observed: parsed.trace_entries_observed,
      manifest_hash: parsed.manifest_hash,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      ...(parsed.verdict === undefined ? {} : { verdict: parsed.verdict }),
      resultPath,
    };
  };
}

function stubChildRunnerWithRawResult(
  resultBody: string,
  outcome: 'complete' | 'aborted' | 'stopped' | 'handoff' | 'escalated' = 'complete',
) {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const resultPath = join(options.runDir, 'reports', 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, resultBody, 'utf8');
    return {
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: 'child-test',
      goal: options.goal,
      outcome,
      summary: 'child summary',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      resultPath,
    };
  };
}

async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

describe('runtime sub-run executor', () => {
  it('runs a sibling child run, copies result.json, and admits an allowed verdict', async () => {
    const runDir = join(baseDir, 'parent-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner('accept'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('accept');
    const copied = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'child-result.json'), 'utf8')),
    );
    expect(copied.verdict).toBe('accept');

    const entries = await trace(runDir);
    const started = entries.find((entry) => entry.kind === 'sub_run.started');
    const completed = entries.find((entry) => entry.kind === 'sub_run.completed');
    expect(started?.child_run_id).toBeDefined();
    expect(completed?.child_run_id).toBe(started?.child_run_id);
    expect(completed?.verdict).toBe('accept');
    expect(
      await readFile(
        join(baseDir, String(started?.child_run_id), 'reports', 'result.json'),
        'utf8',
      ),
    ).toContain('"verdict": "accept"');
  });

  it('rejects a child verdict outside the parent check.pass list', async () => {
    const runDir = join(baseDir, 'parent-reject-run');
    const result = await executeExecutableFlow(parentFlow(['accept']), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner('reject'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("child verdict 'reject'");
    const entries = await trace(runDir);
    expect(entries.find((entry) => entry.kind === 'sub_run.completed')?.verdict).toBe('reject');
    expect(entries.find((entry) => entry.kind === 'check.evaluated')?.outcome).toBe('fail');
  });

  it('does not admit an allowed child verdict when the child run closes non-complete', async () => {
    const runDir = join(baseDir, 'parent-child-aborted-run');
    const result = await executeExecutableFlow(parentFlow(['accept']), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000008',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner('accept', 'aborted'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    const finalResult = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("child closed with outcome 'aborted'");
    expect(result.verdict).toBeUndefined();
    expect(finalResult.verdict).toBeUndefined();
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'sub_run.completed',
        step_id: 'child-step',
        child_outcome: 'aborted',
        verdict: 'accept',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining("child closed with outcome 'aborted'"),
      }),
    );
  });

  it('routes the declared stop route when the child closes non-complete instead of aborting the parent', async () => {
    // F-M-1: a child that ran end to end and handed back a typed RunResult but
    // closed non-complete (e.g. build aborts after verification retries) is a
    // legible non-success, not an infrastructure failure. When the sub-run step
    // declares a `stop` route, the parent must take it (goal: @stop -> stopped)
    // rather than crashing on the missing verdict. This is the exact shape of
    // the surface-test build child: outcome 'aborted', no verdict field.
    const runDir = join(baseDir, 'parent-child-aborted-stop-route-run');
    const result = await executeExecutableFlow(parentFlow(['accept'], { stopRoute: true }), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000012',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunnerWithResultBody({ outcome: 'aborted' }),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    const finalResult = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('stopped');
    expect(result.verdict).toBeUndefined();
    expect(finalResult.outcome).toBe('stopped');
    // The trace explains the real cause (the child's own outcome), not the
    // downstream "missing verdict" symptom.
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'sub_run.completed',
        step_id: 'child-step',
        child_outcome: 'aborted',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining("child closed with outcome 'aborted'"),
      }),
    );
    // The parent did not abort: no step.aborted / run.closed-aborted reason.
    expect(result.reason).toBeUndefined();
  });

  it('fails before child start when writes.report diverges from writes.result', async () => {
    const runDir = join(baseDir, 'parent-divergent-report-run');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(
      parentFlow(['accept'], { reportPath: 'reports/child-report.json' }),
      {
        runDir,
        runId: '50000000-0000-4000-8000-000000000010',
        goal: 'parent goal',
        childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
        childRunner: async (options) => {
          childRunnerCalls += 1;
          return await stubChildRunner('accept')(options);
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      'writes.report materialization at a path different from writes.result is not yet supported',
    );
    expect(childRunnerCalls).toBe(0);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('writes.report materialization'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('fails before child start when the resolver is missing', async () => {
    const runDir = join(baseDir, 'parent-missing-resolver-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000001',
      goal: 'parent goal',
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('childCompiledFlowResolver is required');
    expect(entries.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'step.entered',
      'check.evaluated',
      'step.aborted',
      'run.closed',
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('childCompiledFlowResolver is required'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('fails before child start when the child runner is missing', async () => {
    const runDir = join(baseDir, 'parent-missing-child-runner-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000011',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('childRunner is required');
    expect(entries.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'step.entered',
      'check.evaluated',
      'step.aborted',
      'run.closed',
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('childRunner is required'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('fails before child start when the resolver throws', async () => {
    const runDir = join(baseDir, 'parent-resolver-throw-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000005',
      goal: 'parent goal',
      childCompiledFlowResolver: () => {
        throw new Error('resolver blew up');
      },
      childRunner: stubChildRunner('accept'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('child flow resolution failed');
    expect(result.reason).toContain('resolver blew up');
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('resolver blew up'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('fails before child start when the resolver returns invalid child flow bytes', async () => {
    const runDir = join(baseDir, 'parent-invalid-child-flow-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000009',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: Buffer.from('not-json{{{') }),
      childRunner: stubChildRunner('accept'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('child flow resolution returned invalid compiled flow');
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('invalid compiled flow'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('fails before child start when the resolver returns the wrong flow id', async () => {
    const runDir = join(baseDir, 'parent-wrong-child-id-run');
    const wrongChildFlow = JSON.parse(childFlowBytes().toString('utf8'));
    wrongChildFlow.id = 'wrong-child-test';

    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000002',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: Buffer.from(JSON.stringify(wrongChildFlow)) }),
      childRunner: stubChildRunner('accept'),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("resolver returned flow id 'wrong-child-test'");
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining("resolver returned flow id 'wrong-child-test'"),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.started', step_id: 'child-step' }),
    );
  });

  it('records child invocation failures after sub_run.started without completing the child', async () => {
    const runDir = join(baseDir, 'parent-child-throw-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000003',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: async () => {
        throw new Error('child runner boom');
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('child flow invocation failed');
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'sub_run.started',
        step_id: 'child-step',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining('child runner boom'),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'sub_run.completed', step_id: 'child-step' }),
    );
  });

  it('copies child result evidence but rejects a missing child verdict', async () => {
    const runDir = join(baseDir, 'parent-missing-verdict-run');
    const result = await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: '50000000-0000-4000-8000-000000000004',
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunnerWithResultBody({ outcome: 'complete' }),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    const entries = await trace(runDir);
    const copied = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'child-result.json'), 'utf8')),
    );
    const finalResult = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("lacks a non-empty string 'verdict' field");
    expect(copied.verdict).toBeUndefined();
    expect(finalResult.verdict).toBeUndefined();
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'sub_run.completed',
        step_id: 'child-step',
        verdict: '<no-verdict>',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'child-step',
        outcome: 'fail',
        reason: expect.stringContaining("lacks a non-empty string 'verdict' field"),
      }),
    );
  });

  it('copies child result evidence but rejects malformed child result bodies', async () => {
    const cases = [
      {
        name: 'invalid-json',
        resultBody: 'not-json{{{',
        expectedReason: /child result body did not parse as JSON/,
        runId: '50000000-0000-4000-8000-000000000006',
      },
      {
        name: 'array-json',
        resultBody: '["accept"]',
        expectedReason: /child result body parsed but is not a JSON object/,
        runId: '50000000-0000-4000-8000-000000000007',
      },
    ] as const;

    for (const testCase of cases) {
      const runDir = join(baseDir, `parent-${testCase.name}-result-run`);
      const result = await executeExecutableFlow(parentFlow(), {
        runDir,
        runId: testCase.runId,
        goal: 'parent goal',
        childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
        childRunner: stubChildRunnerWithRawResult(testCase.resultBody),
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      });

      const entries = await trace(runDir);
      const copied = await readFile(join(runDir, 'reports', 'child-result.json'), 'utf8');
      const finalResult = RunResult.parse(
        JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
      );
      expect(result.outcome, testCase.name).toBe('aborted');
      expect(result.reason, testCase.name).toMatch(testCase.expectedReason);
      expect(copied, testCase.name).toBe(testCase.resultBody);
      expect(finalResult.verdict, testCase.name).toBeUndefined();
      expect(entries, testCase.name).toContainEqual(
        expect.objectContaining({
          kind: 'sub_run.completed',
          step_id: 'child-step',
          verdict: '<no-verdict>',
        }),
      );
      expect(entries, testCase.name).toContainEqual(
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'child-step',
          outcome: 'fail',
          reason: expect.stringMatching(testCase.expectedReason),
        }),
      );
    }
  });

  it('propagates relay connector and config inputs into child run options', async () => {
    const runDir = join(baseDir, 'parent-child-relay-propagation');
    const relayConnector = createStubRelayConnector({ verdict: 'accept' });
    const layer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        host: { kind: 'generic-shell' },
        relay: {
          default: 'codex',
          roles: {},
          circuits: {},
          connectors: {},
        },
        circuits: {},
        defaults: {},
      },
    });
    let observed: CompiledFlowRunOptions | undefined;

    await executeExecutableFlow(parentFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'parent goal',
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: async (options) => {
        observed = options;
        return stubChildRunner('accept')(options);
      },
      relayConnector,
      selectionConfigLayers: [layer],
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(observed?.relayConnector).toBe(relayConnector);
    expect(observed?.selectionConfigLayers).toEqual([layer]);
  });
});

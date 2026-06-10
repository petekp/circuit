import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type {
  ChildCompiledFlowResolver,
  CompiledFlowRunOptions,
  CompiledFlowRunner,
} from '../../src/runtime/run/child-runner.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { RunResult } from '../../src/schemas/result.js';
import { runResultPath as resultPath } from '../../src/shared/result-path.js';

// Sub-run runtime test. Verifies that a parent flow declaring a
// `sub-run` step:
//   - Resolves the child flow through the injected resolver.
//   - Mints a fresh RunId for the child (RUN-I3 cross-run smuggling
//     stays forbidden — no shared run_id).
//   - Provisions a sibling child run-folder under the parent's runs base.
//   - Emits sub_run.{started,completed} on the parent's trace
//     carrying the child_run_id linkage and the observed verdict.
//   - Copies the child's result.json bytes into the parent's
//     `step.writes.result` slot for downstream consumers.
//   - Admits or rejects the child against `step.check.pass`.

const PARENT_WORKFLOW_ID = 'parent-test';
const CHILD_WORKFLOW_ID = 'child-test';

function buildParentCompiledFlow(parentCheckPass: readonly string[]): CompiledFlow {
  const raw = {
    schema_version: '2',
    id: PARENT_WORKFLOW_ID as unknown as string,
    version: '0.1.0',
    purpose: 'sub-run runtime test parent — exercises one sub-run step end-to-end',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'sub-run-step',
    stages: [
      {
        id: 'act-stage',
        title: 'Act',
        canonical: 'act',
        steps: ['sub-run-step'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'narrow sub-run runtime test — only act stage carries the sub-run step.',
    },
    steps: [
      {
        id: 'sub-run-step',
        title: 'Sub-run — invoke child flow',
        protocol: 'sub-run-protocol@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'sub-run',
        flow_ref: {
          flow_id: CHILD_WORKFLOW_ID as unknown as string,
          entry_mode: 'default',
        },
        goal: 'child run goal',
        depth: 'standard',
        writes: { result: 'reports/child-result.json' },
        check: {
          kind: 'result_verdict',
          source: { kind: 'sub_run_result', ref: 'result' },
          pass: parentCheckPass,
        },
      },
    ],
  };
  return CompiledFlow.parse(raw);
}

function buildChildCompiledFlow(): CompiledFlow {
  // The child has a single compose step. The child runner is stubbed
  // anyway (it never runs the child's loop), so the child flow
  // shape only has to type-check through CompiledFlow.parse — the stub
  // childRunner produces a synthetic result.json.
  const raw = {
    schema_version: '2',
    id: CHILD_WORKFLOW_ID as unknown as string,
    version: '0.1.0',
    purpose: 'sub-run runtime test child — single compose step.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'child-step',
    stages: [{ id: 'act-stage', title: 'Act', canonical: 'act', steps: ['child-step'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'narrow stub child for sub-run test.',
    },
    steps: [
      {
        id: 'child-step',
        title: 'Child compose',
        protocol: 'child-compose@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: { path: 'reports/child-compose.json', schema: 'child-compose@v1' },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
      },
    ],
  };
  return CompiledFlow.parse(raw);
}

function makeChildResolver(child: { bytes: Buffer }): ChildCompiledFlowResolver {
  return () => ({ flowBytes: child.bytes });
}

// Stub childRunner that bypasses real child execution. Writes a
// synthetic child result.json (with a verdict field) into the child's
// runDir/reports and returns a minimal GraphRunResult. This
// isolates the parent's sub-run handler logic from the child's full
// loop while still exercising the path-derivation, file-copy, and
// audit-trace_entry surface the handler is responsible for.
function makeStubChildRunner(observed: {
  verdict: string;
  outcome: 'complete' | 'aborted';
  capturedRunIds: { value: string | undefined };
}): CompiledFlowRunner {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    observed.capturedRunIds.value = options.runId;
    const childResultAbs = resultPath(options.runDir);
    mkdirSync(dirname(childResultAbs), { recursive: true });
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: CHILD_WORKFLOW_ID,
      goal: options.goal,
      outcome: observed.outcome,
      summary: 'stub child result',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'stub-manifest-hash',
      verdict: observed.verdict,
    });
    writeFileSync(childResultAbs, `${JSON.stringify(body, null, 2)}\n`);
    return {
      schema_version: body.schema_version,
      run_id: body.run_id,
      flow_id: body.flow_id,
      goal: body.goal,
      outcome: body.outcome,
      summary: body.summary,
      closed_at: body.closed_at,
      trace_entries_observed: body.trace_entries_observed,
      manifest_hash: body.manifest_hash,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...(body.verdict === undefined ? {} : { verdict: body.verdict }),
      resultPath: childResultAbs,
    };
  };
}

async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-sub-run-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('sub-run runtime', () => {
  it('runs the child, copies result.json into parent writes.result, and admits an in-check verdict', async () => {
    const parentCompiledFlow = buildParentCompiledFlow(['ok']);
    const parentBytes = Buffer.from(JSON.stringify(parentCompiledFlow));
    const childCompiledFlow = buildChildCompiledFlow();
    const childBytes = Buffer.from(JSON.stringify(childCompiledFlow));

    const observed = {
      verdict: 'ok',
      outcome: 'complete' as const,
      capturedRunIds: { value: undefined as string | undefined },
    };
    const stubChildRunner = makeStubChildRunner(observed);
    const childResolver = makeChildResolver({ bytes: childBytes });

    const parentRunId = '11111111-1111-1111-1111-111111111111';
    const parentRunFolder = join(runFolderBase, parentRunId);

    const outcome = await runCompiledFlow({
      runDir: parentRunFolder,
      flowBytes: parentBytes,
      runId: parentRunId,
      goal: 'parent run goal',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 27, 0, 0, 0)),
      childCompiledFlowResolver: childResolver,
      childRunner: stubChildRunner,
    });

    expect(outcome.outcome).toBe('complete');

    // RUN-I3: child has a fresh RunId distinct from parent.
    const childRunId = observed.capturedRunIds.value;
    expect(childRunId).toBeDefined();
    if (childRunId === undefined) throw new Error('expected child run id');
    expect(childRunId).not.toBe(parentRunId);

    // sub_run.started + sub_run.completed both fired with matching
    // child_run_id. (The parent's trace_entries log is the audit trail.)
    const traceEntries = await readTraceEntries(parentRunFolder);
    const subRunStarted = traceEntries.find((e) => e.kind === 'sub_run.started');
    const subRunCompleted = traceEntries.find((e) => e.kind === 'sub_run.completed');
    if (subRunStarted?.kind !== 'sub_run.started') throw new Error('expected sub_run.started');
    if (subRunCompleted?.kind !== 'sub_run.completed')
      throw new Error('expected sub_run.completed');
    expect(subRunStarted.child_run_id).toBe(childRunId);
    expect(subRunCompleted.child_run_id).toBe(childRunId);
    expect(subRunCompleted.verdict).toBe('ok');
    expect(subRunCompleted.child_outcome).toBe('complete');

    // Parent's check admitted the child verdict.
    const passCheck = traceEntries.find(
      (e) =>
        e.kind === 'check.evaluated' &&
        e.check_kind === 'result_verdict' &&
        e.step_id === ('sub-run-step' as unknown as typeof e.step_id),
    );
    if (passCheck?.kind !== 'check.evaluated') throw new Error('expected check.evaluated');
    expect(passCheck.outcome).toBe('pass');

    // Parent's writes.result slot received the child's result.json bytes.
    const parentResultPath = join(parentRunFolder, 'reports', 'child-result.json');
    const parentBody = JSON.parse(readFileSync(parentResultPath, 'utf8')) as { verdict: string };
    expect(parentBody.verdict).toBe('ok');

    // Child run-folder is a sibling of parent's run-folder under the same
    // runs-base directory, NOT nested under parent's run-folder.
    const expectedChildRunFolder = join(runFolderBase, childRunId);
    expect(observed.capturedRunIds.value).toBeDefined();
    const childResultJsonExists = readFileSync(
      join(expectedChildRunFolder, 'reports', 'result.json'),
      'utf8',
    );
    expect(childResultJsonExists).toContain('"verdict": "ok"');
  });

  it('rejects an out-of-check child verdict and aborts the parent step', async () => {
    const parentCompiledFlow = buildParentCompiledFlow(['ok']);
    const parentBytes = Buffer.from(JSON.stringify(parentCompiledFlow));
    const childCompiledFlow = buildChildCompiledFlow();
    const childBytes = Buffer.from(JSON.stringify(childCompiledFlow));

    const observed = {
      verdict: 'reject',
      outcome: 'complete' as const,
      capturedRunIds: { value: undefined as string | undefined },
    };
    const stubChildRunner = makeStubChildRunner(observed);
    const childResolver = makeChildResolver({ bytes: childBytes });

    const parentRunId = '11111111-1111-1111-1111-111111111112';
    const parentRunFolder = join(runFolderBase, parentRunId);

    const outcome = await runCompiledFlow({
      runDir: parentRunFolder,
      flowBytes: parentBytes,
      runId: parentRunId,
      goal: 'parent check-rejection test',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 27, 0, 30, 0)),
      childCompiledFlowResolver: childResolver,
      childRunner: stubChildRunner,
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain('reject');

    // sub_run.completed still fired with the observed verdict before
    // the check rejected — durable transcript of what the child said.
    const traceEntries = await readTraceEntries(parentRunFolder);
    const subRunCompleted = traceEntries.find((e) => e.kind === 'sub_run.completed');
    if (subRunCompleted?.kind !== 'sub_run.completed')
      throw new Error('expected sub_run.completed');
    expect(subRunCompleted.verdict).toBe('reject');

    const failCheck = traceEntries.find(
      (e) =>
        e.kind === 'check.evaluated' && e.check_kind === 'result_verdict' && e.outcome === 'fail',
    );
    expect(failCheck).toBeDefined();
  });

  it('aborts cleanly when the resolver is missing', async () => {
    const parentCompiledFlow = buildParentCompiledFlow(['ok']);
    const parentBytes = Buffer.from(JSON.stringify(parentCompiledFlow));

    const parentRunId = '11111111-1111-1111-1111-111111111113';
    const parentRunFolder = join(runFolderBase, parentRunId);

    const outcome = await runCompiledFlow({
      runDir: parentRunFolder,
      flowBytes: parentBytes,
      runId: parentRunId,
      goal: 'missing-resolver test',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 27, 1, 0, 0)),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain('childCompiledFlowResolver');
  });
});

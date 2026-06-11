import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';

// Adversarial-review fix #4: a handler that throws unexpectedly must not
// leave the run-folder half-bootstrapped. Runtime should close the run with
// step.aborted, run.closed, and reports/result.json for both handler lookup
// failures and mid-handler throws.

function oneStepFlow(step: ExecutableFlow['steps'][number]): ExecutableFlow {
  return {
    id: 'handler-throw-recovery',
    version: '0.1.0',
    entry: step.id,
    stages: [{ id: 'main', stepIds: [step.id] }],
    steps: [step],
    purpose: 'Exercise runtime close-on-handler-throw behavior.',
  };
}

async function runHandlerThrowCase(input: {
  readonly runFolder: string;
  readonly flow: ExecutableFlow;
  readonly runId: string;
  readonly executors?: Partial<ExecutorRegistry>;
}) {
  const result = await executeExecutableFlow(input.flow, {
    runDir: input.runFolder,
    runId: input.runId,
    goal: 'prove handler throws fall through to a graceful aborted run',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 3, 26, 12, 0, 0)),
    ...(input.executors === undefined ? {} : { executors: input.executors }),
  });
  const trace_entries = await new TraceStore(input.runFolder).load();
  return { result, trace_entries };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-handler-throw-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('handler-throw recovery — fix #4', () => {
  it('graceful-aborts when a step kind reaches the runner without a usable handler', async () => {
    const runFolder = join(runFolderBase, 'run-bogus');
    const flow = oneStepFlow({
      id: 'bogus-step',
      kind: 'bogus-kind',
      routes: { pass: { kind: 'terminal', target: '@complete' } },
    } as never);

    const outcome = await runHandlerThrowCase({
      runFolder,
      flow,
      runId: '11111111-2222-3333-4444-555555555555',
      executors: {
        'bogus-kind': async () => {
          throw new Error("no handler registered for step kind 'bogus-kind'");
        },
      } as never,
    });

    expect(outcome.result.outcome).toBe('aborted');
    expect(outcome.result.reason).toMatch(/handler threw/);
    expect(outcome.result.reason).toMatch(/bogus-kind/);

    expect(existsSync(join(runFolder, 'trace.ndjson'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);

    const result = RunResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toBe(outcome.result.reason);

    const lastTraceEntry = outcome.trace_entries[outcome.trace_entries.length - 1];
    expect(lastTraceEntry?.kind).toBe('run.closed');
    if (lastTraceEntry?.kind !== 'run.closed') throw new Error('expected run.closed last');
    expect(lastTraceEntry.outcome).toBe('aborted');

    const stepAborted = outcome.trace_entries.find(
      (trace_entry) => trace_entry.kind === 'step.aborted',
    );
    expect(stepAborted).toBeDefined();
    if (stepAborted?.kind !== 'step.aborted') throw new Error('expected step.aborted in log');
    expect(stepAborted.reason).toMatch(/bogus-kind/);

    expect(
      outcome.trace_entries.some(
        (trace_entry) =>
          trace_entry.kind === 'step.completed' && trace_entry.step_id === 'bogus-step',
      ),
    ).toBe(false);
  });

  it('graceful-aborts when a compose executor throws after step.entered', async () => {
    const runFolder = join(runFolderBase, 'run-mid-throw');
    const flow = oneStepFlow({
      id: 'compose-step',
      kind: 'compose',
      writer: 'throwing-writer',
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['summary'],
      },
      writes: { report: { path: 'reports/compose.json' } },
      routes: { pass: { kind: 'terminal', target: '@complete' } },
    });

    const outcome = await runHandlerThrowCase({
      runFolder,
      flow,
      runId: '11111111-2222-3333-4444-555555555556',
      executors: {
        compose: async () => {
          throw new Error('compose executor exploded after step.entered');
        },
      },
    });

    expect(outcome.result.outcome).toBe('aborted');
    expect(outcome.result.reason).toMatch(/handler threw/);
    expect(outcome.result.reason).toMatch(/compose executor exploded/);

    expect(existsSync(join(runFolder, 'trace.ndjson'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);

    const result = RunResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toBe(outcome.result.reason);
    expect(result.trace_entries_observed).toBe(outcome.trace_entries.length);

    const lastTraceEntry = outcome.trace_entries[outcome.trace_entries.length - 1];
    expect(lastTraceEntry?.kind).toBe('run.closed');
    if (lastTraceEntry?.kind !== 'run.closed') throw new Error('expected run.closed last');
    expect(lastTraceEntry.outcome).toBe('aborted');
  });
});

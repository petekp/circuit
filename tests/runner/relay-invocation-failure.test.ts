import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { RunResult } from '../../src/schemas/result.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function throwingRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async () => {
      throw new Error('auth token missing');
    },
  };
}

async function runFailureCase(input: {
  readonly runFolder: string;
  readonly bytes: Buffer;
}) {
  const result = await runCompiledFlow({
    runDir: input.runFolder,
    flowBytes: input.bytes,
    runId: '71000000-0000-0000-0000-000000000001',
    goal: 'connector failure must close durably',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 3, 24, 18, 0, 0)),
    relayer: throwingRelayer(),
    executors: {
      compose: async (step, context) => {
        if (step.kind !== 'compose') throw new Error('expected compose step');
        const report = step.writes?.report;
        if (report !== undefined) {
          const reportPath = context.files.resolve(report);
          mkdirSync(dirname(reportPath), { recursive: true });
          writeFileSync(reportPath, '{"summary":"runtime-proof relay setup"}\n', 'utf8');
        }
        return { route: 'pass', details: { report: report?.path } };
      },
    },
  });
  const trace_entries = await new TraceStore(input.runFolder).load();
  return { result, trace_entries };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-relay-failure-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('runtime-safety-floor connector invocation failure closure', () => {
  it('closes a throwing relayer as an aborted run with durable invocation provenance', async () => {
    const { flow, bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'throwing-relayer');

    const outcome = await runFailureCase({
      runFolder,
      bytes,
    });

    expect(outcome.result.outcome).toBe('aborted');
    expect(outcome.result.reason).toMatch(/connector invocation failed/i);
    expect(outcome.result.reason).toMatch(/auth token missing/);

    const started = outcome.trace_entries.find((e) => e.kind === 'relay.started');
    if (started?.kind !== 'relay.started') throw new Error('expected relay.started');
    expect(started.step_id).toBe('relay-step');
    expect(started.connector).toEqual({ kind: 'builtin', name: 'claude-code' });
    expect(started.role).toBe('implementer');
    expect(started.resolved_from).toEqual({ source: 'explicit' });
    expect(started.resolved_selection).toEqual({ skills: [], invocation_options: {} });

    const relayStepKinds = outcome.trace_entries
      .filter((trace_entry) => 'step_id' in trace_entry && trace_entry.step_id === 'relay-step')
      .map((trace_entry) => trace_entry.kind);
    expect(relayStepKinds).toEqual([
      'step.entered',
      'relay.started',
      'relay.request',
      'relay.failed',
      'step.aborted',
    ]);

    const request = outcome.trace_entries.find((e) => e.kind === 'relay.request');
    if (request?.kind !== 'relay.request') throw new Error('expected relay.request');
    expect(request.step_id).toBe('relay-step');
    expect(request.request_payload_hash).toMatch(/^[0-9a-f]{64}$/);

    const failed = outcome.trace_entries.find((e) => e.kind === 'relay.failed');
    if (failed?.kind !== 'relay.failed') throw new Error('expected relay.failed');
    expect(failed.step_id).toBe('relay-step');
    expect(failed.request_payload_hash).toBe(request.request_payload_hash);
    expect(failed.reason).toMatch(/connector invocation failed/i);
    expect(failed.reason).toMatch(/auth token missing/);

    const aborted = outcome.trace_entries.find((e) => e.kind === 'step.aborted');
    if (aborted?.kind !== 'step.aborted') throw new Error('expected step.aborted');
    expect(aborted.step_id).toBe('relay-step');

    const closed = outcome.trace_entries.find((e) => e.kind === 'run.closed');
    if (closed?.kind !== 'run.closed') throw new Error('expected run.closed');
    expect(closed.outcome).toBe('aborted');

    expect(aborted.reason).toBe(failed.reason);
    expect(closed.reason).toMatch(/step 'relay-step' handler threw:/);
    expect(closed.reason).toContain(failed.reason);
    expect(outcome.result.reason).toBe(closed.reason);

    expect(
      outcome.trace_entries.find((e) => e.kind === 'step.completed' && e.step_id === 'relay-step'),
    ).toBeUndefined();
    expect(outcome.trace_entries.find((e) => e.kind === 'check.evaluated')).toBeUndefined();
    expect(outcome.trace_entries.find((e) => e.kind === 'relay.completed')).toBeUndefined();
    expect(outcome.trace_entries.find((e) => e.kind === 'relay.receipt')).toBeUndefined();
    expect(outcome.trace_entries.find((e) => e.kind === 'relay.result')).toBeUndefined();

    expect(existsSync(join(runFolder, 'reports', 'relay.request.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports', 'relay.receipt.json'))).toBe(false);
    expect(existsSync(join(runFolder, 'reports', 'relay.result.json'))).toBe(false);

    const result = RunResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.outcome).toBe('aborted');
    expect(result.reason).toBe(closed.reason);

    expect(flow.id).toBe('runtime-proof');
  });
});

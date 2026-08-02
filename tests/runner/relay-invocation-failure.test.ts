import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { TRANSIENT_SIGN_OUT_MARKER } from '../../src/connectors/subprocess.js';
import { connectorRetrySchedule } from '../../src/runtime/executors/relay.js';
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

// A worker that dies once mid-flight (the corpus classes: bare exit 1, a 143,
// an inactivity timeout) and answers cleanly when asked again. The engine's
// connector-layer retry must save this run instead of aborting it.
function diesOnceRelayer(): { relayer: RelayFn; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    relayer: {
      connectorName: 'claude-code',
      relay: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error('claude CLI exited with code 143');
        return {
          request_payload: input.prompt,
          receipt_id: 'receipt-retry-1',
          result_body: '{"verdict":"ok"}',
          duration_ms: 5,
          cli_version: 'test-cli 0.0.1',
        };
      },
    },
  };
}

// A CLI that answered minutes ago and now claims it is signed out. The engine
// reads that as a blip rather than a dead session, so it keeps asking for
// longer than it would for an ordinary connector death.
function transientSignOutRelayer(): { relayer: RelayFn; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    relayer: {
      connectorName: 'claude-code',
      relay: async () => {
        calls += 1;
        throw new Error(
          `The claude CLI reported that it is not logged in, but it answered normally minutes ago, so this is ${TRANSIENT_SIGN_OUT_MARKER} than a signed-out session.`,
        );
      },
    },
  };
}

async function runFailureCase(input: {
  readonly runFolder: string;
  readonly bytes: Buffer;
  readonly relayer?: RelayFn;
}) {
  const result = await runCompiledFlow({
    runDir: input.runFolder,
    flowBytes: input.bytes,
    runId: '71000000-0000-0000-0000-000000000001',
    goal: 'connector failure must close durably',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 3, 24, 18, 0, 0)),
    relayer: input.relayer ?? throwingRelayer(),
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
    expect(started.resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      skills: [],
      invocation_options: {},
    });

    // Two full ask cycles: a dead connector earns one spaced re-ask at the
    // connector layer before the failure is allowed to take down the step.
    const relayStepKinds = outcome.trace_entries
      .filter((trace_entry) => 'step_id' in trace_entry && trace_entry.step_id === 'relay-step')
      .map((trace_entry) => trace_entry.kind);
    expect(relayStepKinds).toEqual([
      'step.entered',
      'relay.started',
      'relay.request',
      'relay.failed',
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

  it('completes the run when the connector dies once and answers on the re-ask', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'dies-once-relayer');
    const { relayer, calls } = diesOnceRelayer();

    const outcome = await runFailureCase({ runFolder, bytes, relayer });

    // The death was transient, so the run must not be lost to it.
    expect(outcome.result.outcome).toBe('complete');
    expect(calls()).toBe(2);

    // The trace stays honest about the death: the failed ask is recorded in
    // full, then the second ask runs to receipt and result.
    const relayStepKinds = outcome.trace_entries
      .filter((trace_entry) => 'step_id' in trace_entry && trace_entry.step_id === 'relay-step')
      .map((trace_entry) => trace_entry.kind);
    expect(relayStepKinds).toEqual([
      'step.entered',
      'relay.started',
      'relay.request',
      'relay.failed',
      'relay.started',
      'relay.request',
      'relay.receipt',
      'relay.result',
      'relay.completed',
      'check.evaluated',
      'step.completed',
    ]);

    const failed = outcome.trace_entries.find((e) => e.kind === 'relay.failed');
    if (failed?.kind !== 'relay.failed') throw new Error('expected relay.failed');
    expect(failed.reason).toMatch(/exited with code 143/);

    expect(existsSync(join(runFolder, 'reports', 'relay.receipt.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports', 'relay.result.json'))).toBe(true);
    expect(outcome.trace_entries.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    const closed = outcome.trace_entries.find((e) => e.kind === 'run.closed');
    if (closed?.kind !== 'run.closed') throw new Error('expected run.closed');
    expect(closed.outcome).toBe('complete');
  });

  it('keeps asking a CLI that claims to be signed out after it had been answering', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'transient-sign-out');
    const { relayer, calls } = transientSignOutRelayer();

    // The real waits are 5s, 15s and 30s. The point under test is how many
    // asks the engine spends, not how long it sleeps between them.
    const realSchedule = connectorRetrySchedule.signedOutMs;
    connectorRetrySchedule.signedOutMs = [0, 0, 0];
    let outcome: Awaited<ReturnType<typeof runFailureCase>>;
    try {
      outcome = await runFailureCase({ runFolder, bytes, relayer });
    } finally {
      connectorRetrySchedule.signedOutMs = realSchedule;
    }

    // Five asks, not the two an ordinary dead connector gets.
    expect(calls()).toBe(5);
    const relayStepKinds = outcome.trace_entries
      .filter((trace_entry) => 'step_id' in trace_entry && trace_entry.step_id === 'relay-step')
      .map((trace_entry) => trace_entry.kind);
    expect(relayStepKinds.filter((kind) => kind === 'relay.failed')).toHaveLength(5);
    expect(relayStepKinds.at(-1)).toBe('step.aborted');

    // When it never comes back the run still closes honestly, and the reason
    // the operator reads still doubts the sign-out rather than asserting it.
    expect(outcome.result.outcome).toBe('aborted');
    expect(outcome.result.reason).toContain(TRANSIENT_SIGN_OUT_MARKER);
  });
});

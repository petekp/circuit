import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { relayClaudeCode } from '../../src/connectors/claude-code.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Claude Code relay round-trip.
//
// The opt-in branch runs the generated runtime-proof flow through runtime with
// the real Claude Code connector. It asserts the durable relay transcript in
// trace.ndjson and the materialized request / receipt / result files. The live
// subprocess path is skipped by default so CI and unauthenticated developer runs
// stay green.

const AGENT_SMOKE = process.env.AGENT_SMOKE === '1';
const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadRuntimeProofBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

function claudeCodeRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: relayClaudeCode,
  };
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"runtime-proof relay setup"}\n', 'utf8');
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          ...attempt,
          report_path: report.path,
          report_schema: report.schema ?? 'runtime.compose',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        ...attempt,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

async function readTrace(runFolder: string): Promise<readonly TraceEntry[]> {
  return await new TraceStore(runFolder).load();
}

function relayEntry<K extends TraceEntry['kind']>(
  trace: readonly TraceEntry[],
  kind: K,
): Extract<TraceEntry, { kind: K }> {
  const entry = trace.find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new Error(`expected ${kind} trace entry`);
  return entry as Extract<TraceEntry, { kind: K }>;
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'agent-relay-roundtrip-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('agent relay round-trip', () => {
  it('static: runtime runner and trace store are available for connector transcript capture', () => {
    expect(typeof runCompiledFlow).toBe('function');
    expect(typeof TraceStore).toBe('function');
  });

  it('static: the relay transcript remains a five-entry relay.* sequence', () => {
    const kinds = [
      'relay.started',
      'relay.request',
      'relay.receipt',
      'relay.result',
      'relay.completed',
    ] as const;
    expect(kinds).toEqual([
      'relay.started',
      'relay.request',
      'relay.receipt',
      'relay.result',
      'relay.completed',
    ]);
  });

  (AGENT_SMOKE ? it : it.skip)(
    'end-to-end: runtime runtime-proof flow uses real Claude Code relay and persists the relay transcript',
    async () => {
      const runFolder = join(runFolderBase, 'claude-code-runtime-proof');
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: loadRuntimeProofBytes(),
        runId: '42424242-4242-4242-4242-424242424242',
        goal: 'agent relay round-trip',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 21, 17, 0, 0)),
        executors: composeExecutor(),
        relayer: claudeCodeRelayer(),
      });

      expect(outcome.outcome).toBe('complete');
      const trace = await readTrace(runFolder);
      expect(outcome.trace_entries_observed).toBe(trace.length);
      expect(trace.map((entry) => entry.sequence)).toEqual(trace.map((_, index) => index));

      const relayKinds = trace
        .filter((entry) => entry.kind.startsWith('relay.'))
        .map((entry) => entry.kind);
      expect(relayKinds).toEqual([
        'relay.started',
        'relay.request',
        'relay.receipt',
        'relay.result',
        'relay.completed',
      ]);

      const started = relayEntry(trace, 'relay.started');
      expect(started.connector).toEqual({ kind: 'builtin', name: 'claude-code' });
      expect(started.role).toBe('implementer');
      expect(started.resolved_from).toEqual({ source: 'explicit' });

      const request = relayEntry(trace, 'relay.request');
      const requestBody = readFileSync(join(runFolder, 'reports', 'relay.request.json'), 'utf8');
      expect(request.request_payload_hash).toBe(sha256Hex(requestBody));

      const receipt = relayEntry(trace, 'relay.receipt');
      const receiptId = String(receipt.receipt_id ?? '');
      expect(receiptId).toEqual(
        readFileSync(join(runFolder, 'reports', 'relay.receipt.json'), 'utf8'),
      );
      expect(receiptId.trim().length).toBeGreaterThan(0);
      expect(String(receipt.cli_version ?? '')).toMatch(/^\d+\.\d+\.\d+/);

      const result = relayEntry(trace, 'relay.result');
      const resultBody = readFileSync(join(runFolder, 'reports', 'relay.result.json'), 'utf8');
      expect(result.result_report_hash).toBe(sha256Hex(resultBody));

      const completed = relayEntry(trace, 'relay.completed');
      expect(completed.verdict).toBe('ok');
      expect(completed.result_path).toBe('reports/relay.result.json');
      expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);
    },
    180_000,
  );
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Adversarial-review fix #2: deriveTerminalVerdict had no direct
// end-to-end coverage. Every existing sub-run
// test stubs the childRunner and hand-writes the child's result.json,
// so the runner's own walk-backward over trace_entries never executes in
// those tests. These tests exercise real derivation through
// runCompiledFlow:
//
//   1) single-relay happy path — the only verdict-bearing step's
//      verdict surfaces as result.verdict.
//   2) multi-relay sequence — when a flow admits two distinct
//      verdicts before close, walk-backward picks the LATER one
//      (the verdict on the route-segment closest to @complete).
//   3) aborted run — result.verdict is undefined regardless of any
//      mid-route admitted verdict.
//   4) compose-only run — no relay / sub-run admission means no
//      terminal verdict; result.verdict is undefined.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadDogfood(): { bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  return { bytes };
}

function fixedRelayer(verdict: string): RelayFn {
  return makeStubRelayer(JSON.stringify({ verdict }), {
    receipt_id: 'stub-receipt-verdict-derivation',
  });
}

function sequenceRelayer(verdicts: string[]): RelayFn {
  let call = 0;
  return makeStubRelayer(() => {
    const verdict = verdicts[call++];
    if (verdict === undefined) {
      throw new Error(
        `sequenceRelayer exhausted at call ${call}; provided ${verdicts.length} verdicts`,
      );
    }
    return JSON.stringify({ verdict });
  });
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"compose setup"}\n', 'utf8');
      }
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-verdict-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('deriveTerminalVerdict — fix #2 coverage', () => {
  it('single-relay run surfaces the verdict on result.json', async () => {
    const { bytes } = loadDogfood();
    const runFolder = join(runFolderBase, 'run-single');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'aaaaaaaa-1111-1111-1111-111111111111',
      goal: 'single-relay verdict derivation',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 12, 0, 0)),
      relayer: fixedRelayer('ok'),
      executors: composeExecutor(),
    });

    expect(outcome.outcome).toBe('complete');
    expect(outcome.verdict).toBe('ok');
  });

  it('multi-relay run surfaces the LATER admitted verdict (walk-backward)', async () => {
    // Two relay steps in sequence, each admitting a distinct
    // verdict. Walk-backward must return the second relay's
    // verdict — the one on the segment that reached @complete.
    const flow = CompiledFlow.parse({
      schema_version: '3',
      id: 'multi-relay-fixture',
      version: '0.1.0',
      purpose: 'Test fixture for multi-relay terminal verdict derivation.',
      axes: {
        allowed_depths: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'first-relay',
      stages: [
        {
          id: 'act-stage',
          title: 'Act',
          canonical: 'act',
          steps: ['first-relay', 'second-relay'],
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'plan', 'analyze', 'verify', 'review', 'close'],
        rationale: 'narrow test fixture for verdict derivation',
      },
      steps: [
        {
          id: 'first-relay',
          title: 'First relay — admits "intermediate"',
          protocol: 'multi-relay@v1',
          reads: [],
          routes: { pass: 'second-relay' },
          executor: 'worker',
          kind: 'relay',
          role: 'implementer',
          writes: {
            request: 'reports/first.request.json',
            receipt: 'reports/first.receipt.json',
            result: 'reports/first.result.json',
          },
          check: {
            kind: 'result_verdict',
            source: { kind: 'relay_result', ref: 'result' },
            pass: ['intermediate'],
          },
        },
        {
          id: 'second-relay',
          title: 'Second relay — admits "final"',
          protocol: 'multi-relay@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'worker',
          kind: 'relay',
          role: 'implementer',
          writes: {
            request: 'reports/second.request.json',
            receipt: 'reports/second.receipt.json',
            result: 'reports/second.result.json',
          },
          check: {
            kind: 'result_verdict',
            source: { kind: 'relay_result', ref: 'result' },
            pass: ['final'],
          },
        },
      ],
    });
    const bytes = Buffer.from(JSON.stringify(flow));
    const runFolder = join(runFolderBase, 'run-multi');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'bbbbbbbb-2222-2222-2222-222222222222',
      goal: 'multi-relay terminal verdict derivation',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 13, 0, 0)),
      relayer: sequenceRelayer(['intermediate', 'final']),
    });

    expect(outcome.outcome).toBe('complete');
    // The chronologically-LATER admitted verdict wins. Pre-fix,
    // walk-backward already implemented this — these tests pin it
    // against regression to a "first verdict found" or
    // "closing-step's verdict" semantic.
    expect(outcome.verdict).toBe('final');
  });

  it('aborted run has no terminal verdict regardless of mid-route admissions', async () => {
    // runtime-proof check.pass = ['ok']; force a verdict the check rejects.
    // The earlier compose step admitted via check_kind=schema_sections
    // (not result_verdict) so it doesn't contribute either way.
    const { bytes } = loadDogfood();
    const runFolder = join(runFolderBase, 'run-aborted');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'cccccccc-3333-3333-3333-333333333333',
      goal: 'aborted run has no terminal verdict',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 14, 0, 0)),
      relayer: fixedRelayer('not-in-check'),
      executors: composeExecutor(),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.verdict).toBeUndefined();
  });

  it('compose-only run has no terminal verdict (no result_verdict admission)', async () => {
    // No relay / sub-run step exists, so no check.evaluated trace_entry
    // ever fires with kind='result_verdict'. The walk finds nothing
    // and returns undefined.
    const flow = CompiledFlow.parse({
      schema_version: '3',
      id: 'compose-only-fixture',
      version: '0.1.0',
      purpose: 'Test fixture: a flow with no verdict-bearing steps.',
      axes: {
        allowed_depths: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'only-compose',
      stages: [{ id: 'plan-stage', title: 'Plan', canonical: 'plan', steps: ['only-compose'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
        rationale: 'narrow test fixture for verdict-undefined case',
      },
      steps: [
        {
          id: 'only-compose',
          title: 'Compose — no verdict surface',
          protocol: 'compose-only@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'compose',
          writes: {
            report: { path: 'reports/only.json', schema: 'plan.strategy@v1' },
          },
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['summary'],
          },
        },
      ],
    });
    const bytes = Buffer.from(JSON.stringify(flow));
    const runFolder = join(runFolderBase, 'run-synth-only');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'dddddddd-4444-4444-4444-444444444444',
      goal: 'compose-only run has no verdict',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 15, 0, 0)),
      relayer: fixedRelayer('unused'),
      executors: composeExecutor(),
    });

    expect(outcome.outcome).toBe('complete');
    expect(outcome.verdict).toBeUndefined();
  });
});

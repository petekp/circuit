import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Connector-identity plumbing through `runCompiledFlow`. `RelayFn` is a
// structured descriptor
// `{ connectorName: EnabledConnector; relay: (input) => Promise<RelayResult> }`
// and the materializer call site is parameterized on
// `relayer.connectorName`. This test injects a codex-shaped descriptor
// (no real codex subprocess; stub `relay` function returning a
// deterministic `RelayResult`) and asserts the trace_entry-log records
// `connector.name='codex'` — proving the descriptor-to-trace_entry plumbing
// carries connector identity end-to-end through `runCompiledFlow`.
//
// The companion second-connector round-trip at
// `tests/runner/codex-relay-roundtrip.test.ts` exercises the real
// `relayCodex → materializeRelay` path directly (CODEX_SMOKE=1).
// This test exercises the `runCompiledFlow` seam on top of that — the
// regression the round-trip alone cannot catch, since the round-trip
// calls `materializeRelay` directly and bypasses `runCompiledFlow`.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadFixture(): { bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: {
    steps: Array<{
      id: string;
      kind: string;
      role?: string;
    }>;
  } = JSON.parse(bytes.toString('utf8'));
  const relayStep = raw.steps.find((step) => step.id === 'relay-step' && step.kind === 'relay');
  if (relayStep === undefined) throw new Error('runtime-proof relay step not found');
  // This test is only about descriptor identity, so use a reviewer role and
  // avoid implementer write behavior.
  relayStep.role = 'reviewer';
  return { bytes: Buffer.from(JSON.stringify(raw)) };
}

function codexShapedStub(): RelayFn {
  return makeStubRelayer('{"verdict":"ok"}', {
    connectorName: 'codex',
    receipt_id: 'stub-codex-thread-id',
  });
}

async function runConnectorIdentityCase(input: {
  readonly runFolder: string;
  readonly bytes: Buffer;
}) {
  const result = await runCompiledFlow({
    runDir: input.runFolder,
    flowBytes: input.bytes,
    runId: '45a45a45-a45a-45a4-5a45-a45a45a45a45',
    goal: 'connector-identity regression',
    depth: 'medium',
    now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
    relayer: codexShapedStub(),
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
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-connector-identity-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('RelayFn descriptor carries connector identity into relay.started', () => {
  it('injecting a codex-shaped descriptor through CompiledFlowInvocation.relayer lands connector.name="codex"', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'codex-identity');
    const outcome = await runConnectorIdentityCase({
      runFolder,
      bytes,
    });

    expect(outcome.result.outcome).toBe('complete');
    expect(outcome.result.flow_id).toBe('runtime-proof');

    const relayStarted = outcome.trace_entries.find((e) => e.kind === 'relay.started');
    if (!relayStarted || relayStarted.kind !== 'relay.started') {
      throw new Error('expected relay.started trace_entry');
    }
    // The critical regression: identity comes from the descriptor, not
    // a call-site literal. A regression here would land `name: 'claude-code'`
    // and fail this test.
    expect(relayStarted.connector).toEqual({ kind: 'builtin', name: 'codex' });
  });
});

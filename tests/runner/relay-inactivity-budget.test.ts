import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

// Executor-seam proof for budgets.inactivity_ms: a relay step's declared
// inactivity ceiling must reach the relayer as idleTimeoutMs — the exact
// sibling of the budgets.wall_clock_ms → timeoutMs path. Regression context is
// Build run 37a27314, where the connector's fixed inactivity default killed a
// healthy relay sitting in a legitimately silent long tool call; the per-step
// budget is the declared escape hatch, so the threading itself is pinned here
// through the injected-relayer path (what the eval harness and in-process
// tests run).

function relayStepCompiledFlow(budgets?: Record<string, number>): { bytes: Buffer } {
  const raw = {
    schema_version: '3',
    id: 'relay-inactivity-budget-flow',
    version: '0.1.0',
    purpose: 'Runtime regression fixture for per-step inactivity budget threading.',
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'relay-step',
    stages: [
      {
        id: 'act-stage',
        title: 'Act',
        canonical: 'act',
        steps: ['relay-step'],
      },
    ],
    steps: [
      {
        id: 'relay-step',
        title: 'Budgeted relay',
        protocol: 'relay-inactivity-budget@v1',
        reads: [],
        routes: { pass: '@complete' },
        ...(budgets === undefined ? {} : { budgets }),
        executor: 'worker',
        kind: 'relay',
        role: 'implementer',
        writes: {
          request: 'reports/relay/request.txt',
          receipt: 'reports/relay/receipt.txt',
          result: 'reports/relay/result.json',
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: ['ok'],
        },
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'One-step relay fixture keeps the budget-threading seam focused.',
    },
  };
  const flow = CompiledFlow.parse(raw);
  return { bytes: Buffer.from(JSON.stringify(flow)) };
}

function capturingRelayer(captured: RelayInput[]): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      captured.push(input);
      return {
        request_payload: input.prompt,
        receipt_id: 'inactivity-budget-receipt',
        result_body: '{"verdict":"ok"}',
        duration_ms: 1,
        cli_version: '0.0.0-test',
      };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-relay-inactivity-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('budgets.inactivity_ms threading to the relayer', () => {
  it('delivers a declared inactivity budget as idleTimeoutMs', async () => {
    const { bytes } = relayStepCompiledFlow({ max_attempts: 1, inactivity_ms: 900_000 });
    const captured: RelayInput[] = [];
    const outcome = await runCompiledFlow({
      runDir: join(runFolderBase, 'with-budget'),
      flowBytes: bytes,
      runId: '75000000-0000-0000-0000-000000000001',
      goal: 'inactivity budget reaches the relayer',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 12, 20, 0, 0)),
      relayer: capturingRelayer(captured),
    });

    expect(outcome.outcome).toBe('complete');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.idleTimeoutMs).toBe(900_000);
  });

  it('delivers no idleTimeoutMs when the step declares no inactivity budget', async () => {
    const { bytes } = relayStepCompiledFlow();
    const captured: RelayInput[] = [];
    const outcome = await runCompiledFlow({
      runDir: join(runFolderBase, 'without-budget'),
      flowBytes: bytes,
      runId: '75000000-0000-0000-0000-000000000002',
      goal: 'absent inactivity budget stays absent',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 12, 20, 30, 0)),
      relayer: capturingRelayer(captured),
    });

    expect(outcome.outcome).toBe('complete');
    expect(captured).toHaveLength(1);
    // Absent means absent: the relay input carries no idleTimeoutMs key at
    // all, so the connector default decides the bound.
    expect(Object.hasOwn(captured[0] ?? {}, 'idleTimeoutMs')).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCompiledFlowWithWaiting } from '../../src/runtime/run/compiled-flow-runner.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import { RunTrace } from '../../src/schemas/run.js';
import { TraceEntry } from '../../src/schemas/trace-entry.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const REVIEW_RELAY_BODY = JSON.stringify({
  // Review fans out one reviewer per unit; a single-unit target has unit-1.
  unit_id: 'unit-1',
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function relayerWithBody(body: string): RelayFn {
  return makeStubRelayer(body, { receipt_id: 'stub-receipt-runtime-trace-contract' });
}

function readTrace(runFolder: string): unknown[] {
  return readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = join(tmpdir(), `circuit-runtime-trace-contract-${randomUUID()}`);
  mkdirSync(runFolderBase, { recursive: true });
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('runtime trace contract', () => {
  it('emits real runtime trace entries that satisfy the public RunTrace schema', async () => {
    const runFolder = join(runFolderBase, 'review');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: readFileSync(join(process.cwd(), 'generated/flows/review/circuit.json')),
      runDir: runFolder,
      runId: '85000000-0000-4000-8000-000000000101',
      goal: 'review this supplied text: The trace must record real entries that satisfy the public schema.',
      now: deterministicNow(Date.UTC(2026, 4, 7, 12, 0, 0)),
      relayer: relayerWithBody(REVIEW_RELAY_BODY),
    });

    expect(result.outcome).toBe('complete');

    const trace = readTrace(runFolder);
    const kinds = trace.map((entry) => (entry as { kind?: string }).kind);
    expect(kinds.slice(0, 3)).toEqual(['run.bootstrapped', 'guidance.decision', 'step.entered']);
    const flowGuidance = trace[1] as {
      kind: string;
      subject?: string;
      selected?: { flow_id?: string; work_contract_ref?: { kind?: string; ref?: string } };
    };
    expect(flowGuidance).toMatchObject({
      kind: 'guidance.decision',
      subject: 'flow_selection',
      selected: {
        flow_id: 'review',
        work_contract_ref: {
          kind: 'work_contract',
        },
      },
    });
    expect(flowGuidance.selected?.work_contract_ref?.ref).toMatch(
      /^runtime\/work-contract\/review\/[0-9a-f]{64}\.json$/,
    );

    const relayGuidanceIndex = trace.findIndex(
      (entry) =>
        (entry as { kind?: string; subject?: string }).kind === 'guidance.decision' &&
        (entry as { subject?: string }).subject === 'relay_execution',
    );
    const relayStartedIndex = kinds.indexOf('relay.started');
    const relayRequestIndex = kinds.indexOf('relay.request');
    expect(relayGuidanceIndex).toBeGreaterThan(0);
    expect(relayStartedIndex).toBeGreaterThan(relayGuidanceIndex);
    expect(relayRequestIndex).toBeGreaterThan(relayStartedIndex);

    const relayGuidance = trace[relayGuidanceIndex] as {
      selected?: {
        connector?: unknown;
        role?: string;
        request_payload_hash?: string;
      };
    };
    const relayStarted = trace[relayStartedIndex] as { connector?: unknown; role?: string };
    const relayRequest = trace[relayRequestIndex] as { request_payload_hash?: string };
    expect(relayGuidance.selected?.connector).toEqual(relayStarted.connector);
    expect(relayGuidance.selected?.role).toBe(relayStarted.role);
    expect(relayGuidance.selected?.request_payload_hash).toBe(relayRequest.request_payload_hash);

    for (const [index, entry] of trace.entries()) {
      const parsed = TraceEntry.safeParse(entry);
      expect(
        parsed.success,
        `trace entry ${index} should parse: ${
          parsed.success ? '' : JSON.stringify(parsed.error.issues)
        }`,
      ).toBe(true);
    }

    const parsedTrace = RunTrace.safeParse(trace);
    expect(
      parsedTrace.success,
      parsedTrace.success ? '' : JSON.stringify(parsedTrace.error.issues),
    ).toBe(true);
  });

  it('forwards connector-reported usage onto relay.completed', async () => {
    const runFolder = join(runFolderBase, 'review-with-usage');
    const usage = {
      input_tokens: 451,
      output_tokens: 52,
      cache_read_tokens: 17696,
      cache_creation_tokens: 6024,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 6024,
      total_cost_usd_reported: 0.0145286,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 451,
          output_tokens: 52,
          cache_read_tokens: 17696,
          cache_creation_tokens: 6024,
          cost_usd_reported: 0.0145286,
        },
      ],
    };
    const result = await runCompiledFlowWithWaiting({
      flowBytes: readFileSync(join(process.cwd(), 'generated/flows/review/circuit.json')),
      runDir: runFolder,
      runId: '85000000-0000-4000-8000-000000000104',
      goal: 'review this supplied text: The trace must retain the usage reported by the connector.',
      now: deterministicNow(Date.UTC(2026, 4, 7, 12, 30, 0)),
      relayer: makeStubRelayer(REVIEW_RELAY_BODY, {
        receipt_id: 'stub-receipt-runtime-trace-contract',
        usage,
      }),
    });

    expect(result.outcome).toBe('complete');

    const trace = readTrace(runFolder);
    const completed = trace.filter(
      (entry) => (entry as { kind?: string }).kind === 'relay.completed',
    ) as Array<{ usage?: unknown }>;
    expect(completed.length).toBeGreaterThan(0);
    for (const entry of completed) {
      expect(entry.usage).toEqual(usage);
    }
    // The usage-bearing trace still satisfies the public schema end to end.
    const parsedTrace = RunTrace.safeParse(trace);
    expect(
      parsedTrace.success,
      parsedTrace.success ? '' : JSON.stringify(parsedTrace.error.issues),
    ).toBe(true);
  });

  it('uses the generated WorkContract path when the compiled flow path is known', async () => {
    const runFolder = join(runFolderBase, 'review-with-path');
    const compiledFlowPath = join(process.cwd(), 'generated/flows/review/circuit.json');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: readFileSync(compiledFlowPath),
      compiledFlowPath,
      runDir: runFolder,
      runId: '85000000-0000-4000-8000-000000000102',
      goal: 'review this supplied text: The trace must use the generated work contract source path.',
      now: deterministicNow(Date.UTC(2026, 4, 7, 12, 10, 0)),
      relayer: relayerWithBody(REVIEW_RELAY_BODY),
    });

    expect(result.outcome).toBe('complete');

    const trace = readTrace(runFolder);
    const parsedTrace = RunTrace.safeParse(trace);
    expect(
      parsedTrace.success,
      parsedTrace.success ? '' : JSON.stringify(parsedTrace.error.issues),
    ).toBe(true);
    expect(trace[1]).toMatchObject({
      kind: 'guidance.decision',
      subject: 'flow_selection',
      selected: {
        flow_id: 'review',
        work_contract_ref: {
          kind: 'work_contract',
          ref: compiledFlowPath.replace(/\.json$/, '.work-contract.v0.json'),
        },
      },
    });
  });

  it('records config-layer policy refs on relay guidance decisions', async () => {
    const runFolder = join(runFolderBase, 'review-with-policy-ref');
    const projectPolicyPath = join(runFolderBase, '.circuit/config.yaml');
    const result = await runCompiledFlowWithWaiting({
      flowBytes: readFileSync(join(process.cwd(), 'generated/flows/review/circuit.json')),
      runDir: runFolder,
      runId: '85000000-0000-4000-8000-000000000103',
      goal: 'review this supplied text: The trace must retain the policy source for relay guidance.',
      now: deterministicNow(Date.UTC(2026, 4, 7, 12, 20, 0)),
      relayer: relayerWithBody(REVIEW_RELAY_BODY),
      selectionConfigLayers: [
        LayeredConfig.parse({
          layer: 'project',
          source_path: projectPolicyPath,
          config: {
            schema_version: 1,
            defaults: {
              selection: {
                effort: 'medium',
              },
            },
          },
        }),
      ],
    });

    expect(result.outcome).toBe('complete');

    const trace = readTrace(runFolder);
    const parsedTrace = RunTrace.safeParse(trace);
    expect(
      parsedTrace.success,
      parsedTrace.success ? '' : JSON.stringify(parsedTrace.error.issues),
    ).toBe(true);

    const relayGuidance = trace.find(
      (entry) =>
        (entry as { kind?: string; subject?: string }).kind === 'guidance.decision' &&
        (entry as { subject?: string }).subject === 'relay_execution',
    ) as { policy_refs?: Array<{ ref?: string; sha256?: string }> } | undefined;
    expect(relayGuidance?.policy_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: 'policy.runtime.config_v1' }),
        expect.objectContaining({ ref: projectPolicyPath }),
      ]),
    );
    const projectedPolicyRef = relayGuidance?.policy_refs?.find(
      (ref) => ref.ref === projectPolicyPath,
    );
    expect(projectedPolicyRef?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

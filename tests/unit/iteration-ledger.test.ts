import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import {
  type IterationLedgerRow,
  iterationLedgerFromTrace,
  renderIterationLedgerMarkdown,
} from '../../src/runtime/run/iteration-ledger.js';

// A relay.completed entry carrying token usage (and optionally a reported cost),
// shaped like the budget test's helper so the ledger's usage accounting is
// proven on the same input shape the engine actually writes.
function relay(input: {
  sequence: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}): TraceEntry {
  return {
    schema_version: 1,
    sequence: input.sequence,
    recorded_at: '2026-06-28T05:00:00.000Z',
    run_id: 'r',
    kind: 'relay.completed',
    step_id: 'loop-body',
    attempt: 1,
    verdict: 'ok',
    duration_ms: 1,
    result_path: 'reports/relay-result.json',
    receipt_path: 'reports/relay-receipt.json',
    usage: {
      input_tokens: input.inputTokens ?? 0,
      output_tokens: input.outputTokens ?? 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      ...(input.costUsd === undefined ? {} : { total_cost_usd_reported: input.costUsd }),
    },
  } as unknown as TraceEntry;
}

// A relay.completed entry with NO usage block (codex / custom connectors).
function relayNoUsage(sequence: number): TraceEntry {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-06-28T05:00:00.000Z',
    run_id: 'r',
    kind: 'relay.completed',
    step_id: 'loop-body',
    attempt: 1,
    verdict: 'ok',
    duration_ms: 1,
    result_path: 'reports/relay-result.json',
    receipt_path: 'reports/relay-receipt.json',
  } as unknown as TraceEntry;
}

function judgment(input: {
  sequence: number;
  iteration: number;
  disposition: IterationLedgerRow['disposition'];
  goalProposed: boolean;
  evidenceConfirmed: boolean;
  noProgressCount?: number;
  openLatchCount?: number;
  lesson?: string;
}): TraceEntry {
  return {
    schema_version: 1,
    sequence: input.sequence,
    recorded_at: '2026-06-28T05:00:00.000Z',
    run_id: 'r',
    kind: 'run.until-judgment',
    step_id: 'loop-tail',
    iteration: input.iteration,
    goal_proposed: input.goalProposed,
    evidence_confirmed: input.evidenceConfirmed,
    disposition: input.disposition,
    no_progress_count: input.noProgressCount ?? 0,
    open_latch_count: input.openLatchCount ?? 0,
    ...(input.lesson === undefined ? {} : { lesson: input.lesson }),
  } as unknown as TraceEntry;
}

// A non-until trace: a couple of relays and a close, no judgment entries.
function nonUntilTrace(): TraceEntry[] {
  return [
    relay({ sequence: 0, inputTokens: 10, outputTokens: 5 }),
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: '2026-06-28T05:00:00.000Z',
      run_id: 'r',
      kind: 'run.closed',
      outcome: 'complete',
    } as unknown as TraceEntry,
  ];
}

describe('iterationLedgerFromTrace', () => {
  it('emits one row per judgment, in order, bracketing the usage of its iteration', () => {
    // Three iterations: reenter, reenter, stop-clean. Each iteration's body
    // relay precedes that iteration's judgment; the third iteration ran two
    // relays. The token sum for each row is exactly its iteration's relays.
    const trace: TraceEntry[] = [
      relay({ sequence: 0, inputTokens: 100, outputTokens: 20 }), // iter 0: 120
      judgment({
        sequence: 1,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
        lesson: 'try again',
      }),
      relay({ sequence: 2, inputTokens: 200, outputTokens: 30 }), // iter 1: 230
      judgment({
        sequence: 3,
        iteration: 1,
        disposition: 'reenter',
        goalProposed: true,
        evidenceConfirmed: false,
        openLatchCount: 0,
      }),
      relay({ sequence: 4, inputTokens: 50, outputTokens: 10 }), // iter 2: 50+10 + 40+10 = 110
      relay({ sequence: 5, inputTokens: 40, outputTokens: 10 }),
      judgment({
        sequence: 6,
        iteration: 2,
        disposition: 'stop-clean',
        goalProposed: true,
        evidenceConfirmed: true,
      }),
    ];

    const rows = iterationLedgerFromTrace(trace);
    expect(rows.map((r) => r.iteration)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.disposition)).toEqual(['reenter', 'reenter', 'stop-clean']);
    expect(rows.map((r) => r.inputPlusOutputTokens)).toEqual([120, 230, 110]);
    // The third row is the confirmed clean stop.
    expect(rows[2]?.goalProposed).toBe(true);
    expect(rows[2]?.evidenceConfirmed).toBe(true);
    expect(rows.every((r) => r.openLatchCount === 0)).toBe(true);
    expect(rows[0]?.lesson).toBe('try again');
  });

  it('sums reported cost per iteration and leaves it undefined when none reported', () => {
    const trace: TraceEntry[] = [
      relay({ sequence: 0, inputTokens: 10, costUsd: 0.01 }),
      relay({ sequence: 1, inputTokens: 10, costUsd: 0.02 }),
      judgment({
        sequence: 2,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
      }),
      relay({ sequence: 3, inputTokens: 10 }), // no cost reported this iteration
      judgment({
        sequence: 4,
        iteration: 1,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
      }),
    ];
    const rows = iterationLedgerFromTrace(trace);
    expect(rows[0]?.costUsd).toBeCloseTo(0.03, 10);
    expect(rows[1]?.costUsd).toBeUndefined();
  });

  it('counts tokens from a usage-bearing relay even when another relay in the iteration has no usage', () => {
    const trace: TraceEntry[] = [
      relay({ sequence: 0, inputTokens: 100, outputTokens: 0 }),
      relayNoUsage(1),
      judgment({
        sequence: 2,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
      }),
    ];
    const rows = iterationLedgerFromTrace(trace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputPlusOutputTokens).toBe(100);
  });

  it('projects a tamper-shaped judgment faithfully (proposed true, evidence false, latch open)', () => {
    const trace: TraceEntry[] = [
      judgment({
        sequence: 0,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: true,
        evidenceConfirmed: false,
        openLatchCount: 1,
      }),
    ];
    const rows = iterationLedgerFromTrace(trace);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      iteration: 0,
      disposition: 'reenter',
      goalProposed: true,
      evidenceConfirmed: false,
      openLatchCount: 1,
      inputPlusOutputTokens: 0,
    });
    expect(rows[0]?.costUsd).toBeUndefined();
  });

  it('yields an empty ledger for an empty trace', () => {
    expect(iterationLedgerFromTrace([])).toEqual([]);
  });

  it('yields an empty ledger for a non-until trace (no judgment entries)', () => {
    expect(iterationLedgerFromTrace(nonUntilTrace())).toEqual([]);
  });

  it('is order-independent on input: out-of-sequence entries still project in iteration order', () => {
    const trace: TraceEntry[] = [
      judgment({
        sequence: 3,
        iteration: 1,
        disposition: 'stop-clean',
        goalProposed: true,
        evidenceConfirmed: true,
      }),
      relay({ sequence: 2, inputTokens: 7, outputTokens: 3 }),
      relay({ sequence: 0, inputTokens: 5, outputTokens: 5 }),
      judgment({
        sequence: 1,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
      }),
    ];
    const rows = iterationLedgerFromTrace(trace);
    expect(rows.map((r) => r.iteration)).toEqual([0, 1]);
    expect(rows.map((r) => r.inputPlusOutputTokens)).toEqual([10, 10]);
  });
});

describe('renderIterationLedgerMarkdown', () => {
  it('renders a table with one row per iteration', () => {
    const rows = iterationLedgerFromTrace([
      relay({ sequence: 0, inputTokens: 100, outputTokens: 20 }),
      judgment({
        sequence: 1,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
        lesson: 'try again',
      }),
      judgment({
        sequence: 2,
        iteration: 1,
        disposition: 'stop-clean',
        goalProposed: true,
        evidenceConfirmed: true,
      }),
    ]);
    const md = renderIterationLedgerMarkdown(rows);
    // Plain-English headers, no internal jargon.
    expect(md).toContain('| Iteration |');
    expect(md).toContain('Goal proposed');
    expect(md).toContain('Evidence confirmed');
    expect(md).toContain('stop-clean');
    expect(md).toContain('try again');
    // Two data rows (iterations 0 and 1) plus a header and separator.
    const dataLines = md
      .split('\n')
      .filter((line) => line.trim().startsWith('| 0') || line.trim().startsWith('| 1'));
    expect(dataLines).toHaveLength(2);
  });

  it('truncates a long lesson to keep the table compact', () => {
    const long = 'x'.repeat(200);
    const rows = iterationLedgerFromTrace([
      judgment({
        sequence: 0,
        iteration: 0,
        disposition: 'reenter',
        goalProposed: false,
        evidenceConfirmed: false,
        lesson: long,
      }),
    ]);
    const md = renderIterationLedgerMarkdown(rows);
    expect(md).not.toContain(long);
    expect(md).toContain('…');
  });

  it('returns an empty string for an empty ledger', () => {
    expect(renderIterationLedgerMarkdown([])).toBe('');
  });
});

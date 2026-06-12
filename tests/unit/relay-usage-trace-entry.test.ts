import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RelayCompletedTraceEntry, TraceEntry } from '../../src/schemas/trace-entry.js';

// relay.completed optionally carries the connector-reported token/cost usage
// (charter instrument 1; also the substrate for the itemized receipt card).
// The field must stay optional — codex and custom connectors emit none — and
// strict, so a malformed usage block is caught at append time rather than
// surfacing as garbage in a downstream cost report.

function baseEntry(): Record<string, unknown> {
  return {
    schema_version: 1,
    sequence: 7,
    recorded_at: '2026-06-11T00:00:00.000Z',
    run_id: randomUUID(),
    kind: 'relay.completed',
    step_id: 'implement',
    attempt: 1,
    verdict: 'pass',
    duration_ms: 1200,
    result_path: 'relays/implement-1/result.json',
    receipt_path: 'relays/implement-1/receipt.txt',
  };
}

const USAGE = {
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
      input_tokens: 10,
      output_tokens: 39,
      cache_read_tokens: 17696,
      cache_creation_tokens: 6024,
      cost_usd_reported: 0.0140226,
    },
  ],
};

describe('relay.completed usage evidence', () => {
  it('parses without usage (codex and custom connectors emit none)', () => {
    const parsed = RelayCompletedTraceEntry.parse(baseEntry());
    expect(parsed.usage).toBeUndefined();
  });

  it('parses with a full usage block, through the union too', () => {
    const entry = { ...baseEntry(), usage: USAGE };
    const parsed = RelayCompletedTraceEntry.parse(entry);
    expect(parsed.usage?.input_tokens).toBe(451);
    expect(parsed.usage?.models?.[0]?.model).toBe('claude-haiku-4-5');
    expect(() => TraceEntry.parse(entry)).not.toThrow();
  });

  it('rejects negative token counts', () => {
    const entry = { ...baseEntry(), usage: { ...USAGE, input_tokens: -1 } };
    expect(() => RelayCompletedTraceEntry.parse(entry)).toThrow();
  });

  it('rejects unknown usage keys (strict, so drift is caught at append time)', () => {
    const entry = { ...baseEntry(), usage: { ...USAGE, surprise: 1 } };
    expect(() => RelayCompletedTraceEntry.parse(entry)).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { evaluateUntilBudget } from '../../src/runtime/run/until-budget.js';

// A relay.completed entry carrying a usage block. Only the fields the budget
// accumulator reads are set; the rest of RelayUsageEvidence defaults to zero.
function relayWithUsage(input: {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}): TraceEntry {
  return {
    run_id: 'r',
    kind: 'relay.completed',
    step_id: 'work',
    attempt: 1,
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
function relayMissingUsage(): TraceEntry {
  return {
    run_id: 'r',
    kind: 'relay.completed',
    step_id: 'work',
    attempt: 1,
  } as unknown as TraceEntry;
}

describe('evaluateUntilBudget: no cap', () => {
  it('is always clear when neither cap is set, even with missing usage', () => {
    const verdict = evaluateUntilBudget([relayMissingUsage()], {});
    expect(verdict).toEqual({ overCap: false, nearCap: false });
  });
});

describe('evaluateUntilBudget: token cap', () => {
  it('is clear well under the cap', () => {
    const verdict = evaluateUntilBudget([relayWithUsage({ inputTokens: 100, outputTokens: 100 })], {
      tokenCap: 1000,
    });
    expect(verdict.overCap).toBe(false);
    expect(verdict.nearCap).toBe(false);
  });

  it('warns at the 80% soft threshold without stopping', () => {
    const verdict = evaluateUntilBudget([relayWithUsage({ inputTokens: 500, outputTokens: 300 })], {
      tokenCap: 1000,
    });
    expect(verdict.overCap).toBe(false);
    expect(verdict.nearCap).toBe(true);
    expect(verdict.reason).toContain('prioritize closing out');
  });

  it('is over the cap at or above 100%', () => {
    const verdict = evaluateUntilBudget([relayWithUsage({ inputTokens: 700, outputTokens: 400 })], {
      tokenCap: 1000,
    });
    expect(verdict.overCap).toBe(true);
    expect(verdict.reason).toContain('token cap');
  });

  it('sums tokens across multiple relays (cumulative, not per-relay)', () => {
    const verdict = evaluateUntilBudget(
      [
        relayWithUsage({ inputTokens: 400, outputTokens: 100 }),
        relayWithUsage({ inputTokens: 400, outputTokens: 200 }),
      ],
      { tokenCap: 1000 },
    );
    expect(verdict.overCap).toBe(true);
  });
});

describe('evaluateUntilBudget: USD cap', () => {
  it('is clear under the cap and warns at the soft threshold', () => {
    expect(evaluateUntilBudget([relayWithUsage({ costUsd: 0.5 })], { usdCap: 2 }).nearCap).toBe(
      false,
    );
    expect(evaluateUntilBudget([relayWithUsage({ costUsd: 1.7 })], { usdCap: 2 }).nearCap).toBe(
      true,
    );
  });

  it('is over the cap at or above 100%', () => {
    const verdict = evaluateUntilBudget([relayWithUsage({ costUsd: 2.5 })], { usdCap: 2 });
    expect(verdict.overCap).toBe(true);
    expect(verdict.reason).toContain('USD cap');
  });
});

describe('evaluateUntilBudget: fail closed', () => {
  it('fails closed when a cap is set and any relay reported no usage', () => {
    const verdict = evaluateUntilBudget(
      [relayWithUsage({ inputTokens: 10, outputTokens: 10 }), relayMissingUsage()],
      { tokenCap: 1_000_000 },
    );
    expect(verdict.overCap).toBe(true);
    expect(verdict.reason).toContain('unmeasurable');
  });

  it('fails closed when a USD cap is set but no relay reported a cost', () => {
    const verdict = evaluateUntilBudget([relayWithUsage({ inputTokens: 10, outputTokens: 10 })], {
      usdCap: 100,
    });
    expect(verdict.overCap).toBe(true);
    expect(verdict.reason).toContain('no relay reported a cost');
  });

  it('does NOT fail a token cap on a cost-less but token-bearing usage block', () => {
    // A usage block with tokens but no reported cost is fine for a TOKEN cap;
    // fail-closed only applies to the dimension that cannot be measured.
    const verdict = evaluateUntilBudget([relayWithUsage({ inputTokens: 10, outputTokens: 10 })], {
      tokenCap: 1000,
    });
    expect(verdict.overCap).toBe(false);
  });
});

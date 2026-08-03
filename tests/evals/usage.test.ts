import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseVanillaClaim } from '../../scripts/evals/fix-vs-vanilla/scoring.ts';
import {
  type PriceTable,
  type UsageEnvelope,
  buildArmUsageScore,
  computeEnvelopeCostUsd,
  groupRelaysByRole,
  loadPriceTable,
  normalizeUsage,
  parseVanillaEnvelope,
  readCircuitRunUsage,
  resolveModelPrice,
} from '../../scripts/evals/shared/usage.ts';

// Fixture lookups are `T | undefined` under noUncheckedIndexedAccess. A throw
// with a label fails at the missing fixture and names it; a non-null assertion
// fails later on a property read and names nothing.
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing test fixture: ${label}`);
  return value;
}

const TABLE: PriceTable = {
  schema_version: 1,
  as_of: '2026-06-11',
  models: {
    'claude-haiku-4-5': {
      input: 1,
      cache_write_5m: 1.25,
      cache_write_1h: 2,
      cache_read: 0.1,
      output: 5,
    },
    'claude-opus-4-5': {
      input: 5,
      cache_write_5m: 6.25,
      cache_write_1h: 10,
      cache_read: 0.5,
      output: 25,
    },
  },
};

// The live CLI probe this module was designed against (2026-06-11): a haiku
// run whose total_cost_usd the CLI computed from list prices. The result
// event shape below mirrors the probe verbatim.
function probeResultEvent(): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    total_cost_usd: 0.0145286,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 6024,
      cache_read_input_tokens: 17696,
      output_tokens: 39,
      cache_creation: { ephemeral_1h_input_tokens: 6024, ephemeral_5m_input_tokens: 0 },
    },
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens: 441,
        outputTokens: 13,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.000506,
      },
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: 39,
        cacheReadInputTokens: 17696,
        cacheCreationInputTokens: 6024,
        costUSD: 0.0140226,
      },
    },
  };
}

describe('normalizeUsage', () => {
  it('takes token totals from modelUsage, not the main-loop usage block', () => {
    const usage = normalizeUsage(probeResultEvent());
    // 441 + 10: the helper-model call appears only in modelUsage.
    expect(usage.input_tokens).toBe(451);
    expect(usage.output_tokens).toBe(52);
    expect(usage.cache_read_tokens).toBe(17696);
    expect(usage.cache_creation_tokens).toBe(6024);
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(6024);
    expect(usage.cost_usd_reported).toBe(0.0145286);
    expect(usage.models).toHaveLength(2);
  });

  it('falls back to the top-level usage block when modelUsage is absent', () => {
    const event = probeResultEvent();
    event.modelUsage = undefined;
    const usage = normalizeUsage(event);
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(39);
    expect(usage.cache_creation_tokens).toBe(6024);
    expect(usage.models).toHaveLength(0);
  });

  it('normalizes an empty modelUsage key to "unknown"', () => {
    const event = probeResultEvent();
    event.modelUsage = { '': { inputTokens: 5, outputTokens: 1 } };
    const usage = normalizeUsage(event);
    expect(usage.models[0]?.model).toBe('unknown');
  });
});

describe('parseVanillaEnvelope', () => {
  it('unwraps the result text so claim parsing sees the fenced claim JSON', () => {
    const claimBlock =
      '```json\n{"claimed_fixed": true, "regression_proof": {"failed_before": true, "passed_after": true}, "commands_run": []}\n```';
    const envelope = JSON.stringify({
      ...probeResultEvent(),
      result: `All done.\n\n${claimBlock}`,
    });

    const parsed = parseVanillaEnvelope(envelope);
    expect(parsed).toBeDefined();
    if (parsed === undefined) throw new Error('expected the envelope to parse');

    // Load-bearing regression: on raw envelope stdout the last-JSON-object
    // claim parser parses the envelope itself and reports claimed_fixed
    // false. Unwrapped, the real claim comes through.
    const shadowed = parseVanillaClaim(envelope);
    expect(shadowed.claimed_fixed).toBe(false);
    const unwrapped = parseVanillaClaim(parsed.result_text);
    expect(unwrapped.claimed_fixed).toBe(true);
    expect(parsed.usage.cost_usd_reported).toBe(0.0145286);
  });

  it('returns undefined for plain-text stdout and partial output', () => {
    expect(parseVanillaEnvelope('The bug is fixed.')).toBeUndefined();
    expect(parseVanillaEnvelope('{"type":"result","resu')).toBeUndefined();
    expect(parseVanillaEnvelope('{"type":"system"}')).toBeUndefined();
    expect(parseVanillaEnvelope('[]')).toBeUndefined();
  });

  it('tolerates stray bytes before the envelope but not after it', () => {
    const envelope = JSON.stringify(probeResultEvent());
    const noisy = parseVanillaEnvelope(`npm WARN deprecated something\n{not json}\n${envelope}`);
    expect(noisy).toBeDefined();
    expect(noisy?.usage.cost_usd_reported).toBe(0.0145286);
    // The CLI writes the envelope last; trailing bytes mean it is not the
    // terminal result event and nothing in the stdout is trustworthy.
    expect(parseVanillaEnvelope(`${envelope}\nstray trailing line`)).toBeUndefined();
  });

  it('never mistakes a truncated envelope fragment for the result event', () => {
    // A SIGTERM mid-envelope can leave a complete nested object (for example
    // usage) at the tail; it lacks type "result" and must not parse.
    const full = JSON.stringify(probeResultEvent());
    const truncated = full.slice(0, full.indexOf('"modelUsage"'));
    expect(parseVanillaEnvelope(truncated)).toBeUndefined();
  });

  // The shape the CLI actually writes for `-p --output-format json` (observed
  // live 2026-06-12, run 2026-06-12T15-49-10-758Z-held-out): one single-line
  // JSON ARRAY of events, the result event among them. The bare-object
  // envelope remains supported for older shapes.
  function eventArrayStdout(events: unknown[]): string {
    return `${JSON.stringify(events)}\n`;
  }

  it('parses the event-array shape the live CLI writes for --output-format json', () => {
    const init = { type: 'system', subtype: 'init', session_id: 's', tools: ['Bash'] };
    const assistant = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working' }] },
    };
    const stdout = eventArrayStdout([init, assistant, probeResultEvent()]);

    const parsed = parseVanillaEnvelope(stdout);
    expect(parsed).toBeDefined();
    expect(parsed?.result_text).toBe('ok');
    expect(parsed?.usage.cost_usd_reported).toBe(0.0145286);
    expect(parsed?.usage.input_tokens).toBe(451);
    expect(parsed?.usage.models).toHaveLength(2);
  });

  it('tolerates stray bytes before the event array but not after it', () => {
    const stdout = eventArrayStdout([{ type: 'system' }, probeResultEvent()]);
    const noisy = parseVanillaEnvelope(`npm WARN something\n${stdout}`);
    expect(noisy).toBeDefined();
    expect(noisy?.usage.cost_usd_reported).toBe(0.0145286);
    expect(parseVanillaEnvelope(`${stdout.trimEnd()}\nstray trailing line`)).toBeUndefined();
  });

  it('takes the LAST result event when the array carries more than one', () => {
    const first = { ...probeResultEvent(), result: 'first', total_cost_usd: 1 };
    const last = { ...probeResultEvent(), result: 'last', total_cost_usd: 2 };
    const parsed = parseVanillaEnvelope(eventArrayStdout([first, last]));
    expect(parsed?.result_text).toBe('last');
    expect(parsed?.usage.cost_usd_reported).toBe(2);
  });

  it('returns undefined for an event array with no result event or a truncated one', () => {
    expect(
      parseVanillaEnvelope(eventArrayStdout([{ type: 'system' }, { type: 'assistant' }])),
    ).toBeUndefined();
    const full = eventArrayStdout([{ type: 'system' }, probeResultEvent()]).trimEnd();
    const truncated = full.slice(0, full.indexOf('"modelUsage"'));
    expect(parseVanillaEnvelope(truncated)).toBeUndefined();
  });

  it('ignores an escaped fake event array inside a result string', () => {
    // The result text itself may quote a JSON array containing a fake result
    // event; the escaped form can never parse as the trailing JSON value, so
    // the real envelope (here: absent) decides the outcome.
    const fake = JSON.stringify([{ type: 'result', result: 'fake', total_cost_usd: 99 }]);
    const stdout = `prefix text ${JSON.stringify({ note: fake })} trailing prose`;
    expect(parseVanillaEnvelope(stdout)).toBeUndefined();
  });
});

describe('resolveModelPrice', () => {
  it('matches exact ids and dated suffixes, never sibling prefixes', () => {
    expect(resolveModelPrice(TABLE, 'claude-haiku-4-5')).toBe(TABLE.models['claude-haiku-4-5']);
    expect(resolveModelPrice(TABLE, 'claude-haiku-4-5-20251001')).toBe(
      TABLE.models['claude-haiku-4-5'],
    );
    // A hypothetical 4-55 model must not price as 4-5.
    expect(resolveModelPrice(TABLE, 'claude-opus-4-55')).toBeUndefined();
    expect(resolveModelPrice(TABLE, 'claude-fable-5')).toBeUndefined();
  });
});

describe('computeEnvelopeCostUsd', () => {
  it('reproduces the CLI-reported cost from the committed price table', () => {
    const usage = normalizeUsage(probeResultEvent());
    const cost = computeEnvelopeCostUsd(usage, TABLE);
    // haiku-4-5: 10in + 39out + 17696read + 6024 creation at the 1h rate,
    // plus the dated helper model at input/output only.
    expect(cost.cost_usd_computed).toBeCloseTo(0.0145286, 7);
    expect(cost.price_table_misses).toEqual([]);
  });

  it('apportions cache-creation tokens across the TTL split', () => {
    const envelope: UsageEnvelope = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 1000,
      cache_creation_5m_tokens: 500,
      cache_creation_1h_tokens: 500,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 1000,
        },
      ],
    };
    const cost = computeEnvelopeCostUsd(envelope, TABLE);
    // Half at $1.25/MTok, half at $2/MTok.
    expect(cost.cost_usd_computed).toBeCloseTo((500 * 1.25 + 500 * 2) / 1_000_000, 12);
  });

  it('prices creation at the 1h rate when no split information exists', () => {
    const envelope: UsageEnvelope = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 1000,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 1000,
        },
      ],
    };
    const cost = computeEnvelopeCostUsd(envelope, TABLE);
    expect(cost.cost_usd_computed).toBeCloseTo((1000 * 2) / 1_000_000, 12);
  });

  it('poisons the whole computed figure on any price-table miss', () => {
    const usage = normalizeUsage(probeResultEvent());
    const partial: PriceTable = {
      ...TABLE,
      models: {
        'claude-opus-4-5': must(TABLE.models['claude-opus-4-5'], 'claude-opus-4-5 price row'),
      },
    };
    const cost = computeEnvelopeCostUsd(usage, partial);
    expect(cost.cost_usd_computed).toBeUndefined();
    expect(cost.price_table_misses).toContain('claude-haiku-4-5');
  });

  it('treats tokens with no per-model attribution as a miss, never a $0 cost', () => {
    const envelope: UsageEnvelope = {
      input_tokens: 5000,
      output_tokens: 900,
      cache_read_tokens: 17696,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      models: [],
    };
    const cost = computeEnvelopeCostUsd(envelope, TABLE);
    expect(cost.cost_usd_computed).toBeUndefined();
    expect(cost.price_table_misses).toEqual(['unknown']);
    // A genuinely empty capture is the one legitimate $0.
    const empty: UsageEnvelope = {
      ...envelope,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
    };
    expect(computeEnvelopeCostUsd(empty, TABLE).cost_usd_computed).toBe(0);
  });

  it('poisons when the models array covers only part of the top-level tokens', () => {
    // A single model entry must not turn unattributed top-level tokens into
    // a silently-priced $0 share: 5000 top-level input vs 100 attributed.
    const envelope: UsageEnvelope = {
      input_tokens: 5000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 100,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
    };
    const cost = computeEnvelopeCostUsd(envelope, TABLE);
    expect(cost.cost_usd_computed).toBeUndefined();
    expect(cost.price_table_misses).toEqual(['unknown']);
  });

  it('checks attribution per token class, so a surplus cannot hide a deficit', () => {
    // Models attribute 100 input the top level lacks, while 100 top-level
    // output goes unattributed; grand totals match but the output tokens
    // still have no model to price against.
    const envelope: UsageEnvelope = {
      input_tokens: 0,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 100,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
    };
    const cost = computeEnvelopeCostUsd(envelope, TABLE);
    expect(cost.cost_usd_computed).toBeUndefined();
    expect(cost.price_table_misses).toEqual(['unknown']);
  });

  it('never returns $0 for a non-empty envelope with an all-zero models array', () => {
    const envelope: UsageEnvelope = {
      input_tokens: 5000,
      output_tokens: 900,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
    };
    const cost = computeEnvelopeCostUsd(envelope, TABLE);
    expect(cost.cost_usd_computed).toBeUndefined();
    expect(cost.price_table_misses).toEqual(['unknown']);
  });

  it('counts a malformed price row as a miss instead of emitting NaN', () => {
    const broken = {
      ...TABLE,
      models: {
        // cache_write_1h missing: the arithmetic would produce NaN.
        'claude-haiku-4-5': { input: 1, cache_write_5m: 1.25, cache_read: 0.1, output: 5 },
      },
    } as unknown as PriceTable;
    const envelope: UsageEnvelope = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 1000,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      models: [
        {
          model: 'claude-haiku-4-5',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 1000,
        },
      ],
    };
    const cost = computeEnvelopeCostUsd(envelope, broken);
    expect(cost.cost_usd_computed).toBeUndefined();
    expect(cost.price_table_misses).toEqual(['claude-haiku-4-5']);
  });
});

describe('readCircuitRunUsage', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeTrace(lines: unknown[]): string {
    dir = mkdtempSync(resolve(tmpdir(), 'usage-test-'));
    writeFileSync(
      resolve(dir, 'trace.ndjson'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    return dir;
  }

  const usageBlock = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 10,
    cache_creation_tokens: 20,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 20,
    total_cost_usd_reported: 0.001,
    models: [
      {
        model: 'claude-haiku-4-5',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_creation_tokens: 20,
        cost_usd_reported: 0.001,
      },
    ],
  };

  it('joins relay.completed usage to the relay.started role per attempt', () => {
    const runFolder = writeTrace([
      { kind: 'relay.started', step_id: 'research', attempt: 1, role: 'researcher' },
      { kind: 'relay.completed', step_id: 'research', attempt: 1, usage: usageBlock },
      { kind: 'relay.started', step_id: 'implement', attempt: 1, role: 'implementer' },
      { kind: 'relay.completed', step_id: 'implement', attempt: 1, usage: usageBlock },
      // A retry on the same step is its own attempt and its own cost.
      { kind: 'relay.started', step_id: 'implement', attempt: 2, role: 'implementer' },
      { kind: 'relay.completed', step_id: 'implement', attempt: 2, usage: usageBlock },
    ]);
    const run = readCircuitRunUsage(runFolder);
    expect(run).toBeDefined();
    if (run === undefined) throw new Error('expected run usage to be read');
    expect(run.relay_count).toBe(3);
    expect(run.relays_missing_usage).toBe(0);
    const byRole = groupRelaysByRole(run.relays);
    expect(byRole.get('researcher')).toHaveLength(1);
    expect(byRole.get('implementer')).toHaveLength(2);
  });

  it('counts usage-less relays instead of dropping them silently', () => {
    const runFolder = writeTrace([
      { kind: 'relay.started', step_id: 'research', attempt: 1, role: 'researcher' },
      { kind: 'relay.completed', step_id: 'research', attempt: 1 },
      { kind: 'relay.completed', step_id: 'orphan', attempt: 1, usage: usageBlock },
    ]);
    const run = readCircuitRunUsage(runFolder);
    expect(run?.relay_count).toBe(2);
    expect(run?.relays_missing_usage).toBe(1);
    expect(run?.relays_failed).toBe(0);
    // No relay.started match: the usage still counts, under an unknown role.
    expect(run?.relays[0]?.role).toBe('unknown');
  });

  it('counts crashed attempts (relay.failed) so the undercount is visible', () => {
    // A timed-out or crashed attempt never reaches relay.completed; its
    // tokens are uncaptured and only this counter marks the gap.
    const runFolder = writeTrace([
      { kind: 'relay.started', step_id: 'implement', attempt: 1, role: 'implementer' },
      { kind: 'relay.failed', step_id: 'implement', attempt: 1 },
      { kind: 'relay.started', step_id: 'implement', attempt: 2, role: 'implementer' },
      { kind: 'relay.completed', step_id: 'implement', attempt: 2, usage: usageBlock },
    ]);
    const run = readCircuitRunUsage(runFolder);
    expect(run?.relay_count).toBe(1);
    expect(run?.relays_missing_usage).toBe(0);
    expect(run?.relays_failed).toBe(1);
  });

  it('normalizes an empty model name to "unknown"', () => {
    const runFolder = writeTrace([
      {
        kind: 'relay.completed',
        step_id: 'research',
        attempt: 1,
        usage: {
          ...usageBlock,
          models: [{ ...must(usageBlock.models[0], 'first usage model'), model: '' }],
        },
      },
    ]);
    const run = readCircuitRunUsage(runFolder);
    expect(run?.relays[0]?.usage.models[0]?.model).toBe('unknown');
  });

  it('returns undefined when the run folder has no trace', () => {
    dir = mkdtempSync(resolve(tmpdir(), 'usage-test-'));
    expect(readCircuitRunUsage(dir)).toBeUndefined();
  });
});

describe('buildArmUsageScore', () => {
  const envelope = (over: Partial<UsageEnvelope> = {}): UsageEnvelope => ({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    cost_usd_reported: (100 * 1 + 50 * 5) / 1_000_000,
    models: [
      {
        model: 'claude-haiku-4-5',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
    ],
    ...over,
  });

  it('marks usage absent when nothing was captured', () => {
    const score = buildArmUsageScore({ envelopes: [], table: TABLE });
    expect(score.usage_present).toBe(false);
    expect(score.tokens_input).toBeUndefined();
  });

  it('sums envelopes, computes cost, and stays unflagged when figures agree', () => {
    const score = buildArmUsageScore({ envelopes: [envelope(), envelope()], table: TABLE });
    expect(score.usage_present).toBe(true);
    expect(score.tokens_input).toBe(200);
    expect(score.tokens_output).toBe(100);
    expect(score.cost_usd_computed).toBeCloseTo(score.cost_usd_reported, 10);
    expect(score.cost_divergence_flag).toBe(false);
    expect(score.price_table_miss).toBe(false);
  });

  it('flags reported-vs-computed divergence above 5 percent', () => {
    const skewed = envelope({ cost_usd_reported: 0.001 });
    const score = buildArmUsageScore({ envelopes: [skewed], table: TABLE });
    expect(score.cost_divergence_flag).toBe(true);
    expect(score.cost_divergence_pct).toBeGreaterThan(0.05);
  });

  it('still flags divergence when the CLI reports a cost of zero', () => {
    // The denominator is the larger figure, so reported $0 against a real
    // computed cost cannot silence the check by dividing by zero.
    const zeroReported = envelope({ cost_usd_reported: 0 });
    const score = buildArmUsageScore({ envelopes: [zeroReported], table: TABLE });
    expect(score.cost_divergence_flag).toBe(true);
    expect(score.cost_divergence_pct).toBe(1);
  });

  it('counts envelopes whose CLI-reported cost is missing', () => {
    const noReported = envelope();
    (noReported as Record<string, unknown>).cost_usd_reported = undefined;
    const score = buildArmUsageScore({ envelopes: [envelope(), noReported], table: TABLE });
    // The summed reported figure is partial; the counter marks it.
    expect(score.envelopes_missing_reported_cost).toBe(1);
    expect(score.cost_usd_reported).toBeCloseTo(
      must(envelope().cost_usd_reported, 'envelope reported cost'),
      12,
    );
    const complete = buildArmUsageScore({ envelopes: [envelope()], table: TABLE });
    expect(complete.envelopes_missing_reported_cost).toBe(0);
  });

  it('passes the relays_failed tally through to the score', () => {
    const score = buildArmUsageScore({
      envelopes: [envelope()],
      table: TABLE,
      relayCount: 1,
      relaysMissingUsage: 0,
      relaysFailed: 2,
    });
    expect(score.relays_failed).toBe(2);
    const empty = buildArmUsageScore({
      envelopes: [],
      table: TABLE,
      relayCount: 0,
      relaysMissingUsage: 0,
      relaysFailed: 1,
    });
    expect(empty.usage_present).toBe(false);
    expect(empty.relays_failed).toBe(1);
  });

  it('rolls up per-role detail for the circuit arm', () => {
    const byRole = new Map([
      ['researcher', [envelope()]],
      ['implementer', [envelope(), envelope()]],
    ]);
    const score = buildArmUsageScore({
      envelopes: [envelope(), envelope(), envelope()],
      byRole,
      table: TABLE,
      relayCount: 3,
      relaysMissingUsage: 0,
    });
    expect(score.usage_by_role.researcher.relay_count).toBe(1);
    expect(score.usage_by_role.implementer.tokens_input).toBe(200);
    expect(score.relay_count).toBe(3);
  });

  it('marks price_table_miss without inventing a computed cost', () => {
    const foreign = envelope({
      models: [
        {
          model: 'claude-fable-5',
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      ],
    });
    const noTable = buildArmUsageScore({ envelopes: [envelope()], table: undefined });
    expect(noTable.price_table_miss).toBe(true);
    expect(noTable.cost_usd_computed).toBeUndefined();
    const missing = buildArmUsageScore({ envelopes: [foreign], table: TABLE });
    expect(missing.price_table_miss).toBe(true);
    expect(missing.cost_usd_computed).toBeUndefined();
    expect(missing.price_table_misses).toEqual(['claude-fable-5']);
  });
});

describe('loadPriceTable', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('loads the newest dated file', () => {
    dir = mkdtempSync(resolve(tmpdir(), 'prices-test-'));
    writeFileSync(
      resolve(dir, '2026-01-01.json'),
      JSON.stringify({ schema_version: 1, as_of: '2026-01-01', models: {} }),
    );
    writeFileSync(
      resolve(dir, '2026-06-11.json'),
      JSON.stringify({ schema_version: 1, as_of: '2026-06-11', models: TABLE.models }),
    );
    const table = loadPriceTable(dir);
    expect(table?.as_of).toBe('2026-06-11');
  });

  it('returns undefined for a missing or empty directory', () => {
    expect(loadPriceTable('/nonexistent/prices')).toBeUndefined();
    dir = mkdtempSync(resolve(tmpdir(), 'prices-test-'));
    expect(loadPriceTable(dir)).toBeUndefined();
  });
});

describe('committed price table', () => {
  it('reproduces the live probe cost exactly', () => {
    const table = loadPriceTable(resolve(import.meta.dirname, '../../evals/ledger/prices'));
    expect(table).toBeDefined();
    const cost = computeEnvelopeCostUsd(
      normalizeUsage(probeResultEvent()),
      must(table, 'committed price table'),
    );
    expect(cost.cost_usd_computed).toBeCloseTo(0.0145286, 7);
  });
});

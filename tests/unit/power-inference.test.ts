// Auto-power inference unit coverage: the run-scoped channel's set-once
// semantics, bounds clamping, the field-tolerant recommendation extractor,
// and the checkpoint-resume reseed.
import { describe, expect, it } from 'vitest';
import { RunId } from '../../src/schemas/ids.js';
import {
  PowerInferenceResolvedTraceEntry,
  type TraceEntry,
} from '../../src/schemas/trace-entry.js';
import {
  type ResolvedPowerInference,
  clampPowerToBounds,
  createPowerInferenceChannel,
  extractPowerRecommendation,
  seedPowerInferenceFromTrace,
} from '../../src/selection/power-inference.js';

const inference = (overrides?: Partial<ResolvedPowerInference>): ResolvedPowerInference => ({
  recommended: 'low',
  rationale: 'small localized change with good coverage',
  resolved: 'low',
  clamped: false,
  ...overrides,
});

describe('PowerInferenceChannel', () => {
  it('reads undefined until a resolution lands', () => {
    expect(createPowerInferenceChannel().get()).toBeUndefined();
  });

  it('first write wins; later writes are ignored', () => {
    const channel = createPowerInferenceChannel();
    channel.set(inference({ resolved: 'low' }));
    channel.set(inference({ resolved: 'high', recommended: 'high' }));
    expect(channel.get()?.resolved).toBe('low');
  });
});

describe('clampPowerToBounds', () => {
  it('raises a recommendation below the floor to the floor', () => {
    expect(clampPowerToBounds('low', { floor: 'medium', ceiling: 'high' })).toBe('medium');
  });

  it('lowers a recommendation above the ceiling to the ceiling', () => {
    expect(clampPowerToBounds('high', { floor: 'low', ceiling: 'medium' })).toBe('medium');
  });

  it('passes a recommendation inside the bounds through unchanged', () => {
    expect(clampPowerToBounds('medium', { floor: 'low', ceiling: 'high' })).toBe('medium');
  });
});

describe('extractPowerRecommendation', () => {
  it('returns a validated recommendation from a report body', () => {
    const body = {
      verdict: 'accept',
      recommended_power: { value: 'high', rationale: 'wide, weakly-tested surface' },
    };
    expect(extractPowerRecommendation(body)).toEqual({
      value: 'high',
      rationale: 'wide, weakly-tested surface',
    });
  });

  it('returns undefined when the key is absent', () => {
    expect(extractPowerRecommendation({ verdict: 'accept' })).toBeUndefined();
  });

  it('returns undefined for a malformed value (bad tier, surplus key, missing rationale)', () => {
    expect(
      extractPowerRecommendation({ recommended_power: { value: 'max', rationale: 'x' } }),
    ).toBeUndefined();
    expect(
      extractPowerRecommendation({
        recommended_power: { value: 'low', rationale: 'x', extra: true },
      }),
    ).toBeUndefined();
    expect(extractPowerRecommendation({ recommended_power: { value: 'low' } })).toBeUndefined();
  });

  it('returns undefined for non-object bodies', () => {
    expect(extractPowerRecommendation(null)).toBeUndefined();
    expect(extractPowerRecommendation('recommended_power')).toBeUndefined();
    expect(extractPowerRecommendation(42)).toBeUndefined();
  });
});

describe('seedPowerInferenceFromTrace', () => {
  const entry = (sequence: number, resolved: 'low' | 'medium' | 'high'): TraceEntry =>
    PowerInferenceResolvedTraceEntry.parse({
      schema_version: 1,
      sequence,
      recorded_at: '2026-06-11T00:00:00.000Z',
      run_id: RunId.parse('1f1bb1aa-0000-4000-8000-000000000000'),
      kind: 'run.power-inference',
      step_id: 'gather-context',
      recommended: resolved,
      rationale: 'seed fixture',
      floor: 'low',
      ceiling: 'high',
      resolved,
      clamped: false,
    });

  it('replays the durable record into a fresh channel', () => {
    const channel = createPowerInferenceChannel();
    seedPowerInferenceFromTrace([entry(3, 'high')], channel);
    expect(channel.get()).toEqual({
      recommended: 'high',
      rationale: 'seed fixture',
      resolved: 'high',
      clamped: false,
    });
  });

  it('the first run.power-inference entry wins', () => {
    const channel = createPowerInferenceChannel();
    seedPowerInferenceFromTrace([entry(3, 'low'), entry(9, 'high')], channel);
    expect(channel.get()?.resolved).toBe('low');
  });

  it('is a no-op on a trace without a resolution and on an undefined channel', () => {
    const channel = createPowerInferenceChannel();
    seedPowerInferenceFromTrace([], channel);
    expect(channel.get()).toBeUndefined();
    expect(() => seedPowerInferenceFromTrace([entry(1, 'low')], undefined)).not.toThrow();
  });
});

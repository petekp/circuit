import { describe, expect, it } from 'vitest';
import { type ComparisonMeta, compareVariants, computeDelta } from './compare.ts';
import type { VariantCost, VariantRecord } from './types.ts';

function cost(total: number, unit: VariantCost['unit'] = 'usd'): VariantCost {
  return { per_role: { implementer: total }, total, unit, partial: false };
}

function variant(
  overrides: Partial<VariantRecord> & Pick<VariantRecord, 'variant_id'>,
): VariantRecord {
  return {
    flow_id: overrides.variant_id === 'holistic' ? 'fix' : 'build',
    worktree_path: '/tmp/x',
    verdict: 'pass',
    quality_signal: {
      objective_passed: true,
      flow_claimed_done: true,
      false_fixed: false,
      flow_outcome: null,
      run_verdict: 'accept',
      checks_evaluated: 1,
      checks_failed: 0,
      missing_evidence_count: 0,
    },
    evidence_refs: [],
    cost: cost(1),
    steps: 1,
    wall_time_ms: 1000,
    failure_seam: null,
    changed_files: [],
    ...overrides,
  };
}

const META: ComparisonMeta = {
  task_id: 't',
  done_when: 'objective met',
  base_ref: 'base',
  mode: 'fixture',
  generated_at: '2026-06-13T00:00:00.000Z',
};

describe('computeDelta', () => {
  it('divides cost when both arms metered the same unit', () => {
    const delta = computeDelta(
      variant({ variant_id: 'holistic', cost: cost(0.42) }),
      variant({ variant_id: 'separated', cost: cost(1.85) }),
    );
    expect(delta.cost_ratio_basis).toBe('usd');
    expect(delta.cost_ratio).toBeCloseTo(4.4048, 3);
  });

  it('marks the ratio unavailable when an arm recorded no usage', () => {
    const delta = computeDelta(
      variant({
        variant_id: 'holistic',
        cost: { per_role: {}, total: 0, unit: 'none', partial: true },
      }),
      variant({ variant_id: 'separated', cost: cost(1.85) }),
    );
    expect(delta.cost_ratio_basis).toBe('unavailable');
    expect(delta.cost_ratio).toBe(0);
  });

  it('marks the ratio unavailable when the meters differ (usd vs tokens)', () => {
    const delta = computeDelta(
      variant({ variant_id: 'holistic', cost: cost(0.42, 'usd') }),
      variant({ variant_id: 'separated', cost: cost(5000, 'tokens') }),
    );
    expect(delta.cost_ratio_basis).toBe('unavailable');
  });

  it('detects a verdict mismatch and reports it', () => {
    const delta = computeDelta(
      variant({ variant_id: 'holistic', verdict: 'pass' }),
      variant({
        variant_id: 'separated',
        verdict: 'fail',
        quality_signal: {
          ...variant({ variant_id: 'separated' }).quality_signal,
          objective_passed: false,
          false_fixed: true,
        },
      }),
    );
    expect(delta.verdict_match).toBe(false);
    expect(delta.notes).toContain('separated false-fixed');
  });
});

describe('compareVariants', () => {
  it('orders holistic first, separated second, and stamps the meta', () => {
    const comparison = compareVariants(
      [variant({ variant_id: 'separated' }), variant({ variant_id: 'holistic' })],
      META,
    );
    expect(comparison.schema_version).toBe(1);
    expect(comparison.variants.map((v) => v.variant_id)).toEqual(['holistic', 'separated']);
    expect(comparison.mode).toBe('fixture');
    expect(comparison.generated_at).toBe(META.generated_at);
  });

  it('throws when a required variant is missing', () => {
    expect(() => compareVariants([variant({ variant_id: 'holistic' })], META)).toThrow(/separated/);
  });
});

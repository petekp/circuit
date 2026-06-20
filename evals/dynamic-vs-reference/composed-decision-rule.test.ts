// Locks the SIBLING composed-vs-reference decision rule (--with-composed arm).
//
// Pre-registered before any composed live data: the composed fix arm reaches
// COMPOSITION-VIABLE only when, on fix, it holds objective-fixed quality within
// 10pp of the hand-authored reference AND does not raise false-fixed by more than
// 10pp AND has a clean composed pipeline. Any composed pipeline failure (a compose
// wall, a runnability abort, or a missing result) is PIPELINE-BROKEN and overrides
// the efficacy numbers — you cannot judge a flow that never ran cleanly.
//
// This is intentionally separate from the section-5 rule (classifyDynamicVsReference,
// locked in decision-rule.test.ts). The composed rule reuses the same pre-registered
// margins but drops the build fold-cost criterion (composition is fix-only here).

import { describe, expect, it } from 'vitest';
import {
  classifyComposedVsReference,
  type ComposedDecisionInput,
  type FamilyArmAggregate,
} from './run-dynamic-comparison.ts';

// Minimal aggregate: classify reads objective_fixed_rate, false_fixed_rate, and
// (on the composed arm) pipeline_failure_count. The rest satisfy the type.
function agg(over: Partial<FamilyArmAggregate>): FamilyArmAggregate {
  return {
    task_count: 4,
    objective_fixed_rate: 1,
    false_fixed_rate: 0,
    verification_pass_rate: 1,
    median_cost_usd_computed: 0.5,
    pipeline_failure_count: 0,
    ...over,
  };
}

// Parity input: composed matches the reference, pipeline clean — the
// COMPOSITION-VIABLE case.
function viableInput(): ComposedDecisionInput {
  return {
    fix: {
      reference: agg({ objective_fixed_rate: 1, false_fixed_rate: 0 }),
      composed: agg({ objective_fixed_rate: 1, false_fixed_rate: 0 }),
    },
  };
}

describe('classifyComposedVsReference — sibling rule, locked before data', () => {
  it('COMPOSITION-VIABLE at parity with a clean pipeline', () => {
    const result = classifyComposedVsReference(viableInput());
    expect(result.verdict).toBe('COMPOSITION-VIABLE');
    expect(result.predicates.quality_fix_within_margin).toBe(true);
    expect(result.predicates.honesty_fix_ok).toBe(true);
    expect(result.predicates.pipeline_fix_clean).toBe(true);
  });

  it('tolerates a composed quality dip of exactly 10pp (boundary holds)', () => {
    const input = viableInput();
    input.fix.composed = agg({ objective_fixed_rate: 0.9, false_fixed_rate: 0 });
    expect(classifyComposedVsReference(input).verdict).toBe('COMPOSITION-VIABLE');
  });

  it('BELOW-REFERENCE when composed quality falls more than 10pp', () => {
    const input = viableInput();
    input.fix.composed = agg({ objective_fixed_rate: 0.89, false_fixed_rate: 0 });
    const result = classifyComposedVsReference(input);
    expect(result.verdict).toBe('BELOW-REFERENCE');
    expect(result.predicates.quality_fix_within_margin).toBe(false);
  });

  it('tolerates a composed false-fixed rise of exactly 10pp (boundary holds)', () => {
    const input = viableInput();
    input.fix.composed = agg({ objective_fixed_rate: 1, false_fixed_rate: 0.1 });
    expect(classifyComposedVsReference(input).verdict).toBe('COMPOSITION-VIABLE');
  });

  it('BELOW-REFERENCE when composed false-fixed rises more than 10pp', () => {
    const input = viableInput();
    input.fix.composed = agg({ objective_fixed_rate: 1, false_fixed_rate: 0.11 });
    const result = classifyComposedVsReference(input);
    expect(result.verdict).toBe('BELOW-REFERENCE');
    expect(result.predicates.honesty_fix_ok).toBe(false);
  });

  it('PIPELINE-BROKEN overrides even perfect efficacy when the composed pipeline failed', () => {
    const input = viableInput();
    input.fix.composed = agg({ objective_fixed_rate: 1, false_fixed_rate: 0, pipeline_failure_count: 1 });
    const result = classifyComposedVsReference(input);
    expect(result.verdict).toBe('PIPELINE-BROKEN');
    expect(result.predicates.pipeline_fix_clean).toBe(false);
  });

  it('null composed rates cannot pass (no data is not parity)', () => {
    const input = viableInput();
    input.fix.composed = agg({ objective_fixed_rate: null, false_fixed_rate: null });
    expect(classifyComposedVsReference(input).verdict).toBe('BELOW-REFERENCE');
  });
});

// Locks the section-5 decision rule and the arg contract of the
// dynamic-vs-reference harness. These are the pre-registered thresholds: if a
// future edit moves a boundary, this test fails and the change is deliberate.
//
// This file lives outside tasks/ and results/, so `npm run test` collects it
// (those two segments are the only eval exclusions) and it stays inside the
// allowed evals/ diff set.

import { describe, expect, it } from 'vitest';
import {
  type DecisionInput,
  type DynManifest,
  type FamilyArmAggregate,
  classifyDynamicVsReference,
  parseDynArgs,
} from './run-dynamic-comparison.ts';

// Minimal aggregate: classify only reads objective_fixed_rate, false_fixed_rate,
// and (on the generated arm) pipeline_failure_count. The rest satisfy the type.
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

// A baseline input where both families are at parity, the pipeline is clean,
// and the build fold is cheaper than the reference: the WORTH-INVESTING case.
function worthInvestingInput(): DecisionInput {
  return {
    fix: {
      reference: agg({ objective_fixed_rate: 1, false_fixed_rate: 0 }),
      generated: agg({ objective_fixed_rate: 1, false_fixed_rate: 0 }),
    },
    build: {
      reference: agg({ objective_fixed_rate: 1, false_fixed_rate: 0 }),
      generated: agg({ objective_fixed_rate: 1, false_fixed_rate: 0 }),
      foldCostReference: 0.85,
      foldCostGenerated: 0.6,
    },
  };
}

const MANIFEST: DynManifest = {
  benchmark_id: 'dynamic-vs-reference',
  default_provider: 'claude-code',
  default_model: 'claude-haiku-4-5-20251001',
  default_effort: 'medium',
  default_timeout_ms: 900_000,
  reps_per_task: 3,
  families: { fix: ['fix-a'], build: ['build-a'] },
  expected_grain: {},
  fold_cost_tasks: ['build-a'],
};

describe('classifyDynamicVsReference (section-5 rule)', () => {
  it('WORTH-INVESTING when both families hold parity, pipeline clean, fold pays for itself', () => {
    const result = classifyDynamicVsReference(worthInvestingInput());
    expect(result.verdict).toBe('WORTH-INVESTING');
    expect(result.predicates.build_fold_cost_pays_for_itself).toBe(true);
  });

  it('MIXED when parity holds but the build fold costs more than the reference', () => {
    const input = worthInvestingInput();
    input.build.foldCostGenerated = 1.2; // dearer than the 0.85 reference
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('MIXED');
    expect(result.predicates.build_fold_cost_pays_for_itself).toBe(false);
  });

  it('NOT-YET when generated quality falls more than 10pp below reference on a family', () => {
    const input = worthInvestingInput();
    input.fix.generated = agg({ objective_fixed_rate: 0.85, false_fixed_rate: 0 }); // 1.0 - 0.85 = 0.15 > 0.10
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('NOT-YET');
    expect(result.predicates.quality_fix_within_margin).toBe(false);
  });

  it('quality exactly at the 10pp margin still passes (>= boundary)', () => {
    const input = worthInvestingInput();
    input.build.generated = agg({ objective_fixed_rate: 0.9, false_fixed_rate: 0 }); // 1.0 - 0.9 = 0.10, allowed
    const result = classifyDynamicVsReference(input);
    expect(result.predicates.quality_build_within_margin).toBe(true);
    expect(result.verdict).toBe('WORTH-INVESTING');
  });

  it('NOT-YET when generated false-fixed rises more than 10pp above reference', () => {
    const input = worthInvestingInput();
    input.build.generated = agg({ objective_fixed_rate: 1, false_fixed_rate: 0.25 }); // 0 + 0.25 > 0.10
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('NOT-YET');
    expect(result.predicates.honesty_build_ok).toBe(false);
  });

  it('false-fixed exactly at the 10pp margin still passes (<= boundary)', () => {
    const input = worthInvestingInput();
    input.fix.generated = agg({ objective_fixed_rate: 1, false_fixed_rate: 0.1 }); // 0 + 0.10, allowed
    const result = classifyDynamicVsReference(input);
    expect(result.predicates.honesty_fix_ok).toBe(true);
    expect(result.verdict).toBe('WORTH-INVESTING');
  });

  it('pipeline-integrity override caps at NOT-YET even with perfect quality', () => {
    const input = worthInvestingInput();
    input.build.generated = agg({
      objective_fixed_rate: 1,
      false_fixed_rate: 0,
      pipeline_failure_count: 1,
    });
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('NOT-YET');
    expect(result.predicates.pipeline_build_clean).toBe(false);
    expect(result.reasons[0]).toMatch(/pipeline-integrity override/i);
  });

  it('pipeline override outranks a quality failure (override headline wins)', () => {
    const input = worthInvestingInput();
    input.fix.generated = agg({
      objective_fixed_rate: 0.5,
      false_fixed_rate: 0,
      pipeline_failure_count: 2,
    });
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('NOT-YET');
    expect(result.reasons[0]).toMatch(/pipeline-integrity override/i);
  });

  it('null quality rate is treated as failing — no data cannot pass', () => {
    const input = worthInvestingInput();
    input.fix.generated = agg({ objective_fixed_rate: null, false_fixed_rate: 0 });
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('NOT-YET');
    expect(result.predicates.quality_fix_within_margin).toBe(false);
  });

  it('null false-fixed rate is treated as failing on the honesty axis', () => {
    const input = worthInvestingInput();
    input.build.generated = agg({ objective_fixed_rate: 1, false_fixed_rate: null });
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('NOT-YET');
    expect(result.predicates.honesty_build_ok).toBe(false);
  });

  it('null fold cost cannot satisfy the fold-cost gain — falls to MIXED', () => {
    const input = worthInvestingInput();
    input.build.foldCostGenerated = null;
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('MIXED');
    expect(result.predicates.build_fold_cost_pays_for_itself).toBe(false);
  });

  it('fold cost exactly equal to reference still pays for itself (<= boundary)', () => {
    const input = worthInvestingInput();
    input.build.foldCostReference = 0.7;
    input.build.foldCostGenerated = 0.7;
    const result = classifyDynamicVsReference(input);
    expect(result.verdict).toBe('WORTH-INVESTING');
    expect(result.predicates.build_fold_cost_pays_for_itself).toBe(true);
  });
});

describe('parseDynArgs (arg contract)', () => {
  it('defaults: pin on, manifest model, both families selected', () => {
    const args = parseDynArgs([], MANIFEST);
    expect(args.pinModel).toBe(true);
    expect(args.model).toBe('claude-haiku-4-5-20251001');
    expect(args.reps).toBe(3);
    expect(args.dryRun).toBe(false);
    expect(args.family).toBeUndefined();
  });

  it('--pin-model sets the model and keeps pin on', () => {
    const args = parseDynArgs(['--pin-model', 'claude-sonnet-4-6'], MANIFEST);
    expect(args.model).toBe('claude-sonnet-4-6');
    expect(args.pinModel).toBe(true);
  });

  it('--no-pin-model turns pinning off', () => {
    const args = parseDynArgs(['--no-pin-model'], MANIFEST);
    expect(args.pinModel).toBe(false);
  });

  it('--dry-run and --reps parse', () => {
    const args = parseDynArgs(['--dry-run', '--reps', '1'], MANIFEST);
    expect(args.dryRun).toBe(true);
    expect(args.reps).toBe(1);
  });

  it('rejects an unknown family', () => {
    expect(() => parseDynArgs(['--family', 'refactor'], MANIFEST)).toThrow(/family/i);
  });

  it('rejects a non-positive rep count', () => {
    expect(() => parseDynArgs(['--reps', '0'], MANIFEST)).toThrow(/positive integer/i);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseDynArgs(['--frobnicate'], MANIFEST)).toThrow(/unknown arg/i);
  });
});

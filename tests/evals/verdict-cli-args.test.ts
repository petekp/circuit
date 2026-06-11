import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../evals/verdict-correctness/cli-args.ts';
import {
  STANDARD_DEFECT_IDS,
  SUBTLE_DEFECT_IDS,
} from '../../evals/verdict-correctness/defect-taxonomy.ts';
import { summarize } from '../../evals/verdict-correctness/summary.ts';

const FIXED_NOW = () => new Date('2026-06-11T00:00:00.000Z');

describe('verdict-correctness parseArgs --model', () => {
  it('accepts --model with the claude-code judge and records it', () => {
    const args = parseArgs(
      ['--judge', 'claude-code', '--model', 'claude-haiku-4-5-20251001'],
      { now: FIXED_NOW },
    );
    expect(args.judge).toBe('claude-code');
    expect(args.model).toBe('claude-haiku-4-5-20251001');
  });

  it('tags the results dir with both judge and model', () => {
    const args = parseArgs(
      ['--judge', 'claude-code', '--model', 'claude-sonnet-4-6'],
      { now: FIXED_NOW },
    );
    expect(args.resultsDir.endsWith('2026-06-11T00-00-00-000Z-claude-code-claude-sonnet-4-6')).toBe(
      true,
    );
  });

  it('defaults model to null and omits the model suffix', () => {
    const args = parseArgs([], { now: FIXED_NOW });
    expect(args.model).toBeNull();
    expect(args.judge).toBe('codex');
    expect(args.resultsDir.endsWith('2026-06-11T00-00-00-000Z-codex')).toBe(true);
  });

  it('rejects --model with the default (codex) judge', () => {
    expect(() => parseArgs(['--model', 'claude-haiku-4-5-20251001'])).toThrow(
      /only supported with --judge claude-code/,
    );
  });

  it('rejects --model when --judge codex is explicit, regardless of flag order', () => {
    expect(() => parseArgs(['--model', 'claude-haiku-4-5-20251001', '--judge', 'codex'])).toThrow(
      /only supported with --judge claude-code/,
    );
  });
});

describe('verdict-correctness parseArgs --suite', () => {
  it('defaults to the standard suite', () => {
    const args = parseArgs([], { now: FIXED_NOW });
    expect(args.suite).toBe('standard');
    expect(args.defects).toEqual(STANDARD_DEFECT_IDS);
  });

  it('selects the subtle suite and records it', () => {
    const args = parseArgs(['--suite', 'subtle'], { now: FIXED_NOW });
    expect(args.suite).toBe('subtle');
    expect(args.defects).toEqual(SUBTLE_DEFECT_IDS);
  });

  it('selects all defects with --suite all', () => {
    const args = parseArgs(['--suite', 'all'], { now: FIXED_NOW });
    expect(args.suite).toBe('all');
    expect(args.defects).toHaveLength(STANDARD_DEFECT_IDS.length + SUBTLE_DEFECT_IDS.length);
  });

  it('records suite as custom when --defects overrides the set', () => {
    const args = parseArgs(['--suite', 'subtle', '--defects', 'wrong-subject'], {
      now: FIXED_NOW,
    });
    expect(args.suite).toBe('custom');
    expect(args.defects).toEqual(['wrong-subject']);
  });

  it('rejects an unknown suite name', () => {
    expect(() => parseArgs(['--suite', 'bogus'])).toThrow(/unknown suite/);
  });
});

describe('verdict-correctness summarize judge_model', () => {
  it('records the pinned judge model in the summary', () => {
    const summary = summarize([], 1000, 'claude-code', 'claude-opus-4-8', 'standard');
    expect(summary.judge_model).toBe('claude-opus-4-8');
    expect(summary.judge).toBe('claude-code');
  });

  it('records null when no model is pinned', () => {
    const summary = summarize([], 1000, 'codex', null, 'standard');
    expect(summary.judge_model).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { type FixManifest, parseFixArgs } from '../../evals/fix-vs-vanilla/run-fix-comparison.ts';

// A minimal manifest so the parser has defaults to fall back on without
// touching disk. The real manifest carries the same shape.
const MANIFEST: FixManifest = {
  benchmark_id: 'fix-vs-vanilla',
  default_provider: 'claude-code',
  default_model: 'claude-haiku-4-5-20251001',
  default_effort: 'medium',
  default_timeout_ms: 900_000,
  sets: {
    discovery: ['discovery-one'],
    regression: ['regression-one'],
    'held-out': ['heldout-one'],
  },
};

describe('parseFixArgs defaults', () => {
  it('runs both arms once on the held-out set by default', () => {
    const args = parseFixArgs([], MANIFEST);
    expect(args.arm).toBe('both');
    expect(args.reps).toBe(1);
    expect(args.set).toBe('held-out');
  });
});

describe('parseFixArgs --arm', () => {
  it('accepts vanilla, circuit, and both', () => {
    expect(parseFixArgs(['--arm', 'vanilla'], MANIFEST).arm).toBe('vanilla');
    expect(parseFixArgs(['--arm', 'circuit'], MANIFEST).arm).toBe('circuit');
    expect(parseFixArgs(['--arm', 'both'], MANIFEST).arm).toBe('both');
  });

  it('rejects an unknown arm', () => {
    expect(() => parseFixArgs(['--arm', 'sideways'], MANIFEST)).toThrow(/--arm/);
  });
});

describe('parseFixArgs --reps', () => {
  it('parses a positive integer', () => {
    expect(parseFixArgs(['--reps', '3'], MANIFEST).reps).toBe(3);
  });

  it('rejects zero, negative, and non-numeric reps', () => {
    expect(() => parseFixArgs(['--reps', '0'], MANIFEST)).toThrow(/--reps/);
    expect(() => parseFixArgs(['--reps', '-2'], MANIFEST)).toThrow(/--reps/);
    expect(() => parseFixArgs(['--reps', 'lots'], MANIFEST)).toThrow(/--reps/);
  });
});

describe('parseFixArgs keeps the existing flags working', () => {
  it('still parses set, task-id, and circuit-mode', () => {
    const args = parseFixArgs(
      ['--set', 'discovery', '--circuit-mode', 'high', '--reps', '2', '--arm', 'vanilla'],
      MANIFEST,
    );
    expect(args.set).toBe('discovery');
    expect(args.circuitMode).toBe('high');
    expect(args.reps).toBe(2);
    expect(args.arm).toBe('vanilla');
  });
});

describe('parseFixArgs --circuit-power', () => {
  it('defaults to undefined (CLI default-on dial)', () => {
    expect(parseFixArgs([], MANIFEST).circuitPower).toBeUndefined();
  });

  it('parses low, medium, and high', () => {
    expect(parseFixArgs(['--circuit-power', 'low'], MANIFEST).circuitPower).toBe('low');
    expect(parseFixArgs(['--circuit-power', 'medium'], MANIFEST).circuitPower).toBe('medium');
    expect(parseFixArgs(['--circuit-power', 'high'], MANIFEST).circuitPower).toBe('high');
  });

  it('rejects an unknown dial position', () => {
    expect(() => parseFixArgs(['--circuit-power', 'turbo'], MANIFEST)).toThrow(/--circuit-power/);
  });
});

describe('parseFixArgs --pin-model', () => {
  it('defaults to false', () => {
    expect(parseFixArgs([], MANIFEST).pinModel).toBe(false);
  });

  it('is a boolean switch that takes no value', () => {
    const args = parseFixArgs(['--pin-model', '--arm', 'both'], MANIFEST);
    expect(args.pinModel).toBe(true);
    expect(args.arm).toBe('both');
  });
});

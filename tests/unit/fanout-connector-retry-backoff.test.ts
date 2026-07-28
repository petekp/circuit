// The wait between a dead connector and the re-ask that follows it.
//
// The re-ask itself is proved end to end in
// tests/runner/review-codebase-fanout.test.ts. What this pins is the schedule:
// short enough that a fan-out branch is not holding its slot for nothing, and
// growing, so a connector that is genuinely down is not hammered once per
// attempt at the same cadence.
import { describe, expect, it } from 'vitest';
import { connectorRetryBackoffMs } from '../../src/runtime/fanout/branch-execution.js';

describe('connector retry backoff', () => {
  it('waits longer before each later re-ask', () => {
    // Attempt 1 is the first ask, so there is no backoff to compute for it.
    expect(connectorRetryBackoffMs(2)).toBe(400);
    expect(connectorRetryBackoffMs(3)).toBe(800);
    expect(connectorRetryBackoffMs(4)).toBe(1600);
  });

  it('never asks a caller to wait a negative or growing-backwards amount', () => {
    expect(connectorRetryBackoffMs(1)).toBe(400);
    expect(connectorRetryBackoffMs(0)).toBe(400);
  });
});

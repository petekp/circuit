import { describe, expect, it } from 'vitest';

import {
  CONTEXT_DELIVERY_BUDGET,
  createContextDelivery,
  decideContextDeliveryOutcome,
} from '../../../src/runtime/run/context-delivery.js';

// Pull-then-retry delivery — the pure pieces. The guard owns the per-run bound
// (a step delivers at most once; a global cap bounds the total), and the
// decision helper says whether to keep the enriched retry or fall back to the
// starved original. The orchestration (reading the trace, re-running the step)
// lives inline in graph-runner; these two are the testable invariants.

describe('createContextDelivery (the per-run delivery bound)', () => {
  it('lets a step claim a delivery exactly once', () => {
    const guard = createContextDelivery();
    expect(guard.claim('act-step')).toBe(true);
    // A second claim by the same step is refused: delivery is once-per-step,
    // the same once-only discipline the equipment reshaper holds.
    expect(guard.claim('act-step')).toBe(false);
  });

  it('bounds the total number of deliveries per run by a global budget', () => {
    const guard = createContextDelivery();
    // Distinct steps each claim, until the global budget is spent.
    for (let i = 0; i < CONTEXT_DELIVERY_BUDGET; i += 1) {
      expect(guard.claim(`step-${i}`)).toBe(true);
    }
    // The next distinct step is refused: the global cap, not just the per-step
    // guard, bounds delivery so a pathological flow cannot retry forever.
    expect(guard.claim('one-too-many')).toBe(false);
  });
});

describe('decideContextDeliveryOutcome (keep the retry, or fall back)', () => {
  it('keeps the enriched retry when it produced a result', () => {
    const decision = decideContextDeliveryOutcome({ kind: 'produced' });
    expect(decision.keep).toBe('retry');
    expect(decision.reason).toMatch(/retry/i);
  });

  it('falls back to the original when the retry threw before producing a result', () => {
    const decision = decideContextDeliveryOutcome({ kind: 'errored' });
    expect(decision.keep).toBe('original');
    expect(decision.reason).toMatch(/error/i);
  });

  it('falls back to the original when the retry connector failed', () => {
    // The fail-safe that matters: a connector blip on the retry must never
    // discard the work the starved attempt already produced.
    const decision = decideContextDeliveryOutcome({ kind: 'connector_failed' });
    expect(decision.keep).toBe('original');
    expect(decision.reason).toMatch(/connector/i);
  });
});

import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '../../../src/runtime/domain/trace.js';
import {
  CONTEXT_DELIVERY_BUDGET,
  createContextDelivery,
  decideContextDeliveryOutcome,
  seedContextDeliveryFromTrace,
} from '../../../src/runtime/run/context-delivery.js';

// A minimal run.context-delivery trace entry. seedContextDeliveryFromTrace
// only reads `kind` and `step_id`, so the fixture carries just those plus the
// base fields the type requires; the rest is irrelevant to the reseed.
function deliveryEntry(stepId: string, sequence: number): TraceEntry {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-06-17T00:00:00.000Z',
    run_id: 'run-test',
    kind: 'run.context-delivery',
    step_id: stepId,
    delivered_slices: 1,
    delivered_bytes: 42,
    retried: true,
    kept: 'retry',
    reason: 'the enriched retry produced a result on the delivered context; kept the retry',
  } as unknown as TraceEntry;
}

function unrelatedEntry(sequence: number): TraceEntry {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-06-17T00:00:00.000Z',
    run_id: 'run-test',
    kind: 'run.context-pull',
    step_id: 'act-step',
    from_step: 'ground',
    field_path: 'observations',
    answered: true,
    bytes: 10,
    reason: 'resolved',
  } as unknown as TraceEntry;
}

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

describe('seedContextDeliveryFromTrace (re-thread the bound on resume)', () => {
  it('refuses a fresh claim by a step that already delivered before the crash', () => {
    // On a healthy run the act-step delivered once, spending its per-step
    // claim. After a crash-resume the guard is rebuilt from the trace, so the
    // step must NOT deliver a second time — its claim is already spent.
    const guard = seedContextDeliveryFromTrace([deliveryEntry('act-step', 0)]);
    expect(guard.claim('act-step')).toBe(false);
  });

  it('charges each recorded delivery against the global budget', () => {
    // Two steps delivered before the crash. The reseeded guard must reflect
    // that spend: only CONTEXT_DELIVERY_BUDGET - 2 fresh steps may still claim.
    const guard = seedContextDeliveryFromTrace([
      deliveryEntry('step-a', 0),
      deliveryEntry('step-b', 1),
    ]);
    const remaining = CONTEXT_DELIVERY_BUDGET - 2;
    for (let i = 0; i < remaining; i += 1) {
      expect(guard.claim(`fresh-${i}`)).toBe(true);
    }
    expect(guard.claim('one-too-many')).toBe(false);
  });

  it('is identical to a fresh guard when the trace holds no delivery entries', () => {
    // No prior delivery (or delivery was off) → the reseed must be byte-for-byte
    // a fresh guard: every fresh step can still claim up to the full budget, and
    // unrelated trace entries are ignored.
    const guard = seedContextDeliveryFromTrace([unrelatedEntry(0), unrelatedEntry(1)]);
    for (let i = 0; i < CONTEXT_DELIVERY_BUDGET; i += 1) {
      expect(guard.claim(`fresh-${i}`)).toBe(true);
    }
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

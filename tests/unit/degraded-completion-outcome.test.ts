import { describe, expect, it } from 'vitest';

import { isDegradedCompletionOutcome } from '../../src/shared/outcome.js';

// Locks the membership of the degraded-completion set the run surface uses to
// qualify an otherwise-clean "Done". The set is the load-bearing detail: a Fix
// reaches the run surface with a `complete` run outcome (it does not bind its
// run outcome to its primary result), so EVERY non-clean FixResultOutcome word
// must qualify, or a degraded fix reads as an unqualified pass. `handoff` was
// the word originally missed; this test exists so dropping any of them regresses.
describe('isDegradedCompletionOutcome', () => {
  // FixResultOutcome = fixed | not-reproduced | partial | stopped | handoff | failed
  const FIX_DEGRADED = ['partial', 'stopped', 'handoff', 'failed'] as const;
  const FIX_CLEAN = ['fixed', 'not-reproduced'] as const;

  it.each(FIX_DEGRADED)('treats the Fix non-clean outcome %s as degraded', (outcome) => {
    expect(isDegradedCompletionOutcome(outcome)).toBe(true);
  });

  it.each(FIX_CLEAN)('treats the Fix clean outcome %s as not degraded', (outcome) => {
    expect(isDegradedCompletionOutcome(outcome)).toBe(false);
  });

  it('treats non-clean words from other flows as degraded', () => {
    // Goal/Build/Pursue/Prototype words that mean "did not cleanly succeed".
    for (const outcome of ['needs_attention', 'blocked']) {
      expect(isDegradedCompletionOutcome(outcome)).toBe(true);
    }
  });

  it('treats clean success words from other flows as not degraded', () => {
    // `complete` (build/goal/pursue), `kept`/`build_input_saved` (prototype).
    for (const outcome of ['complete', 'kept', 'build_input_saved']) {
      expect(isDegradedCompletionOutcome(outcome)).toBe(false);
    }
  });

  it('treats an absent outcome as not degraded (fail safe)', () => {
    expect(isDegradedCompletionOutcome(undefined)).toBe(false);
  });

  it('treats an unrecognized outcome word as not degraded (fail safe)', () => {
    expect(isDegradedCompletionOutcome('some-future-success-word')).toBe(false);
  });
});

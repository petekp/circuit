// On-demand context-pull demonstrator test — asserts on REAL measured numbers
// computed by the demonstrator from its model, not hardcoded guesses. Every
// expectation derives from summarize()/thinPull()/runPullChannel(), so a drift
// in the model surfaces here.
//
// The proofs, in the spec's terms:
//   1. thin push starves      — the assembly-time guess under-covers the runtime need.
//   2. fat push is complete   — but carries the whole blob (most bytes, most irrelevant).
//   3. thin + pull wins       — same completeness as fat push at a fraction of the
//                               carried context, closing exactly the starved fields.
//   4. no "everything"        — an '*' query is refused as a finding, not answered.
//   5. bounded                — a spent budget degrades to a finding, never an infinite widen.
//   6. legible                — every answered pull is recorded in the trace.

import { describe, expect, it } from 'vitest';
import {
  type PullQuery,
  fatPush,
  runPullChannel,
  summarize,
  thinPull,
  thinPush,
} from './context-pull-demonstrator.ts';

describe('context-pull demonstrator — the cost/completeness trade', () => {
  it('thin push is focused but STARVES on the fields the static guess missed', () => {
    const tp = thinPush();
    expect(tp.starvedFields).toBeGreaterThan(0);
    // It carries nothing irrelevant (focused) — the trade is starvation, not waste.
    expect(tp.irrelevantBytes).toBe(0);
  });

  it('fat push is COMPLETE but carries the whole blob (most bytes, most irrelevant)', () => {
    const fp = fatPush();
    const tp = thinPush();
    const pull = thinPull();
    expect(fp.starvedFields).toBe(0);
    // It carries strictly more than either alternative...
    expect(fp.carriedBytes).toBeGreaterThan(tp.carriedBytes);
    expect(fp.carriedBytes).toBeGreaterThan(pull.carriedBytes);
    // ...and the most irrelevant bytes of any strategy (the distraction cost).
    expect(fp.irrelevantBytes).toBeGreaterThan(pull.irrelevantBytes);
    expect(fp.irrelevantBytes).toBeGreaterThan(tp.irrelevantBytes);
  });

  it('thin + pull reaches fat-push completeness at a fraction of the carried context', () => {
    const s = summarize();
    // Completeness: no starvation, same as fat push.
    expect(s.thinPull.starvedFields).toBe(0);
    expect(s.thinPull.starvedFields).toBe(s.fatPush.starvedFields);
    // Cost: far cheaper than fat push. The headline saving is real and large
    // (fat push drags intake.full_text + scorecards + rejected concepts).
    expect(s.bytesSavedVsFatPush).toBeGreaterThan(0);
    expect(s.thinPull.carriedBytes).toBeLessThan(s.fatPush.carriedBytes / 2);
    // It closed exactly the fields the thin push starved on, with one pull each.
    expect(s.starvedFieldsClosed).toBe(s.thinPush.starvedFields);
    expect(s.thinPull.pulls).toBe(s.thinPush.starvedFields);
    // Focus: it carries far less irrelevant context than the fat push.
    expect(s.thinPull.irrelevantBytes).toBeLessThan(s.fatPush.irrelevantBytes);
  });
});

describe('context-pull demonstrator — the conservative defaults hold', () => {
  it('refuses an "everything" query as a finding instead of answering it', () => {
    const everything: PullQuery[] = [{ fieldId: '*' }];
    const result = runPullChannel(everything, 5);
    expect(result.answered).toHaveLength(0);
    expect(result.findings.some((f) => f.kind === 'everything-query-refused')).toBe(true);
    // Surfacing it through the scored path too: the smell never silently widens.
    const pull = thinPull({ extraQueries: [{ fieldId: '*' }] });
    expect(pull.findings.some((f) => f.kind === 'everything-query-refused')).toBe(true);
  });

  it('bounds pulls by a per-step budget: a spent budget degrades to a finding, never an infinite widen', () => {
    // Budget of 1 against a need of two missing fields: one is answered, the
    // second degrades to a budget-exhausted finding (proceed with what was pulled).
    const pull = thinPull({ budget: 1 });
    expect(pull.pulls).toBe(1);
    expect(pull.findings.some((f) => f.kind === 'budget-exhausted')).toBe(true);
    // The bound leaves a residual starvation rather than widening past budget:
    // it did NOT silently pull more than the budget allowed.
    expect(pull.starvedFields).toBeGreaterThan(0);
    expect(pull.pulls).toBeLessThanOrEqual(1);
  });

  it('records every answered pull in the trace (legible after the fact)', () => {
    const pull = thinPull();
    expect(pull.trace).toHaveLength(pull.pulls);
    // The trace names exactly the slices pulled — replayable provenance.
    expect(pull.trace.map((a) => a.fieldId).sort()).toEqual(
      ['digest.key_claims', 'spec.section_outline'].sort(),
    );
  });
});

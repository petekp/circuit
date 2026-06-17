// STEP 0 demonstrator test — asserts on REAL measured numbers computed from the
// pure assemble -> compile chain, not hardcoded guesses. Every expectation is
// derived from the demonstrator's own measurement (scoreSpec / summarize), so a
// drift in the chain or the resolvers surfaces here.
//
// The five proofs, in the spec's terms:
//   1. equipment reshape   — additive: compiles, slot debt strictly decreases on
//                            the unequipped seed, no new issue class appears.
//   2. decompose-down      — adds verification surface: the decomposed seed's
//                            verify+review surface is >= the whole seed's.
//   3. re-hold             — finding-only: never reshaped, finding cites the
//                            verification surface / finding-only default.
//   4. safety floor        — an illegal reshape input FAILS (reshaped:false with a
//                            safety-floor finding) AND the underlying chain rejects
//                            it (ok:false), rather than producing a broken tail.
//   5. bound               — budget {remaining:0} and the same-step cycle both
//                            yield reshaped:false finding-only.

import { describe, expect, it } from 'vitest';
import { tryAssemble, tryCompile } from './harness.ts';
import {
  type SpecScore,
  applyStructure,
  boundScenarios,
  decomposedSeed,
  illegalRemainingSpec,
  reshapeRemaining,
  resolveStructure,
  scoreSpec,
  summarize,
  unequippedDecomposedSeed,
  wholeSeed,
} from './recompile-demonstrator.ts';

const verificationSurface = (s: SpecScore): number => s.verifyStageSteps + s.reviewStageSteps;
const slotDebt = (s: SpecScore): number => s.tally['work-step-without-skill-slots'];

describe('recompile demonstrator — equipment reshape (additive, the safest live case)', () => {
  it('reshapes, compiles, strictly reduces slot debt, and adds no new issue class', () => {
    // The unequipped decomposed seed is the realistic precondition: a relay that
    // assembly-time equipment resolution did not equip.
    const seed = unequippedDecomposedSeed();
    const before = scoreSpec(seed);
    // Precondition: there is slot debt to fix (otherwise the test proves nothing).
    expect(before.ok).toBe(true);
    expect(slotDebt(before)).toBeGreaterThan(0);

    const result = reshapeRemaining(
      seed,
      { from_step: 'act-step', kind: 'turned-out-react', evidence: 'confirmed React' },
      { remaining: 3, touched: new Set() },
    );

    expect(result.reshaped).toBe(true);
    if (!result.reshaped) throw new Error('expected an honored reshape');

    const after = scoreSpec(result.spec);
    // Compiles.
    expect(after.ok).toBe(true);
    // Slot debt strictly DECREASES.
    expect(slotDebt(after)).toBeLessThan(slotDebt(before));
    // No NEW issue class appears: every class count in `after` <= in `before`.
    for (const key of Object.keys(before.tally) as Array<keyof typeof before.tally>) {
      expect(after.tally[key]).toBeLessThanOrEqual(before.tally[key]);
    }
  });
});

describe('recompile demonstrator — decompose-down (adds verification surface)', () => {
  it('the decomposed seed has at least as much verify+review surface as the whole seed', () => {
    const whole = scoreSpec(wholeSeed());
    const decomposed = scoreSpec(decomposedSeed());
    expect(whole.ok).toBe(true);
    expect(decomposed.ok).toBe(true);
    // The whole grain folds away the auxiliary verify checks and the review
    // relay; the decomposed grain keeps them. So decompose-down never REDUCES
    // verification surface — the conservative direction.
    expect(verificationSurface(decomposed)).toBeGreaterThanOrEqual(verificationSurface(whole));
  });

  it('a turned-out-bigger reshape compiles and is honored', () => {
    const seed = wholeSeed();
    const result = reshapeRemaining(
      seed,
      {
        from_step: 'act-step',
        kind: 'turned-out-bigger',
        evidence: 'the act step found the change spans several independent units',
      },
      { remaining: 3, touched: new Set() },
    );
    expect(result.reshaped).toBe(true);
    if (!result.reshaped) throw new Error('expected an honored reshape');
    expect(scoreSpec(result.spec).ok).toBe(true);
  });
});

describe('recompile demonstrator — re-hold (finding-only, never auto-applied)', () => {
  it('refuses to reshape and the finding cites verification surface / finding-only', () => {
    const result = reshapeRemaining(
      decomposedSeed(),
      {
        from_step: 'act-step',
        kind: 're-hold',
        evidence: 'the planned slices collapsed into one trivial edit',
      },
      // Budget is available — re-hold is refused regardless.
      { remaining: 3, touched: new Set() },
    );
    expect(result.reshaped).toBe(false);
    if (result.reshaped) throw new Error('expected a finding-only outcome');
    expect(result.finding).toMatch(/verification surface|finding-only/i);
  });
});

describe('recompile demonstrator — safety floor (illegal reshape FAILS, no broken tail)', () => {
  it('returns a finding citing the safety floor and the underlying chain rejects', () => {
    const illegal = illegalRemainingSpec();
    const result = reshapeRemaining(
      illegal,
      { from_step: 'act-step', kind: 'turned-out-bigger', evidence: 'illegal' },
      { remaining: 3, touched: new Set() },
    );

    // The reshape FAILED rather than producing a broken tail.
    expect(result.reshaped).toBe(false);
    if (result.reshaped) throw new Error('expected the safety floor to reject the reshape');
    expect(result.finding).toMatch(/safety floor/i);

    // Prove the underlying pure chain rejects the post-resolve spec independently:
    // the assembler (or compiler) returns ok:false on the illegal shape.
    const resolved = applyStructure(
      illegal,
      resolveStructure({
        summary: 'illegal',
        surface_area: 'large',
        risk: 'medium',
        explicit_decompose: true,
      }),
    );
    const assembled = tryAssemble(resolved);
    const chainRejected = !assembled.ok || !tryCompile(assembled.schematic).ok;
    expect(chainRejected).toBe(true);
  });
});

describe('recompile demonstrator — bound (budget + cycle guard)', () => {
  it('budget {remaining:0} yields finding-only immediately', () => {
    const { zeroBudget } = boundScenarios();
    expect(zeroBudget.first.reshaped).toBe(false);
    if (zeroBudget.first.reshaped) throw new Error('expected a finding-only outcome');
    expect(zeroBudget.first.finding).toMatch(/budget exhausted|already reshaped/i);
  });

  it('a same-step cycle: the first reshape is honored, the second is finding-only', () => {
    const { sameStepCycle } = boundScenarios();
    expect(sameStepCycle.first.reshaped).toBe(true);
    expect(sameStepCycle.second).toBeDefined();
    expect(sameStepCycle.second?.reshaped).toBe(false);
    if (sameStepCycle.second?.reshaped) throw new Error('expected the cycle guard to refuse');
    expect(sameStepCycle.second?.finding).toMatch(/budget exhausted|already reshaped/i);
  });
});

describe('recompile demonstrator — summary (all conservative-default claims, with numbers)', () => {
  it('reports the three conservative-default claims as held and no selection-under-abundance', () => {
    const summary = summarize();

    // Claim 1: re-holding is always finding-only.
    expect(summary.conservativeDefaults.reHoldAlwaysFindingOnly).toBe(true);
    // Claim 2: decompose-down never reduces verification surface.
    expect(summary.conservativeDefaults.decomposeDownNeverReducesVerificationSurface).toBe(true);
    // Claim 3a: equipment reshape never adds an issue class (additive safety).
    expect(summary.conservativeDefaults.equipmentReshapeNeverAddsIssueClass).toBe(true);
    // Claim 3b: equipment reshape reduces slot debt where debt is present.
    expect(summary.conservativeDefaults.equipmentReshapeReducesSlotDebtWhenPresent).toBe(true);

    // The safety floor held: the illegal reshape failed and the chain rejected.
    expect(summary.safetyFloor.reshaped).toBe(false);
    expect(summary.safetyFloor.chainRejected).toBe(true);

    // Selection-under-abundance did NOT bite: no honored reshape made quality
    // strictly worse.
    expect(summary.selectionUnderAbundanceBit).toBe(false);

    // Every scenario was scored from the pure chain (ok before and after, except
    // the finding-only re-holds which leave the spec — and its score — unchanged).
    for (const s of summary.scenarios) {
      expect(s.before.ok).toBe(true);
      expect(s.after.ok).toBe(true);
    }
  });
});

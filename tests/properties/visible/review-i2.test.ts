import { describe, expect, it } from 'vitest';

import {
  type ReviewFinding,
  type ReviewFindingSeverity,
  ReviewResult,
  computeReviewVerdict,
} from '../../../src/flows/review/reports.js';

type Counts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function findingsFor(counts: Counts): ReviewFinding[] {
  const severities: ReviewFindingSeverity[] = [
    ...Array.from({ length: counts.critical }, () => 'critical' as const),
    ...Array.from({ length: counts.high }, () => 'high' as const),
    ...Array.from({ length: counts.medium }, () => 'medium' as const),
    ...Array.from({ length: counts.low }, () => 'low' as const),
  ];
  return severities.map((severity, index) => ({
    severity,
    id: `finding-${index}`,
    text: `${severity} finding ${index}`,
    file_refs: [`src/example-${index}.ts`],
  }));
}

describe('REVIEW-I2 verdict determinism property', () => {
  it('computes CLEAN iff every finding is severity low (or none) across randomized finding counts', () => {
    const next = lcg(0x52657677);
    for (let i = 0; i < 200; i++) {
      const counts = {
        critical: next() % 4,
        high: next() % 4,
        medium: next() % 4,
        low: next() % 6,
      };
      const findings = findingsFor(counts);
      const expected =
        counts.critical === 0 && counts.high === 0 && counts.medium === 0
          ? 'CLEAN'
          : 'ISSUES_FOUND';

      expect(computeReviewVerdict(findings)).toBe(expected);
      const prose = {
        assessment: `case ${i}: deterministic verdict assertion`,
        verification: ['Property check'],
        confidence_limitations: [],
      };
      expect(
        ReviewResult.safeParse({
          scope: `case ${i}`,
          findings,
          verdict: expected,
          outcome: expected === 'CLEAN' ? 'complete' : 'stopped',
          ...prose,
        }).success,
      ).toBe(true);

      const wrong = expected === 'CLEAN' ? 'ISSUES_FOUND' : 'CLEAN';
      // Give the invalid object an `outcome` consistent with its (wrong)
      // verdict so the outcome-vs-verdict refinement passes and the parse fails
      // for the reason this test guards: verdict must match the findings.
      expect(
        ReviewResult.safeParse({
          scope: `case ${i}`,
          findings,
          verdict: wrong,
          outcome: wrong === 'CLEAN' ? 'complete' : 'stopped',
          ...prose,
        }).success,
      ).toBe(false);
    }
  });
});

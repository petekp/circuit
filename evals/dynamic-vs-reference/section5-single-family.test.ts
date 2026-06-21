// Section-5 single-family honesty guard.
//
// classifyDynamicVsReference is a both-families rule (locked in decision-rule.test.ts,
// untouched here). On a --family fix run the absent build family's null aggregates
// make the locked rule return a spurious NOT-YET — a both-families verdict the run
// never earned. resolveSection5Outcome sits OUTSIDE the locked rule and reports the
// §5 verdict honestly: authoritative only when both families ran, INCONCLUSIVE
// otherwise, with the raw classification preserved for transparency.

import { describe, expect, it } from 'vitest';
import { type Classification, resolveSection5Outcome } from './run-dynamic-comparison.js';

const NOT_YET: Classification = {
  verdict: 'NOT-YET',
  reasons: ['build family null aggregates treated as failing'],
  predicates: {},
};
const WORTH: Classification = {
  verdict: 'WORTH-INVESTING',
  reasons: ['both families within margin, pipeline clean, fold pays'],
  predicates: {},
};

describe('resolveSection5Outcome — single-family honesty guard', () => {
  it('passes the real verdict through when BOTH families ran (authoritative)', () => {
    const out = resolveSection5Outcome({
      ranFamilies: new Set<'fix' | 'build'>(['fix', 'build']),
      classification: WORTH,
    });
    expect(out.authoritative).toBe(true);
    expect(out.verdict).toBe('WORTH-INVESTING');
    expect(out.ranFamilies).toEqual(['fix', 'build']);
  });

  it('reports INCONCLUSIVE on a fix-only run instead of the spurious NOT-YET', () => {
    const out = resolveSection5Outcome({
      ranFamilies: new Set<'fix' | 'build'>(['fix']),
      // What the locked both-families rule returns when build is absent.
      classification: NOT_YET,
    });
    expect(out.authoritative).toBe(false);
    expect(out.verdict).toContain('INCONCLUSIVE');
    expect(out.verdict).toContain('fix only');
    // The raw both-families verdict is preserved for transparency, not headlined.
    expect(out.classification.verdict).toBe('NOT-YET');
    expect(out.ranFamilies).toEqual(['fix']);
  });

  it('reports INCONCLUSIVE on a build-only run too', () => {
    const out = resolveSection5Outcome({
      ranFamilies: new Set<'fix' | 'build'>(['build']),
      classification: NOT_YET,
    });
    expect(out.authoritative).toBe(false);
    expect(out.verdict).toContain('INCONCLUSIVE');
    expect(out.verdict).toContain('build only');
    expect(out.ranFamilies).toEqual(['build']);
  });

  it('does not invent a verdict when no family ran', () => {
    const out = resolveSection5Outcome({
      ranFamilies: new Set<'fix' | 'build'>(),
      classification: NOT_YET,
    });
    expect(out.authoritative).toBe(false);
    expect(out.verdict).toContain('INCONCLUSIVE');
    expect(out.ranFamilies).toEqual([]);
  });

  it('keeps fix→build ordering regardless of insertion order', () => {
    const out = resolveSection5Outcome({
      ranFamilies: new Set<'fix' | 'build'>(['build', 'fix']),
      classification: WORTH,
    });
    expect(out.ranFamilies).toEqual(['fix', 'build']);
  });
});

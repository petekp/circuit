import { describe, expect, it } from 'vitest';
import { scoreProjectFactRelevance } from '../../src/app/history/query.js';

// Pins the weighting of the project-fact relevance scorer that run-start recall
// uses to rank stored facts against the run query. The scorer mirrors prior-run
// scoring: weighted term frequency (summary > facet > text) capped at 3, an
// exact-phrase bonus, and an adjacent-bigram bonus, with flat IDF.
describe('scoreProjectFactRelevance', () => {
  it('returns 0 when no query term appears in the fact', () => {
    const score = scoreProjectFactRelevance({
      query: 'dashboard filter rendering',
      summary: 'rotate the authentication secret',
      hintTexts: ['the token store needs a manual key rotation'],
      appliesTo: ['operator_note'],
    });
    expect(score).toBe(0);
  });

  it('returns 0 for an empty query', () => {
    const score = scoreProjectFactRelevance({
      query: '   ',
      summary: 'dashboard filter rendering regressed',
      hintTexts: ['re-renders on every keystroke'],
      appliesTo: ['context'],
    });
    expect(score).toBe(0);
  });

  it('weights a summary match above the same term in hint text only', () => {
    const inSummary = scoreProjectFactRelevance({
      query: 'dashboard',
      summary: 'the dashboard regressed',
      hintTexts: ['unrelated detail'],
      appliesTo: ['context'],
    });
    const inText = scoreProjectFactRelevance({
      query: 'dashboard',
      summary: 'unrelated headline',
      hintTexts: ['the dashboard regressed'],
      appliesTo: ['context'],
    });
    // summary field weight (4 -> capped 3) outranks text field weight (1).
    expect(inSummary).toBeGreaterThan(inText);
    expect(inText).toBeGreaterThan(0);
  });

  it('adds the exact-phrase bonus when the whole query appears verbatim', () => {
    const withPhrase = scoreProjectFactRelevance({
      query: 'dashboard filter',
      summary: 'the dashboard filter regressed',
      hintTexts: ['detail'],
      appliesTo: ['context'],
    });
    const scattered = scoreProjectFactRelevance({
      query: 'dashboard filter',
      summary: 'the filter and the dashboard regressed',
      hintTexts: ['detail'],
      appliesTo: ['context'],
    });
    // Same per-term frequency, but the verbatim phrase earns the +2 bonus.
    expect(withPhrase).toBeGreaterThan(scattered);
  });

  it('caps the contribution of a single repeated term', () => {
    const repeated = scoreProjectFactRelevance({
      query: 'filter',
      summary: 'filter filter filter filter filter',
      hintTexts: ['filter filter filter'],
      appliesTo: ['context'],
    });
    // Uncapped this term would weigh 5*4 + 3 = 23; the per-term min(., 3) bounds
    // its tf contribution to 3, plus the +2 verbatim-phrase bonus -> 5.
    expect(repeated).toBe(5);
  });
});

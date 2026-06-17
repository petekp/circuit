import { describe, expect, it } from 'vitest';

import {
  CONTEXT_PULL_BUDGET,
  type ContextPullSurface,
  createContextPuller,
  extractContextRequest,
} from '../../src/runtime/run/context-pull.js';

// On-demand context-pull — the typed-lookup channel, runtime half. These tests
// pin the per-run closure the live seam drives: a running step asks its parent
// for ONE named typed slice, and the channel resolves it against the parent's
// typed report or parks it as a finding. Pure + sync: the live seam materializes
// the surface (reading each queried parent's report) and the channel resolves
// against it, so it is unit-testable with a hand-built surface exactly like the
// offline demonstrator's PARENT_SURFACE (experiments/flow-lab/).

// A hand-built typed surface: parent step ids -> that step's typed report JSON.
function surface(): ContextPullSurface {
  return new Map<string, unknown>([
    ['digest', { key_claims: ['a', 'b', 'c'], figure_captions: ['fig1'] }],
    ['spec', { house_style: 'plain', section_outline: { intro: 'x', body: 'y' } }],
  ]);
}

const q = (from_step: string, field_path: string) => ({ from_step, field_path });

describe('extractContextRequest', () => {
  it('reads a well-formed context_request off a relay result body', () => {
    const request = extractContextRequest({
      verdict: 'accept',
      context_request: { queries: [{ from_step: 'digest', field_path: 'key_claims' }] },
    });
    expect(request).toEqual({ queries: [{ from_step: 'digest', field_path: 'key_claims' }] });
  });

  it('returns undefined for an absent, malformed, or non-object body', () => {
    // Absent key.
    expect(extractContextRequest({ verdict: 'accept' })).toBeUndefined();
    // Empty query list (min 1) — an empty pull is not a pull.
    expect(extractContextRequest({ context_request: { queries: [] } })).toBeUndefined();
    // A query missing its field_path (typed lookup names exactly one field).
    expect(
      extractContextRequest({ context_request: { queries: [{ from_step: 'digest' }] } }),
    ).toBeUndefined();
    expect(extractContextRequest(null)).toBeUndefined();
    expect(extractContextRequest('nope')).toBeUndefined();
  });
});

describe('createContextPuller — the per-run typed-lookup channel', () => {
  it('answers a targeted typed query with the named slice (value + bytes + source)', () => {
    const pull = createContextPuller();
    const out = pull({ fromStepId: 'act', query: q('digest', 'key_claims'), surface: surface() });
    expect(out.answered).toBe(true);
    if (!out.answered) return;
    expect(out.value).toEqual(['a', 'b', 'c']);
    expect(out.source).toBe('digest.key_claims');
    expect(out.bytes).toBe(JSON.stringify(['a', 'b', 'c']).length);
  });

  it('resolves a nested dotted path (a named contract field)', () => {
    const pull = createContextPuller();
    const out = pull({
      fromStepId: 'act',
      query: q('spec', 'section_outline.intro'),
      surface: surface(),
    });
    expect(out.answered).toBe(true);
    if (!out.answered) return;
    expect(out.value).toBe('x');
  });

  it('refuses an "everything"/untyped query as a finding (never answered)', () => {
    const pull = createContextPuller();
    for (const path of ['*', '', '   ']) {
      const out = pull({ fromStepId: 'act', query: q('digest', path), surface: surface() });
      expect(out.answered).toBe(false);
      if (out.answered) return;
      expect(out.finding).toMatch(/everything/i);
    }
  });

  it('bounds answered pulls by the per-run budget and degrades gracefully', () => {
    const pull = createContextPuller();
    // A surface with strictly more answerable fields than the budget allows.
    const big = new Map<string, unknown>([['p', { a: 1, b: 2, c: 3, d: 4 }]]);
    const keys = ['a', 'b', 'c', 'd'];
    let answered = 0;
    let exhausted = 0;
    for (const key of keys) {
      const out = pull({ fromStepId: 'act', query: q('p', key), surface: big });
      if (out.answered) {
        answered += 1;
      } else {
        expect(out.finding).toMatch(/budget/i);
        exhausted += 1;
      }
    }
    expect(answered).toBe(CONTEXT_PULL_BUDGET);
    expect(exhausted).toBe(keys.length - CONTEXT_PULL_BUDGET);
  });

  it('parks an unknown parent step as a finding (unanswerable, never throws)', () => {
    const pull = createContextPuller();
    const out = pull({ fromStepId: 'act', query: q('no-such-step', 'x'), surface: surface() });
    expect(out.answered).toBe(false);
    if (out.answered) return;
    expect(out.finding).toMatch(/no readable typed report/i);
  });

  it('refuses prototype-chain keys — they name no own field of the typed report', () => {
    // field_path is untrusted model free text. A bare object descent would
    // resolve '__proto__', 'constructor', 'toString', etc. up the JS prototype
    // chain and answer them as if they were real report fields. The typed-lookup
    // rail says a path must name ONE own field; these name none, so they park.
    const pull = createContextPuller();
    for (const path of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const out = pull({ fromStepId: 'act', query: q('digest', path), surface: surface() });
      expect(out.answered).toBe(false);
      if (out.answered) return;
      expect(out.finding).toMatch(/unanswerable/i);
    }
  });

  it('parks a missing field, or a non-object descent, as a finding (never throws)', () => {
    const pull = createContextPuller();
    const missing = pull({ fromStepId: 'act', query: q('digest', 'nope'), surface: surface() });
    expect(missing.answered).toBe(false);
    if (missing.answered) return;
    expect(missing.finding).toMatch(/unanswerable/i);

    // 'key_claims' is an array — descending INTO it ('.0') is a non-object descent
    // that resolveDottedPath throws on; the channel parks it rather than crashing.
    const nonObject = pull({
      fromStepId: 'act',
      query: q('digest', 'key_claims.0'),
      surface: surface(),
    });
    expect(nonObject.answered).toBe(false);
  });

  it('holds a per-step budget: a fresh puller starts full, independent of an exhausted one', () => {
    // The live seam builds one puller per asking step, so each step's budget is
    // its own. Exhausting one puller must not touch the budget of the next.
    const big = new Map<string, unknown>([['p', { a: 1, b: 2, c: 3, d: 4 }]]);
    const stepOne = createContextPuller();
    let stepOneAnswered = 0;
    for (const key of ['a', 'b', 'c', 'd']) {
      if (stepOne({ fromStepId: 'one', query: q('p', key), surface: big }).answered) {
        stepOneAnswered += 1;
      }
    }
    expect(stepOneAnswered).toBe(CONTEXT_PULL_BUDGET); // first puller drained to zero

    const stepTwo = createContextPuller();
    let stepTwoAnswered = 0;
    for (const key of ['a', 'b', 'c']) {
      if (stepTwo({ fromStepId: 'two', query: q('p', key), surface: big }).answered) {
        stepTwoAnswered += 1;
      }
    }
    expect(stepTwoAnswered).toBe(CONTEXT_PULL_BUDGET); // second puller had its own full budget
  });

  it('a refusal never spends the budget — only answered pulls draw down', () => {
    const pull = createContextPuller();
    // More refusals than the whole budget: none may consume it.
    for (let i = 0; i < CONTEXT_PULL_BUDGET + 2; i += 1) {
      const refused = pull({ fromStepId: 'act', query: q('digest', '*'), surface: surface() });
      expect(refused.answered).toBe(false);
    }
    // The full budget of real answers still all succeed.
    const big = new Map<string, unknown>([['p', { a: 1, b: 2, c: 3 }]]);
    let answered = 0;
    for (const key of ['a', 'b', 'c']) {
      const out = pull({ fromStepId: 'act', query: q('p', key), surface: big });
      if (out.answered) answered += 1;
    }
    expect(answered).toBe(CONTEXT_PULL_BUDGET);
  });
});

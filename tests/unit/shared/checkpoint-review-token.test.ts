import { describe, expect, it } from 'vitest';

import {
  decodeCheckpointReviewResponse,
  encodeCheckpointReviewResponse,
} from '../../../src/shared/checkpoint-review-token.js';

const RESPONSE = {
  schema: 'checkpoint.review-response@v1' as const,
  run_id: '11111111-1111-4111-8111-111111111111',
  step_id: 'prototype-variant-checkpoint-step',
  attempt: 1,
  request_sha256: 'a'.repeat(64),
  selection: 'variant-b',
  comments: [
    {
      scope: 'choice' as const,
      choice_id: 'variant-b',
      body: 'Keep the calm opening — it reads clearly on mobile.',
    },
    {
      scope: 'overall' as const,
      body: 'Use the shorter title. “Review” is enough.',
    },
  ],
};

describe('checkpoint review response tokens', () => {
  it('round-trips typed comments, including Unicode punctuation', () => {
    const token = encodeCheckpointReviewResponse(RESPONSE);

    expect(token).toMatch(/^ckr1\.[A-Za-z0-9_-]+$/);
    expect(decodeCheckpointReviewResponse(token)).toEqual(RESPONSE);
  });

  it('rejects malformed and wrong-version envelopes', () => {
    expect(() => decodeCheckpointReviewResponse('not-a-review')).toThrow('invalid envelope');
    expect(() => decodeCheckpointReviewResponse('ckr1.')).toThrow('no payload');

    const wrongVersion = `ckr1.${Buffer.from(
      JSON.stringify({ ...RESPONSE, schema: 'checkpoint.review-response@v2' }),
    ).toString('base64url')}`;
    expect(() => decodeCheckpointReviewResponse(wrongVersion)).toThrow();
  });

  it('enforces comment length before encoding', () => {
    expect(() =>
      encodeCheckpointReviewResponse({
        ...RESPONSE,
        comments: [{ scope: 'overall', body: 'x'.repeat(2_001) }],
      }),
    ).toThrow();
  });

  it('rejects a valid-looking response that would exceed the transport envelope', () => {
    expect(() =>
      encodeCheckpointReviewResponse({
        ...RESPONSE,
        comments: Array.from({ length: 24 }, () => ({
          scope: 'overall' as const,
          body: '界'.repeat(2_000),
        })),
      }),
    ).toThrow('exceeds 60000 UTF-8 bytes');
  });
});

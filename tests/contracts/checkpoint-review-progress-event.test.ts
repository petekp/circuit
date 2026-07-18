import { describe, expect, it } from 'vitest';

import { ProgressEvent } from '../../src/schemas/progress-event.js';

describe('checkpoint review session progress event', () => {
  it('carries the loopback review URL without exposing the completion secret', () => {
    const parsed = ProgressEvent.parse({
      schema_version: 1,
      type: 'checkpoint_review.ready',
      run_id: '11111111-1111-4111-8111-111111111111',
      flow_id: 'prototype',
      recorded_at: '2026-07-17T17:00:00.000Z',
      label: 'Checkpoint review is ready',
      display: {
        text: 'Circuit: Review the checkpoint in your browser.',
        importance: 'major',
        tone: 'checkpoint',
      },
      presentation: {
        block_id: '11111111-1111-4111-8111-111111111111',
        line_mode: 'append',
        status_text: 'Review the checkpoint in your browser.',
      },
      step_id: 'review-options',
      attempt: 1,
      review_url: 'http://127.0.0.1:43123/session-token/reports/operator-summary.html',
    });

    expect(parsed.type).toBe('checkpoint_review.ready');
    expect(parsed).not.toHaveProperty('authorization');
  });

  it('rejects non-loopback review URLs', () => {
    expect(() =>
      ProgressEvent.parse({
        schema_version: 1,
        type: 'checkpoint_review.ready',
        run_id: '11111111-1111-4111-8111-111111111111',
        flow_id: 'prototype',
        recorded_at: '2026-07-17T17:00:00.000Z',
        label: 'Checkpoint review is ready',
        display: {
          text: 'Circuit: Review the checkpoint in your browser.',
          importance: 'major',
          tone: 'checkpoint',
        },
        step_id: 'review-options',
        attempt: 1,
        review_url: 'https://example.com/review',
      }),
    ).toThrow();
  });
});

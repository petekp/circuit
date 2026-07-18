import { describe, expect, it, vi } from 'vitest';

import {
  isLocalCheckpointReviewUrl,
  openLocalCheckpointReview,
} from '../../src/cli/checkpoint-review-open.js';

describe('local checkpoint review opener', () => {
  it('accepts only an explicit loopback HTTP URL', () => {
    expect(
      isLocalCheckpointReviewUrl('http://127.0.0.1:43123/session/reports/operator-summary.html'),
    ).toBe(true);
    expect(isLocalCheckpointReviewUrl('https://127.0.0.1:43123/session')).toBe(false);
    expect(isLocalCheckpointReviewUrl('http://localhost:43123/session')).toBe(false);
    expect(isLocalCheckpointReviewUrl('http://example.com/session')).toBe(false);
    expect(isLocalCheckpointReviewUrl('file:///tmp/operator-summary.html')).toBe(false);
  });

  it('opens the explicit review URL without a shell', () => {
    const unref = vi.fn();
    const on = vi.fn();
    const spawn = vi.fn(() => ({ on, unref }));
    const url = 'http://127.0.0.1:43123/session/reports/operator-summary.html';

    expect(
      openLocalCheckpointReview(url, {
        platform: 'darwin',
        env: {},
        spawn,
      }),
    ).toBe(true);
    expect(spawn).toHaveBeenCalledWith('open', [url], {
      detached: true,
      stdio: 'ignore',
    });
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(unref).toHaveBeenCalledOnce();
  });

  it('honors explicit and CI opt-outs', () => {
    const spawn = vi.fn();
    const url = 'http://127.0.0.1:43123/session/reports/operator-summary.html';

    expect(
      openLocalCheckpointReview(url, {
        platform: 'darwin',
        env: { CIRCUIT_NO_AUTO_OPEN: '1' },
        spawn,
      }),
    ).toBe(false);
    expect(
      openLocalCheckpointReview(url, {
        platform: 'darwin',
        env: { CI: 'true' },
        spawn,
      }),
    ).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not try xdg-open without a Linux display', () => {
    const spawn = vi.fn();
    expect(
      openLocalCheckpointReview('http://127.0.0.1:43123/session/reports/operator-summary.html', {
        platform: 'linux',
        env: {},
        spawn,
      }),
    ).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

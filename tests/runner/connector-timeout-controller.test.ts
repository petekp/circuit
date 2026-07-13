import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTimeoutController, describeTimeout } from '../../src/connectors/subprocess.js';

// The timer policy behind the connector inactivity timeout, tested in isolation
// with fake timers so the state machine is proven deterministically (the
// real-subprocess wiring is covered separately in connector-subprocess.test.ts).
//
// Two bounds guard every CLI-agent relay:
//   - an ABSOLUTE backstop that never resets (a hard ceiling on total wall time)
//   - an optional INACTIVITY bound reset on every byte of output (silence, not
//     total time, is what a hung agent looks like when it streams progress)
// The controller decides which bound elapsed first and fires exactly once.

describe('createTimeoutController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the inactivity bound after idleMs of silence', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 100_000,
      idleMs: 1_000,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity(); // arm at spawn
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(fired).toEqual(['idle']);
  });

  it('resets the inactivity countdown on every activity', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 100_000,
      idleMs: 1_000,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity();
    // Five bursts of activity 900ms apart: 4500ms total elapsed but never a
    // full 1000ms of silence, so the inactivity bound must not fire.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      controller.onActivity();
    }
    expect(fired).toEqual([]);
    // Now go silent past the window.
    vi.advanceTimersByTime(1_001);
    expect(fired).toEqual(['idle']);
  });

  it('fires the absolute backstop even under continuous activity', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 5_000,
      idleMs: 1_000,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity();
    // Stream every 500ms so the inactivity bound keeps resetting; the absolute
    // ceiling still fires at 5000ms.
    for (let t = 0; t < 5_000; t += 500) {
      vi.advanceTimersByTime(500);
      controller.onActivity();
    }
    expect(fired).toEqual(['absolute']);
  });

  it('fires at most once, earliest bound wins', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 1_000,
      idleMs: 500,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity();
    vi.advanceTimersByTime(10_000);
    // Inactivity (500ms) elapses before the absolute (1000ms); the later bound
    // must be suppressed.
    expect(fired).toEqual(['idle']);
  });

  it('with no idleMs supplied, only the absolute backstop can fire', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 1_000,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity(); // no inactivity bound to arm
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(fired).toEqual(['absolute']);
  });

  it('clear() cancels every pending bound', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 1_000,
      idleMs: 500,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity();
    controller.clear();
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it('onActivity after clear() does not resurrect the inactivity timer', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 10_000,
      idleMs: 500,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity();
    controller.clear();
    controller.onActivity(); // must be inert
    vi.advanceTimersByTime(5_000);
    expect(fired).toEqual([]);
  });

  it('onActivity after a fire does not re-arm the inactivity timer', () => {
    const fired: string[] = [];
    const controller = createTimeoutController({
      absoluteMs: 10_000,
      idleMs: 500,
      onFire: (kind) => fired.push(kind),
    });
    controller.onActivity();
    vi.advanceTimersByTime(501); // idle fires
    expect(fired).toEqual(['idle']);
    controller.onActivity(); // late byte arriving during SIGTERM grace
    vi.advanceTimersByTime(5_000);
    expect(fired).toEqual(['idle']); // still just the one fire
  });
});

describe('describeTimeout', () => {
  it('names the inactivity bound and its per-step remedy when the idle window elapsed', () => {
    expect(
      describeTimeout({ timeoutKind: 'idle' }, { idleMs: 180_000, absoluteMs: 3_600_000 }),
    ).toBe(
      'no output for 180000ms (inactivity; a step that legitimately goes silent longer can raise budgets.inactivity_ms)',
    );
  });

  it('names the wall-clock backstop when the absolute ceiling elapsed', () => {
    expect(
      describeTimeout({ timeoutKind: 'absolute' }, { idleMs: 180_000, absoluteMs: 3_600_000 }),
    ).toBe('exceeded the 3600000ms wall-clock backstop');
  });

  it('falls back to the backstop wording when no idle bound was configured', () => {
    // An absolute-only connector (custom, health) never sets idleMs, so an idle
    // kind cannot arise; the wording still resolves to the wall-clock backstop.
    expect(describeTimeout({ timeoutKind: 'idle' }, { absoluteMs: 20 })).toBe(
      'exceeded the 20ms wall-clock backstop',
    );
  });

  it('falls back to the backstop wording when timeoutKind is absent', () => {
    expect(describeTimeout({}, { idleMs: 180_000, absoluteMs: 3_600_000 })).toBe(
      'exceeded the 3600000ms wall-clock backstop',
    );
  });
});

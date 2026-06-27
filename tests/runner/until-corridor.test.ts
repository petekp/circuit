import { describe, expect, it } from 'vitest';

import type { UntilLoopEngineFlag } from '../../src/flows/types.js';
import { UntilCorridor } from '../../src/runtime/run/until-corridor.js';

const FLAG: UntilLoopEngineFlag = {
  headStep: 'loop-head',
  tailStep: 'loop-tail',
  bodySteps: ['loop-head', 'loop-body', 'loop-tail'],
  reenterRoute: 'reenter',
  maxIterations: 3,
  activateWhenDepthAtLeast: 'autonomous',
};

function corridor(input: {
  flag?: UntilLoopEngineFlag | undefined;
  depth?: string | undefined;
}): UntilCorridor {
  return new UntilCorridor({
    flag: 'flag' in input ? input.flag : FLAG,
    depth: 'depth' in input ? input.depth : 'autonomous',
  });
}

describe('UntilCorridor activation', () => {
  it('is inert when the flow has no until-loop flag', () => {
    const c = corridor({ flag: undefined });
    expect(c.isActive()).toBe(false);
    expect(c.isLoopBodyStep('loop-head')).toBe(false);
    expect(c.countKey('loop-head', 0)).toBe('loop-head');
  });

  it('is inert below the depth floor (high < autonomous)', () => {
    const c = corridor({ depth: 'high' });
    expect(c.isActive()).toBe(false);
    expect(c.isLoopBodyStep('loop-body')).toBe(false);
    expect(c.countKey('loop-body', 2)).toBe('loop-body');
  });

  it('is inert with no depth (defaults to standard)', () => {
    const c = corridor({ depth: undefined });
    expect(c.isActive()).toBe(false);
  });

  it('activates only at the floor (autonomous)', () => {
    expect(corridor({ depth: 'autonomous' }).isActive()).toBe(true);
    expect(corridor({ depth: 'tournament' }).isActive()).toBe(false);
  });
});

describe('UntilCorridor isLoopBodyStep', () => {
  it('is true for EVERY body step, not just head and tail', () => {
    const c = corridor({});
    expect(c.isLoopBodyStep('loop-head')).toBe(true);
    // The intermediate step is the generalization the slice loop lacks: it must
    // also count as a body step, or it aborts as an illegal re-entry on pass 2.
    expect(c.isLoopBodyStep('loop-body')).toBe(true);
    expect(c.isLoopBodyStep('loop-tail')).toBe(true);
    expect(c.isLoopBodyStep('plan-step')).toBe(false);
  });
});

describe('UntilCorridor countKey', () => {
  it('iteration-scopes every body step and leaves non-loop steps bare', () => {
    const c = corridor({});
    expect(c.countKey('loop-head', 0)).toBe('loop-head#i0');
    expect(c.countKey('loop-body', 0)).toBe('loop-body#i0');
    expect(c.countKey('loop-tail', 1)).toBe('loop-tail#i1');
    expect(c.countKey('plan-step', 0)).toBe('plan-step');
  });
});

describe('UntilCorridor re-enter', () => {
  it('re-enters at the tail forward route until the iteration cap, then stops', () => {
    const c = corridor({});
    // iteration 0 -> forward exit, 2 more iterations allowed.
    expect(c.shouldReenter({ stepId: 'loop-tail', route: 'pass' })).toBe(true);
    expect(c.advance()).toBe('loop-head');
    expect(c.currentIterationIndex()).toBe(1);
    expect(c.shouldReenter({ stepId: 'loop-tail', route: 'pass' })).toBe(true);
    c.advance();
    // iteration 2 is the last; no further re-enter (index+1 === maxIterations).
    expect(c.currentIterationIndex()).toBe(2);
    expect(c.shouldReenter({ stepId: 'loop-tail', route: 'pass' })).toBe(false);
  });

  it('does not re-enter on the re-enter route itself (in-iteration loop-back)', () => {
    const c = corridor({});
    expect(c.shouldReenter({ stepId: 'loop-tail', route: 'reenter' })).toBe(false);
  });

  it('does not re-enter for a non-tail step', () => {
    const c = corridor({});
    expect(c.shouldReenter({ stepId: 'loop-head', route: 'pass' })).toBe(false);
    expect(c.shouldReenter({ stepId: 'loop-body', route: 'pass' })).toBe(false);
  });

  it('never re-enters when inert', () => {
    const c = corridor({ depth: 'high' });
    expect(c.shouldReenter({ stepId: 'loop-tail', route: 'pass' })).toBe(false);
  });

  it('runs a single pass when maxIterations is 1', () => {
    const c = new UntilCorridor({
      flag: { ...FLAG, maxIterations: 1 },
      depth: 'autonomous',
    });
    expect(c.shouldReenter({ stepId: 'loop-tail', route: 'pass' })).toBe(false);
  });

  it('throws when advance is called without a flag', () => {
    const c = corridor({ flag: undefined });
    expect(() => c.advance()).toThrow('without an until-loop flag');
  });
});

describe('UntilCorridor recordProgressMarker (slice 6 no-progress)', () => {
  it('never counts the first observed marker as a stall', () => {
    const c = corridor({});
    expect(c.recordProgressMarker(3)).toBe(0);
  });

  it('counts consecutive unchanged markers as stalls', () => {
    const c = corridor({});
    expect(c.recordProgressMarker(3)).toBe(0); // first
    expect(c.recordProgressMarker(3)).toBe(1); // stalled once
    expect(c.recordProgressMarker(3)).toBe(2); // stalled twice
  });

  it('resets the stall run when the marker changes', () => {
    const c = corridor({});
    c.recordProgressMarker(3);
    expect(c.recordProgressMarker(3)).toBe(1);
    expect(c.recordProgressMarker(2)).toBe(0); // progress: count resets
    expect(c.recordProgressMarker(2)).toBe(1); // stalled again from the new value
  });

  it('compares markers by value, not reference (objects, strings)', () => {
    const c = corridor({});
    expect(c.recordProgressMarker({ remaining: 4 })).toBe(0);
    expect(c.recordProgressMarker({ remaining: 4 })).toBe(1); // structurally equal
    expect(c.recordProgressMarker({ remaining: 3 })).toBe(0); // structurally different
  });

  it('treats a persistently absent marker as no progress', () => {
    // progressPath set but the judge never writes it: undefined every pass reads
    // as a stall after the first, so the ceiling can still bound a marker-less loop.
    const c = corridor({});
    expect(c.recordProgressMarker(undefined)).toBe(0);
    expect(c.recordProgressMarker(undefined)).toBe(1);
  });
});

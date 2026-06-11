import { describe, expect, it } from 'vitest';

import type { SliceLoopEngineFlag } from '../../src/flows/types.js';
import { SliceCorridor } from '../../src/runtime/run/slice-corridor.js';

const FLAG: SliceLoopEngineFlag = {
  headStep: 'act-step',
  tailStep: 'verify-step',
  advanceRoute: 'advance',
  slicesFrom: { report: 'reports/build/plan.json', itemsPath: 'slices' },
  maxSlices: 8,
  activateWhenDepthAtLeast: 'high',
};

const SLICES = [
  { id: 'slice-1', intent: 'scaffold', anticipated_file_extensions: ['.ts'] },
  { id: 'slice-2', intent: 'wire', anticipated_file_extensions: ['.ts'] },
  { id: 'slice-3', intent: 'test', anticipated_file_extensions: ['.test.ts'] },
];

function corridor(input: {
  flag?: SliceLoopEngineFlag | undefined;
  depth?: string | undefined;
  slices?: readonly unknown[];
}): SliceCorridor {
  return new SliceCorridor({
    flag: 'flag' in input ? input.flag : FLAG,
    depth: 'depth' in input ? input.depth : 'high',
    readSlices: async () => input.slices ?? SLICES,
  });
}

describe('SliceCorridor activation', () => {
  it('is inert when the flow has no slice-loop flag', () => {
    const c = corridor({ flag: undefined });
    expect(c.isActive()).toBe(false);
    expect(c.isLoopBodyStep('act-step')).toBe(false);
    expect(c.countKey('act-step', 0)).toBe('act-step');
  });

  it('is inert below the depth floor (standard < deep)', () => {
    const c = corridor({ depth: 'medium' });
    expect(c.isActive()).toBe(false);
    expect(c.countKey('act-step', 2)).toBe('act-step');
  });

  it('is inert with no depth (defaults to standard)', () => {
    const c = corridor({ depth: undefined });
    expect(c.isActive()).toBe(false);
  });

  it('activates at the floor (deep) and above (autonomous)', () => {
    expect(corridor({ depth: 'high' }).isActive()).toBe(true);
    expect(corridor({ depth: 'autonomous' }).isActive()).toBe(true);
  });
});

describe('SliceCorridor slice list', () => {
  it('lazily loads slices and is idempotent', async () => {
    let reads = 0;
    const c = new SliceCorridor({
      flag: FLAG,
      depth: 'high',
      readSlices: async () => {
        reads += 1;
        return SLICES;
      },
    });
    expect(c.sliceCount()).toBe(0);
    await c.ensureInitialized();
    await c.ensureInitialized();
    expect(reads).toBe(1);
    expect(c.sliceCount()).toBe(3);
    expect((c.currentSlice() as { id: string }).id).toBe('slice-1');
  });

  it('caps the slice list at maxSlices', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `slice-${i}` }));
    const c = corridor({ slices: many });
    await c.ensureInitialized();
    expect(c.sliceCount()).toBe(FLAG.maxSlices);
  });

  it('does not read slices when inert', async () => {
    let reads = 0;
    const c = new SliceCorridor({
      flag: FLAG,
      depth: 'medium',
      readSlices: async () => {
        reads += 1;
        return SLICES;
      },
    });
    await c.ensureInitialized();
    expect(reads).toBe(0);
    expect(c.sliceCount()).toBe(0);
  });
});

describe('SliceCorridor countKey', () => {
  it('slice-scopes loop-body steps and leaves non-loop steps bare', () => {
    const c = corridor({});
    expect(c.countKey('act-step', 0)).toBe('act-step#s0');
    expect(c.countKey('verify-step', 2)).toBe('verify-step#s2');
    expect(c.countKey('plan-step', 0)).toBe('plan-step');
    expect(c.countKey('review-step', 0)).toBe('review-step');
  });
});

describe('SliceCorridor advance', () => {
  it('advances at the tail forward route while slices remain, then stops at the last', async () => {
    const c = corridor({});
    await c.ensureInitialized();
    // slice 0 -> forward to review (a non-head step) with 2 more slices.
    expect(c.shouldAdvance({ stepId: 'verify-step', targetStepId: 'review-step' })).toBe(true);
    expect(c.advance()).toBe('act-step');
    expect(c.currentSliceIndex()).toBe(1);
    expect(c.shouldAdvance({ stepId: 'verify-step', targetStepId: 'review-step' })).toBe(true);
    c.advance();
    // slice 2 is the last; no further advance.
    expect(c.currentSliceIndex()).toBe(2);
    expect(c.shouldAdvance({ stepId: 'verify-step', targetStepId: 'review-step' })).toBe(false);
    expect((c.currentSlice() as { id: string }).id).toBe('slice-3');
  });

  it('does not advance on a retry back to the head step (in-slice recovery)', async () => {
    const c = corridor({});
    await c.ensureInitialized();
    expect(c.shouldAdvance({ stepId: 'verify-step', targetStepId: 'act-step' })).toBe(false);
  });

  it('does not advance on a terminal route (stop)', async () => {
    const c = corridor({});
    await c.ensureInitialized();
    expect(c.shouldAdvance({ stepId: 'verify-step', targetStepId: undefined })).toBe(false);
  });

  it('does not advance for a non-tail step', async () => {
    const c = corridor({});
    await c.ensureInitialized();
    expect(c.shouldAdvance({ stepId: 'act-step', targetStepId: 'verify-step' })).toBe(false);
  });

  it('never advances when inert', async () => {
    const c = corridor({ depth: 'medium' });
    await c.ensureInitialized();
    expect(c.shouldAdvance({ stepId: 'verify-step', targetStepId: 'review-step' })).toBe(false);
  });
});

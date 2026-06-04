// The slice-corridor state machine.
//
// Under deep rigor, Build implements and verifies the plan's slices one at a
// time. This object owns the slice-loop lifecycle the graph-runner loop
// consults: which steps form the loop body, which completedStepCounts key a
// loop-body step uses (slice-scoped, so re-entering for the next slice reads
// as a fresh attempt rather than an illegal cycle), whether a completed tail
// step should advance to the next slice, and which slice's metadata to
// surface to the worker.
//
// Modeled on RecoveryCorridor: pure decisions plus one injected async reader
// for the lazy slice-list load. It performs no IO of its own. See
// docs/ideas/build-slice-decomposition.md.

import type { SliceLoopEngineFlag } from '../../flows/types.js';

// Depth labels ordered least-to-most thorough. The slice loop only activates
// at or above the flag's activateWhenDepthAtLeast.
const DEPTH_ORDER = ['lite', 'standard', 'deep', 'tournament', 'autonomous'] as const;

function depthAtLeast(depth: string | undefined, floor: string): boolean {
  const current = DEPTH_ORDER.indexOf((depth ?? 'standard') as (typeof DEPTH_ORDER)[number]);
  const minimum = DEPTH_ORDER.indexOf(floor as (typeof DEPTH_ORDER)[number]);
  if (current < 0 || minimum < 0) return false;
  return current >= minimum;
}

export interface SliceCorridorDeps {
  // The flow's slice-loop flag, or undefined when the flow has no slice loop.
  readonly flag: SliceLoopEngineFlag | undefined;
  // The run's effective depth label (context.depth).
  readonly depth: string | undefined;
  // Lazily reads the ordered slice array from the flag's slicesFrom report.
  // Called once on first activation; should return [] when unreadable/absent.
  readonly readSlices: () => Promise<readonly unknown[]>;
}

export class SliceCorridor {
  private readonly flag: SliceLoopEngineFlag | undefined;
  private readonly activeForDepth: boolean;
  private slices: readonly unknown[] | undefined;
  private index = 0;

  constructor(private readonly deps: SliceCorridorDeps) {
    this.flag = deps.flag;
    this.activeForDepth =
      deps.flag !== undefined && depthAtLeast(deps.depth, deps.flag.activateWhenDepthAtLeast);
  }

  // True when this flow has a slice loop AND the run's depth activates it.
  // Every method below is inert (single-pass behavior) when this is false.
  isActive(): boolean {
    return this.activeForDepth;
  }

  // True when stepId is the loop body's head or tail step.
  isLoopBodyStep(stepId: string): boolean {
    if (!this.activeForDepth || this.flag === undefined) return false;
    return stepId === this.flag.headStep || stepId === this.flag.tailStep;
  }

  // Lazily load the ordered slice list (idempotent), capped at maxSlices.
  async ensureInitialized(): Promise<void> {
    if (!this.activeForDepth || this.flag === undefined || this.slices !== undefined) return;
    const raw = await this.deps.readSlices();
    this.slices = raw.slice(0, this.flag.maxSlices);
  }

  sliceCount(): number {
    return this.slices?.length ?? 0;
  }

  currentSliceIndex(): number {
    return this.index;
  }

  currentSlice(): unknown | undefined {
    return this.slices?.[this.index];
  }

  // The completedStepCounts key for a step at a given slice index:
  // slice-scoped for loop-body steps when active, else the bare stepId. The
  // caller passes the index that applies to the entry being keyed (the live
  // index for the incoming guard / target guard; a captured snapshot for the
  // step's own trace + completion count, taken before any advance).
  countKey(stepId: string, sliceIndex: number): string {
    if (!this.activeForDepth || !this.isLoopBodyStep(stepId)) return stepId;
    return `${stepId}#s${sliceIndex}`;
  }

  // True when the just-completed tail step took its forward route (to a step
  // that is not the loop head) and more slices remain. The caller resolves
  // the route's target step id (undefined for a terminal route).
  shouldAdvance(input: { stepId: string; targetStepId: string | undefined }): boolean {
    if (!this.activeForDepth || this.flag === undefined) return false;
    if (input.stepId !== this.flag.tailStep) return false;
    // A terminal route (e.g. stop) is not a slice advance.
    if (input.targetStepId === undefined) return false;
    // A route back to the head step is an in-slice recovery retry, not an
    // advance to the next slice.
    if (input.targetStepId === this.flag.headStep) return false;
    return this.index + 1 < this.sliceCount();
  }

  // Advance to the next slice; returns the head step id to re-enter.
  advance(): string {
    if (this.flag === undefined) {
      throw new Error('SliceCorridor.advance called without a slice-loop flag');
    }
    this.index += 1;
    return this.flag.headStep;
  }
}

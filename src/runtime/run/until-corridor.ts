// The until-corridor state machine.
//
// An until-loop re-enters its body once per iteration until a stop condition
// holds: a while loop for flows, the third control shape after run-once and the
// counted for-each of the slice loop. This object owns the loop lifecycle the
// graph-runner consults: which steps form the body, which completedStepCounts
// key a body step uses (iteration-scoped, so re-entering for the next iteration
// reads as a fresh attempt rather than an illegal cycle), and whether a
// completed tail step should re-enter the head for another iteration.
//
// Forked from SliceCorridor with three generalizations:
//   - isLoopBodyStep is true for ANY step in the body span, not just head and
//     tail. The slice loop's head and tail are adjacent, so it only scopes those
//     two; an until-loop body can hold intermediate steps, and every one needs
//     the iteration-scoped key or the first intermediate step aborts as an
//     illegal re-entry on the second pass.
//   - countKey keys on the iteration index (#i) rather than a slice index (#s).
//   - the count-driven slice advance becomes a count-driven re-enter: there is
//     no precomputed list to exhaust, so the loop runs until maxIterations.
//
// Two advance modes, both pure (no IO): a flag with no stopJudge runs the
// count-driven slice-1 form (shouldReenter/advance, a fixed maxIterations); a
// flag with a stopJudge runs the slice-2 form (disposeIteration), where the
// caller reads the tail's goal-met proposal and an evidence signal and the
// corridor decides stop-clean / reenter / needs-attention. The honesty ledger
// that backs the evidence floor with latch state is a later slice. See
// docs/ideas/until-loop.md.

import type { UntilLoopEngineFlag } from '../../flows/types.js';

// What the engine does at the tail seam after disposing the stop-judge's
// proposal against the evidence floor:
//   - 'stop-clean'      honor the tail's forward route and exit the loop cleanly
//   - 'reenter'         redirect to reenterRoute and advance() (loop back)
//   - 'needs-attention' redirect to needsAttentionRoute (bounded exhaustion)
export type UntilDisposition = 'stop-clean' | 'reenter' | 'needs-attention';

// CompiledDepth labels ordered least-to-most thorough. The until loop only
// activates at or above the flag's activateWhenDepthAtLeast. Duplicated from
// slice-corridor.ts so the fork stays self-contained; neither is exported.
const DEPTH_ORDER = ['low', 'medium', 'high', 'tournament', 'autonomous'] as const;

function depthAtLeast(depth: string | undefined, floor: string): boolean {
  const current = DEPTH_ORDER.indexOf((depth ?? 'medium') as (typeof DEPTH_ORDER)[number]);
  const minimum = DEPTH_ORDER.indexOf(floor as (typeof DEPTH_ORDER)[number]);
  if (current < 0 || minimum < 0) return false;
  return current >= minimum;
}

export interface UntilCorridorDeps {
  // The flow's until-loop flag, or undefined when the flow has no until loop.
  readonly flag: UntilLoopEngineFlag | undefined;
  // The run's effective depth label (context.depth).
  readonly depth: string | undefined;
}

export class UntilCorridor {
  private readonly flag: UntilLoopEngineFlag | undefined;
  private readonly activeForDepth: boolean;
  private readonly bodySteps: ReadonlySet<string>;
  private index = 0;
  // Slice 6 (no-progress steering). The engine treats the judge's progress
  // marker as OPAQUE: it serializes it and compares only for equality across
  // iterations, never interpreting the value. `lastMarker` holds the prior
  // iteration's serialized marker, `observed` distinguishes "no prior marker
  // yet" from "prior marker was absent", and `consecutiveNoProgress` counts how
  // many iterations in a row left the marker unchanged.
  private lastMarker: string | undefined;
  private observedMarker = false;
  private consecutiveNoProgress = 0;

  constructor(deps: UntilCorridorDeps) {
    this.flag = deps.flag;
    this.activeForDepth =
      deps.flag !== undefined && depthAtLeast(deps.depth, deps.flag.activateWhenDepthAtLeast);
    this.bodySteps = new Set(deps.flag?.bodySteps ?? []);
  }

  // True when this flow has an until loop AND the run's depth activates it.
  // Every method below is inert (single-pass behavior) when this is false.
  isActive(): boolean {
    return this.activeForDepth;
  }

  // True when stepId is any step in the loop body span (head, tail, or an
  // intermediate). This is the generalization the slice loop lacks.
  isLoopBodyStep(stepId: string): boolean {
    if (!this.activeForDepth) return false;
    return this.bodySteps.has(stepId);
  }

  currentIterationIndex(): number {
    return this.index;
  }

  // The completedStepCounts key for a body step at a given iteration index:
  // iteration-scoped for loop-body steps when active, else the bare stepId. The
  // caller passes the index that applies to the entry being keyed (the live
  // index for the incoming guard / target guard; a captured snapshot for the
  // step's own trace + completion count, taken before any re-enter advance).
  countKey(stepId: string, iterationIndex: number): string {
    if (!this.activeForDepth || !this.isLoopBodyStep(stepId)) return stepId;
    return `${stepId}#i${iterationIndex}`;
  }

  // True when the just-completed tail step took a forward (non-re-enter) route
  // and the iteration count has not yet reached maxIterations. The caller has
  // already resolved the route the tail selected; a route that is itself the
  // re-enter route is an in-iteration loop-back, not a fresh forward exit.
  shouldReenter(input: { stepId: string; route: string }): boolean {
    if (!this.activeForDepth || this.flag === undefined) return false;
    if (input.stepId !== this.flag.tailStep) return false;
    if (input.route === this.flag.reenterRoute) return false;
    return this.index + 1 < this.flag.maxIterations;
  }

  // True when at least one more iteration is allowed within the cap. The
  // abort-intercept consults this to decide whether an exhausted body step
  // re-enters a fresh iteration or, at the cap, exits to needs-attention. Same
  // cap arithmetic as disposeIteration so the two never disagree about when the
  // loop is out of iterations.
  canReenter(): boolean {
    if (!this.activeForDepth || this.flag === undefined) return false;
    return this.index + 1 < this.flag.maxIterations;
  }

  // Advance to the next iteration; returns the head step id to re-enter.
  advance(): string {
    if (this.flag === undefined) {
      throw new Error('UntilCorridor.advance called without an until-loop flag');
    }
    this.index += 1;
    return this.flag.headStep;
  }

  // Slice 2: dispose the tail's goal-met proposal against an independent evidence
  // signal, within the iteration cap. Pure — the caller reads the judge boolean
  // (goalProposed) and computes evidenceConfirms, then acts on the disposition.
  //
  // The honest core is two rules, in order:
  //   1. A clean stop happens ONLY on a goal the evidence confirms. The judge's
  //      claim alone is never enough; a met-claim the evidence rejects is a
  //      blocked false-done that falls through to rule 2.
  //   2. Anything not a confirmed stop wants another pass, but the iteration cap
  //      bounds it. At the cap the loop exits to needs-attention, never to a
  //      clean stop: the loop never reports done by running out of iterations.
  // This keeps "the loop succeeded" unreachable through exhaustion, and a
  // hallucinating judge cannot end the loop on a claim the engine cannot back.
  disposeIteration(input: { goalProposed: boolean; evidenceConfirms: boolean }): UntilDisposition {
    if (input.goalProposed && input.evidenceConfirms) return 'stop-clean';
    const maxIterations = this.flag?.maxIterations ?? 0;
    if (this.index + 1 >= maxIterations) return 'needs-attention';
    return 'reenter';
  }

  // Slice 6: record this iteration's opaque progress marker and report how many
  // iterations IN A ROW have left it unchanged. The engine never interprets the
  // marker; it serializes it and compares for equality only. The first observed
  // marker can never be a stall (there is nothing to compare it to), so it
  // returns 0. A changed marker resets the run to 0; an unchanged marker
  // increments it. The caller uses the count to attach a first-stall steer (== 1)
  // and to exit at the no-progress ceiling.
  recordProgressMarker(marker: unknown): number {
    const serialized = JSON.stringify(marker);
    if (!this.observedMarker) {
      this.observedMarker = true;
      this.lastMarker = serialized;
      this.consecutiveNoProgress = 0;
      return 0;
    }
    if (serialized === this.lastMarker) {
      this.consecutiveNoProgress += 1;
    } else {
      this.consecutiveNoProgress = 0;
      this.lastMarker = serialized;
    }
    return this.consecutiveNoProgress;
  }
}

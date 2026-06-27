// The honesty ledger and the finalize chokepoint.
//
// An until-loop that can recover from a worker overclaim (a relay that claimed
// to change files the working tree does not show, or a body step whose in-step
// retries exhausted) must not abort the whole run on the first failure. Under
// the flag it latches the failure, carries a correction note forward, and
// re-enters the loop to try again. But it must never report the loop done while
// a latch is still open. The ledger holds those open latches; the finalize
// chokepoint at the close path reads them, so a clean `complete` is impossible
// while any latch is open. This extends the existing "a run never closes
// complete by exhaustion" invariant (src/app/run-envelope/continuation-loop.ts)
// to the body loop and to open overclaims.
//
// The latch set is small (a handful of open overclaims at most), so the whole
// ledger is rewritten atomically on each change rather than appended line by
// line. The atomic write (stage to a temp file, validate, rename) means a crash
// never leaves a torn ledger: the file on disk is always a complete prior state
// or the complete new one. The durable file is write-through state for crash
// inspection; reading it back to reconstruct a resumed run is a later slice
// (until-loop resume stays fenced for now).

import { writeJsonAtomic } from '../../shared/atomic-io.js';

// One open latch: a body step that overclaimed or exhausted its in-step retries
// this iteration, recorded with the iteration it last failed on and a plain
// reason. Keyed by stepId so a step that fails across several iterations holds a
// single latch carrying its latest failure, not one per attempt.
export interface OverclaimLatch {
  readonly stepId: string;
  readonly iterationIndex: number;
  readonly reason: string;
}

interface HonestyLedgerState {
  readonly open_overclaims: readonly OverclaimLatch[];
}

export interface HonestyLedgerDeps {
  // Run-folder path for the durable mirror. Omitted in unit tests and on any
  // run that does not want a durable file: the ledger is then in-memory only.
  readonly path?: string;
}

export class HonestyLedger {
  private readonly latches = new Map<string, OverclaimLatch>();
  private readonly path: string | undefined;

  constructor(deps: HonestyLedgerDeps = {}) {
    this.path = deps.path;
  }

  // Open or refresh a step's latch. A step that overclaims on iteration 0 and
  // again on iteration 2 holds a single latch recording iteration 2 — the loop
  // tracks "this step is still unresolved", not a history of every failure.
  latchOverclaim(input: OverclaimLatch): void {
    this.latches.set(input.stepId, { ...input });
    this.persist();
  }

  // Clear a step's latch — called when a later iteration re-runs that step and
  // its honesty check passes clean. Clearing a step that holds no latch is a
  // no-op (it never overclaimed, or was already cleared), so callers can clear
  // unconditionally after a clean body step.
  clearLatch(stepId: string): void {
    if (this.latches.delete(stepId)) this.persist();
  }

  hasOpenLatches(): boolean {
    return this.latches.size > 0;
  }

  openLatches(): readonly OverclaimLatch[] {
    return [...this.latches.values()];
  }

  // A one-line reason for the close path naming which steps are still open, or
  // undefined when none are. The finalize chokepoint uses this both to decide
  // (defined => block complete) and to explain the downgrade in the run result.
  openLatchSummary(): string | undefined {
    if (this.latches.size === 0) return undefined;
    const steps = [...this.latches.keys()].join(', ');
    const noun = this.latches.size === 1 ? 'overclaim latch' : 'overclaim latches';
    return `${this.latches.size} ${noun} still open: ${steps}`;
  }

  private persist(): void {
    if (this.path === undefined) return;
    const state: HonestyLedgerState = { open_overclaims: this.openLatches() };
    writeJsonAtomic(this.path, state, { validate: (raw) => JSON.parse(raw) });
  }
}

// The finalize chokepoint, expressed as a gap function mirroring
// completeCloseProofGap: it returns a reason string when an open latch must
// block a `complete` close, or undefined when the ledger is clean (or absent).
// closeRun consults this only when it would otherwise close complete, and
// downgrades to `stopped` (operator-visible "needs attention") rather than
// `aborted` — an unresolved overclaim is an honest non-completion, not a crash.
export function honestyLatchGap(ledger: HonestyLedger | undefined): string | undefined {
  return ledger?.openLatchSummary();
}

// Pull-then-retry context-delivery — the value half of the typed-lookup channel.
//
// On-demand context-pull resolves a running step's typed `context_request` against
// a parent's report and records each answer. That is the resolve-and-record cut:
// it never changes the run. Delivery is the next, bounded step — it FOLDS the
// answered slices back into the starving step's envelope and RE-RUNS the step
// ONCE on the enriched context, so a step that started thin and asked for more
// actually gets to use what it pulled.
//
// This module owns the two pure pieces the seam in graph-runner needs: the per-run
// BOUND (a step delivers at most once; a global cap bounds the total — the same
// once-only discipline the equipment reshaper holds) and the keep-or-fall-back
// DECISION. The orchestration — reading the starved result off the trace,
// materializing the parent surface, re-running the executor — stays inline in the
// runner like the reshape and resolve-and-record seams, because it needs the run's
// trace, files, and step map. Keeping the bound and the decision here makes both
// unit-testable without standing up a run.
//
// Inert by construction: the runner only builds a guard when the live path opts in
// (`enableContextDelivery`); off the opt-in there is no guard, the resolve-and-
// record seam runs instead, and a run is byte-identical to today.

import type { TraceEntry } from '../domain/trace.js';

// One answered slice, ready to fold into a relay prompt. The shape mirrors the
// answered branch of ContextPullOutcome: where it came from, the value, and its
// serialized size (so the delivery record can report bytes folded in).
export type DeliveredContextSlice = {
  readonly source: string;
  readonly value: unknown;
  readonly bytes: number;
};

// The per-run delivery bound. A delivery loop must be bounded or a step could
// re-run forever, so this caps deliveries two ways: a step delivers AT MOST ONCE
// (the cycle guard), and a global counter bounds the total across the run. Both
// live in the guard closure (created once per run), mirroring the equipment
// reshaper's `{ remaining, touched }` bound.
export const CONTEXT_DELIVERY_BUDGET = 3;

export type ContextDeliveryGuard = {
  // Returns true (and spends the bound) if this step may deliver-and-retry now;
  // false once the step has already delivered this run or the global budget is
  // spent. A refused claim means "do not re-run" — the run proceeds on the
  // starved result, exactly as if delivery were off.
  readonly claim: (stepId: string) => boolean;
};

export function createContextDelivery(): ContextDeliveryGuard {
  const budget = { remaining: CONTEXT_DELIVERY_BUDGET, touched: new Set<string>() };
  return {
    claim(stepId: string): boolean {
      if (budget.remaining <= 0) return false;
      if (budget.touched.has(stepId)) return false;
      budget.remaining -= 1;
      budget.touched.add(stepId);
      return true;
    },
  };
}

// Re-thread the per-run delivery bound on resume. A crash can land mid-run after
// a step already delivered, and the durable `run.context-delivery` trace entry
// is the proof it did. The fresh guard a resumed run builds knows nothing of
// that history, so without this it would let an already-delivered step deliver
// again (double-spending its once-per-step claim) and ignore budget the run had
// already spent. The mirror of `seedEquipmentReshapeFromTrace`: fold the trace
// forward and re-claim each recorded delivery on a fresh guard. Each
// `run.context-delivery` entry is written only after a `claim()` succeeded, so
// re-claiming it reproduces exactly that spend — the per-step touched-set and
// the global counter both land where the pre-crash guard left them. Skips every
// other entry kind; an empty or delivery-free trace yields a guard identical to
// a fresh `createContextDelivery()`.
export function seedContextDeliveryFromTrace(entries: readonly TraceEntry[]): ContextDeliveryGuard {
  const guard = createContextDelivery();
  for (const entry of entries) {
    if (entry.kind !== 'run.context-delivery') continue;
    guard.claim(entry.step_id);
  }
  return guard;
}

// How the enriched re-run turned out, as the seam observed it:
//   - errored:          the executor threw before producing a result.
//   - connector_failed: the executor returned, but the worker connector failed
//                       before a result was written (the engine records a
//                       relay.failed for this); the starved result is untouched.
//   - produced:         the connector succeeded and a result was persisted (the
//                       check may pass or route to rework — either way the
//                       enriched result is the live, honest outcome).
export type RetryEvaluation =
  | { readonly kind: 'errored' }
  | { readonly kind: 'connector_failed' }
  | { readonly kind: 'produced' };

// Keep the enriched retry, or fall back to the starved original?
//
// Fall back in exactly the two cases where the retry produced no usable result:
// it errored, or its connector failed before writing anything. In both, the
// starved result is still on disk untouched, so keeping the original is coherent
// with zero restoration. Otherwise keep the retry — it is the live result on the
// context the step asked for. Note this keeps a retry even when its check routes
// to rework: an enriched attempt that still cannot pass is honest signal (the run
// does MORE work, never less), and it can only route a starved pass to rework, never
// launder a real failure into a false done.
export function decideContextDeliveryOutcome(retry: RetryEvaluation): {
  readonly keep: 'retry' | 'original';
  readonly reason: string;
} {
  switch (retry.kind) {
    case 'errored':
      return {
        keep: 'original',
        reason: 'the enriched retry errored before producing a result; kept the starved original',
      };
    case 'connector_failed':
      return {
        keep: 'original',
        reason:
          'the enriched retry connector-failed before producing a result; kept the starved original',
      };
    case 'produced':
      return {
        keep: 'retry',
        reason: 'the enriched retry produced a result on the delivered context; kept the retry',
      };
  }
}

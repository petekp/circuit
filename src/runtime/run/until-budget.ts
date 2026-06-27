// Cumulative budget evaluation for the until loop.
//
// An until loop can re-enter its body many times, so a runaway or low-progress
// loop is the spend risk the iteration cap alone does not bound (a cap of 8 says
// nothing about cost per pass). The cumulative cap closes that: at the tail seam
// the engine sums the per-relay usage already recorded on the trace and, at or
// above the cap, exits to needs-attention rather than spending another pass.
//
// FAIL CLOSED is the rule that makes this honest. A spend cap you cannot measure
// is not a cap. If any relay reported no usage (codex and custom connectors
// leave it absent), or a USD cap is set but no relay reported a cost, the engine
// cannot prove the loop is under budget — so it treats the loop as over budget.
// A flow that runs usage-less connectors simply does not set a cap.
//
// Usage parsing mirrors the operator-summary spend rollup
// (src/app/operator-summary/writer.ts): same RelayUsageEvidence parse, same
// missing-usage accounting.

import { RelayUsageEvidence } from '../../schemas/trace-entry.js';
import type { TraceEntry } from '../domain/trace.js';

// The soft-warning threshold: at or above this fraction of a cap the loop is
// still allowed to continue, but a closure-priority steer is attached to the
// carried note so the next pass knows to wrap up.
const SOFT_THRESHOLD = 0.8;

export interface UntilBudgetCaps {
  readonly usdCap?: number;
  readonly tokenCap?: number;
}

export interface UntilBudgetVerdict {
  // At or above 100% of a cap, OR fail-closed (a cap is set but spend is
  // unmeasurable). The loop must stop spending.
  readonly overCap: boolean;
  // At or above the soft threshold but under the hard cap, with measurable
  // spend. The loop continues but should prioritize closing out.
  readonly nearCap: boolean;
  // Operator-facing one-liner explaining an over/near verdict; undefined when
  // neither fired. Names the cap and the measured (or unmeasurable) spend.
  readonly reason?: string;
}

interface LoopSpend {
  readonly costUsd: number | undefined;
  readonly inputPlusOutputTokens: number;
  readonly relaysMissingUsage: number;
}

// Sum the run's per-relay spend from the trace. costUsd is undefined when NO
// relay reported a cost (a USD cap then cannot be enforced). Token totals are
// always summable from a present usage block; relaysMissingUsage counts relays
// with no usage block at all, the fail-closed trigger for any cap.
function summarizeSpend(entries: readonly TraceEntry[]): LoopSpend {
  let costUsd: number | undefined;
  let tokens = 0;
  let relaysMissingUsage = 0;
  for (const entry of entries) {
    if (entry.kind !== 'relay.completed') continue;
    const usage = RelayUsageEvidence.safeParse(entry.usage);
    if (!usage.success) {
      relaysMissingUsage += 1;
      continue;
    }
    tokens += usage.data.input_tokens + usage.data.output_tokens;
    if (usage.data.total_cost_usd_reported !== undefined) {
      costUsd = (costUsd ?? 0) + usage.data.total_cost_usd_reported;
    }
  }
  return { costUsd, inputPlusOutputTokens: tokens, relaysMissingUsage };
}

// Evaluate the run's cumulative spend against the caps. No cap set => always
// clear (the default loop is uncapped). With a cap set, an unmeasurable spend
// fails closed to overCap.
export function evaluateUntilBudget(
  entries: readonly TraceEntry[],
  caps: UntilBudgetCaps,
): UntilBudgetVerdict {
  if (caps.usdCap === undefined && caps.tokenCap === undefined) {
    return { overCap: false, nearCap: false };
  }
  const spend = summarizeSpend(entries);

  // Fail closed: a cap is set but at least one relay reported no usage, so the
  // total is a floor, not the truth. We cannot prove we are under the cap.
  if (spend.relaysMissingUsage > 0) {
    return {
      overCap: true,
      nearCap: false,
      reason: `cumulative budget cannot be enforced: ${spend.relaysMissingUsage} relay(s) reported no usage, so spend is unmeasurable (failing closed)`,
    };
  }

  if (caps.usdCap !== undefined) {
    // Fail closed: a USD cap with no reported cost anywhere is unenforceable.
    if (spend.costUsd === undefined) {
      return {
        overCap: true,
        nearCap: false,
        reason: `cumulative USD cap $${caps.usdCap} cannot be enforced: no relay reported a cost (failing closed)`,
      };
    }
    if (spend.costUsd >= caps.usdCap) {
      return {
        overCap: true,
        nearCap: false,
        reason: `cumulative spend $${spend.costUsd.toFixed(4)} reached the USD cap $${caps.usdCap}`,
      };
    }
  }

  if (caps.tokenCap !== undefined && spend.inputPlusOutputTokens >= caps.tokenCap) {
    return {
      overCap: true,
      nearCap: false,
      reason: `cumulative ${spend.inputPlusOutputTokens} tokens reached the token cap ${caps.tokenCap}`,
    };
  }

  // Under both caps. Flag the soft threshold so the next pass can prioritize
  // closing out before the hard cap forces an exit.
  const usdNear =
    caps.usdCap !== undefined &&
    spend.costUsd !== undefined &&
    spend.costUsd >= caps.usdCap * SOFT_THRESHOLD;
  const tokenNear =
    caps.tokenCap !== undefined && spend.inputPlusOutputTokens >= caps.tokenCap * SOFT_THRESHOLD;
  if (usdNear || tokenNear) {
    return {
      overCap: false,
      nearCap: true,
      reason: 'nearing the cumulative budget cap; prioritize closing out the goal this pass',
    };
  }

  return { overCap: false, nearCap: false };
}

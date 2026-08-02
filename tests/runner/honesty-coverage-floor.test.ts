// Every flow that can end badly must have something that makes the bad ending
// visible.
//
// The primary-result honesty floor (primary-result-honesty-floor.test.ts) is
// strong but it only sees flows that declare a primary result. It SKIPS the
// rest, which means it passes vacuously for a flow that writes reports, closes
// runs, and names nothing that could contradict a green close. Three flows are
// in that position today. A fourth added tomorrow would join them silently,
// which is the same shape of hole the honesty flag had: the gap is invisible
// because the guard simply has nothing to say.
//
// This file is the floor under that floor. It asks one question of every row of
// the live catalog: if this flow can end badly, what would say so?
//
// Two mechanisms count:
//
//   primary result — the flow names the report that speaks for it, and
//     run-close binds the terminal outcome to that report's own word.
//   until-loop stop judge — the flow iterates under a judge and latches
//     unresolved overclaims into the honesty ledger, which blocks a clean stop.
//
// A flow that cannot end badly at all needs neither, and that exemption is
// derived from its routes rather than kept in a list.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadCompiledFlow, resolveCompiledFlowPath } from '../../src/cli/compiled-flow-loading.js';
import { flowPackages } from '../../src/flows/catalog.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';

const RECOVERY_ROUTE = /(?:retry|revise|repair|rework|recover)/;
const DEGRADED_TERMINALS = new Set(['@stop', '@escalate', '@handoff']);

interface FlowCoverage {
  readonly id: string;
  readonly visibility: string;
  readonly canEndBadly: boolean;
  readonly hasPrimaryResult: boolean;
  readonly hasStopJudge: boolean;
  // The until-loop only switches on at or above a declared depth. Below it the
  // ledger never latches, so a flow leaning on the judge alone is uncovered for
  // part of its own operating range. Recorded so the public-flow rule below can
  // refuse to accept it as sufficient.
  readonly stopJudgeDepthGate: string | undefined;
}

function catalogCoverage(): readonly FlowCoverage[] {
  return flowPackages.map((flowPackage) => {
    const schematic = JSON.parse(
      readFileSync(`src/flows/${flowPackage.id}/schematic.json`, 'utf8'),
    ) as { readonly items?: readonly { readonly routes?: Record<string, unknown> }[] };
    let canEndBadly = false;
    for (const item of schematic.items ?? []) {
      for (const [route, target] of Object.entries(item.routes ?? {})) {
        if (RECOVERY_ROUTE.test(route)) canEndBadly = true;
        if (route === 'stop') canEndBadly = true;
        if (typeof target === 'string' && DEGRADED_TERMINALS.has(target)) canEndBadly = true;
      }
    }
    const { flow } = loadCompiledFlow(
      resolveCompiledFlowPath(flowPackage.id, undefined, undefined, undefined),
    );
    const runtimeFlow = fromCompiledFlow(flow);
    const until = runtimeFlow.engineFlags?.iteratesUntilCondition;
    return {
      id: flowPackage.id,
      visibility: String(flowPackage.visibility),
      canEndBadly,
      hasPrimaryResult: runtimeFlow.runtimeSurface?.primaryResult?.path !== undefined,
      hasStopJudge: until?.stopJudge !== undefined,
      stopJudgeDepthGate: until?.activateWhenDepthAtLeast,
    };
  });
}

describe('every flow that can end badly can say so', () => {
  const coverage = catalogCoverage();

  it('finds flows to check, so this cannot pass vacuously', () => {
    expect(coverage.length).toBeGreaterThan(0);
    expect(coverage.some((flow) => flow.canEndBadly)).toBe(true);
  });

  for (const flow of coverage) {
    it(`${flow.id} is covered by an honesty mechanism`, () => {
      if (!flow.canEndBadly) {
        // No recovery route, no stop route, no degraded terminal. There is no
        // bad ending for this flow to hide, so there is nothing to guard.
        // Asserted rather than skipped so the exempt set cannot quietly grow:
        // a flow carrying a mechanism it supposedly does not need means the
        // route scan above has stopped seeing the ways this flow can fail.
        expect(
          flow.hasPrimaryResult || flow.hasStopJudge,
          `${flow.id} reads as unable to end badly, yet it carries an honesty mechanism. Either it can end badly and the route scan in this file missed how, or the mechanism is vestigial.`,
        ).toBe(false);
        return;
      }
      expect(
        flow.hasPrimaryResult || flow.hasStopJudge,
        `${flow.id} can end badly and has neither a primary result nor an until-loop stop judge, so nothing would contradict a green close. Declare runtimeSurface.primaryResult naming the report that speaks for this flow.`,
      ).toBe(true);
    });
  }
});

// The public five carry a stricter rule than the catalog at large. A depth-gated
// stop judge is real coverage at autonomous depth and no coverage at all below
// it, which is not a defensible position for a flow an operator reaches by
// typing its name. Public flows must be covered unconditionally, and the only
// unconditional mechanism is the primary result.
describe('a public flow is covered at every depth it runs at', () => {
  const publicFlows = catalogCoverage().filter((flow) => flow.visibility === 'public');

  it('finds public flows to check', () => {
    expect(publicFlows.length).toBeGreaterThan(0);
  });

  for (const flow of publicFlows) {
    it(`${flow.id} declares a primary result rather than relying on a depth-gated judge`, () => {
      expect(
        flow.hasPrimaryResult,
        `${flow.id} is public and does not declare a primary result. An until-loop stop judge is not enough here: it is gated on run depth (${flow.stopJudgeDepthGate ?? 'none'}), so below that depth the flow would have no honesty mechanism at all.`,
      ).toBe(true);
    });
  }
});

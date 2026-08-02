// The honesty floor, stated once over the whole catalog.
//
// A run must never close green while the report it hands the operator says
// otherwise. That used to be opt-in: a flow declared
// `binds_terminal_outcome_to_primary_result` on its schematic and got the
// honest close, and a flow that declared nothing closed `complete` over its own
// `blocked` result. The unsafe answer was the default, so forgetting was silent
// and always in the wrong direction. Pursue, cross-tool-build and prototype had
// all three forgotten it, and each one looked locally fine.
//
// The flag is gone. The bind is derived from the flow declaring a primary
// result at all, which is the only honest reading of "here is the report that
// speaks for this run". This file is the guard on that: it enumerates the real
// catalog rather than a list someone maintains by hand, so a flow added
// tomorrow is enrolled with no author action and turns this suite red on the
// day it lands if it can close green over a degraded word.
import { describe, expect, it } from 'vitest';

import { loadCompiledFlow, resolveCompiledFlowPath } from '../../src/cli/compiled-flow-loading.js';
import { flowPackages } from '../../src/flows/catalog.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { terminalOutcomeBoundToPrimaryResult } from '../../src/runtime/run/run-close.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';

// Every word a close writer can use to say the work did not fully land. Kept
// here as a literal rather than imported from the shared set on purpose: this
// file is the operator-facing statement of the floor, and a silent edit to the
// shared set should have to come here and argue for itself.
const DEGRADED_OUTCOMES = ['partial', 'needs_attention', 'failed', 'blocked', 'stopped'] as const;

interface CatalogFlow {
  readonly id: string;
  readonly primaryResultPath: string;
  readonly context: (result: unknown) => RunContext;
}

// Built from the compiled flows the engine actually loads, not from the
// authoring packages: the runtime surface and the engine flags only reach their
// final shape after compilation, so reading the packages would test a
// pre-image of what ships.
function catalogFlowsWithAPrimaryResult(): readonly CatalogFlow[] {
  const flows: CatalogFlow[] = [];
  for (const flowPackage of flowPackages) {
    const { flow } = loadCompiledFlow(
      resolveCompiledFlowPath(flowPackage.id, undefined, undefined, undefined),
    );
    const runtimeFlow = fromCompiledFlow(flow);
    const primaryResultPath = runtimeFlow.runtimeSurface?.primaryResult?.path;
    // A flow with no primary result has no report speaking for it, so there is
    // nothing here to bind and nothing to check.
    if (primaryResultPath === undefined) continue;
    flows.push({
      id: flowPackage.id,
      primaryResultPath,
      context: (result: unknown) =>
        ({ flow: runtimeFlow, files: { readJson: async () => result } }) as unknown as RunContext,
    });
  }
  return flows;
}

describe('no flow may close a run green over its own degraded result', () => {
  const flows = catalogFlowsWithAPrimaryResult();

  it('finds flows to check, so an empty catalog cannot pass this file vacuously', () => {
    expect(flows.length).toBeGreaterThan(0);
  });

  for (const flow of flows) {
    for (const degraded of DEGRADED_OUTCOMES) {
      it(`${flow.id} does not close complete when its result reports '${degraded}'`, async () => {
        const bound = await terminalOutcomeBoundToPrimaryResult(
          flow.context({ outcome: degraded }),
          'complete',
        );
        expect(
          bound?.outcome,
          `${flow.id} closed a run 'complete' while ${flow.primaryResultPath} reported '${degraded}'`,
        ).toBe('stopped');
      });
    }

    it(`${flow.id} still closes complete on a clean result`, async () => {
      // The floor must not cost honest successes. Fix reports 'fixed' and
      // 'not-reproduced'; nothing here may downgrade a flow's own success word.
      const bound = await terminalOutcomeBoundToPrimaryResult(
        flow.context({ outcome: 'complete' }),
        'complete',
      );
      expect(bound).toBeUndefined();
    });
  }
});

import { describe, expect, it } from 'vitest';

import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import type { CompiledFlow as CompiledFlowValue } from '../../src/index.js';
import { recoveryKindForRoute } from '../../src/policy/recovery-route-policy.js';
import { projectWorkContractProjectionV0 } from '../../src/shared/work-contract-projection.js';

// Recovery-route binding gate.
//
// Regression context: three explainer runs (2026-06-16, attention-is-all-you-need
// repo) aborted with "step 'build-step' selected recovery route 'stop' after
// failed_check but the WorkContract does not declare a matching recovery binding".
// The executor had selected a route the projection of the SAME flow did not bind:
// the projector's binding derivation and the graph-runner's runtime binding lookup
// had diverged. Replaying that run's exact compiled flow through today's projector
// derives the binding and the verdict passes — the divergence is fixed — but
// nothing pinned the two sides together, so it could reopen silently.
//
// This gate walks every compiled built-in flow and asserts, for every route the
// recovery projection recognizes, that the projected WorkContract carries a binding
// the graph-runner's lookup (recoveryBindingForCompletedRoute: exact step_id +
// route_id + route_target triple) will find. If a change to either side breaks the
// alignment, this fails at build time instead of aborting an operator's run.

function compiledBuiltInFlows(): readonly CompiledFlowValue[] {
  const flows: CompiledFlowValue[] = [];
  for (const definition of flowDefinitions) {
    const compiled = compileSchematicToCompiledFlow(schematicForFlowDefinition(definition));
    if (compiled.kind === 'single') {
      flows.push(compiled.flow);
      continue;
    }
    flows.push(...compiled.flows.values());
  }
  return flows;
}

describe('recovery-route binding gate', () => {
  it('every recovery-eligible route on every built-in flow has a matching projected binding', () => {
    const flows = compiledBuiltInFlows();
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      const bindings = projectWorkContractProjectionV0({ flow }).work_contract.recovery;
      for (const step of flow.steps) {
        for (const [routeId, routeTarget] of Object.entries(step.routes)) {
          const kind = recoveryKindForRoute({ routeId, routeTarget, stepId: step.id });
          if (kind === undefined) continue;
          // Compiled-flow route targets are raw strings ('@stop' or a step id);
          // the runtime lookup key (routeTargetKey) resolves back to that same
          // string, so an exact triple match here proves the runtime lookup finds
          // the binding.
          const binding = bindings.find(
            (candidate) =>
              candidate.step_id === step.id &&
              candidate.route_id === routeId &&
              candidate.route_target === routeTarget,
          );
          expect(
            binding,
            `${flow.id}@${flow.version} step '${step.id}' route '${routeId}' -> '${routeTarget}' is recovery-eligible (${kind}) but the projected WorkContract has no matching binding; a run taking it after a failure would abort`,
          ).toBeDefined();
        }
      }
    }
  });

  it("every sub-run step's declared stop route accepts failed_check, covering the executor's child-aborted disposal", () => {
    // sub-run.ts routes a legible non-complete child through the step's declared
    // `stop` route without consulting bindings (the one hard-coded failure-path
    // route selection in the executors). The graph-runner then derives
    // failed_check evidence and enforces the binding, so that binding must exist
    // and allow failed_check or the disposal path itself becomes an abort.
    for (const flow of compiledBuiltInFlows()) {
      const bindings = projectWorkContractProjectionV0({ flow }).work_contract.recovery;
      for (const step of flow.steps) {
        if (step.kind !== 'sub-run') continue;
        const stopTarget = step.routes.stop;
        if (stopTarget === undefined) continue;
        const binding = bindings.find(
          (candidate) =>
            candidate.step_id === step.id &&
            candidate.route_id === 'stop' &&
            candidate.route_target === stopTarget,
        );
        expect(
          binding,
          `${flow.id}@${flow.version} sub-run step '${step.id}' declares a stop route but the projection binds nothing for it`,
        ).toBeDefined();
        expect(
          binding?.allowed_failure_causes,
          `${flow.id}@${flow.version} sub-run step '${step.id}' stop binding must allow failed_check for the child-aborted disposal path`,
        ).toContain('failed_check');
      }
    }
  });
});

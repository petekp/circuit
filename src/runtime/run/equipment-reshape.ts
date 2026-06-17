// Step 2 — the live equipment reshape, runtime half.
//
// The first time the engine adapts a RUNNING flow. A relay can surface a
// CONFIRMED runtime discovery ("this turned out to be a React app"); this turns
// that into a re-equipped executable tail the run continues on. The actual
// re-resolution and the compiled-flow schema gate live in the flows layer
// (reResolveEquipmentOnCompiledFlow, reached through the sanctioned compile
// seam so the engine never imports a per-flow resolver). This module owns the
// runtime half: the per-run BOUND, the graph-validation gate (fromCompiledFlow /
// assertExecutableFlow), and materializing the validated candidate into the
// ExecutableFlow the runner walks. The runner only ever sees ExecutableFlow —
// the compiled form stays encapsulated in the reshaper closure.
//
// Scope is the safest reshape case ONLY: equipment injection is ADDITIVE, so the
// step SEQUENCE never changes and there is no splice seam (Step 3). The reshaper
// is created once per run (at the compiled-flow edge) and injected as a runner
// option; off the live path the option is absent and the whole reshape is inert.

import { reResolveEquipmentOnCompiledFlow } from '../../flows/compile-schematic-to-flow.js';
import type { CompiledFlow } from '../../schemas/compiled-flow.js';
import { EquipmentDiscovery } from '../../schemas/equipment-discovery.js';
import type { ExecutableFlow } from '../manifest/executable-flow.js';
import { fromCompiledFlow } from '../manifest/from-compiled-flow.js';

export type { EquipmentDiscovery };

// The bound. A reshape loop must be bounded or a step could re-equip forever.
// Each honored reshape decrements a per-run counter; a cycle guard stops any one
// step honoring a second reshape this run. The bound lives in the reshaper
// closure (created once per run) — a reshape never spawns a child run, so unlike
// the recursion bound it is loop-local, not threaded through run options.
export const EQUIPMENT_RESHAPE_BUDGET = 3;

// The outcome the runner reacts to. `reshaped:true` carries the re-validated
// executable tail (NOT the compiled form) plus the steps that gained equipment;
// `reshaped:false` carries the finding the operator gets (Option B), with the
// running flow unchanged.
export type EquipmentReshapeOutcome =
  | {
      readonly reshaped: true;
      readonly executableFlow: ExecutableFlow;
      readonly equippedSteps: readonly string[];
      readonly rationale: string;
    }
  | {
      readonly reshaped: false;
      readonly finding: string;
    };

// The injected capability: given a confirmed discovery and the remaining relay
// steps, return a re-equipped executable tail or a finding. Closes over the
// per-run bound and the evolving compiled flow; the runner holds only this
// function and the ExecutableFlow it returns.
export type EquipmentReshaper = (input: {
  readonly fromStepId: string;
  readonly remainingRelayStepIds: ReadonlySet<string>;
  readonly discovery: EquipmentDiscovery;
}) => EquipmentReshapeOutcome;

// Field-tolerant read of a relay result body: a validated EquipmentDiscovery at
// the top-level `equipment_discovery` key, or undefined for anything else
// (absent key, malformed value, non-object body). Tolerance matters because this
// runs against raw result JSON at the post-step seam; the body has already
// passed its flow schema, but this module must not depend on any flow's report
// type. Mirrors extractPowerRecommendation (selection/power-inference.ts).
export function extractEquipmentDiscovery(report: unknown): EquipmentDiscovery | undefined {
  if (report === null || typeof report !== 'object') return undefined;
  const candidate = (report as { equipment_discovery?: unknown }).equipment_discovery;
  if (candidate === undefined) return undefined;
  const parsed = EquipmentDiscovery.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function finding(message: string): EquipmentReshapeOutcome {
  return { reshaped: false, finding: message };
}

// Build the per-run reshaper. The closure owns the bound (budget + cycle guard)
// and the evolving compiled flow (each honored reshape builds on the last). The
// confirmed-only default and the bound are checked before any work; an
// unconfirmed discovery never spends the budget or trips the cycle guard. The
// safety floor is two halves: the flows layer re-runs the compiled-flow schema
// gate, and fromCompiledFlow here re-runs the executable-graph gate
// (assertExecutableFlow). If either rejects, the reshape downgrades to a finding
// and the run continues on the current, still-valid flow — the budget is spent
// only on a fully honored reshape.
export function createEquipmentReshaper(initialCompiledFlow: CompiledFlow): EquipmentReshaper {
  let current = initialCompiledFlow;
  const budget = { remaining: EQUIPMENT_RESHAPE_BUDGET, touched: new Set<string>() };

  return ({ fromStepId, remainingRelayStepIds, discovery }) => {
    // Confirmed-only, checked first: an unconfirmed signal is a hunch and must
    // park regardless of budget or cycle state.
    if (!discovery.confirmed) {
      return finding(
        `equipment discovery from step '${fromStepId}' is unconfirmed; recorded as a finding, flow unchanged`,
      );
    }
    if (budget.remaining <= 0) {
      return finding(
        `equipment reshape budget exhausted at step '${fromStepId}'; recorded as a finding, flow unchanged`,
      );
    }
    if (budget.touched.has(fromStepId)) {
      return finding(
        `step '${fromStepId}' already reshaped this run (cycle guard); recorded as a finding, flow unchanged`,
      );
    }

    // Compile-layer half: re-resolve equipment + the compiled-flow schema gate.
    const candidate = reResolveEquipmentOnCompiledFlow({
      sourceFlow: current,
      fromStepId,
      remainingRelayStepIds,
      discovery,
    });
    if (!candidate.ok) return finding(candidate.reason);

    // Graph-validation half: the same fromCompiledFlow chain every loaded flow
    // passes (it re-runs assertExecutableFlow). A rejection here means do NOT run
    // the reshaped tail — fall back to the current flow.
    let executableFlow: ExecutableFlow;
    try {
      executableFlow = fromCompiledFlow(candidate.compiledFlow);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finding(`equipment reshape rejected by the executable-graph safety floor: ${message}`);
    }

    // Honored. Spend the bound, advance the evolving compiled flow.
    budget.remaining -= 1;
    budget.touched.add(fromStepId);
    current = candidate.compiledFlow;
    return {
      reshaped: true,
      executableFlow,
      equippedSteps: candidate.equippedSteps,
      rationale: candidate.rationale,
    };
  };
}

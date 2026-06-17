// Step 2 — the live equipment reshape, compile-layer half.
//
// When a relay surfaces a CONFIRMED runtime discovery ("this turned out to be a
// React app"), this re-resolves equipment for the REMAINING relay steps and
// re-validates the candidate flow through the compiled-flow schema gate — the
// same gate every loaded flow passes (CompiledFlow.parse, including the
// no-duplicate-skill-slot rule). It lives in the flows layer, not the engine,
// because re-resolving equipment and re-compiling is a compile-time flow
// operation: the resolver (resolveEquipment) and the compiled-flow schema both
// belong here, and the engine reaches this only through the sanctioned
// compile-schematic-to-flow seam. The runtime owns the second half of the gate
// (fromCompiledFlow / assertExecutableFlow) and materializing the executable
// tail; see src/runtime/run/equipment-reshape.ts.
//
// Scope is the safest reshape case ONLY: equipment injection is ADDITIVE — it
// equips a step already in the remaining sequence — so the step SEQUENCE never
// changes and there is no splice seam (that is Step 3, structural reshape,
// deliberately out of scope). Pure: no run state, no I/O.

import { CompiledFlow } from '../schemas/compiled-flow.js';
import type { EquipmentDiscovery } from '../schemas/equipment-discovery.js';
import type { SkillSlot } from '../schemas/skill.js';
import { resolveEquipment } from './resolvers/equipment.js';

// The outcome of building + gating a reshape candidate. `ok:true` carries the
// re-validated compiled flow (the runtime materializes it into an executable
// tail) plus the steps that gained equipment; `ok:false` carries the reason the
// reshape downgraded to a finding, with no candidate produced.
export type EquipmentReshapeCandidate =
  | {
      readonly ok: true;
      readonly compiledFlow: CompiledFlow;
      readonly equippedSteps: readonly string[];
      readonly rationale: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

// Merge injected slots into a step's existing slots, deduping by id (existing
// first, so an author's slot is never displaced). Returns the merged list and
// the ids that were newly added.
function mergeSlots(
  existing: readonly SkillSlot[],
  injected: readonly SkillSlot[],
): { readonly merged: SkillSlot[]; readonly added: string[] } {
  const byId = new Map<string, SkillSlot>();
  for (const s of existing) byId.set(s.id as unknown as string, s);
  const added: string[] = [];
  for (const s of injected) {
    const id = s.id as unknown as string;
    if (byId.has(id)) continue;
    byId.set(id, s);
    added.push(id);
  }
  return { merged: [...byId.values()], added };
}

// Re-resolve equipment on the remaining relay steps from a confirmed discovery,
// merge it additively into their skill slots, and re-validate the whole flow
// through the compiled-flow schema gate. An unconfirmed discovery, no usable
// tags, a no-op (the equipment is already present), or a gate rejection all
// return `ok:false` with the reason; the caller leaves the running flow
// unchanged. No budget or cycle logic here — the runtime closure owns the bound
// (a reshape happens within one run loop and never spawns a child run).
export function reResolveEquipmentOnCompiledFlow(input: {
  readonly sourceFlow: CompiledFlow;
  readonly fromStepId: string;
  readonly remainingRelayStepIds: ReadonlySet<string>;
  readonly discovery: EquipmentDiscovery;
}): EquipmentReshapeCandidate {
  const { sourceFlow, fromStepId, remainingRelayStepIds, discovery } = input;

  // Confirmed-only. An unconfirmed discovery is a hunch; the conservative
  // default never reshapes on it.
  if (!discovery.confirmed) {
    return {
      ok: false,
      reason: `equipment discovery from step '${fromStepId}' is unconfirmed; recorded as a finding, flow unchanged`,
    };
  }

  const tags = discovery.domain_tags.filter((tag) => tag.trim().length > 0);
  if (tags.length === 0) {
    return {
      ok: false,
      reason: `equipment discovery from step '${fromStepId}' carried no usable domain tags; nothing to equip`,
    };
  }

  // Build the candidate: re-resolve equipment for each remaining relay step and
  // merge it additively into that step's slots. The source flow and its step
  // objects are never mutated (map returns new objects for changed steps).
  const equippedSteps: string[] = [];
  let addedAny = false;
  const steps = sourceFlow.steps.map((step) => {
    if (step.kind !== 'relay' || !remainingRelayStepIds.has(step.id)) return step;
    const resolution = resolveEquipment({
      step_id: step.id,
      role: step.role as 'researcher' | 'implementer' | 'reviewer',
      domain_tags: tags,
    });
    const { merged, added } = mergeSlots(
      (step.skill_slots ?? []) as readonly SkillSlot[],
      resolution.choice,
    );
    if (added.length === 0) return step;
    addedAny = true;
    equippedSteps.push(step.id);
    return { ...step, skill_slots: merged };
  });

  if (!addedAny) {
    return {
      ok: false,
      reason: `the remaining relay steps already carry the discovered equipment; nothing to inject (from step '${fromStepId}')`,
    };
  }

  // Safety floor (schema half): re-run the compiled-flow schema gate every
  // loaded flow passes, including the no-duplicate-skill-slot rule. The runtime
  // closure runs the graph half (fromCompiledFlow / assertExecutableFlow). If
  // either rejects, the caller falls back to the original, still-valid flow.
  //
  // SCOPE NOTE: the full compile path (compileSchematicToCompiledFlow) also runs
  // the block-catalog gate and the self-reference check. Those are intentionally
  // NOT re-run here, and that is sound ONLY because this reshape touches solely
  // `skill_slots` — it changes no contract, route, block id, or sub-run target,
  // which is all the catalog gate governs, and the sequence is unchanged so
  // self-reference cannot regress. Step 3 (structural / splice reshape) changes
  // routes and the step set, so it MUST re-add the catalog gate before relying on
  // this function — do not extend this to a structural reshape without it.
  let compiledFlow: CompiledFlow;
  try {
    compiledFlow = CompiledFlow.parse({ ...sourceFlow, steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `equipment reshape rejected by the compiled-flow schema gate: ${message}`,
    };
  }

  return {
    ok: true,
    compiledFlow,
    equippedSteps,
    rationale: `confirmed ${tags.join(', ')}; equipped ${equippedSteps.join(', ')} and re-validated the flow`,
  };
}

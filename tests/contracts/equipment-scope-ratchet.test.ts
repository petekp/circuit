// Equipment-scope ratchet — a self-contained gate over the two equipment
// sub-axes on the shipped flows.
//
//   skill-slot gaps  — relay steps that declare no skill_slots (the SKILLS
//                      sub-axis seat is empty). One issue per bare relay step.
//   tool-scope gaps  — implementer relay steps (the write tier) that declare no
//                      equipment_scope (the TOOLS sub-axis is unset).
//
// Each BASELINE pins a ceiling summed across the shipped corpus, gated by
// toBeLessThanOrEqual: a number can only shrink. Lowering a ceiling is a
// reviewed edit to the literal. Filling a step's seat is what drives a ceiling
// down; this test holds the line so a regression cannot quietly re-open a gap.
//
// This is a minimal, dependency-free cousin of the offline flow-lab ratchet on
// exp/next-phase-flow-lab (PR #88), which scores the same skill-slot-gap class
// through experiments/flow-lab. When these branches converge, fold this gate
// into that one rather than maintaining both.

import { describe, expect, it } from 'vitest';

import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { shippedFlowSchematics } from '../helpers/in-memory-schematics.js';

// Ceilings, summed across every shipped schematic. Filling a seat lowers these.
//
// The skill-slot ceiling dropped 15 -> 1 when the shipped product flows (build,
// explore, goal, prototype, pursue, review) had house-style skill slots declared
// on every work relay (analyze/act/synthesize/clarify/batch/audit and their
// review steps). The remaining gaps are the two internal proof harnesses, whose
// relays do no real work and get no house-style seat:
//   - runtime-proof's `relay-step` (1): drives one compose + one relay end-to-end.
//   - converge-proof's three relay steps (3): the until-loop e2e harness body
//     (plan / act / review); the relayer is faked, so a real seat would be inert.
// Both are intentional harness gaps, not product-flow regressions (the per-flow
// assertion below pins every product flow to 0). If a harness gap is ever filled,
// lower this ceiling to match.
const SKILL_SLOT_GAP_BASELINE = 4;
// Implementer relays still missing an equipment_scope. The product-flow gaps are
// the partial equipment-axis rollout (fix's implementer is the proven, scoped
// slice); converge-proof's `work-step` adds the one harness implementer relay,
// left unscoped for the same reason its seats are empty.
const TOOL_SCOPE_GAP_BASELINE = 6;

function isRelay(item: FlowSchematic['items'][number]): boolean {
  return item.execution.kind === 'relay';
}

function isImplementerRelay(item: FlowSchematic['items'][number]): boolean {
  return item.execution.kind === 'relay' && item.execution.role === 'implementer';
}

function skillSlotGaps(): { total: number; byFlow: Record<string, number> } {
  const byFlow: Record<string, number> = {};
  let total = 0;
  for (const schematic of shippedFlowSchematics()) {
    for (const item of schematic.items) {
      if (isRelay(item) && item.skill_slots.length === 0) {
        total += 1;
        byFlow[schematic.id as unknown as string] =
          (byFlow[schematic.id as unknown as string] ?? 0) + 1;
      }
    }
  }
  return { total, byFlow };
}

function toolScopeGaps(): { total: number; byFlow: Record<string, number> } {
  const byFlow: Record<string, number> = {};
  let total = 0;
  for (const schematic of shippedFlowSchematics()) {
    for (const item of schematic.items) {
      if (isImplementerRelay(item) && item.equipment_scope === undefined) {
        total += 1;
        byFlow[schematic.id as unknown as string] =
          (byFlow[schematic.id as unknown as string] ?? 0) + 1;
      }
    }
  }
  return { total, byFlow };
}

describe('equipment-scope ratchet (shipped schematics)', () => {
  it('never lets the skill-slot gap exceed its recorded ceiling', () => {
    const { total, byFlow } = skillSlotGaps();
    console.log(`\nskill-slot gaps: ${total} (ceiling ${SKILL_SLOT_GAP_BASELINE})`);
    console.log(JSON.stringify(byFlow, null, 2));
    expect(
      total,
      'relay steps without skill_slots regressed above the recorded ceiling',
    ).toBeLessThanOrEqual(SKILL_SLOT_GAP_BASELINE);
  });

  it('never lets the implementer tool-scope gap exceed its recorded ceiling', () => {
    const { total, byFlow } = toolScopeGaps();
    console.log(`\ntool-scope gaps: ${total} (ceiling ${TOOL_SCOPE_GAP_BASELINE})`);
    console.log(JSON.stringify(byFlow, null, 2));
    expect(
      total,
      'implementer relay steps without equipment_scope regressed above the recorded ceiling',
    ).toBeLessThanOrEqual(TOOL_SCOPE_GAP_BASELINE);
  });

  it('records the fix flow as fully scoped (its seats and write-tier tools are filled)', () => {
    // The fix flow is the proven slice: all four of its relay steps declare
    // skill_slots, and its implementer step declares an equipment_scope. If a
    // future edit re-opens either gap on fix, this fails before the summed
    // ceilings would.
    expect(skillSlotGaps().byFlow.fix ?? 0).toBe(0);
    expect(toolScopeGaps().byFlow.fix ?? 0).toBe(0);
  });

  it('records every shipped product flow as fully skill-scoped (only the proof harness lags)', () => {
    // Increment 1 of the skills axis: declaring a skill slot is itself a real
    // injection (its description reaches the worker as House Style guidance), so
    // every work relay on the product flows now carries a seat. Only the
    // runtime-proof smoke harness is allowed an empty seat. Asserting per-flow,
    // not just the summed ceiling, stops a future edit re-opening one product
    // flow's gap while another's drops to keep the sum flat.
    const gaps = skillSlotGaps().byFlow;
    for (const flow of ['build', 'explore', 'goal', 'prototype', 'pursue', 'review', 'fix']) {
      expect(gaps[flow] ?? 0, `${flow} re-opened a skill-slot gap`).toBe(0);
    }
  });

  it('pins the fix implementer step to an ENFORCED scope with its exact write-tier tool list', () => {
    // The proven slice is the whole point of the ratchet: not just "a scope is
    // present" (what the gap count proves) but that it is the enforced binding
    // with the file-and-shell toolset a focused fix needs. A future edit that
    // silently weakened it to trusted, or trimmed/widened the tools, would keep
    // the gap count at zero — so assert the content, not only its presence.
    const fix = shippedFlowSchematics().find((s) => (s.id as unknown as string) === 'fix');
    if (fix === undefined) throw new Error('fix schematic missing from corpus');
    const implementer = fix.items.filter(isImplementerRelay);
    expect(implementer, 'fix should have exactly one implementer relay step').toHaveLength(1);
    expect(implementer[0]?.equipment_scope).toEqual({
      tools: { allow: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
      enforcement: 'enforced',
    });
  });
});

describe('the ratchet scorer is non-vacuous', () => {
  it('counts a bare relay step as a skill-slot gap', () => {
    const fix = shippedFlowSchematics().find((s) => (s.id as unknown as string) === 'fix');
    if (fix === undefined) throw new Error('fix schematic missing from corpus');
    const bareRelay = fix.items.find(
      (item) => item.execution.kind === 'relay' && item.skill_slots.length > 0,
    );
    if (bareRelay === undefined) throw new Error('expected at least one scoped relay on fix');
    // Strip the seats back off: the scorer must see the gap return.
    const reopened: FlowSchematic = {
      ...fix,
      items: fix.items.map((item) => (item === bareRelay ? { ...item, skill_slots: [] } : item)),
    };
    const gap = reopened.items.filter(
      (item) => item.execution.kind === 'relay' && item.skill_slots.length === 0,
    ).length;
    const original = fix.items.filter(
      (item) => item.execution.kind === 'relay' && item.skill_slots.length === 0,
    ).length;
    expect(gap).toBe(original + 1);
  });
});

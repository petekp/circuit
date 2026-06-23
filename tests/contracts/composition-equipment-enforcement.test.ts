// Flow-shape composition (experimental, default-OFF): equipment enforcement.
//
// Iteration 1 of the equipment axis let a generated flow give each worker step a
// TRUSTED tool profile — the scope is offered to the worker as guidance, never a
// hard limit. This file locks iteration 2: an opt-in composer lever
// (`enforceImplementerTools`) upgrades the implementer (act) step's tightening
// profile from trusted to ENFORCED, so the connector restricts the worker's
// `--tools` at the write tier (the lever PR #89 shipped) instead of merely
// suggesting them.
//
// Enforcement is a write-tier boundary, so the schematic parse gate
// (flow-schematic.ts) accepts `enforcement: 'enforced'` ONLY on an implementer
// relay step. The composer therefore upgrades that step and no other: a
// researcher's read-only scope and a verifier's tester scope stay trusted even
// with the lever on, so the parse gate never trips. With the lever off, every
// composed flow is byte-identical to iteration 1 (and to before the axis).

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

// Stated independently of the implementation (hard-coded, not imported) so the
// test fixes the contract, not the code's view of it. The enforced editor scope
// is the same allow-list as the trusted one with enforcement flipped.
const TRUSTED_READ_ONLY = { tools: { allow: ['Read', 'Grep', 'Glob'] }, enforcement: 'trusted' };
const TRUSTED_EDITOR = {
  tools: { allow: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  enforcement: 'trusted',
};
const ENFORCED_EDITOR = {
  tools: { allow: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  enforcement: 'enforced',
};
const TRUSTED_TESTER = {
  tools: { allow: ['Read', 'Grep', 'Glob', 'Bash'] },
  enforcement: 'trusted',
};

// The same equipped shape iteration 1 uses: researcher only looks (read-only),
// implementer edits (editor), verifier runs the suite (tester).
const EQUIPPED: CompositionRoleSet = {
  ...RESEARCH_THEN_BUILD,
  id: 'research-then-build-equipped-enforced',
  title: 'Research then Build (enforced edit tier)',
  roles: RESEARCH_THEN_BUILD.roles.map((role) => {
    if (role.block === 'gather-context') return { ...role, equipment: 'read-only' as const };
    if (role.block === 'act') return { ...role, equipment: 'editor' as const };
    if (role.block === 'run-verification') return { ...role, equipment: 'tester' as const };
    return role;
  }),
};

describe('flow-shape composition — equipment enforcement (iteration 2)', () => {
  const trusted = composeFlow(EQUIPPED, { definitions: flowDefinitions });
  const enforced = composeFlow(EQUIPPED, {
    definitions: flowDefinitions,
    enforceImplementerTools: true,
  });

  it('composes with the enforce lever on, without a wall', () => {
    if (!enforced.ok) {
      throw new Error(
        `composer walled: ${enforced.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(enforced.ok).toBe(true);
  });

  it('upgrades ONLY the implementer (act) step to enforced', () => {
    if (!enforced.ok) throw new Error('compose failed');
    const gather = enforced.spec.items.find((it) => String(it.block) === 'gather-context');
    const act = enforced.spec.items.find((it) => String(it.block) === 'act');
    const verify = enforced.spec.items.find((it) => String(it.block) === 'run-verification');
    if (!gather || !act || !verify) throw new Error('missing equipped steps');
    // The act step (implementer relay) is the write tier — it is hard-enforced.
    expect(act.equipmentScope).toEqual(ENFORCED_EDITOR);
    // The researcher and verifier have no write tier to bound, so they stay
    // trusted; enforcing them would trip the parse gate.
    expect(gather.equipmentScope).toEqual(TRUSTED_READ_ONLY);
    expect(verify.equipmentScope).toEqual(TRUSTED_TESTER);
  });

  it('the enforced spec is VALID by the real engine gates (the parse gate accepts it)', () => {
    if (!enforced.ok) throw new Error('compose failed');
    const validity = evaluateValidity(enforced.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
  });

  it('the enforced scope survives compile onto the runtime step', () => {
    if (!enforced.ok) throw new Error('compose failed');
    const validity = evaluateValidity(enforced.spec);
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    if (!flow) throw new Error('no compiled flow');
    const act = enforced.spec.items.find((it) => String(it.block) === 'act');
    const compiledAct = flow.steps.find((s) => s.id === String(act?.id));
    if (!compiledAct) throw new Error('no compiled act step');
    expect(compiledAct.equipment_scope).toEqual(ENFORCED_EDITOR);
  });

  it('with the lever OFF the act step stays trusted (byte-identical to iteration 1)', () => {
    if (!trusted.ok) throw new Error('compose failed');
    const act = trusted.spec.items.find((it) => String(it.block) === 'act');
    expect(act?.equipmentScope).toEqual(TRUSTED_EDITOR);
  });

  it('enforcement needs a tightening profile: a full/absent implementer scope is a no-op', () => {
    // The act step opts into nothing (full surface). Enforcing "full" is a
    // contradiction the schema rejects, so the lever must leave it omitted — not
    // emit an invalid enforced-full scope.
    const fullActImplementer: CompositionRoleSet = {
      ...RESEARCH_THEN_BUILD,
      id: 'research-then-build-full-act',
      roles: RESEARCH_THEN_BUILD.roles.map((role) =>
        role.block === 'gather-context' ? { ...role, equipment: 'read-only' as const } : role,
      ),
    };
    const outcome = composeFlow(fullActImplementer, {
      definitions: flowDefinitions,
      enforceImplementerTools: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const act = outcome.spec.items.find((it) => String(it.block) === 'act');
    expect(act?.equipmentScope).toBeUndefined();
    // And it still compiles (no enforced-full slipped through to wall the gate).
    expect(evaluateValidity(outcome.spec).valid).toBe(true);
  });
});

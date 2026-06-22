// Flow-shape composition (experimental, default-OFF): the equipment axis.
//
// The composer chose a graph of blocks, but every block ran as the same
// do-everything worker: full tool surface, full read scope. So a generated
// "researcher" step and a generated "implementer" step were the same agent in
// different positions — topology was the only thing that ever varied. The
// shape-discrimination experiment NULLed for exactly this reason: a single
// capable agent block internally reproduces what topology was meant to add
// (it greps, reads siblings, runs tests on its own), so the one lever a single
// block CANNOT reproduce is per-block SCOPE (different tools, different reach).
//
// These tests lock the first scope the composer can PROPOSE per block: a role
// may carry `equipment` naming a profile from a small closed menu (read-only,
// editor, tester, full), and the composer attaches that profile's tool scope as
// the step's `equipment_scope`. The engine already reads equipment_scope off the
// compiled step (PR #89); here the COMPOSER assigns it instead of every step
// defaulting to "full".
//
// The closed-menu discipline mirrors the (block,executionKind) menu: an
// out-of-menu profile is a vocabulary error that walls honestly with a stable
// reason string the proposer can self-correct against. A role set with no
// equipment choice produces a byte-identical spec to today (the default-strip at
// compile time keeps composed flows that declare nothing unchanged).

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRole,
  type CompositionRoleSet,
  PROPOSER_PROMPT,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateValidity,
  renderEquipmentProfileMenu,
} from '../../src/flows/composition/index.js';

// The four trusted profiles, as the composer must expand them. Hard-coded here
// (not imported from the implementation) so the test states the contract
// independently of the code under test.
const READ_ONLY_SCOPE = { tools: { allow: ['Read', 'Grep', 'Glob'] }, enforcement: 'trusted' };
const EDITOR_SCOPE = {
  tools: { allow: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  enforcement: 'trusted',
};
const TESTER_SCOPE = {
  tools: { allow: ['Read', 'Grep', 'Glob', 'Bash'] },
  enforcement: 'trusted',
};

// RESEARCH_THEN_BUILD with one added directive per worker step: the researcher
// only looks (read-only), the implementer edits (editor), the verifier runs the
// suite (tester). Topology is untouched — only the per-block scope changes.
const RESEARCH_THEN_BUILD_EQUIPPED: CompositionRoleSet = {
  ...RESEARCH_THEN_BUILD,
  id: 'research-then-build-equipped',
  title: 'Research then Build (scoped equipment)',
  roles: RESEARCH_THEN_BUILD.roles.map((role) => {
    if (role.block === 'gather-context') return { ...role, equipment: 'read-only' };
    if (role.block === 'act') return { ...role, equipment: 'editor' };
    if (role.block === 'run-verification') return { ...role, equipment: 'tester' };
    return role;
  }),
};

describe('flow-shape composition — equipment axis', () => {
  const plain = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
  const equipped = composeFlow(RESEARCH_THEN_BUILD_EQUIPPED, { definitions: flowDefinitions });

  it('composes the equipped role set without a wall', () => {
    if (!equipped.ok) {
      throw new Error(
        `composer walled: ${equipped.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(equipped.ok).toBe(true);
  });

  it('attaches each chosen profile as the step equipment_scope', () => {
    if (!equipped.ok) throw new Error('compose failed');
    const gather = equipped.spec.items.find((it) => String(it.block) === 'gather-context');
    const act = equipped.spec.items.find((it) => String(it.block) === 'act');
    const verify = equipped.spec.items.find((it) => String(it.block) === 'run-verification');
    if (!gather || !act || !verify) throw new Error('missing equipped steps');
    // The composed spec item is a BlockStepUse (camelCase `equipmentScope`); it
    // becomes snake `equipment_scope` only after expansion + compile (asserted
    // on the runtime step below).
    expect(gather.equipmentScope).toEqual(READ_ONLY_SCOPE);
    expect(act.equipmentScope).toEqual(EDITOR_SCOPE);
    expect(verify.equipmentScope).toEqual(TESTER_SCOPE);
  });

  it('the equipped spec is VALID by the real engine gates', () => {
    if (!equipped.ok) throw new Error('compose failed');
    const validity = evaluateValidity(equipped.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
  });

  it('the chosen scope survives compile onto the runtime step', () => {
    if (!equipped.ok) throw new Error('compose failed');
    const validity = evaluateValidity(equipped.spec);
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    if (!flow) throw new Error('no compiled flow');
    const act = equipped.spec.items.find((it) => String(it.block) === 'act');
    const compiledAct = flow.steps.find((s) => s.id === String(act?.id));
    if (!compiledAct) throw new Error('no compiled act step');
    expect(compiledAct.equipment_scope).toEqual(EDITOR_SCOPE);
  });

  it('an unknown equipment profile walls honestly', () => {
    const bogus: CompositionRoleSet = {
      ...RESEARCH_THEN_BUILD,
      id: 'bad-equipment',
      // The model emits an equipment name outside the closed menu. The proposer's
      // JSON.parse would accept the unknown string, so the composer must wall with
      // a stable, legible reason rather than silently dropping it.
      roles: RESEARCH_THEN_BUILD.roles.map((role) =>
        role.block === 'gather-context'
          ? ({ ...role, equipment: 'wizard' } as unknown as CompositionRole)
          : role,
      ),
    };
    const outcome = composeFlow(bogus, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const wall = outcome.walls.find((w) => /equipment/i.test(w.reason));
      expect(wall).toBeDefined();
      // The bad value is named back so the model can self-correct.
      expect(wall?.reason).toContain('wizard');
    }
  });

  it('the proposer prompt renders the closed menu from the same profile table the validator uses', () => {
    // One source of truth: the prompt the model reads and the validator that
    // walls out-of-menu picks both derive from EQUIPMENT_PROFILES. If the table
    // changes but the hardcoded prompt menu does not, this fails (drift guard).
    expect(PROPOSER_PROMPT).toContain(renderEquipmentProfileMenu());
  });

  it('a role set with no equipment choice is byte-unchanged (no equipment_scope on any step)', () => {
    if (!plain.ok) throw new Error('compose failed');
    for (const item of plain.spec.items) {
      expect(item.equipmentScope).toBeUndefined();
    }
    // And the compiled steps carry nothing either — composed flows that declare
    // no equipment stay identical to before this axis existed.
    const validity = evaluateValidity(plain.spec);
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    if (!flow) throw new Error('no compiled flow');
    for (const step of flow.steps) {
      expect(step.equipment_scope).toBeUndefined();
    }
  });
});

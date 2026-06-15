// Resolver #2 (equipment) — behavior, the enforced-vs-trusted verdict tied to
// the substrate, and measurement through the flow lab.
import { describe, expect, it } from 'vitest';

import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { scoreSpec } from '../flow-lab/index.js';
import {
  type EquipmentStepContext,
  resolveAndApplyEquipment,
  resolveEquipment,
} from './equipment.js';

const IMPLEMENTER: EquipmentStepContext = {
  step_id: 'act-step',
  role: 'implementer',
  domain_tags: ['react', 'typescript'],
};

describe('resolveEquipment selects skills by work-type', () => {
  it('attaches the role base skill plus a skill per known domain tag', () => {
    const r = resolveEquipment(IMPLEMENTER);
    const ids = r.choice.map((s) => s.id as unknown as string);
    expect(ids).toContain('implementation-patterns'); // implementer base
    expect(ids).toContain('react-expert'); // domain tag
    expect(ids).toContain('typescript-strict'); // domain tag
  });

  it('ignores unknown domain tags and never duplicates a skill', () => {
    const r = resolveEquipment({
      step_id: 's',
      role: 'researcher',
      domain_tags: ['react', 'react', 'cobol'],
    });
    const ids = r.choice.map((s) => s.id as unknown as string);
    expect(ids.filter((id) => id === 'react-expert')).toHaveLength(1); // de-duped
    expect(ids).not.toContain('cobol'); // unknown tag dropped
  });
});

describe('the enforced-vs-trusted decision is explicit and tied to the substrate', () => {
  it('is trusted by default — skill_slots is additive injection, not an allow-list', () => {
    const r = resolveEquipment(IMPLEMENTER);
    expect(r.enforcement).toBe('trusted');
    expect(r.downgraded).toBe(false);
    expect(r.finding).toBeNull();
  });

  it('downgrades an enforced request to trusted with a finding naming the missing field', () => {
    const r = resolveEquipment(IMPLEMENTER, { requested: 'enforced' });
    expect(r.requested_enforcement).toBe('enforced');
    expect(r.enforcement).toBe('trusted');
    expect(r.downgraded).toBe(true);
    expect(r.finding).toMatch(/equipment_scope/);
  });

  it('the compiled step can only HOLD injected skills, not enforce a kit', () => {
    // Compile an equipped flow and inspect a relay step. The substrate truth the
    // `trusted` verdict rests on: the step carries skill_slots (injection) but
    // there is no equipment_scope / tool allow-list field to enforce a kit.
    const { spec } = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
    const score = scoreSpec(spec);
    if (score.score === null) throw new Error('equipped spec failed to assemble');
    if (!score.compiled.ok) throw new Error('equipped spec failed to compile');
    const relay = score.compiled.flow.steps.find((s) => s.skill_slots !== undefined);
    expect(relay).toBeDefined();
    expect(relay?.skill_slots?.length).toBeGreaterThan(0);
    expect(relay).not.toHaveProperty('equipment_scope');
  });
});

describe('measured through the flow lab: equipment drives the skill-slot gap to zero', () => {
  it('a relay-heavy flow loses every work-step-without-skill-slots issue once equipped', () => {
    const before = scoreSpec({ ...buildAssemblySpec, id: 'build-bare' });
    if (before.score === null) throw new Error('seed failed to assemble');
    const bareGap = before.tally['work-step-without-skill-slots'];
    expect(bareGap).toBeGreaterThan(0); // build's three relays start unequipped

    const { resolutions, spec } = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
    expect(resolutions.length).toBe(bareGap); // one resolution per relay
    const after = scoreSpec(spec);
    if (after.score === null) throw new Error('equipped spec failed to assemble');
    expect(after.tally['work-step-without-skill-slots']).toBe(0);
  });

  it('equipping introduces no new deficiency in any other class', () => {
    const before = scoreSpec({ ...buildAssemblySpec, id: 'build-bare' });
    const { spec } = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
    const after = scoreSpec(spec);
    if (before.score === null || after.score === null) throw new Error('failed to assemble');
    for (const key of Object.keys(after.tally) as (keyof typeof after.tally)[]) {
      if (key === 'work-step-without-skill-slots') continue;
      expect(after.tally[key], `class ${key} regressed`).toBeLessThanOrEqual(before.tally[key]);
    }
  });
});

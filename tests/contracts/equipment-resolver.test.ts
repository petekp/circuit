// B3 — the equipment resolver, ported from the offline flow lab into src.
//
// Resolver #2, built to the SAME four-part shape as the structure resolver
// (resolve / Resolution record / apply / resolveAndApply) but honoring the
// divergences recorded in docs/ideas/resolver-shared-shape.md:
//   - scope is PER WORK STEP (many resolutions per flow, not one);
//   - enforcement is TRUSTED ONLY (skill_slots is additive injection, no withhold);
//   - a DOWNGRADE / finding channel fires when `enforced` is requested.
//
// Two concerns mirror the structure-resolver test: (1) the chooser's behavior +
// the enforced-vs-trusted verdict are preserved from the lab, and (2) the
// materialized spec rides the real in-src assembler — it assembles, compiles, and
// is catalog-clean — and the injected skills actually survive onto the compiled
// step while NO enforcement field is set (the substrate truth the `trusted`
// verdict rests on).
import { describe, expect, it } from 'vitest';

import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type EquipmentStepContext,
  applyEquipment,
  resolveAndApplyEquipment,
  resolveEquipment,
} from '../../src/flows/resolvers/equipment.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';

const IMPLEMENTER: EquipmentStepContext = {
  step_id: 'act-step',
  role: 'implementer',
  domain_tags: ['react', 'typescript'],
};

// The relay steps in build's spine — the only steps equipment is resolved for.
const BUILD_RELAY_STEP_IDS = ['analyze-step', 'act-step', 'review-step'];

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

describe('every resolution is comparable trace evidence', () => {
  it('records axis, choice, binding time, enforcement, and a rationale', () => {
    const r = resolveEquipment(IMPLEMENTER);
    expect(r.axis).toBe('equipment');
    expect(r.binding_time).toBe('assembly');
    expect(r.enforcement).toBe('trusted');
    expect(Array.isArray(r.choice)).toBe(true);
    expect(r.rationale.length).toBeGreaterThan(0);
  });
});

describe('scope is per work step (the load-bearing divergence from structure)', () => {
  it('produces one resolution per relay step of a multi-relay flow', () => {
    const { resolutions } = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
    expect(resolutions.length).toBe(BUILD_RELAY_STEP_IDS.length);
    const stepIds = resolutions.map((r) => r.step_id).sort();
    expect(stepIds).toEqual([...BUILD_RELAY_STEP_IDS].sort());
    // Each resolution names its own step — equipment is a per-step choice, not a
    // single per-flow grain like structure.
    for (const r of resolutions) expect(r.step_id.length).toBeGreaterThan(0);
  });
});

describe('the enforced-vs-trusted decision is explicit and tied to the substrate', () => {
  it('is trusted by default — skill_slots is additive injection, not an allow-list', () => {
    const r = resolveEquipment(IMPLEMENTER);
    expect(r.requested_enforcement).toBe('trusted');
    expect(r.enforcement).toBe('trusted');
    expect(r.downgraded).toBe(false);
    expect(r.finding).toBeNull();
  });

  it('downgrades an enforced request to trusted with a finding naming the missing field', () => {
    const r = resolveEquipment(IMPLEMENTER, { requested: 'enforced' });
    expect(r.requested_enforcement).toBe('enforced');
    expect(r.enforcement).toBe('trusted'); // honest: substrate can only honor trusted
    expect(r.downgraded).toBe(true);
    expect(r.finding).toMatch(/equipment_scope/);
  });

  it('downgrades every per-step resolution when the whole flow is equipped enforced', () => {
    const { resolutions } = resolveAndApplyEquipment(buildAssemblySpec, ['react'], {
      requested: 'enforced',
    });
    expect(resolutions.length).toBeGreaterThan(0);
    for (const r of resolutions) {
      expect(r.downgraded).toBe(true);
      expect(r.enforcement).toBe('trusted');
      expect(r.finding).not.toBeNull();
    }
  });
});

describe('applyEquipment materializes a valid spec the assembler eats', () => {
  it('equipping a relay step assembles, compiles, and is catalog-clean', () => {
    const { spec } = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
    // Same item count as the seed — equipment augments steps, never adds/removes.
    expect(spec.items.length).toBe(buildAssemblySpec.items.length);

    const schematic = assembleFlowSchematic({ ...spec, id: 'equipment-probe' });
    // Engine boundary: the equipped flow is catalog-compatible and compiles clean.
    expect(collectSchematicCatalogIssues(schematic)).toEqual([]);
    const compiled = compileSchematicToCompiledFlow(schematic);
    expect(compiled.kind).toBe('single');
  });

  it('the injected skills survive onto the compiled relay step, with NO enforcement field', () => {
    // The substrate truth the `trusted` verdict rests on: the compiled step
    // carries skill_slots (additive injection) but no equipment_scope / tool
    // allow-list — nothing makes the kit the step's ONLY tools.
    const { spec } = resolveAndApplyEquipment(buildAssemblySpec, ['react']);
    if (compiled_kind_single(spec) === false) throw new Error('expected single compiled flow');
    const schematic = assembleFlowSchematic({ ...spec, id: 'equipment-compiled-probe' });
    const compiled = compileSchematicToCompiledFlow(schematic);
    if (compiled.kind !== 'single') throw new Error('expected single compiled flow');

    const equipped = compiled.flow.steps.find((s) => s.skill_slots !== undefined);
    expect(equipped).toBeDefined();
    expect(equipped?.skill_slots?.length).toBeGreaterThan(0);
    // Trusted-only: there is no enforced equipment_scope set by the resolver.
    expect(equipped?.equipment_scope).toBeUndefined();
  });

  it('leaves steps with no resolution untouched', () => {
    const ctx: EquipmentStepContext = {
      step_id: 'act-step',
      role: 'implementer',
      domain_tags: ['react'],
    };
    const resolution = resolveEquipment(ctx);
    const spec = applyEquipment(buildAssemblySpec, [resolution]);
    const equipped = spec.items.find((i) => i.id === 'act-step');
    const untouched = spec.items.find((i) => i.id === 'plan-step'); // compose, no resolution
    expect(equipped?.skillSlots).toBeDefined();
    expect(untouched?.skillSlots).toBeUndefined();
  });
});

// Helper used above to assert the equipped spec is single-compiled before the
// detailed step inspection; keeps the inspection test's intent legible.
function compiled_kind_single(spec: Parameters<typeof assembleFlowSchematic>[0]): boolean {
  const schematic = assembleFlowSchematic({ ...spec, id: 'equipment-kind-probe' });
  return compileSchematicToCompiledFlow(schematic).kind === 'single';
}

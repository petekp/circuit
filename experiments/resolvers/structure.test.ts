// Resolver #1 (structure) — behavior + measurement through the flow lab.
import { describe, expect, it } from 'vitest';

import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { scoreSpec } from '../flow-lab/index.js';
import {
  type StructureTaskContext,
  applyStructure,
  resolveAndApplyStructure,
  resolveStructure,
} from './structure.js';

const STRUCTURAL_CLASSES = [
  'single-step-flow',
  'undeclared-missing-act',
  'undeclared-missing-verify',
  'undeclared-missing-review',
  'partial-spine-without-rationale',
] as const;

function structuralIssues(tally: Record<string, number>): number {
  return STRUCTURAL_CLASSES.reduce((sum, key) => sum + (tally[key] ?? 0), 0);
}

const SMALL_TASK: StructureTaskContext = {
  summary: 'Rename a local variable for clarity.',
  surface_area: 'small',
  risk: 'low',
};

describe('resolveStructure leans to whole (conservative default)', () => {
  it('holds (whole) when there is no strong decompose signal', () => {
    const r = resolveStructure(SMALL_TASK);
    expect(r.choice).toBe('whole');
    expect(r.rationale.toLowerCase()).toContain('conservative');
  });

  it('chops (decomposed) on a large surface area', () => {
    expect(resolveStructure({ ...SMALL_TASK, surface_area: 'large' }).choice).toBe('decomposed');
  });

  it('chops (decomposed) on high risk', () => {
    expect(resolveStructure({ ...SMALL_TASK, risk: 'high' }).choice).toBe('decomposed');
  });

  it('chops (decomposed) on an explicit operator request', () => {
    expect(resolveStructure({ ...SMALL_TASK, explicit_decompose: true }).choice).toBe('decomposed');
  });
});

describe('every resolution is comparable trace evidence', () => {
  it('records axis, choice, binding time, enforcement, and a rationale', () => {
    const r = resolveStructure(SMALL_TASK);
    expect(r.axis).toBe('structure');
    // Structure is enforced: the assembler materializes exactly the chosen shape.
    expect(r.enforcement).toBe('enforced');
    expect(r.binding_time).toBe('assembly');
    expect(r.rationale.length).toBeGreaterThan(0);
  });
});

describe('the chooser feeds the assembler and both grains score well', () => {
  it('materializes whole as a strictly smaller, valid, well-structured flow', () => {
    const { resolution, spec } = resolveAndApplyStructure(buildAssemblySpec, SMALL_TASK);
    expect(resolution.choice).toBe('whole');
    const score = scoreSpec(spec);
    expect(score.assembled.ok).toBe(true);
    if (score.score === null) throw new Error('whole grain failed to assemble');
    expect(score.compiled.ok).toBe(true);
    // The conservative grain is genuinely fewer steps than the full spine.
    expect(spec.items.length).toBeLessThan(buildAssemblySpec.items.length);
    // ...and the assembler folded analyze + review into declared omits.
    const stages = (score.assembled.schematic.stages ?? []).map((s) => s.canonical);
    expect(stages).not.toContain('analyze');
    expect(stages).not.toContain('review');
    // Scoring well = zero STRUCTURAL deficiencies (skill-slot/alias gaps are the
    // other resolvers' axes, not structure's).
    expect(structuralIssues(score.tally)).toBe(0);
  });

  it('materializes decomposed as the full, valid spine with zero structural issues', () => {
    const { resolution, spec } = resolveAndApplyStructure(buildAssemblySpec, {
      ...SMALL_TASK,
      surface_area: 'large',
    });
    expect(resolution.choice).toBe('decomposed');
    const score = scoreSpec(spec);
    if (score.score === null) throw new Error('decomposed grain failed to assemble');
    expect(score.compiled.ok).toBe(true);
    expect(spec.items.length).toBe(buildAssemblySpec.items.length);
    const stages = (score.assembled.schematic.stages ?? []).map((s) => s.canonical);
    expect(stages).toContain('analyze');
    expect(stages).toContain('review');
    expect(structuralIssues(score.tally)).toBe(0);
  });

  it('the whole grain scores no worse than the decomposed grain on structure', () => {
    const whole = scoreSpec(applyStructure(buildAssemblySpec, resolveStructure(SMALL_TASK)));
    const decomposed = scoreSpec(
      applyStructure(buildAssemblySpec, resolveStructure({ ...SMALL_TASK, risk: 'high' })),
    );
    if (whole.score === null || decomposed.score === null)
      throw new Error('grain failed to assemble');
    expect(structuralIssues(whole.tally)).toBe(0);
    expect(structuralIssues(decomposed.tally)).toBe(0);
  });
});

// B2 — the structure resolver, ported from the offline flow lab into src.
//
// Two concerns: (1) the chooser's lean-to-whole behavior is preserved verbatim
// from the lab, and (2) the materialized grains ride the real in-src assembler
// and pass the fail-closed catalog gate + compile clean. (2) is the engine
// boundary check from the brief: foldToWhole reuses build's body-registered
// actuals, so the folded flow dodges the M9-A1 typed-seam gate the way the full
// spine does — it must still be catalog-compatible and compilable.
import { describe, expect, it } from 'vitest';

import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type StructureTaskContext,
  applyStructure,
  resolveAndApplyStructure,
  resolveStructure,
} from '../../src/flows/resolvers/structure.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';

const SMALL_TASK: StructureTaskContext = {
  summary: 'Rename a local variable for clarity.',
  surface_area: 'small',
  risk: 'low',
};

const FOLDED_AWAY = ['analyze-step', 'build-baseline', 'build-touch-area', 'review-step'];

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
    expect(r.enforcement).toBe('enforced');
    expect(r.binding_time).toBe('assembly');
    expect(r.rationale.length).toBeGreaterThan(0);
  });
});

describe('applyStructure materializes a valid spec for the assembler', () => {
  it('whole grain: folds the spine to frame -> plan -> act -> verify -> close, catalog-clean', () => {
    const { resolution, spec } = resolveAndApplyStructure(buildAssemblySpec, SMALL_TASK);
    expect(resolution.choice).toBe('whole');

    // Strictly fewer items than the full spine, and the folded steps are gone.
    expect(spec.items.length).toBeLessThan(buildAssemblySpec.items.length);
    expect(spec.items.length).toBe(buildAssemblySpec.items.length - FOLDED_AWAY.length);
    const ids = spec.items.map((item) => item.id);
    for (const dropped of FOLDED_AWAY) expect(ids).not.toContain(dropped);

    // The assembler accepts it: absent canonicals become declared omits.
    const schematic = assembleFlowSchematic({ ...spec, id: 'grain-whole-probe' });
    const canonicals = (schematic.stages ?? []).map((stage) => stage.canonical);
    expect(canonicals).not.toContain('analyze');
    expect(canonicals).not.toContain('review');
    expect(schematic.stage_path_policy?.mode).toBe('partial');

    // Engine boundary: the folded flow is catalog-compatible and compiles clean.
    expect(collectSchematicCatalogIssues(schematic)).toEqual([]);
    const compiled = compileSchematicToCompiledFlow(schematic);
    expect(compiled.kind).toBe('single');
  });

  it('decomposed grain: the full spine verbatim, catalog-clean', () => {
    const { resolution, spec } = resolveAndApplyStructure(buildAssemblySpec, {
      ...SMALL_TASK,
      surface_area: 'large',
    });
    expect(resolution.choice).toBe('decomposed');
    expect(spec.items.length).toBe(buildAssemblySpec.items.length);

    const schematic = assembleFlowSchematic({ ...spec, id: 'grain-decomposed-probe' });
    const canonicals = (schematic.stages ?? []).map((stage) => stage.canonical);
    expect(canonicals).toContain('analyze');
    expect(canonicals).toContain('review');
    expect(schematic.stage_path_policy?.mode).toBe('strict');
    expect(collectSchematicCatalogIssues(schematic)).toEqual([]);
  });

  it('applyStructure stamps a grain suffix the caller can override', () => {
    const whole = applyStructure(buildAssemblySpec, resolveStructure(SMALL_TASK));
    expect(whole.id).toBe('build-whole');
    const decomposed = applyStructure(
      buildAssemblySpec,
      resolveStructure({ ...SMALL_TASK, explicit_decompose: true }),
    );
    expect(decomposed.id).toBe('build-decomposed');
  });
});

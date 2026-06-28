// Unit tests for the per-mode behavior of compileSchematicToCompiledFlow:
// reachability with route_overrides, dead-step elimination per mode,
// auto-omitted canonicals in stage_path_policy, and rich route preservation.
// Byte-equivalence against committed compiled flows is covered separately by
// tests/contracts/compile-schematic-to-flow.test.ts.

import { describe, expect, it } from 'vitest';

import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlow } from '../helpers/in-memory-schematics.js';

// The carried-notes file the until flag maintains across iterations is engine-
// written: it has no schematic producer, so the contract-driven reads derivation
// never adds it. But the until loop's compounding mechanism depends on the head
// step re-reading the accumulated lessons each pass (the prompt composer inlines
// every reads-declared file). So the compiler injects the until flag's
// carried_notes.report path into the head step's reads. fix-until-green is the
// first flow to declare carried_notes, so it is the fixture for this behavior.
function loadFixUntilGreenSchematic() {
  return schematicForFlow('fix-until-green');
}

// M6: build schematic from the in-memory catalog definition, not disk.
function loadBuildSchematic() {
  return schematicForFlow('build');
}

describe('compileSchematicToCompiledFlow — per-mode emission', () => {
  it('returns kind:single when no item declares route_overrides', () => {
    const schematic = loadBuildSchematic();
    const result = compileSchematicToCompiledFlow(schematic);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    expect(result.flow.axes).toMatchObject({
      allowed_depths: ['low', 'medium', 'high'],
      supports_autonomous: true,
    });
    expect(result.flow.starts_at).toBe('frame-step');
  });

  it('returns kind:per-mode when an item declares route_overrides; low mode drops unreachable items', () => {
    const schematic = loadBuildSchematic();
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'review-step'
        ? { ...item, route_overrides: { continue: { low: '@complete' as const } } }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;

    const result = compileSchematicToCompiledFlow(mutated);
    expect(result.kind).toBe('per-mode');
    if (result.kind !== 'per-mode') return;

    const low = result.flows.get('low');
    const def = result.flows.get('default');
    expect(low).toBeDefined();
    expect(def).toBeDefined();
    if (low === undefined || def === undefined) return;

    // Reachable steps differ. Low skips close-step entirely because
    // review-step's continue edge now lands on the @complete terminal.
    const lowIds = low.steps.map((s) => s.id as unknown as string);
    const defIds = def.steps.map((s) => s.id as unknown as string);
    expect(lowIds).not.toContain('close-step');
    expect(defIds).toContain('close-step');

    // The review-step's own pass edge differs by mode.
    const lowReview = low.steps.find((s) => (s.id as unknown as string) === 'review-step');
    const defReview = def.steps.find((s) => (s.id as unknown as string) === 'review-step');
    expect(lowReview?.routes.pass).toBe('@complete');
    expect(defReview?.routes.pass).toBe('close-step');

    expect(low.starts_at).toBe('frame-step');
    expect(def.starts_at).toBe('frame-step');
  });

  it('auto-omits canonicals that have no reachable items in a given mode', () => {
    const schematic = loadBuildSchematic();
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'review-step'
        ? { ...item, route_overrides: { continue: { low: '@complete' as const } } }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;

    const result = compileSchematicToCompiledFlow(mutated);
    if (result.kind !== 'per-mode') {
      throw new Error('expected per-mode result');
    }
    const low = result.flows.get('low');
    if (low === undefined) throw new Error('expected low compiled flow');

    // close-step's canonical stage is 'close'. Low drops it; the compiled
    // stage_path_policy must auto-omit 'close' so the CompiledFlow validator's
    // stage path completeness rule still passes.
    expect(low.stage_path_policy.mode).toBe('partial');
    if (low.stage_path_policy.mode !== 'partial') return;
    expect(low.stage_path_policy.omits).toContain('close');
    expect(low.stage_path_policy.rationale).toMatch(/low/);
  });

  it('preserves rich schematic outcomes as executable compiled routes', () => {
    const schematic = loadBuildSchematic();
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'close-step'
        ? {
            ...item,
            routes: {
              ...item.routes,
              handoff: '@handoff' as const,
              escalate: '@escalate' as const,
            },
          }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;

    const result = compileSchematicToCompiledFlow(mutated);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    const close = result.flow.steps.find((s) => (s.id as unknown as string) === 'close-step');
    expect(close).toBeDefined();
    expect(close?.routes).toMatchObject({
      pass: '@complete',
      complete: '@complete',
      stop: '@stop',
      handoff: '@handoff',
      escalate: '@escalate',
    });
  });

  it('injects the until flag carried_notes path into the head step reads', () => {
    const schematic = loadFixUntilGreenSchematic();
    const result = compileSchematicToCompiledFlow(schematic);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;

    const flag = result.flow.engine_flags?.iterates_until_condition;
    expect(flag).toBeDefined();
    if (flag === undefined) return;
    const notesPath = flag.carried_notes?.report;
    expect(notesPath).toBe('reports/fix-until-green/carried-notes.json');
    if (notesPath === undefined) return;

    const head = result.flow.steps.find((s) => (s.id as unknown as string) === flag.head_step);
    expect(head).toBeDefined();
    // The head re-reads the accumulated lessons each pass, so the prompt composer
    // inlines them. The path has no schematic producer, so the contract-driven
    // reads derivation never adds it — the compiler injects it from the flag.
    expect(head?.reads).toContain(notesPath);

    // The injection is head-only: a non-head body step must not gain the path.
    const tail = result.flow.steps.find((s) => (s.id as unknown as string) === flag.tail_step);
    expect(tail?.reads ?? []).not.toContain(notesPath);
  });
});

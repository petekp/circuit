// Unit tests for the per-mode behavior of compileSchematicToCompiledFlow:
// reachability with route_overrides, dead-step elimination per mode,
// auto-omitted canonicals in stage_path_policy, and rich route preservation.
// Byte-equivalence against committed compiled flows is covered separately by
// tests/contracts/compile-schematic-to-flow.test.ts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadBuildSchematic() {
  return FlowSchematic.parse(readJson('src/flows/build/schematic.json'));
}

describe('compileSchematicToCompiledFlow — per-mode emission', () => {
  it('returns kind:single when no item declares route_overrides', () => {
    const schematic = loadBuildSchematic();
    const result = compileSchematicToCompiledFlow(schematic);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    expect(result.flow.axes).toMatchObject({
      allowed_depths: ['lite', 'standard', 'deep'],
      supports_autonomous: true,
    });
    expect(result.flow.starts_at).toBe('frame-step');
  });

  it('returns kind:per-mode when an item declares route_overrides; lite mode drops unreachable items', () => {
    const schematic = loadBuildSchematic();
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'review-step'
        ? { ...item, route_overrides: { continue: { lite: '@complete' as const } } }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;

    const result = compileSchematicToCompiledFlow(mutated);
    expect(result.kind).toBe('per-mode');
    if (result.kind !== 'per-mode') return;

    const lite = result.flows.get('lite');
    const def = result.flows.get('default');
    expect(lite).toBeDefined();
    expect(def).toBeDefined();
    if (lite === undefined || def === undefined) return;

    // Reachable steps differ. Lite skips close-step entirely because
    // review-step's continue edge now lands on the @complete terminal.
    const liteIds = lite.steps.map((s) => s.id as unknown as string);
    const defIds = def.steps.map((s) => s.id as unknown as string);
    expect(liteIds).not.toContain('close-step');
    expect(defIds).toContain('close-step');

    // The review-step's own pass edge differs by mode.
    const liteReview = lite.steps.find((s) => (s.id as unknown as string) === 'review-step');
    const defReview = def.steps.find((s) => (s.id as unknown as string) === 'review-step');
    expect(liteReview?.routes.pass).toBe('@complete');
    expect(defReview?.routes.pass).toBe('close-step');

    expect(lite.starts_at).toBe('frame-step');
    expect(def.starts_at).toBe('frame-step');
  });

  it('auto-omits canonicals that have no reachable items in a given mode', () => {
    const schematic = loadBuildSchematic();
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'review-step'
        ? { ...item, route_overrides: { continue: { lite: '@complete' as const } } }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;

    const result = compileSchematicToCompiledFlow(mutated);
    if (result.kind !== 'per-mode') {
      throw new Error('expected per-mode result');
    }
    const lite = result.flows.get('lite');
    if (lite === undefined) throw new Error('expected lite compiled flow');

    // close-step's canonical stage is 'close'. Lite drops it; the compiled
    // stage_path_policy must auto-omit 'close' so the CompiledFlow validator's
    // stage path completeness rule still passes.
    expect(lite.stage_path_policy.mode).toBe('partial');
    if (lite.stage_path_policy.mode !== 'partial') return;
    expect(lite.stage_path_policy.omits).toContain('close');
    expect(lite.stage_path_policy.rationale).toMatch(/lite/);
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
});

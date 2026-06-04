import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Bug (Pete, 2026-06-03): Build plans and acts without ever reading the codebase.
// Frame is a static-template checkpoint, Plan is a deterministic compose over the
// brief alone, and Act (the implementer) is the first step that touches the repo.
// A grounded Build must read the code BEFORE planning: a `researcher` relay on an
// `analyze` stage between Frame and Plan (the `gather-context` block, as Fix uses).
// These assertions fail until that grounding step exists.
//
// The schematic is read from its checked-in JSON artifact rather than imported
// from the flow's data.ts, so the test stays on the engine->flow boundary's
// allowed surface (no direct flow-internal import), the way flow-facts does.

type SchematicItemView = {
  readonly id: string;
  readonly stage?: string;
  readonly execution?: { readonly kind?: string; readonly role?: string };
  readonly routes?: Record<string, string>;
};
type SchematicStageView = { readonly canonical?: string };
type SchematicView = {
  readonly items: ReadonlyArray<SchematicItemView>;
  readonly stages: ReadonlyArray<SchematicStageView>;
};

const schematic = JSON.parse(
  readFileSync(resolve('src/flows/build/schematic.json'), 'utf8'),
) as SchematicView;
const items = schematic.items;
const byId = new Map(items.map((step) => [step.id, step]));

describe('Build grounded planning (mise en place before act)', () => {
  it('includes an analyze stage for grounding', () => {
    const canonicals = schematic.stages.map((stage) => stage.canonical);
    expect(canonicals).toContain('analyze');
  });

  it('reads the code before planning: the step after Frame is a researcher relay on analyze', () => {
    const frame = byId.get('frame-step');
    expect(frame, 'frame-step should exist').toBeDefined();
    const next = byId.get(frame?.routes?.continue ?? '');
    expect(
      next,
      'Frame should continue into a code-reading step, not jump to a blind plan',
    ).toBeDefined();
    expect(next?.execution?.kind).toBe('relay');
    expect(next?.execution?.role).toBe('researcher');
    expect(next?.stage).toBe('analyze');
  });

  it('the grounding relay feeds the plan, so the plan is informed by the codebase', () => {
    const researcher = items.find(
      (step) => step.execution?.kind === 'relay' && step.execution?.role === 'researcher',
    );
    expect(researcher, 'Build should have a code-reading researcher relay').toBeDefined();
    expect(researcher?.routes?.continue).toBe('plan-step');
  });
});

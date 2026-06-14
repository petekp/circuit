import { describe, expect, it } from 'vitest';

import { schematicForFlow } from '../helpers/in-memory-schematics.js';

// Bug (Pete, 2026-06-03): Build plans and acts without ever reading the codebase.
// Frame is a static-template checkpoint, Plan is a deterministic compose over the
// brief alone, and Act (the implementer) is the first step that touches the repo.
// A grounded Build must read the code BEFORE planning: a `researcher` relay on an
// `analyze` stage between Frame and Plan (the `gather-context` block, as Fix uses).
// These assertions fail until that grounding step exists.
//
// M6: the schematic comes from the in-memory catalog definition (schematicForFlow)
// instead of reading the generated JSON back from disk. This still avoids a direct
// flow-internal import — the helper reads the catalog aggregate, the same
// boundary-safe surface flow-facts uses — and check-flow-drift proves the committed
// schematic.json is a snapshot of this very definition.

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

const schematic = schematicForFlow('build') as unknown as SchematicView;
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

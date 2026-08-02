// The designer's flow id comes off a URL and used to be joined straight into a
// filesystem path, so `../../..` in it reached any schematic.json on the
// machine, and a PUT could write one there.
import { describe, expect, it } from 'vitest';
import { flowSchematicPath } from '../../apps/designer/flow-id.js';

const FLOWS_DIR = '/repo/src/flows';

describe('the designer resolving a flow id to a file', () => {
  it('resolves a real flow id under the flow directory', () => {
    expect(flowSchematicPath(FLOWS_DIR, 'review')).toEqual({
      ok: true,
      path: '/repo/src/flows/review/schematic.json',
    });
    expect(flowSchematicPath(FLOWS_DIR, 'fix-until-green').ok).toBe(true);
  });

  it('refuses an id that climbs out of the flow directory', () => {
    for (const id of ['..', '../../etc', 'review/../../..', '/etc']) {
      const resolved = flowSchematicPath(FLOWS_DIR, id);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error('expected a refusal');
      expect(resolved.reason).toContain('flow id');
    }
  });

  it('refuses an empty or shouted id rather than guessing', () => {
    expect(flowSchematicPath(FLOWS_DIR, '').ok).toBe(false);
    expect(flowSchematicPath(FLOWS_DIR, 'Review').ok).toBe(false);
    expect(flowSchematicPath(FLOWS_DIR, '-review').ok).toBe(false);
  });
});

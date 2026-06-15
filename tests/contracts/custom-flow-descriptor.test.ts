// M9-C: the custom-flow package descriptor no longer carries an `archetype`.
//
// Before first-class composition, `circuit create` produced a custom flow by
// cloning build's COMPILED bytes off disk and stamping `archetype: build` — a
// second production mechanism that hard-coded "every custom flow IS a build
// clone". M9 retires that path: create now produces its flow through the
// sanctioned assemble->compile path, the same way build's own data.ts does.
// The descriptor schema drops the `archetype: z.literal('build')` lock, and
// being `.strict()`, now REJECTS a stray archetype key rather than blessing it.
import { describe, expect, it } from 'vitest';
import { CustomFlowPackageDescriptor } from '../../src/schemas/custom-flow-descriptor.js';

const validDescriptor = {
  schema_version: 1 as const,
  id: 'release-note-flow',
  format: 'compiled-flow-package' as const,
  compiled_flow: 'circuit.json' as const,
  purpose: 'Draft release notes from a change summary',
};

describe('CustomFlowPackageDescriptor', () => {
  it('accepts a descriptor without an archetype field', () => {
    expect(() => CustomFlowPackageDescriptor.parse(validDescriptor)).not.toThrow();
  });

  it('rejects a descriptor that still carries the legacy archetype key', () => {
    expect(() =>
      CustomFlowPackageDescriptor.parse({ ...validDescriptor, archetype: 'build' }),
    ).toThrow();
  });
});

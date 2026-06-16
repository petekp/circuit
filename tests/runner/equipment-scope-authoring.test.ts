// Equipment scope rides the manifest, end to end: authored on the schematic
// step (manifest-first, never a by-id lookup), guarded for enforced-only-at-the-
// write-tier, and compiled onto the runtime step exactly like skill_slots.

import { describe, expect, it } from 'vitest';

import {
  type BlockStepUse,
  expandBlockStepUseValue,
  relayBlockStep,
} from '../../src/flows/block-step-expansion.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlow } from '../helpers/in-memory-schematics.js';

const relayWrites = {
  request_path: 'reports/relay/act-request.json',
  receipt_path: 'reports/relay/act-receipt.json',
  result_path: 'reports/relay/act-result.json',
  report_path: 'reports/implementation.json',
} as const;

function actUse(extra: Partial<BlockStepUse>): BlockStepUse {
  return {
    id: 'act-step',
    block: 'act',
    title: 'Implement the plan',
    stage: 'act',
    input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'test-act@v1',
    writes: relayWrites,
    check: { pass: ['accept'] },
    routes: { continue: 'verify-step', retry: 'act-step', stop: '@stop' },
    ...extra,
  };
}

describe('Equipment scope — authoring on the schematic step', () => {
  it('carries an enforced allow-list onto an implementer relay step', () => {
    const result = expandBlockStepUseValue(
      actUse({
        equipmentScope: { tools: { allow: ['Read', 'Edit', 'Write'] }, enforcement: 'enforced' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.equipment_scope).toEqual({
      tools: { allow: ['Read', 'Edit', 'Write'] },
      enforcement: 'enforced',
    });
  });

  it('defaults enforcement to trusted when only tools are declared', () => {
    const result = expandBlockStepUseValue(
      actUse({ equipmentScope: { tools: { allow: ['Read'] } } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.equipment_scope?.enforcement).toBe('trusted');
  });

  it('omits equipment_scope when none is declared (back-compat)', () => {
    const result = expandBlockStepUseValue(actUse({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.equipment_scope).toBeUndefined();
  });

  it('rejects an enforced binding on a researcher relay (enforced is a write-tier property)', () => {
    // relayBlockStep throws on an invalid step; the enforced-on-researcher guard
    // must fire here just as it does through the Value form below.
    expect(() =>
      relayBlockStep({
        id: 'gather-step',
        block: 'gather-context',
        role: 'researcher',
        title: 'Gather context',
        stage: 'analyze',
        input: { brief: 'flow.brief@v1' },
        protocol: 'test-gather@v1',
        writes: {
          request_path: 'reports/relay/gather-request.json',
          receipt_path: 'reports/relay/gather-receipt.json',
          result_path: 'reports/relay/gather-result.json',
        },
        check: { pass: ['accept'] },
        routes: { continue: 'act-step', stop: '@stop' },
        equipmentScope: { tools: { allow: ['Read'] }, enforcement: 'enforced' },
      }),
    ).toThrow();
  });

  it('rejects an enforced binding on a researcher relay via the Value form', () => {
    const result = expandBlockStepUseValue({
      id: 'gather-step',
      block: 'gather-context',
      title: 'Gather context',
      stage: 'analyze',
      input: { brief: 'flow.brief@v1' },
      execution: { kind: 'relay', role: 'researcher' },
      protocol: 'test-gather@v1',
      writes: {
        request_path: 'reports/relay/gather-request.json',
        receipt_path: 'reports/relay/gather-receipt.json',
        result_path: 'reports/relay/gather-result.json',
      },
      check: { pass: ['accept'] },
      routes: { continue: 'act-step', stop: '@stop' },
      equipmentScope: { tools: { allow: ['Read'] }, enforcement: 'enforced' },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a trusted allow-list on a researcher relay (trusted is role-agnostic)', () => {
    const result = expandBlockStepUseValue({
      id: 'gather-step',
      block: 'gather-context',
      title: 'Gather context',
      stage: 'analyze',
      input: { brief: 'flow.brief@v1' },
      execution: { kind: 'relay', role: 'researcher' },
      protocol: 'test-gather@v1',
      writes: {
        request_path: 'reports/relay/gather-request.json',
        receipt_path: 'reports/relay/gather-receipt.json',
        result_path: 'reports/relay/gather-result.json',
      },
      check: { pass: ['accept'] },
      routes: { continue: 'act-step', stop: '@stop' },
      equipmentScope: { tools: { allow: ['Read', 'Grep'] }, enforcement: 'trusted' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('Equipment scope — compiled onto the runtime step', () => {
  it('carries a non-default equipment_scope through the compiler', () => {
    const schematic = schematicForFlow('build');
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'act-step'
        ? {
            ...item,
            equipment_scope: {
              tools: { allow: ['Read', 'Edit', 'Write'] as string[] },
              enforcement: 'enforced' as const,
            },
          }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;
    const result = compileSchematicToCompiledFlow(mutated);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    const act = result.flow.steps.find((s) => (s.id as unknown as string) === 'act-step');
    expect(act?.equipment_scope).toEqual({
      tools: { allow: ['Read', 'Edit', 'Write'] },
      enforcement: 'enforced',
    });
  });

  it('omits equipment_scope on steps that declare none (byte-stable default)', () => {
    const schematic = schematicForFlow('build');
    const result = compileSchematicToCompiledFlow(schematic);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    for (const step of result.flow.steps) {
      expect(step.equipment_scope).toBeUndefined();
    }
  });
});

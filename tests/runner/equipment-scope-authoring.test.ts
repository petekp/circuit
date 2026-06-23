// Equipment scope rides the manifest, end to end: authored on the schematic
// step (manifest-first, never a by-id lookup), guarded so enforced is legal on
// any relay step (every role runs a tool-scoped worker) but still rejected on
// orchestrator steps, and compiled onto the runtime step like skill_slots.

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

  it('carries an enforced allow-list onto a researcher relay (a read-only floor on a worker that should only look)', () => {
    // A researcher relay runs a real worker subprocess that the connector can
    // tool-scope. An enforced read-only scope is a genuine boundary there — the
    // place a hard floor is most valuable, not an authoring slip. relayBlockStep
    // returns the step (it no longer throws).
    const step = relayBlockStep({
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
    });
    expect(step.equipment_scope).toEqual({
      tools: { allow: ['Read'] },
      enforcement: 'enforced',
    });
  });

  it('carries an enforced allow-list onto a researcher relay via the Value form', () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.equipment_scope).toEqual({
      tools: { allow: ['Read'] },
      enforcement: 'enforced',
    });
  });

  it('carries an enforced allow-list onto a reviewer relay (a reviewer only judges)', () => {
    // The second newly-allowed role. A reviewer is a non-writing worker too, so
    // a hard read-only floor is just as meaningful and the gate must accept it.
    const result = expandBlockStepUseValue({
      id: 'review-step',
      block: 'review',
      title: 'Review the change',
      stage: 'review',
      input: { brief: 'flow.brief@v1' },
      execution: { kind: 'relay', role: 'reviewer' },
      protocol: 'test-review@v1',
      writes: {
        request_path: 'reports/relay/review-request.json',
        receipt_path: 'reports/relay/review-receipt.json',
        result_path: 'reports/relay/review-result.json',
      },
      check: { pass: ['accept'] },
      routes: { continue: 'close-step', stop: '@stop' },
      equipmentScope: { tools: { allow: ['Read', 'Grep', 'Glob'] }, enforcement: 'enforced' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.equipment_scope?.enforcement).toBe('enforced');
  });

  it('still rejects an enforced binding on a non-relay (verification) step', () => {
    // The gate narrowed from "implementer relay only" to "any relay", not to
    // "anywhere". An orchestrator step (here, verification) runs no tool-scoped
    // worker subprocess, so an enforced tool restriction there has nothing to
    // bound and is still an authoring slip. This guards against over-lifting.
    const result = expandBlockStepUseValue({
      id: 'verify-step',
      block: 'run-verification',
      title: 'Run verification',
      stage: 'verify',
      input: { plan: 'verification.plan@v1' },
      protocol: 'test-verify@v1',
      reportPath: 'reports/verification.json',
      required: ['overall_status', 'commands'],
      routes: { continue: 'close-step', retry: 'verify-step', stop: '@stop' },
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

  it('carries an enforced read-only equipment_scope through the compiler on a researcher step', () => {
    // The lifted gate makes enforced legal on a researcher relay; the compiler
    // copies it onto the runtime step role-blind, exactly as it does for the
    // implementer. This compiled scope is the artifact the runtime resolver
    // reads to apply the connector's --tools restriction.
    const schematic = schematicForFlow('build');
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'analyze-step'
        ? {
            ...item,
            equipment_scope: {
              tools: { allow: ['Read', 'Grep', 'Glob'] as string[] },
              enforcement: 'enforced' as const,
            },
          }
        : item,
    );
    const mutated = { ...schematic, items } as typeof schematic;
    const result = compileSchematicToCompiledFlow(mutated);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    const analyze = result.flow.steps.find((s) => (s.id as unknown as string) === 'analyze-step');
    expect(analyze?.equipment_scope).toEqual({
      tools: { allow: ['Read', 'Grep', 'Glob'] },
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

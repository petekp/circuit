// Step budgets, end to end from the schematic to the runtime step.
//
// The engine half of budgets has been live for a while: the runtime step schema
// carries them, the manifest threads them, and all four connectors document how
// they override the watchdog bounds. The authoring half was missing — `budgets`
// was not a field on the schematic step, so a flow author could not write one.
// Everything below the schematic was waiting on an input that had no way in.
//
// Two behaviours are worth stating because they are easy to get wrong:
//
//   A budget may declare a timeout WITHOUT touching retries. `max_attempts` was
//   required inside the budgets object, and the runtime reads
//   `configuredMaxAttempts(step) ?? (recoveryRoute ? 2 : 1)` — one declared
//   value covering two different defaults. So any step that declared a timeout
//   was forced to also pick a retry count, and no single choice preserved the
//   existing behaviour for both route shapes. Making it optional is what lets a
//   timeout be declared in isolation.
//
//   A declared budget must survive block expansion. Most steps are authored as
//   block uses, not as raw schematic items, so a passthrough that only covers
//   the direct form would miss nearly every real step.

import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type BlockStepUse,
  expandBlockStepUseValue,
  relayBlockStep,
} from '../../src/flows/block-step-expansion.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { StepBase } from '../../src/schemas/step.js';
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

describe('Step budgets — a timeout can be declared without touching retries', () => {
  it('accepts a budget that sets only an inactivity ceiling', () => {
    const parsed = StepBase.shape.budgets.safeParse({ inactivity_ms: 1_800_000 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a budget that sets only a wall-clock ceiling', () => {
    const parsed = StepBase.shape.budgets.safeParse({ wall_clock_ms: 7_200_000 });
    expect(parsed.success).toBe(true);
  });

  it('still accepts a budget that sets max_attempts', () => {
    const parsed = StepBase.shape.budgets.safeParse({ max_attempts: 3 });
    expect(parsed.success).toBe(true);
  });

  it('still rejects an out-of-range max_attempts', () => {
    expect(StepBase.shape.budgets.safeParse({ max_attempts: 0 }).success).toBe(false);
    expect(StepBase.shape.budgets.safeParse({ max_attempts: 11 }).success).toBe(false);
  });

  it('rejects a non-positive timeout', () => {
    expect(StepBase.shape.budgets.safeParse({ inactivity_ms: 0 }).success).toBe(false);
    expect(StepBase.shape.budgets.safeParse({ wall_clock_ms: -1 }).success).toBe(false);
  });
});

describe('Step budgets — authoring on a block use', () => {
  it('carries a declared budget onto an implementer relay step', () => {
    const result = expandBlockStepUseValue(actUse({ budgets: { inactivity_ms: 1_800_000 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.budgets).toEqual({ inactivity_ms: 1_800_000 });
  });

  it('carries a budget through the non-Value block helper too', () => {
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
      budgets: { wall_clock_ms: 5_400_000 },
    });
    expect(step.budgets).toEqual({ wall_clock_ms: 5_400_000 });
  });

  it('omits budgets on a step that declares none (byte-stable default)', () => {
    const result = expandBlockStepUseValue(actUse({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.budgets).toBeUndefined();
  });
});

describe('Step budgets — compiled onto the runtime step', () => {
  it('carries a declared budget through the compiler', () => {
    const schematic = schematicForFlow('build');
    const items = schematic.items.map((item) =>
      (item.id as unknown as string) === 'act-step'
        ? { ...item, budgets: { inactivity_ms: 1_800_000 } }
        : item,
    );
    const result = compileSchematicToCompiledFlow({ ...schematic, items } as typeof schematic);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    const act = result.flow.steps.find((s) => (s.id as unknown as string) === 'act-step');
    expect(act?.budgets).toEqual({ inactivity_ms: 1_800_000 });
  });

  it('omits budgets on steps that declare none', () => {
    const schematic = schematicForFlow('build');
    const result = compileSchematicToCompiledFlow(schematic);
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') return;
    for (const step of result.flow.steps) {
      if ((step.id as unknown as string) === 'act-step') continue;
      expect(step.budgets).toBeUndefined();
    }
  });
});

describe('Step budgets — the two declarations that ship', () => {
  // Sized from the recorded run corpus, not from taste. Across 122 relay
  // executions these are the only two steps whose duration comes within 3x of
  // the connector's 60-minute wall-clock backstop: build's act-step reaches 21
  // minutes and pursue's batch-step reaches 28, with a 20-minute median. Nothing
  // else exceeds 10. If either declaration is dropped, the long tail of the two
  // most expensive steps in the product goes back to being killed mid-flight.
  const declared: ReadonlyArray<readonly [string, string]> = [
    ['build', 'act-step'],
    ['pursue', 'batch-step'],
  ];

  for (const [flowId, stepId] of declared) {
    it(`${flowId}/${stepId} ships a two-hour wall clock and no other bound`, () => {
      const compiled = JSON.parse(
        readFileSync(resolve(`generated/flows/${flowId}/circuit.json`), 'utf8'),
      ) as { steps: ReadonlyArray<{ id: string; budgets?: Record<string, number> }> };
      const step = compiled.steps.find((s) => s.id === stepId);
      expect(step).toBeDefined();
      // Wall clock only. The inactivity bound stays at the connector default
      // because that is the bound that detects a wedged worker; raising it too
      // would trade a real safety property for nothing.
      expect(step?.budgets).toEqual({ wall_clock_ms: 7_200_000 });
    });
  }

  it('leaves every other shipped step unbudgeted', () => {
    // A budget is a claim that a step needs one. Sprinkling them would make the
    // two that are evidence-backed indistinguishable from guesses.
    const declaredKeys = new Set(declared.map(([f, s]) => `${f}/${s}`));
    const found: string[] = [];
    for (const path of globSync('generated/flows/*/circuit.json')) {
      const flowId = path.split('/')[2];
      const compiled = JSON.parse(readFileSync(path, 'utf8')) as {
        steps?: ReadonlyArray<{ id: string; budgets?: unknown }>;
      };
      for (const step of compiled.steps ?? []) {
        if (step.budgets !== undefined) found.push(`${flowId}/${step.id}`);
      }
    }
    expect(new Set(found.filter((k) => !declaredKeys.has(k)))).toEqual(new Set());
  });
});

// Cross-flow hygiene invariants for worker-facing relay prompt text.
//
// Three invariants from the 2026-06-11 prompt audit
// (docs/audits/2026-06-11-prompt-audit.md):
//   1. Every schema shape hint carries the full mechanical parse contract.
//      The runtime hard-fails on prose around the JSON and on JSON.parse
//      errors, so a hint that omits the warning leaves its worker as the
//      only one never told about an enforcement that applies to all.
//   2. Progress display roles match the schematic execution role, so the
//      operator is never told an implementer is "making the change" while
//      a read-only researcher step runs.
//   3. Prompt-facing strings use the shipped depth vocabulary (low,
//      medium, high) — not the retired lite/deep/standard mode words the
//      worker never sees in its "Depth:" line.

import { describe, expect, it } from 'vitest';

import { flowDefinitions } from '../../src/flows/catalog.js';
import { listRegisteredSchemaHints } from '../../src/flows/registries/shape-hints/registry.js';

type SchematicItem = {
  readonly id: string;
  readonly title?: string;
  readonly execution?: { readonly kind?: string; readonly role?: string };
};

type ProgressStep = {
  readonly stepId: string;
  readonly taskTitle?: string;
  readonly activeText?: string;
  readonly relayRole?: string;
  readonly relayStartedText?: string;
  readonly relayCompletedText?: string;
};

function schematicItems(definition: (typeof flowDefinitions)[number]): readonly SchematicItem[] {
  return (definition.schematic as { items?: readonly SchematicItem[] }).items ?? [];
}

function progressSteps(definition: (typeof flowDefinitions)[number]): readonly ProgressStep[] {
  return (
    (definition.runtimeSurface as { progress?: { steps?: readonly ProgressStep[] } } | undefined)
      ?.progress?.steps ?? []
  );
}

describe('relay prompt hygiene', () => {
  it('every schema shape hint carries the full mechanical parse contract', () => {
    const hints = listRegisteredSchemaHints();
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint.instruction, `${hint.schema} should ban Markdown code fences`).toContain(
        'Do not wrap the JSON in Markdown code fences',
      );
      expect(hint.instruction, `${hint.schema} should ban prose around the JSON object`).toContain(
        'prose before or after the JSON object',
      );
      expect(hint.instruction, `${hint.schema} should warn about JSON.parse`).toContain(
        'JSON.parse',
      );
    }
  });

  it('progress display roles match the schematic execution role', () => {
    for (const definition of flowDefinitions) {
      const items = new Map(schematicItems(definition).map((item) => [item.id, item]));
      for (const step of progressSteps(definition)) {
        if (step.relayRole === undefined) continue;
        const item = items.get(step.stepId);
        if (item?.execution?.kind !== 'relay' || item.execution.role === undefined) continue;
        expect(
          step.relayRole,
          `${definition.id}/${step.stepId} progress role should match the step's execution role`,
        ).toBe(item.execution.role);
      }
    }
  });

  it('prompt-facing strings use the shipped depth vocabulary', () => {
    const staleVocabulary = /\b(lite|deep job|deep depth|lighter depth|standard depth)\b/i;
    const offenders: string[] = [];

    for (const hint of listRegisteredSchemaHints()) {
      if (staleVocabulary.test(hint.instruction)) {
        offenders.push(`shape hint ${hint.schema}`);
      }
    }
    for (const definition of flowDefinitions) {
      for (const item of schematicItems(definition)) {
        if (item.title !== undefined && staleVocabulary.test(item.title)) {
          offenders.push(`${definition.id}/${item.id} title "${item.title}"`);
        }
      }
      for (const step of progressSteps(definition)) {
        for (const text of [
          step.taskTitle,
          step.activeText,
          step.relayStartedText,
          step.relayCompletedText,
        ]) {
          if (text !== undefined && staleVocabulary.test(text)) {
            offenders.push(`${definition.id}/${step.stepId} progress text "${text}"`);
          }
        }
      }
    }

    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

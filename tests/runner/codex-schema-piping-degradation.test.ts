import { describe, expect, it } from 'vitest';

import {
  codexOutputSchemaFrom,
  isCodexOutputSchemaCompatible,
} from '../../src/connectors/codex.js';
import { PrototypeVariantArtifact } from '../../src/flows/prototype/reports.js';
import { ReviewRelayResult } from '../../src/flows/review/reports.js';
import { responseJsonSchemaFromZod } from '../../src/shared/zod-to-response-schema.js';

describe('isCodexOutputSchemaCompatible — codex --output-schema compatibility probe', () => {
  it('accepts a strict top-level object schema inside the Codex structured-output subset', () => {
    expect(
      isCodexOutputSchemaCompatible({
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it('rejects a top-level anyOf (discriminated union)', () => {
    expect(
      isCodexOutputSchemaCompatible({
        anyOf: [
          { type: 'object', properties: { verdict: { const: 'a' } } },
          { type: 'object', properties: { verdict: { const: 'b' } } },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a top-level oneOf', () => {
    expect(isCodexOutputSchemaCompatible({ oneOf: [{ type: 'object' }, { type: 'string' }] })).toBe(
      false,
    );
  });

  it('rejects array, string, and number roots', () => {
    expect(isCodexOutputSchemaCompatible({ type: 'array', items: {} })).toBe(false);
    expect(isCodexOutputSchemaCompatible({ type: 'string' })).toBe(false);
    expect(isCodexOutputSchemaCompatible({ type: 'number' })).toBe(false);
  });

  // Validation-only keywords used to disqualify a schema outright. They now
  // strip instead, because dropping one cannot make Codex build the wrong
  // structure, and the runtime Zod parse still rejects a value that violates it.
  // Treating them as disqualifying meant no flow schema ever reached the flag:
  // every schema Circuit derives from Zod carries a `$schema` annotation, and
  // every `.min(1)` becomes `minLength`.
  it('accepts a schema whose only unsupported keywords are validation-only', () => {
    expect(
      isCodexOutputSchemaCompatible({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          variant_id: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 1 },
        },
        required: ['variant_id'],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it('rejects object maps expressed through additionalProperties schemas', () => {
    expect(
      isCodexOutputSchemaCompatible({
        type: 'object',
        properties: {
          judgments: {
            type: 'object',
            additionalProperties: { type: 'string', enum: ['pass', 'concern', 'fail'] },
          },
        },
        required: ['judgments'],
        additionalProperties: false,
      }),
    ).toBe(false);
  });

  it('rejects the Prototype variant-artifact report schema so Codex relies on prompt shape and runtime validation', () => {
    const schema = responseJsonSchemaFromZod(PrototypeVariantArtifact);
    expect(isCodexOutputSchemaCompatible(schema)).toBe(false);
  });

  // The reviewer's response is the case this whole path exists for: a plain
  // object of required fields that Codex can hold the model to.
  it('accepts the Review verdict schema so the reviewer response shape is enforced', () => {
    const schema = responseJsonSchemaFromZod(ReviewRelayResult);
    expect(isCodexOutputSchemaCompatible(schema)).toBe(true);
  });
});

describe('codexOutputSchemaFrom — what the flag actually receives', () => {
  it('drops narrowing keywords and keeps every structural one', () => {
    const cleaned = codexOutputSchemaFrom({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, pattern: '^x' },
        tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2 },
      },
      required: ['id', 'tags'],
      additionalProperties: false,
    });

    expect(cleaned).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'tags'],
      additionalProperties: false,
    });
  });

  it('preserves the Review verdict structure the reviewer has to produce', () => {
    const cleaned = codexOutputSchemaFrom(responseJsonSchemaFromZod(ReviewRelayResult)) as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };

    expect(cleaned.required).toEqual([
      'verdict',
      'findings',
      'assessment',
      'verification',
      'confidence_limitations',
    ]);
    // The enum is the reason the flag is worth passing at all: it is what stops
    // a reviewer inventing a verdict the runtime would reject.
    expect(cleaned.properties.verdict?.enum).toEqual(['NO_ISSUES_FOUND', 'ISSUES_FOUND']);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flowPackages } from '../../src/flows/catalog.js';
import { FixChange, FixDiagnosis, FixReview } from '../../src/flows/fix/reports.js';
import { responseJsonSchemaFromZod } from '../../src/shared/zod-to-response-schema.js';

describe('responseJsonSchemaFromZod', () => {
  it('emits draft-07 JSON Schema for a simple object', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });
    const out = responseJsonSchemaFromZod(schema);
    expect(out.type).toBe('object');
    expect(out.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(out.additionalProperties).toBe(false);
    const properties = out.properties as Record<string, { type: string }>;
    expect(properties.name).toEqual({ type: 'string' });
    expect(properties.count).toEqual({ type: 'number' });
  });

  it('encodes enum values', () => {
    const schema = z.object({
      severity: z.enum(['low', 'medium', 'high']),
    });
    const out = responseJsonSchemaFromZod(schema);
    const properties = out.properties as Record<string, { type?: string; enum?: string[] }>;
    const severity = properties.severity;
    expect(severity).toBeDefined();
    expect(severity?.enum).toEqual(['low', 'medium', 'high']);
  });

  it('encodes literal values via const', () => {
    const schema = z.object({
      verdict: z.literal('accept'),
    });
    const out = responseJsonSchemaFromZod(schema);
    const properties = out.properties as Record<
      string,
      { const?: string; type?: string; enum?: string[] } | undefined
    >;
    const verdict = properties.verdict;
    expect(verdict).toBeDefined();
    expect(verdict?.const).toBe('accept');
  });

  it('inlines nested schemas without $ref or definitions', () => {
    const Inner = z.object({ id: z.string() });
    const Outer = z.object({
      first: Inner,
      second: Inner,
    });
    const out = responseJsonSchemaFromZod(Outer);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('$ref');
    expect(serialized).not.toContain('definitions');
  });

  it('keeps loose objects open while plain objects stay closed', () => {
    const out = responseJsonSchemaFromZod(z.looseObject({ value: z.string() }));
    expect(out.type).toBe('object');
    expect(out.additionalProperties).toBe(true);
  });

  it('returns a JSON-serializable object', () => {
    const schema = z.object({
      items: z.array(z.object({ id: z.string(), at: z.number() })),
    });
    const out = responseJsonSchemaFromZod(schema);
    // Round-trip through JSON.stringify/parse to confirm there are no
    // non-serializable values (functions, symbols, undefined) that would
    // break CLI invocation.
    const round = JSON.parse(JSON.stringify(out));
    expect(round).toEqual(out);
  });

  // Regression: a `z.union` whose branches are `z.string` and
  // `z.array(z.string)` must surface BOTH shapes through to the CLI. An
  // earlier shape (`z.preprocess` wrapping the array) was silently dropped
  // by JSON Schema conversion, so the CLI rejected single-string inputs that
  // Zod itself would coerce to a one-element array.
  it('preserves both branches of a union(string, array) as anyOf', () => {
    const schema = z.object({
      evidence: z.union([
        z
          .string()
          .min(1)
          .transform((value) => [value] as string[]),
        z.array(z.string().min(1)).min(1),
      ]),
    });
    const out = responseJsonSchemaFromZod(schema);
    const properties = out.properties as Record<string, { anyOf?: unknown[] } | undefined>;
    const evidence = properties.evidence;
    expect(evidence?.anyOf).toBeDefined();
    expect(Array.isArray(evidence?.anyOf)).toBe(true);
    expect(evidence?.anyOf?.length).toBe(2);
    const branchTypes = (evidence?.anyOf ?? []).map((branch) => (branch as { type?: string }).type);
    expect(branchTypes).toContain('string');
    expect(branchTypes).toContain('array');
  });

  it('emits the LenientNonEmptyStringArray anyOf shape for FixDiagnosis.evidence', () => {
    const out = responseJsonSchemaFromZod(FixDiagnosis);
    const properties = out.properties as Record<string, { anyOf?: unknown[] } | undefined>;
    expect(properties.evidence?.anyOf).toBeDefined();
  });

  it('emits the LenientNonEmptyStringArray anyOf shape for FixChange.evidence', () => {
    const out = responseJsonSchemaFromZod(FixChange);
    const properties = out.properties as Record<string, { anyOf?: unknown[] } | undefined>;
    expect(properties.evidence?.anyOf).toBeDefined();
  });

  // Regression: FixReview's verdict-conditional findings.minItems must
  // appear in the JSON Schema so the CLI rejects {verdict: 'reject',
  // findings: []} at the same boundary as Zod (instead of relying on the
  // runtime to re-validate post-CLI).
  it('encodes FixReview verdict→findings minItems via discriminated branches', () => {
    const out = responseJsonSchemaFromZod(FixReview);
    const branches = out.anyOf as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(branches)).toBe(true);
    expect(branches?.length).toBe(3);
    const branchByVerdict = new Map<string, Record<string, unknown>>();
    for (const branch of branches ?? []) {
      const properties = branch.properties as
        | Record<string, { const?: unknown; enum?: unknown[] }>
        | undefined;
      const verdictProp = properties?.verdict;
      const verdictValue =
        verdictProp?.const ??
        (Array.isArray(verdictProp?.enum) ? verdictProp?.enum?.[0] : undefined);
      if (typeof verdictValue === 'string') {
        branchByVerdict.set(verdictValue, branch);
      }
    }
    const rejectBranch = branchByVerdict.get('reject');
    const rejectFindings = (rejectBranch?.properties as Record<string, { minItems?: number }>)
      ?.findings;
    expect(rejectFindings?.minItems).toBe(1);
    const acceptBranch = branchByVerdict.get('accept');
    const acceptFindings = (acceptBranch?.properties as Record<string, { minItems?: number }>)
      ?.findings;
    expect(acceptFindings?.minItems).toBeUndefined();
    const partialBranch = branchByVerdict.get('accept-with-fixes');
    const partialFindings = (partialBranch?.properties as Record<string, { minItems?: number }>)
      ?.findings;
    expect(partialFindings?.minItems).toBe(1);
  });

  it('keeps every relay report response schema inline and JSON-serializable', () => {
    const relayReports = flowPackages.flatMap((flow) =>
      flow.relayReports.map((report) => ({ flowId: flow.id, report })),
    );
    expect(relayReports.length).toBeGreaterThan(0);

    for (const { flowId, report } of relayReports) {
      const out = responseJsonSchemaFromZod(report.schema);
      const serialized = JSON.stringify(out);
      expect(serialized, `${flowId} ${report.schemaName}`).not.toContain('$ref');
      expect(serialized, `${flowId} ${report.schemaName}`).not.toContain('$defs');
      expect(serialized, `${flowId} ${report.schemaName}`).not.toContain('definitions');
      expect(JSON.parse(serialized), `${flowId} ${report.schemaName}`).toEqual(out);
    }
  });
});

// Renders shape skeletons from Zod schemas and asserts the output is
// equivalent to the hand-written skeletons in flow relay-hints. The
// test is the proof that the Zod-driven renderer can replace hand
// authoring for Fix's relay reports.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixChange, FixContext, FixDiagnosis, FixReview } from '../../src/flows/fix/reports.js';
import { renderShapeSkeleton } from '../../src/flows/registries/shape-hints/from-zod.js';

describe('renderShapeSkeleton', () => {
  it('renders a primitive object shape', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });
    expect(renderShapeSkeleton(schema)).toBe('{ "name": "<string>", "count": <number> }');
  });

  it('uses .describe() text as the leaf placeholder', () => {
    const schema = z.object({
      ref: z.string().describe('project-relative path'),
    });
    expect(renderShapeSkeleton(schema)).toBe('{ "ref": "<project-relative path>" }');
  });

  it('renders enum values as a pipe-separated placeholder', () => {
    const schema = z.object({
      severity: z.enum(['low', 'medium', 'high']),
    });
    expect(renderShapeSkeleton(schema)).toBe('{ "severity": "<low|medium|high>" }');
  });

  it('renders literals verbatim', () => {
    const schema = z.object({ verdict: z.literal('accept') });
    expect(renderShapeSkeleton(schema)).toBe('{ "verdict": "accept" }');
  });

  it('unwraps strict() + superRefine() and renders the underlying object', () => {
    const schema = z
      .object({ name: z.string() })
      .strict()
      .superRefine(() => {});
    expect(renderShapeSkeleton(schema)).toBe('{ "name": "<string>" }');
  });

  it('renders arrays of objects', () => {
    const schema = z.object({
      items: z.array(z.object({ id: z.string() })),
    });
    expect(renderShapeSkeleton(schema)).toBe('{ "items": [{ "id": "<string>" }] }');
  });

  it('renders fix.context@v1 with the same fields as the hand-written hint', () => {
    const out = renderShapeSkeleton(FixContext);
    expect(out).toContain('"verdict": "accept"');
    expect(out).toContain('"sources":');
    expect(out).toContain('"kind": "<file|command|log|operator-note|reference>"');
    expect(out).toContain('"ref":');
    expect(out).toContain('"summary":');
    expect(out).toContain('"observations":');
    expect(out).toContain('"open_questions":');
  });

  it('renders fix.diagnosis@v1 with reproduction_status and confidence enums', () => {
    const out = renderShapeSkeleton(FixDiagnosis);
    expect(out).toContain('"verdict": "accept"');
    expect(out).toContain(
      '"reproduction_status": "<reproduced|not-reproduced|intermittent|not-attempted>"',
    );
    expect(out).toContain('"confidence": "<low|medium|high>"');
    expect(out).toContain('"evidence":');
    expect(out).toContain('"residual_uncertainty":');
  });

  it('renders fix.change@v1 with changed_files and evidence arrays', () => {
    const out = renderShapeSkeleton(FixChange);
    expect(out).toContain('"verdict": "accept"');
    expect(out).toContain('"summary":');
    expect(out).toContain('"diagnosis_ref":');
    expect(out).toContain('"changed_files": ["<project-relative path that was edited>"]');
    expect(out).toContain('"evidence":');
  });

  it('renders fix.review@v1 with verdict enum and findings array of objects', () => {
    // FixReview is a discriminated union, but every branch shares the same
    // key set with a literal `verdict`, so the renderer collapses to one
    // shape with the discriminator displayed as an enum-style placeholder.
    const out = renderShapeSkeleton(FixReview);
    expect(out).toContain('"verdict": "<accept|accept-with-fixes|reject>"');
    expect(out).toContain('"summary":');
    expect(out).toContain('"findings": [{');
    expect(out).toContain('"severity": "<critical|high|medium|low>"');
    expect(out).toContain('"file_refs":');
    expect(out).not.toContain(' | ');
  });

  // Regression: a recursive `z.lazy()` schema (Node → children → Node)
  // previously blew the stack at hint render time. The renderer now
  // detects revisits of the same Zod node and emits `<recursive>`.
  it('renders a recursive z.lazy schema without throwing', () => {
    type Node = { name: string; children: Node[] };
    const Node: z.ZodType<Node> = z.lazy(() =>
      z.object({
        name: z.string(),
        children: z.array(Node),
      }),
    );
    expect(() => renderShapeSkeleton(Node)).not.toThrow();
    const out = renderShapeSkeleton(Node);
    expect(out).toContain('"name":');
    expect(out).toContain('<recursive>');
  });

  // Regression: a `.describe()` text containing a double quote or backslash
  // used to break the skeleton's quoting. JSON-escape ensures the
  // resulting placeholder is syntactically clean.
  it('JSON-escapes embedded quotes and backslashes in .describe() text', () => {
    const schema = z.object({
      title: z.string().describe('contains "quoted" word and a \\ slash'),
    });
    const out = renderShapeSkeleton(schema);
    expect(out).toContain('\\"quoted\\"');
    expect(out).toContain('\\\\');
  });

  it('JSON-escapes object keys that contain special characters', () => {
    const schema = z.object({
      'has "quote"': z.string(),
    });
    const out = renderShapeSkeleton(schema);
    expect(out).toContain('"has \\"quote\\"":');
  });

  // Regression: numeric native enums used to render their reverse-mapped
  // KEY names ("A|B"), but Zod only accepts the numeric VALUES.
  it('renders numeric enum-object values, not reverse-mapped names', () => {
    enum Priority {
      Low = 0,
      High = 1,
    }
    const schema = z.object({
      priority: z.enum(Priority),
    });
    const out = renderShapeSkeleton(schema);
    expect(out).toContain('"<0|1>"');
    expect(out).not.toContain('Low');
    expect(out).not.toContain('High');
  });

  it('renders string enum-object values as the accepted string values', () => {
    enum Color {
      Red = 'red',
      Blue = 'blue',
    }
    const schema = z.object({
      color: z.enum(Color),
    });
    const out = renderShapeSkeleton(schema);
    expect(out).toContain('"<red|blue>"');
  });

  it('collapses a same-shape discriminated union into a single shape', () => {
    const schema = z.discriminatedUnion('verdict', [
      z.object({ verdict: z.literal('accept'), reason: z.string() }).strict(),
      z.object({ verdict: z.literal('reject'), reason: z.string() }).strict(),
    ]);
    const out = renderShapeSkeleton(schema);
    expect(out).toBe('{ "verdict": "<accept|reject>", "reason": "<string>" }');
  });

  it('falls back to pipe-separated branches when discriminated branches differ in shape', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cmd'), command: z.string() }).strict(),
      z.object({ kind: z.literal('proc'), procedure: z.string() }).strict(),
    ]);
    const out = renderShapeSkeleton(schema);
    expect(out).toContain(' | ');
  });
});

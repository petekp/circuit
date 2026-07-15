// Renders shape skeletons from Zod schemas and asserts the output is
// equivalent to the hand-written skeletons in flow relay-hints. The
// test is the proof that the Zod-driven renderer can replace hand
// authoring for Fix's relay reports.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BuildImplementation } from '../../src/flows/build/reports.js';
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

  it('keeps a described boolean visibly boolean instead of quoting it as a string', () => {
    const schema = z.object({
      confirmed: z.boolean().describe('true only when evidence is conclusive'),
    });
    expect(renderShapeSkeleton(schema)).toBe(
      '{ "confirmed": <true|false: true only when evidence is conclusive> }',
    );
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

  // The leaf renderer folds a leaf's .describe() into its placeholder, but an
  // OBJECT- or ARRAY-level .describe() (like the context_request pull channel's
  // "when to ask" guidance) was silently dropped. It now renders as a leading
  // `<...>` annotation — the same not-literal marker the leaf placeholders use —
  // so the worker sees the guidance, not just the bare shape.
  it('renders an object-level .describe() as a leading annotation', () => {
    const schema = z.object({
      payload: z.object({ id: z.string() }).describe('only when you really need it'),
    });
    expect(renderShapeSkeleton(schema)).toBe(
      '{ "payload": <only when you really need it> { "id": "<string>" } }',
    );
  });

  it('renders an array-level .describe() as a leading annotation', () => {
    const schema = z.object({
      items: z.array(z.string()).describe('the named things, one each'),
    });
    expect(renderShapeSkeleton(schema)).toBe(
      '{ "items": <the named things, one each> ["<string>"] }',
    );
  });

  // The describe is commonly attached to a wrapper (.optional()/.default()), as
  // build.implementation's context_request is (ContextRequest.optional().describe()).
  // The annotation must surface through the transparent wrapper, once, not twice.
  it('surfaces a non-leaf describe carried on an optional wrapper', () => {
    const schema = z.object({
      maybe: z.object({ x: z.string() }).optional().describe('present only sometimes'),
    });
    expect(renderShapeSkeleton(schema)).toBe(
      '{ "maybe": <present only sometimes> { "x": "<string>" } }',
    );
  });

  // Byte-identical when no object/array-level describe is present: a leaf's own
  // describe is NOT double-rendered as an annotation, and a describe-less shape
  // is untouched.
  it('does not annotate a leaf field that carries its own describe', () => {
    const schema = z.object({
      ref: z.string().describe('project-relative path'),
      nested: z.object({ id: z.string() }),
    });
    expect(renderShapeSkeleton(schema)).toBe(
      '{ "ref": "<project-relative path>", "nested": { "id": "<string>" } }',
    );
  });

  // The real motivating case: the context_request affordance on build.implementation
  // now reaches the worker through the rendered skeleton.
  it('surfaces the context_request affordance text in build.implementation', () => {
    const out = renderShapeSkeleton(BuildImplementation);
    expect(out).toContain('"context_request":');
    expect(out).toContain('ONLY when the thin envelope this step was handed is missing');
    expect(out).toContain('an "everything"/untyped ask is refused');
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
    expect(out).toContain('"confirmed": <true|false:');
    expect(out).not.toContain('"confirmed": "<true ONLY');
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

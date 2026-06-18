// Render a one-line JSON-shape skeleton from a Zod schema.
//
// Used by flow `relay-hints.ts` authors so the shape portion of a relay
// instruction is derived from the report's Zod schema rather than typed
// out by hand. Authors keep the task-specific guidance and the
// mechanical tail (no code fences, JSON.parse, validation) as authored
// prose — only the literal `{ "field": "<placeholder>", ... }` part is
// generated here.
//
// Field-level placeholders default to `<string>`, `<number>`, etc. An
// author can override the placeholder for any leaf field by calling
// `.describe('what the field carries')` on the Zod schema; the renderer
// renders that description as the placeholder text. A `.describe()` carried
// on an OBJECT or ARRAY shape (including one attached through a transparent
// wrapper like `.optional()`) is not a leaf placeholder, so it renders as a
// leading `<...>` annotation in front of the recursed shape rather than being
// dropped — that is how the context-pull channel's "when to ask" guidance
// reaches the worker.
//
// Limitations the renderer degrades on intentionally:
//   - ZodUnion (non-discriminated) renders each option separated by ` |
//     `. Authors usually want a more guided prose explanation for
//     unions, so this is a deliberately-bare default.
//   - ZodDiscriminatedUnion collapses to a single shape when every
//     branch is a ZodObject with the same key set; the discriminator
//     field becomes an enum-like placeholder. Heterogeneous-shape
//     unions fall back to `a | b | c`.
//   - ZodAny / ZodUnknown render as `<any>` / `<unknown>` placeholders
//     and rely on authored guidance.
//   - `.superRefine`-only invariants that the structural type can't
//     express (e.g. value-conditional minimums) stay in authored prose.
//   - ZodLazy / recursive schemas are guarded against infinite
//     recursion: a node visited again at deeper depth renders as
//     `<recursive>` rather than blowing the stack.

import type * as z4 from 'zod/v4/core';

type ZodSchema = z4.$ZodType;

interface ZodDef {
  readonly type: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

function defOf(node: ZodSchema): ZodDef {
  return (node as z4.$ZodTypes)._zod.def as ZodDef;
}

function objectShape(def: ZodDef): Record<string, ZodSchema> {
  const shape = def.shape;
  return typeof shape === 'function' ? shape() : (shape as Record<string, ZodSchema>);
}

function literalValues(def: ZodDef): readonly unknown[] {
  if (Array.isArray(def.values)) return def.values;
  if ('value' in def) return [def.value];
  return [];
}

function enumValues(def: ZodDef): readonly (string | number)[] {
  const raw = def.entries ?? def.values;
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || typeof raw !== 'object') return [];

  // `z.enum()` over numeric TS enums (formerly `z.nativeEnum()`) carries
  // TypeScript's reverse-mapped form
  // ({0:'Low',1:'High',Low:0,High:1}); Zod accepts the numeric value side.
  const values = Object.values(raw as Record<string, string | number>);
  const isReverseMapped = values.some(
    (value) =>
      typeof value === 'number' &&
      Object.hasOwn(raw as Record<string, string | number>, String(value)),
  );
  const accepted = isReverseMapped
    ? values.filter((value): value is number => typeof value === 'number')
    : values;
  return Array.from(new Set(accepted));
}

function renderEnumValues(values: readonly (string | number)[]): string {
  return values
    .map((value) => (typeof value === 'string' ? escapeJsonInner(value) : String(value)))
    .join('|');
}

// JSON-escape a string for inline use inside a double-quoted JSON-shape
// placeholder. The renderer emits inline JSON-ish prose, not strict JSON,
// but unescaped quotes/backslashes in a `.describe()` text or in an object
// key can break the visual shape (and confuse a worker that tries to
// JSON.parse the literal example). Reuse JSON.stringify and strip the
// surrounding quotes so the escape rules stay in lockstep with the
// language standard.
function escapeJsonInner(value: string): string {
  const serialized = JSON.stringify(value);
  return serialized.slice(1, serialized.length - 1);
}

// The non-empty `.describe()` text carried directly on a node, checking the
// instance-level description first (where `.describe()` writes in Zod v4) and
// falling back to the def. Returns undefined when no description is present.
function carriedDescription(node: ZodSchema): string | undefined {
  const nodeDescription = (node as unknown as { readonly description?: unknown }).description;
  if (typeof nodeDescription === 'string' && nodeDescription.length > 0) {
    return nodeDescription;
  }
  const defDescription = defOf(node).description;
  if (typeof defDescription === 'string' && defDescription.length > 0) {
    return defDescription;
  }
  return undefined;
}

function leafDescriptionOr(node: ZodSchema, fallback: string): string {
  const description = carriedDescription(node);
  if (description !== undefined) {
    return `"<${escapeJsonInner(description)}>"`;
  }
  return fallback;
}

// Base Zod types whose `.describe()` is structural guidance about a shape, not
// a leaf placeholder. A description carried on (or wrapping) one of these is
// surfaced as a `<...>` annotation rather than dropped.
const NON_LEAF_BASE_TYPES = new Set(['object', 'array', 'tuple', 'record', 'map']);

// Peel transparent wrappers (`.optional()`, `.default()`, `.pipe()`, etc.) to
// find the base type a node ultimately stands for, so a description attached to
// a wrapper is attributed to the object/array it wraps. Used only to decide
// whether a carried description annotates a non-leaf shape — leaves fold their
// own describe into the placeholder via `leafDescriptionOr`, so they must not
// also be annotated here.
function annotatesAsNonLeaf(node: ZodSchema): boolean {
  let current: ZodSchema = node;
  for (let depth = 0; depth <= MAX_RECURSION_DEPTH; depth += 1) {
    const def = defOf(current);
    switch (def.type) {
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'catch':
      case 'nonoptional':
      case 'success':
        current = def.innerType as ZodSchema;
        continue;
      case 'pipe':
        current = (def.in ?? def.out) as ZodSchema;
        continue;
      default:
        return NON_LEAF_BASE_TYPES.has(def.type);
    }
  }
  return false;
}

// Prepend a non-leaf node's carried `.describe()` text as a leading `<...>`
// annotation in front of its rendered shape. The text is left unescaped on
// purpose: unlike a leaf placeholder it sits OUTSIDE any JSON string literal,
// so it reads as inline guidance, not as a parseable value. Returns the
// rendered shape unchanged when there is no description or the node is a leaf.
function withCarriedAnnotation(node: ZodSchema, rendered: string): string {
  const description = carriedDescription(node);
  if (description === undefined || !annotatesAsNonLeaf(node)) {
    return rendered;
  }
  return `<${description}> ${rendered}`;
}

// Render-time recursion guard. The visited set captures Zod nodes already
// on the render stack so a `z.lazy(() => Node)` self-reference is detected
// at the second visit and short-circuited. The set is render-call-scoped,
// not module-global, so independent schemas don't share state.
const MAX_RECURSION_DEPTH = 32;

export function renderShapeSkeleton(schema: ZodSchema): string {
  return renderNode(schema, new Set(), 0);
}

// Collect every string value the schema admits for its top-level `verdict`
// field. Handles plain objects (verdict as enum or literal) and unions —
// including discriminated unions over `verdict` — by walking each branch.
// Returns [] when the schema has no introspectable verdict field, so
// callers can degrade to the step's check.pass list alone.
export function verdictValuesFromSchema(schema: ZodSchema): readonly string[] {
  const out: string[] = [];
  collectVerdictValues(schema, out, 0);
  return [...new Set(out)];
}

function collectVerdictValues(node: ZodSchema, out: string[], depth: number): void {
  if (depth > MAX_RECURSION_DEPTH) return;
  const def = defOf(node);
  switch (def.type) {
    case 'object': {
      const verdict = objectShape(def).verdict;
      if (verdict === undefined) return;
      const verdictDef = defOf(verdict);
      const values =
        verdictDef.type === 'enum'
          ? enumValues(verdictDef)
          : verdictDef.type === 'literal'
            ? literalValues(verdictDef)
            : [];
      for (const value of values) {
        if (typeof value === 'string') out.push(value);
      }
      return;
    }
    case 'union': {
      for (const option of def.options as ZodSchema[]) {
        collectVerdictValues(option, out, depth + 1);
      }
      return;
    }
    case 'lazy': {
      const getter = def.getter as () => ZodSchema;
      collectVerdictValues(getter(), out, depth + 1);
      return;
    }
    default:
      return;
  }
}

function renderNode(node: ZodSchema, visited: Set<ZodSchema>, depth: number): string {
  if (visited.has(node) || depth > MAX_RECURSION_DEPTH) {
    return '<recursive>';
  }
  visited.add(node);
  try {
    const rendered = renderNodeInner(node, visited, depth + 1);
    return withCarriedAnnotation(node, rendered);
  } finally {
    visited.delete(node);
  }
}

function renderNodeInner(node: ZodSchema, visited: Set<ZodSchema>, depth: number): string {
  const def = defOf(node);
  switch (def.type) {
    case 'object': {
      const shape = objectShape(def);
      const entries = Object.entries(shape).map(
        ([key, child]) => `"${escapeJsonInner(key)}": ${renderNode(child, visited, depth)}`,
      );
      return `{ ${entries.join(', ')} }`;
    }
    case 'array': {
      const inner = renderNode(def.element as ZodSchema, visited, depth);
      return `[${inner}]`;
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
    case 'success':
      return renderNode(def.innerType as ZodSchema, visited, depth);
    case 'pipe':
      return renderNode((def.in ?? def.out) as ZodSchema, visited, depth);
    case 'transform':
      return '<transform>';
    case 'literal': {
      const [value] = literalValues(def);
      return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
    }
    case 'enum': {
      const values = enumValues(def);
      return `"<${renderEnumValues(values)}>"`;
    }
    case 'string':
      return leafDescriptionOr(node, '"<string>"');
    case 'number':
      return leafDescriptionOr(node, '<number>');
    case 'bigint':
      return leafDescriptionOr(node, '<bigint>');
    case 'boolean':
      return leafDescriptionOr(node, '<true|false>');
    case 'date':
      return leafDescriptionOr(node, '"<iso-date>"');
    case 'null':
      return 'null';
    case 'undefined':
      return '<undefined>';
    case 'any':
      return leafDescriptionOr(node, '<any>');
    case 'unknown':
      return leafDescriptionOr(node, '<unknown>');
    case 'never':
      return '<never>';
    case 'record':
    case 'map':
      return `{ "<key>": ${renderNode(def.valueType as ZodSchema, visited, depth)} }`;
    case 'tuple': {
      const items = (def.items as ZodSchema[]).map((item) => renderNode(item, visited, depth));
      const rest = def.rest as ZodSchema | undefined | null;
      if (rest !== undefined && rest !== null) {
        items.push(`...${renderNode(rest, visited, depth)}`);
      }
      return `[${items.join(', ')}]`;
    }
    case 'union': {
      const options = def.options as ZodSchema[];
      const discriminator = def.discriminator;
      if (typeof discriminator === 'string') {
        const collapsed = collapseDiscriminatedUnion(discriminator, options, visited, depth);
        if (collapsed !== undefined) return collapsed;
      }
      return options.map((opt) => renderNode(opt, visited, depth)).join(' | ');
    }
    case 'lazy': {
      const getter = def.getter as () => ZodSchema;
      return renderNode(getter(), visited, depth);
    }
    case 'intersection': {
      const left = renderNode(def.left as ZodSchema, visited, depth);
      const right = renderNode(def.right as ZodSchema, visited, depth);
      return `${left} & ${right}`;
    }
    default:
      return `<${def.type}>`;
  }
}

// Collapse a discriminated union of ZodObject branches into a single shape
// when every branch has the same key set. The discriminator field renders
// as an enum-style placeholder listing the literal values across branches;
// other fields render from the first branch (they're expected to match in
// shape, even if their value constraints differ). Returns undefined when
// branches diverge structurally, in which case the caller falls back to
// `a | b | c` rendering.
function collapseDiscriminatedUnion(
  discriminator: string,
  options: readonly ZodSchema[],
  visited: Set<ZodSchema>,
  depth: number,
): string | undefined {
  if (options.length === 0) return undefined;
  const objectShapes: Record<string, ZodSchema>[] = [];
  const discriminatorValues: unknown[] = [];
  for (const option of options) {
    const optDef = defOf(option);
    if (optDef.type !== 'object') return undefined;
    const shape = objectShape(optDef);
    objectShapes.push(shape);
    const discriminatorNode = shape[discriminator];
    if (discriminatorNode === undefined) return undefined;
    const discriminatorDef = defOf(discriminatorNode);
    if (discriminatorDef.type !== 'literal') return undefined;
    const [value] = literalValues(discriminatorDef);
    discriminatorValues.push(value);
  }
  const firstShape = objectShapes[0];
  if (firstShape === undefined) return undefined;
  const keyList = Object.keys(firstShape);
  const keyListSorted = keyList.slice().sort();
  for (const shape of objectShapes) {
    const shapeKeys = Object.keys(shape).slice().sort();
    if (shapeKeys.length !== keyListSorted.length) return undefined;
    for (let idx = 0; idx < shapeKeys.length; idx += 1) {
      if (shapeKeys[idx] !== keyListSorted[idx]) return undefined;
    }
  }
  const entries = keyList.map((key) => {
    if (key === discriminator) {
      const rendered = discriminatorValues.map((value) =>
        typeof value === 'string' ? escapeJsonInner(value) : String(value),
      );
      return `"${escapeJsonInner(key)}": "<${rendered.join('|')}>"`;
    }
    const child = firstShape[key];
    if (child === undefined) return `"${escapeJsonInner(key)}": <missing>`;
    return `"${escapeJsonInner(key)}": ${renderNode(child, visited, depth)}`;
  });
  return `{ ${entries.join(', ')} }`;
}

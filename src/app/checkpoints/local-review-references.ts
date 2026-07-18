type MarkupAttribute = {
  readonly name: string;
  readonly value?: string | undefined;
  readonly valueStart?: number | undefined;
  readonly valueEnd?: number | undefined;
  readonly quote?: '"' | "'" | undefined;
};

type MarkupTag = {
  readonly name: string;
  readonly closing: boolean;
  readonly start: number;
  readonly end: number;
  readonly attributes: readonly MarkupAttribute[];
};

type CssReferenceToken = {
  readonly sourceValue: string;
  readonly start: number;
  readonly end: number;
  readonly quote?: '"' | "'" | undefined;
};

type Replacement = {
  readonly start: number;
  readonly end: number;
  readonly value: string;
};

export type LocalReviewReferenceKind = 'html-attribute' | 'html-srcset' | 'css-url';

export type LocalReviewReference = {
  readonly kind: LocalReviewReferenceKind;
  readonly sourceValue: string;
};

const RESOURCE_SRC_ELEMENTS = new Set(['audio', 'img', 'input', 'source', 'track', 'video']);
const SVG_RESOURCE_ELEMENTS = new Set(['image', 'use']);
const HTML_RAW_TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noframes', 'script', 'style', 'xmp']);
const HTML_ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(['textarea', 'title']);

type MarkupFormat = 'html' | 'svg';

export function decodeMarkupAttribute(value: string): string {
  return value.replace(/&(amp|quot|apos|#x27|#39|lt|gt);/giu, (entity) => {
    switch (entity.toLowerCase()) {
      case '&amp;':
        return '&';
      case '&quot;':
        return '"';
      case '&apos;':
      case '&#x27;':
      case '&#39;':
        return "'";
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      default:
        return entity;
    }
  });
}

function declarationEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let cursor = start + 2; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor + 1;
    }
  }
  return source.length;
}

function tagAt(source: string, start: number): MarkupTag | undefined {
  if (source[start] !== '<') return undefined;
  let cursor = start + 1;
  let closing = false;
  if (source[cursor] === '/') {
    closing = true;
    cursor += 1;
  }
  while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/u.test(source[cursor] ?? '')) cursor += 1;
  if (cursor === nameStart) return undefined;
  const name = source.slice(nameStart, cursor).toLowerCase();
  const attributes: MarkupAttribute[] = [];

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    const character = source[cursor];
    if (character === '>') {
      cursor += 1;
      break;
    }
    if (character === '/' && source[cursor + 1] === '>') {
      cursor += 2;
      break;
    }
    if (character === undefined) break;

    const attributeNameStart = cursor;
    while (!/[\s=/>]/u.test(source[cursor] ?? '>')) cursor += 1;
    if (cursor === attributeNameStart) {
      cursor += 1;
      continue;
    }
    const name = source.slice(attributeNameStart, cursor).toLowerCase();
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '=') {
      attributes.push({ name });
      continue;
    }
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    const quote =
      source[cursor] === '"' || source[cursor] === "'" ? (source[cursor] as '"' | "'") : undefined;
    if (quote !== undefined) cursor += 1;
    const valueStart = cursor;
    if (quote !== undefined) {
      while (cursor < source.length && source[cursor] !== quote) cursor += 1;
    } else {
      while (!/[\s>]/u.test(source[cursor] ?? '>')) cursor += 1;
    }
    const valueEnd = cursor;
    if (quote !== undefined && source[cursor] === quote) cursor += 1;
    attributes.push({
      name,
      value: source.slice(valueStart, valueEnd),
      valueStart,
      valueEnd,
      ...(quote === undefined ? {} : { quote }),
    });
  }

  return { name, closing, start, end: cursor, attributes };
}

function rawTextClose(
  source: string,
  lower: string,
  tagName: string,
  start: number,
): MarkupTag | undefined {
  const needle = `</${tagName}`;
  let cursor = start;
  while (cursor < source.length) {
    const closeStart = lower.indexOf(needle, cursor);
    if (closeStart === -1) return undefined;
    const boundary = source[closeStart + needle.length];
    if (boundary === undefined || boundary === '>' || boundary === '/' || /\s/u.test(boundary)) {
      const close = tagAt(source, closeStart);
      if (close?.closing === true && close.name === tagName) return close;
    }
    cursor = closeStart + needle.length;
  }
  return undefined;
}

function visitMarkup(
  source: string,
  visitor: {
    readonly tag: (tag: MarkupTag) => void;
    readonly style: (css: string, start: number, end: number) => void;
  },
  format: MarkupFormat = 'html',
): void {
  let cursor = 0;
  const lower = source.toLowerCase();
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start === -1) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', start) || source.startsWith('<?', start)) {
      cursor = declarationEnd(source, start);
      continue;
    }
    const tag = tagAt(source, start);
    if (tag === undefined) {
      cursor = start + 1;
      continue;
    }
    cursor = tag.end;
    if (tag.closing) continue;
    visitor.tag(tag);
    const localName = tag.name.slice(tag.name.lastIndexOf(':') + 1);
    if (format === 'html' && localName === 'plaintext') break;
    const rawText =
      localName === 'script' ||
      localName === 'style' ||
      (format === 'html' &&
        (HTML_RAW_TEXT_ELEMENTS.has(localName) || HTML_ESCAPABLE_RAW_TEXT_ELEMENTS.has(localName)));
    if (!rawText) continue;
    const close = rawTextClose(source, lower, tag.name, cursor);
    if (close === undefined) {
      if (localName === 'style') visitor.style(source.slice(cursor), cursor, source.length);
      break;
    }
    if (localName === 'style') {
      visitor.style(source.slice(cursor, close.start), cursor, close.start);
    }
    cursor = close.end;
  }
}

function attribute(tag: MarkupTag, name: string): MarkupAttribute | undefined {
  return tag.attributes.find((candidate) => candidate.name === name);
}

function isStylesheetLink(tag: MarkupTag): boolean {
  if (tag.name !== 'link') return false;
  const rel = attribute(tag, 'rel')?.value;
  return (
    rel !== undefined &&
    decodeMarkupAttribute(rel).toLowerCase().split(/\s+/u).includes('stylesheet')
  );
}

function isSvgResourceAttribute(tag: MarkupTag, name: string): boolean {
  return (
    SVG_RESOURCE_ELEMENTS.has(tag.name.slice(tag.name.lastIndexOf(':') + 1)) &&
    (name === 'href' || name === 'xlink:href')
  );
}

function isResourceAttribute(tag: MarkupTag, name: string): boolean {
  if (name === 'src') return RESOURCE_SRC_ELEMENTS.has(tag.name);
  if (name === 'poster') return tag.name === 'video';
  if (isSvgResourceAttribute(tag, name)) return true;
  return name === 'href' && isStylesheetLink(tag);
}

function isCssNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_-]/u.test(character);
}

function quotedCssValue(
  css: string,
  quoteIndex: number,
): { readonly end: number; readonly valueEnd: number; readonly escaped: boolean } {
  const quote = css[quoteIndex];
  let cursor = quoteIndex + 1;
  let escaped = false;
  while (cursor < css.length && css[cursor] !== quote) {
    if (css[cursor] === '\\') {
      escaped = true;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  const valueEnd = cursor;
  if (css[cursor] === quote) cursor += 1;
  return { end: cursor, valueEnd, escaped };
}

function urlTokenAt(
  css: string,
  start: number,
): { readonly token?: CssReferenceToken; end: number } {
  if (
    css.slice(start, start + 3).toLowerCase() !== 'url' ||
    isCssNameCharacter(css[start - 1]) ||
    isCssNameCharacter(css[start + 3])
  ) {
    return { end: start + 1 };
  }
  let cursor = start + 3;
  while (/\s/u.test(css[cursor] ?? '')) cursor += 1;
  if (css[cursor] !== '(') return { end: start + 1 };
  cursor += 1;
  while (/\s/u.test(css[cursor] ?? '')) cursor += 1;
  const quote = css[cursor] === '"' || css[cursor] === "'" ? (css[cursor] as '"' | "'") : undefined;
  if (quote !== undefined) {
    const valueStart = cursor + 1;
    const quoted = quotedCssValue(css, cursor);
    cursor = quoted.end;
    while (/\s/u.test(css[cursor] ?? '')) cursor += 1;
    if (css[cursor] === ')') cursor += 1;
    const sourceValue = css.slice(valueStart, quoted.valueEnd);
    return {
      end: cursor,
      ...(sourceValue.length === 0 || quoted.escaped
        ? {}
        : { token: { sourceValue, start: valueStart, end: quoted.valueEnd, quote } }),
    };
  }
  const rawStart = cursor;
  while (cursor < css.length && css[cursor] !== ')') cursor += 1;
  let valueStart = rawStart;
  let valueEnd = cursor;
  while (/\s/u.test(css[valueStart] ?? '')) valueStart += 1;
  while (valueEnd > valueStart && /\s/u.test(css[valueEnd - 1] ?? '')) valueEnd -= 1;
  if (css[cursor] === ')') cursor += 1;
  const sourceValue = css.slice(valueStart, valueEnd);
  return {
    end: cursor,
    ...(sourceValue.length === 0 || sourceValue.includes('\\')
      ? {}
      : { token: { sourceValue, start: valueStart, end: valueEnd } }),
  };
}

function cssReferenceTokens(css: string): readonly CssReferenceToken[] {
  const tokens: CssReferenceToken[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      const end = css.indexOf('*/', cursor + 2);
      cursor = end === -1 ? css.length : end + 2;
      continue;
    }
    const character = css[cursor];
    if (character === '"' || character === "'") {
      cursor = quotedCssValue(css, cursor).end;
      continue;
    }
    if (
      character === '@' &&
      css.slice(cursor + 1, cursor + 7).toLowerCase() === 'import' &&
      !isCssNameCharacter(css[cursor + 7])
    ) {
      let valueStart = cursor + 7;
      while (/\s/u.test(css[valueStart] ?? '')) valueStart += 1;
      const quote =
        css[valueStart] === '"' || css[valueStart] === "'"
          ? (css[valueStart] as '"' | "'")
          : undefined;
      if (quote !== undefined) {
        const quoted = quotedCssValue(css, valueStart);
        const sourceValue = css.slice(valueStart + 1, quoted.valueEnd);
        if (sourceValue.length > 0 && !quoted.escaped) {
          tokens.push({
            sourceValue,
            start: valueStart + 1,
            end: quoted.valueEnd,
            quote,
          });
        }
        cursor = quoted.end;
        continue;
      }
      cursor = valueStart;
      continue;
    }
    const url = urlTokenAt(css, cursor);
    if (url.token !== undefined) tokens.push(url.token);
    cursor = url.end;
  }
  return tokens;
}

function srcsetTokens(value: string): readonly CssReferenceToken[] {
  const tokens: CssReferenceToken[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[\s,]/u.test(value[cursor] ?? '')) cursor += 1;
    if (cursor >= value.length) break;
    const start = cursor;
    const dataUrl = value.slice(start, start + 5).toLowerCase() === 'data:';
    while (cursor < value.length && !/\s/u.test(value[cursor] ?? '')) cursor += 1;
    let end = cursor;
    let trailingCommas = 0;
    while (end > start && value[end - 1] === ',') {
      trailingCommas += 1;
      end -= 1;
    }
    const sourceValue = value.slice(start, end);
    if (sourceValue.length > 0 && !dataUrl && !sourceValue.includes('\\')) {
      tokens.push({ sourceValue, start, end });
    }
    if (trailingCommas > 0) continue;
    let parentheses = 0;
    while (cursor < value.length) {
      const character = value[cursor];
      if (character === '(') parentheses += 1;
      else if (character === ')' && parentheses > 0) parentheses -= 1;
      else if (character === ',' && parentheses === 0) {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
  }
  return tokens;
}

function uniqueReferences(
  references: readonly LocalReviewReference[],
): readonly LocalReviewReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}\0${reference.sourceValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractCssAssetReferences(css: string): readonly LocalReviewReference[] {
  return uniqueReferences(
    cssReferenceTokens(css).map((token) => ({
      kind: 'css-url' as const,
      sourceValue: token.sourceValue,
    })),
  );
}

function extractMarkupAssetReferences(
  source: string,
  format: MarkupFormat,
): readonly LocalReviewReference[] {
  const references: LocalReviewReference[] = [];
  visitMarkup(
    source,
    {
      tag(tag) {
        for (const candidate of tag.attributes) {
          if (candidate.value === undefined) continue;
          if (
            isResourceAttribute(tag, candidate.name) &&
            !(
              isSvgResourceAttribute(tag, candidate.name) &&
              decodeMarkupAttribute(candidate.value).trim().startsWith('#')
            )
          ) {
            references.push({ kind: 'html-attribute', sourceValue: candidate.value });
          }
          if ((tag.name === 'img' || tag.name === 'source') && candidate.name === 'srcset') {
            for (const token of srcsetTokens(candidate.value)) {
              references.push({ kind: 'html-srcset', sourceValue: token.sourceValue });
            }
          }
          if (candidate.name === 'style') {
            references.push(...extractCssAssetReferences(decodeMarkupAttribute(candidate.value)));
          }
        }
      },
      style(css) {
        references.push(...extractCssAssetReferences(css));
      },
    },
    format,
  );
  return uniqueReferences(references);
}

export function extractHtmlAssetReferences(html: string): readonly LocalReviewReference[] {
  return extractMarkupAssetReferences(html, 'html');
}

export function extractSvgAssetReferences(svg: string): readonly LocalReviewReference[] {
  return extractMarkupAssetReferences(svg, 'svg');
}

function rewriteMarkupAssetReferences(
  source: string,
  format: MarkupFormat,
  replacements: {
    readonly htmlAttribute: ReadonlyMap<string, string>;
    readonly htmlSrcset: ReadonlyMap<string, string>;
    readonly cssUrl: ReadonlyMap<string, string>;
  },
): { readonly source: string; readonly replaced: ReadonlySet<string> } {
  const replaced = new Set<string>();
  const operations: Replacement[] = [];
  visitMarkup(
    source,
    {
      tag(tag) {
        for (const candidate of tag.attributes) {
          if (
            candidate.value === undefined ||
            candidate.valueStart === undefined ||
            candidate.valueEnd === undefined
          ) {
            continue;
          }
          let value: string | undefined;
          if (isResourceAttribute(tag, candidate.name)) {
            const replacement = replacements.htmlAttribute.get(candidate.value);
            if (replacement !== undefined) {
              value = replacement;
              replaced.add(candidate.value);
            }
          } else if ((tag.name === 'img' || tag.name === 'source') && candidate.name === 'srcset') {
            const rewritten = rewriteSrcsetValue(candidate.value, replacements.htmlSrcset);
            if (rewritten.replaced.size > 0) {
              value = rewritten.value;
              for (const sourceValue of rewritten.replaced) replaced.add(sourceValue);
            }
          } else if (candidate.name === 'style') {
            const rewritten = rewriteCssAssetReferences(
              decodeMarkupAttribute(candidate.value),
              replacements.cssUrl,
            );
            if (rewritten.replaced.size > 0) {
              value = rewritten.css;
              for (const sourceValue of rewritten.replaced) replaced.add(sourceValue);
            }
          }
          if (value === undefined) continue;
          operations.push({
            start: candidate.valueStart,
            end: candidate.valueEnd,
            value: serializedAttributeValue(candidate, value),
          });
        }
      },
      style(css, start, end) {
        const rewritten = rewriteCssAssetReferences(css, replacements.cssUrl);
        if (rewritten.replaced.size === 0) return;
        for (const sourceValue of rewritten.replaced) replaced.add(sourceValue);
        operations.push({ start, end, value: rewritten.css });
      },
    },
    format,
  );
  return { source: applyReplacements(source, operations), replaced };
}

export function rewriteHtmlAssetReferences(
  html: string,
  replacements: {
    readonly htmlAttribute: ReadonlyMap<string, string>;
    readonly htmlSrcset: ReadonlyMap<string, string>;
    readonly cssUrl: ReadonlyMap<string, string>;
  },
): { readonly html: string; readonly replaced: ReadonlySet<string> } {
  const rewritten = rewriteMarkupAssetReferences(html, 'html', replacements);
  return { html: rewritten.source, replaced: rewritten.replaced };
}

export function rewriteSvgAssetReferences(
  svg: string,
  replacements: {
    readonly htmlAttribute: ReadonlyMap<string, string>;
    readonly htmlSrcset: ReadonlyMap<string, string>;
    readonly cssUrl: ReadonlyMap<string, string>;
  },
): { readonly svg: string; readonly replaced: ReadonlySet<string> } {
  const rewritten = rewriteMarkupAssetReferences(svg, 'svg', replacements);
  return { svg: rewritten.source, replaced: rewritten.replaced };
}

function escapedAttributeValue(value: string, quote: '"' | "'"): string {
  const ampersands = value.replaceAll('&', '&amp;');
  return quote === '"' ? ampersands.replaceAll('"', '&quot;') : ampersands.replaceAll("'", '&#39;');
}

function serializedAttributeValue(attribute: MarkupAttribute, value: string): string {
  if (attribute.quote !== undefined) return escapedAttributeValue(value, attribute.quote);
  return `"${escapedAttributeValue(value, '"')}"`;
}

function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  let output = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

export function rewriteCssAssetReferences(
  css: string,
  replacements: ReadonlyMap<string, string>,
): { readonly css: string; readonly replaced: ReadonlySet<string> } {
  const replaced = new Set<string>();
  const operations: Replacement[] = [];
  for (const token of cssReferenceTokens(css)) {
    const replacement = replacements.get(token.sourceValue);
    if (replacement === undefined) continue;
    replaced.add(token.sourceValue);
    operations.push({
      start: token.start,
      end: token.end,
      value: token.quote === undefined ? `"${replacement}"` : replacement,
    });
  }
  return { css: applyReplacements(css, operations), replaced };
}

function rewriteSrcsetValue(
  value: string,
  replacements: ReadonlyMap<string, string>,
): { readonly value: string; readonly replaced: ReadonlySet<string> } {
  const replaced = new Set<string>();
  const operations: Replacement[] = [];
  for (const token of srcsetTokens(value)) {
    const replacement = replacements.get(token.sourceValue);
    if (replacement === undefined) continue;
    replaced.add(token.sourceValue);
    operations.push({ start: token.start, end: token.end, value: replacement });
  }
  return { value: applyReplacements(value, operations), replaced };
}

export function rewriteMarkupAttributeReferences(
  html: string,
  attributeNames: ReadonlySet<string>,
  replacements: ReadonlyMap<string, string>,
): { readonly html: string; readonly replaced: ReadonlySet<string> } {
  const replaced = new Set<string>();
  const operations: Replacement[] = [];
  visitMarkup(html, {
    tag(tag) {
      for (const candidate of tag.attributes) {
        if (
          candidate.value === undefined ||
          candidate.valueStart === undefined ||
          candidate.valueEnd === undefined ||
          !attributeNames.has(candidate.name)
        ) {
          continue;
        }
        const replacement = replacements.get(candidate.value);
        if (replacement === undefined) continue;
        replaced.add(candidate.value);
        operations.push({
          start: candidate.valueStart,
          end: candidate.valueEnd,
          value: serializedAttributeValue(candidate, replacement),
        });
      }
    },
    style() {},
  });
  return { html: applyReplacements(html, operations), replaced };
}

export function localReferenceSuffix(
  sourceValue: string,
  options: { readonly decodeAttributeEntities?: boolean } = {},
): string {
  try {
    const parsed = new URL(
      (options.decodeAttributeEntities === false
        ? sourceValue
        : decodeMarkupAttribute(sourceValue)
      ).trim(),
      'file:///circuit-review/reference',
    );
    return `${parsed.search}${parsed.hash}`;
  } catch {
    return '';
  }
}

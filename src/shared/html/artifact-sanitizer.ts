type AttributeSpan = {
  readonly name: string;
  readonly value?: string | undefined;
  readonly start: number;
  readonly end: number;
};

type MarkupTag = {
  readonly name: string;
  readonly closing: boolean;
  readonly raw: string;
  readonly end: number;
  readonly attributes: readonly AttributeSpan[];
};

const REMOVED_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'base',
  'discard',
  'embed',
  'frame',
  'iframe',
  'object',
  'script',
  'set',
]);

const UNWRAPPED_ELEMENTS = new Set(['form']);
const NAVIGATIONAL_ELEMENTS = new Set(['a', 'area']);
const SVG_RESOURCE_ELEMENTS = new Set(['image', 'use']);
const SVG_HTML_INTEGRATION_POINTS = new Set(['desc', 'foreignobject', 'title']);
const REMOVED_ATTRIBUTES = new Set([
  'action',
  'data',
  'formaction',
  'ping',
  'srcdoc',
  'target',
  'xlink:href',
]);

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
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
  const attributes: AttributeSpan[] = [];

  while (cursor < source.length) {
    const whitespaceStart = cursor;
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

    const attributeStart = whitespaceStart;
    const attributeNameStart = cursor;
    while (!/[\s=/>]/u.test(source[cursor] ?? '>')) cursor += 1;
    if (cursor === attributeNameStart) {
      cursor += 1;
      continue;
    }
    const attributeName = source.slice(attributeNameStart, cursor).toLowerCase();
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    let value: string | undefined;
    if (source[cursor] === '=') {
      cursor += 1;
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor] : undefined;
      if (quote !== undefined) {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        value = source.slice(valueStart, cursor);
        if (source[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (!/[\s>]/u.test(source[cursor] ?? '>')) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
    }
    attributes.push({
      name: attributeName,
      value,
      start: attributeStart - start,
      end: cursor - start,
    });
  }

  return { name, closing, raw: source.slice(start, cursor), end: cursor, attributes };
}

function attributeValue(tag: MarkupTag, name: string): string | undefined {
  return tag.attributes.find((attribute) => attribute.name === name)?.value;
}

function decodeAttributeValue(value: string): string {
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

type SanitizeArtifactMarkupOptions = {
  readonly format?: 'html' | 'svg';
  /** Exact captured resource routes that SVG image/use hrefs may retain. */
  readonly allowedResourceUrls?: ReadonlySet<string>;
};

function safeSvgResourceHref(
  tag: MarkupTag,
  attribute: AttributeSpan,
  options: SanitizeArtifactMarkupOptions,
): boolean {
  const elementName = localName(tag.name);
  if (!SVG_RESOURCE_ELEMENTS.has(elementName)) return false;
  if (attribute.name !== 'href' && attribute.name !== 'xlink:href') return false;
  if (attribute.value === undefined) return false;
  const value = decodeAttributeValue(attribute.value).trim();
  return value.startsWith('#') || options.allowedResourceUrls?.has(value) === true;
}

function sanitizeTag(tag: MarkupTag, options: SanitizeArtifactMarkupOptions): string {
  const elementName = localName(tag.name);
  if (REMOVED_ELEMENTS.has(elementName) || UNWRAPPED_ELEMENTS.has(elementName)) return '';
  if (tag.closing) return tag.raw;
  if (
    elementName === 'meta' &&
    attributeValue(tag, 'http-equiv')?.trim().toLowerCase() === 'refresh'
  ) {
    return '';
  }
  if (elementName === 'link') {
    const rel = attributeValue(tag, 'rel')?.toLowerCase().split(/\s+/u) ?? [];
    if (!rel.includes('stylesheet')) return '';
  }

  const removed = tag.attributes.filter((attribute) => {
    const attributeName = localName(attribute.name);
    if (attributeName.startsWith('on')) return true;
    if (attributeName === 'href') {
      if (safeSvgResourceHref(tag, attribute, options)) return false;
      if (attribute.name !== 'href') return true;
      if (tag.name === 'link') return false;
      const fragmentResource =
        !NAVIGATIONAL_ELEMENTS.has(elementName) && attribute.value?.startsWith('#') === true;
      return !fragmentResource;
    }
    return REMOVED_ATTRIBUTES.has(attributeName);
  });
  if (removed.length === 0) return tag.raw;

  let output = tag.raw;
  for (const attribute of [...removed].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, attribute.start)}${output.slice(attribute.end)}`;
  }
  return output;
}

/**
 * Keep a local prototype visually useful while removing every markup feature
 * that can execute code, submit data, open a nested document, or navigate.
 * Resource URLs remain subject to the caller's closed-graph rewrite and CSP.
 */
export function sanitizeArtifactMarkup(
  source: string,
  options: SanitizeArtifactMarkupOptions = {},
): string {
  const normalized = source.replaceAll('\0', '');
  const openElements: Array<{
    readonly name: string;
    readonly childNamespace: 'html' | 'svg';
  }> = [];
  let output = '';
  let cursor = 0;
  while (cursor < normalized.length) {
    const start = normalized.indexOf('<', cursor);
    if (start === -1) {
      output += normalized.slice(cursor);
      break;
    }
    output += normalized.slice(cursor, start);
    if (normalized.startsWith('<!--', start)) {
      const end = normalized.indexOf('-->', start + 4);
      cursor = end === -1 ? normalized.length : end + 3;
      continue;
    }
    if (normalized.startsWith('<!', start) || normalized.startsWith('<?', start)) {
      cursor = declarationEnd(normalized, start);
      continue;
    }
    const tag = tagAt(normalized, start);
    if (tag === undefined) {
      output += '&lt;';
      cursor = start + 1;
      continue;
    }
    const elementName = localName(tag.name);
    const parentNamespace = openElements.at(-1)?.childNamespace ?? 'html';
    const elementNamespace =
      options.format === 'svg' || parentNamespace === 'svg' || tag.name === 'svg' ? 'svg' : 'html';
    const selfClosing = tag.raw.endsWith('/>');
    output += sanitizeTag(tag, options);
    cursor = tag.end;
    if (tag.closing) {
      let matchingIndex = -1;
      for (let index = openElements.length - 1; index >= 0; index -= 1) {
        if (openElements[index]?.name === tag.name) {
          matchingIndex = index;
          break;
        }
      }
      if (matchingIndex !== -1) openElements.splice(matchingIndex);
    } else if (!selfClosing) {
      openElements.push({
        name: tag.name,
        childNamespace:
          options.format !== 'svg' &&
          elementNamespace === 'svg' &&
          SVG_HTML_INTEGRATION_POINTS.has(tag.name)
            ? 'html'
            : elementNamespace,
      });
    }
    const svgStyle =
      elementNamespace === 'svg' &&
      elementName === 'style' &&
      (options.format === 'svg' || tag.name === 'style');
    if (!tag.closing && !selfClosing && svgStyle) {
      const leading = /^[\t\n\r ]*<!\[CDATA\[/u.exec(normalized.slice(cursor));
      if (leading !== null) {
        const contentStart = cursor + leading[0].length;
        const cdataEnd = normalized.indexOf(']]>', contentStart);
        if (cdataEnd !== -1) {
          const closeStart = normalized.toLowerCase().indexOf(`</${tag.name}`, cdataEnd + 3);
          const between =
            closeStart === -1 ? undefined : normalized.slice(cdataEnd + 3, closeStart);
          const content = normalized.slice(contentStart, cdataEnd);
          if (
            closeStart !== -1 &&
            between !== undefined &&
            /^\s*$/u.test(between) &&
            !/<\/style(?:\s|\/|>)/iu.test(content)
          ) {
            output += content;
            cursor = closeStart;
            continue;
          }
        }
      }
    }
    if (!tag.closing && localName(tag.name) === 'script') {
      const closeStart = normalized.toLowerCase().indexOf(`</${tag.name}`, cursor);
      if (closeStart === -1) {
        cursor = normalized.length;
      } else {
        const close = tagAt(normalized, closeStart);
        cursor = close?.end ?? normalized.length;
      }
    }
  }
  return options.format === 'svg' ? output : `<!doctype html>${output}`;
}

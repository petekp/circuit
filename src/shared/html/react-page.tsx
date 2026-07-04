// React document shell for operator-summary pages.
//
// Renders a full HTML document with react-dom/server at write time: static
// markup, design-system CSS inlined from css.generated.ts, and the
// clipboard helper as the only script. Pages stay single-file and
// file://-openable; there is no hydration and no runtime dependency on
// React in the opened page.
//
// React escapes interpolated text, but escaping is not sanitization:
// bidi overrides and C0 controls survive it and can visually reorder
// option labels. Pass every operator-controlled string through t().

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { sanitizeForRender, truncate } from './page.js';
import { UI_CSS } from './ui/css.generated.js';

// Sanitize (and optionally cap) operator-controlled text for rendering.
export function t(value: string, max?: number): string {
  const clean = sanitizeForRender(value);
  return max === undefined ? clean : truncate(clean, max);
}

// Copy-button behavior for <button data-prompt="..."> elements. Clipboard
// access can fail on file:// pages, so buttons flip to "Copy failed" and
// every command stays visible as text beside its button.
const CLIPBOARD_SCRIPT = [
  "document.querySelectorAll('button[data-prompt]').forEach(btn=>{",
  "btn.addEventListener('click',async()=>{",
  'const p=btn.dataset.prompt;if(!p)return;',
  'try{await navigator.clipboard.writeText(p);',
  "const o=btn.textContent;btn.textContent='Copied';",
  'setTimeout(()=>{btn.textContent=o;},1200);}',
  "catch(e){btn.textContent='Copy failed';}",
  '});});',
].join('');

export type RenderHtmlDocumentInput = {
  readonly title: string;
  readonly body: ReactNode;
  // Page-specific stylesheet appended after the design-system CSS. Must be
  // a build-time constant, never operator input.
  readonly extraStyle?: string | undefined;
  // Page-specific behavior script appended after the clipboard helper.
  // Must be a build-time constant, never operator input.
  readonly extraScript?: string | undefined;
};

export function renderHtmlDocument(input: RenderHtmlDocumentInput): string {
  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{t(input.title, 256)}</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-produced CSS, not operator input */}
        <style dangerouslySetInnerHTML={{ __html: UI_CSS }} />
        {input.extraStyle === undefined ? null : (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static stylesheet constant, not operator input
          <style dangerouslySetInnerHTML={{ __html: input.extraStyle }} />
        )}
      </head>
      <body>
        {input.body}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static script constant, not operator input */}
        <script dangerouslySetInnerHTML={{ __html: CLIPBOARD_SCRIPT }} />
        {input.extraScript === undefined ? null : (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static script constant, not operator input
          <script dangerouslySetInnerHTML={{ __html: input.extraScript }} />
        )}
      </body>
    </html>,
  );
  return `<!doctype html>\n${markup}\n`;
}

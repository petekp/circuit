import { describe, expect, it } from 'vitest';

import { sanitizeArtifactMarkup } from '../../../../src/shared/html/artifact-sanitizer.js';

describe('sanitizeArtifactMarkup', () => {
  it('removes quoted, unquoted, mixed-case, and SVG navigation without flattening the preview', () => {
    const source = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="/captured/style.css">',
      '<meta http-equiv=refresh content="0; url=https://attacker.example/refresh">',
      '<base href=https://attacker.example/>',
      '</head><body>',
      '<a id="quoted" href="https://attacker.example/quoted" target=_top>Quoted</a>',
      '<a id=unquoted href=https://attacker.example/unquoted ping=https://attacker.example/ping>Unquoted</a>',
      '<button formaction=https://attacker.example/button onclick=location.href="https://attacker.example/event">Button</button>',
      '<form action=https://attacker.example/form><input type=submit></form>',
      '<svg xmlns:q="http://www.w3.org/1999/xlink"><defs><symbol id="dot"><circle r="2"/></symbol></defs><use id="copy" href="#dot"/><a q:href="https://attacker.example/aliased-svg"><rect width="10" height="10"/></a>',
      '<set attributeName=href to="https://attacker.example/animated"/></svg>',
      '<script src=https://attacker.example/script.js>alert(1)</script>',
      '<iframe src=https://attacker.example/frame></iframe>',
      '</body></html>',
    ].join('');

    const sanitized = sanitizeArtifactMarkup(source);

    expect(sanitized).toMatch(/^<!doctype html>/u);
    expect(sanitized).toContain('<link rel="stylesheet" href="/captured/style.css">');
    expect(sanitized).toContain('<a id="quoted">Quoted</a>');
    expect(sanitized).toContain('<a id=unquoted>Unquoted</a>');
    expect(sanitized).toContain('<button>Button</button>');
    expect(sanitized).toContain('<input type=submit>');
    expect(sanitized).toContain('<use id="copy" href="#dot"/>');
    expect(sanitized).toContain('<a><rect width="10" height="10"/></a>');
    expect(sanitized).not.toMatch(/attacker\.example/u);
    expect(sanitized.match(/\bhref\s*=/giu)).toHaveLength(2);
    expect(sanitized).not.toMatch(/\b(?:xlink:href|ping|target|action|formaction|onclick)\s*=/iu);
    expect(sanitized).not.toMatch(/<(?:script|iframe|form|base|set)\b/iu);
    expect(sanitized).not.toMatch(/http-equiv\s*=\s*["']?refresh/iu);
  });

  it('removes executable declarations, embedded documents, and event handlers from malformed-looking input', () => {
    const source = [
      '<?xml-stylesheet href="https://attacker.example/style.css"?>',
      '<!DOCTYPE svg SYSTEM "https://attacker.example/evil.dtd">',
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<foreignObject><object data=https://attacker.example/object>Fallback</object></foreignObject>',
      '<image onload = "fetch(\'https://attacker.example/load\')" href = https://attacker.example/image />',
      '<animateTransform attributeName="transform" values="0;1"/>',
      '<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>',
      '</svg>',
    ].join('');

    const sanitized = sanitizeArtifactMarkup(source, { format: 'svg' });

    expect(sanitized).toContain('<svg xmlns="http://www.w3.org/2000/svg">');
    expect(sanitized).toContain('<foreignObject>Fallback</foreignObject>');
    expect(sanitized).toContain('<image />');
    expect(sanitized).not.toContain('attacker.example');
    expect(sanitized).not.toMatch(/<\?|<!DOCTYPE|<object|<animateTransform|<s:script/iu);
    expect(sanitized).not.toMatch(/\bonload\s*=/iu);
  });

  it('keeps only explicitly captured SVG image or use resources and local fragments', () => {
    const source = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<defs><symbol id="dot"><circle r="2"/></symbol></defs>',
      '<image id="image" href="/asset/tile?mode=one&amp;size=two#tile"/>',
      '<image id="xlink-image" xlink:href="/asset/tile-xlink#tile"/>',
      '<use id="use" href="/asset/symbols#dot"/>',
      '<use id="xlink-use" xlink:href="/asset/symbols-xlink#dot"/>',
      '<use id="local" href="#dot"/>',
      '<image id="unbound" href="./missing.svg"/>',
      '<use id="external" xlink:href="https://attacker.example/symbols.svg#dot"/>',
      '<a id="navigation" href="/asset/tile"><text>Navigate</text></a>',
      '</svg>',
    ].join('');

    const sanitized = sanitizeArtifactMarkup(source, {
      format: 'svg',
      allowedResourceUrls: new Set([
        '/asset/tile?mode=one&size=two#tile',
        '/asset/tile-xlink#tile',
        '/asset/symbols#dot',
        '/asset/symbols-xlink#dot',
      ]),
    });

    expect(sanitized).toContain('href="/asset/tile?mode=one&amp;size=two#tile"');
    expect(sanitized).toContain('xlink:href="/asset/tile-xlink#tile"');
    expect(sanitized).toContain('href="/asset/symbols#dot"');
    expect(sanitized).toContain('xlink:href="/asset/symbols-xlink#dot"');
    expect(sanitized).toContain('href="#dot"');
    expect(sanitized).not.toContain('./missing.svg');
    expect(sanitized).not.toContain('attacker.example');
    expect(sanitized).toContain('<a id="navigation"><text>Navigate</text></a>');
  });

  it('unwraps SVG style CDATA without admitting declarations, scripts, or navigation', () => {
    const source = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE svg SYSTEM "https://attacker.example/evil.dtd">',
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<style><![CDATA[.card{fill:rgb(12,34,56);background:url("/asset/paint#paint")}]]></style>',
      '<script>document.body.dataset.executed="yes"</script>',
      '<a href="https://attacker.example/navigation"><rect class="card"/></a>',
      '</svg>',
    ].join('');

    const sanitized = sanitizeArtifactMarkup(source, { format: 'svg' });

    expect(sanitized).toContain(
      '<style>.card{fill:rgb(12,34,56);background:url("/asset/paint#paint")}</style>',
    );
    expect(sanitized).not.toContain('<![CDATA[');
    expect(sanitized).not.toMatch(/<\?|<!DOCTYPE|<script/iu);
    expect(sanitized).not.toContain('attacker.example');
    expect(sanitized).toContain('<a><rect class="card"/></a>');
  });

  it('unwraps CDATA only for an inline SVG style inside HTML', () => {
    const source = [
      '<!doctype html><html><head>',
      '<style><![CDATA[.html-card{color:rgb(1,2,3)}]]></style>',
      '</head><body>',
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<style><![CDATA[.svg-card{fill:rgb(12,34,56);background:url("/asset/paint#paint")}]]></style>',
      '<image id="bound" href="/asset/tile"/><image id="unbound" href="/asset/missing"/>',
      '<foreignObject><style><![CDATA[.html-island{color:rgb(4,5,6)}]]></style></foreignObject>',
      '<script>document.body.dataset.executed="yes"</script>',
      '<a href="https://attacker.example/navigation"><rect class="svg-card"/></a>',
      '</svg>',
      '</body></html>',
    ].join('');

    const sanitized = sanitizeArtifactMarkup(source, {
      allowedResourceUrls: new Set(['/asset/tile']),
    });

    expect(sanitized).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.svg-card{fill:rgb(12,34,56);background:url("/asset/paint#paint")}</style>',
    );
    expect(sanitized).not.toContain('.html-card');
    expect(sanitized).not.toContain('.html-island');
    expect(sanitized).not.toContain('<![CDATA[');
    expect(sanitized).toContain('<image id="bound" href="/asset/tile"/>');
    expect(sanitized).toContain('<image id="unbound"/>');
    expect(sanitized).not.toContain('/asset/missing');
    expect(sanitized).not.toMatch(/<script/iu);
    expect(sanitized).not.toContain('attacker.example');
    expect(sanitized).toContain('<a><rect class="svg-card"/></a>');
  });
});

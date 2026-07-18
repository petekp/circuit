import { describe, expect, it } from 'vitest';

import {
  extractHtmlAssetReferences,
  extractSvgAssetReferences,
  rewriteHtmlAssetReferences,
  rewriteSvgAssetReferences,
} from '../../src/app/checkpoints/local-review-references.js';

describe('local checkpoint review references', () => {
  it('decodes entity-quoted inline style URLs before capture and safely reserializes them', () => {
    const html = [
      '<div id="single" style="background:url(&#x27;./single.png?mode=1&amp;scale=2#single&#x27;)"></div>',
      "<div id='double' style='background:url(&quot;./double.png?mode=2&amp;scale=3#double&quot;)'></div>",
      '<div id="apostrophe" style="background:url(&apos;./apostrophe.png&apos;)"></div>',
    ].join('');

    expect(extractHtmlAssetReferences(html)).toEqual([
      {
        kind: 'css-url',
        sourceValue: './single.png?mode=1&scale=2#single',
      },
      {
        kind: 'css-url',
        sourceValue: './double.png?mode=2&scale=3#double',
      },
      { kind: 'css-url', sourceValue: './apostrophe.png' },
    ]);

    const rewritten = rewriteHtmlAssetReferences(html, {
      htmlAttribute: new Map(),
      htmlSrcset: new Map(),
      cssUrl: new Map([
        ['./single.png?mode=1&scale=2#single', '/asset/single?mode=1&scale=2#single'],
        ['./double.png?mode=2&scale=3#double', '/asset/double?mode=2&scale=3#double'],
        ['./apostrophe.png', '/asset/apostrophe'],
      ]),
    }).html;

    expect(rewritten).toContain(
      'style="background:url(\'/asset/single?mode=1&amp;scale=2#single\')"',
    );
    expect(rewritten).toContain(
      'style=\'background:url("/asset/double?mode=2&amp;scale=3#double")\'',
    );
    expect(rewritten).toContain('style="background:url(\'/asset/apostrophe\')"');
    expect(rewritten).not.toContain('&#x27;./single.png');
    expect(rewritten).not.toContain('&quot;./double.png');
  });

  it.each(['textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'script'])(
    'does not treat markup-looking text inside <%s> as live markup',
    (element) => {
      const html = `<${element}><img src="./not-live.png"></${element}><img src="./live.png">`;

      expect(extractHtmlAssetReferences(html)).toEqual([
        { kind: 'html-attribute', sourceValue: './live.png' },
      ]);

      const rewritten = rewriteHtmlAssetReferences(html, {
        htmlAttribute: new Map([
          ['./not-live.png', '/asset/not-live'],
          ['./live.png', '/asset/live'],
        ]),
        htmlSrcset: new Map(),
        cssUrl: new Map(),
      }).html;
      expect(rewritten).toContain(`<${element}><img src="./not-live.png"></${element}>`);
      expect(rewritten).toContain('<img src="/asset/live">');
      expect(rewritten).not.toContain('/asset/not-live');
    },
  );

  it('treats everything after a plaintext start tag as text', () => {
    const html = '<img src="./live.png"><plaintext><img src="./not-live.png"></plaintext>';

    expect(extractHtmlAssetReferences(html)).toEqual([
      { kind: 'html-attribute', sourceValue: './live.png' },
    ]);
    expect(
      rewriteHtmlAssetReferences(html, {
        htmlAttribute: new Map([
          ['./live.png', '/asset/live'],
          ['./not-live.png', '/asset/not-live'],
        ]),
        htmlSrcset: new Map(),
        cssUrl: new Map(),
      }).html,
    ).toBe('<img src="/asset/live"><plaintext><img src="./not-live.png"></plaintext>');
  });

  it('requires a valid end-tag boundary before leaving a style raw-text block', () => {
    const html = [
      '<style>',
      '.card::after{content:"</stylesheet><img src=\'./not-live.png\'>"}',
      ".card{background:url('./style.png')}",
      '</style>',
      '<img src="./live.png">',
    ].join('');

    expect(extractHtmlAssetReferences(html)).toEqual([
      { kind: 'css-url', sourceValue: './style.png' },
      { kind: 'html-attribute', sourceValue: './live.png' },
    ]);

    const rewritten = rewriteHtmlAssetReferences(html, {
      htmlAttribute: new Map([
        ['./not-live.png', '/asset/not-live'],
        ['./live.png', '/asset/live'],
      ]),
      htmlSrcset: new Map(),
      cssUrl: new Map([['./style.png', '/asset/style']]),
    }).html;
    expect(rewritten).toContain("</stylesheet><img src='./not-live.png'>");
    expect(rewritten).toContain("background:url('/asset/style')");
    expect(rewritten).toContain('<img src="/asset/live">');
    expect(rewritten).not.toContain('/asset/not-live');
  });

  it('keeps commas inside srcset URLs and rewrites the same candidates a browser parses', () => {
    const html = [
      '<img srcset="./small,card.svg 1x, ./large,card.svg 2x">',
      '<source srcset="./plain.svg, ./wide,card.svg 1200w">',
    ].join('');

    expect(extractHtmlAssetReferences(html)).toEqual([
      { kind: 'html-srcset', sourceValue: './small,card.svg' },
      { kind: 'html-srcset', sourceValue: './large,card.svg' },
      { kind: 'html-srcset', sourceValue: './plain.svg' },
      { kind: 'html-srcset', sourceValue: './wide,card.svg' },
    ]);

    const rewritten = rewriteHtmlAssetReferences(html, {
      htmlAttribute: new Map(),
      htmlSrcset: new Map([
        ['./small,card.svg', '/asset/small'],
        ['./large,card.svg', '/asset/large'],
        ['./plain.svg', '/asset/plain'],
        ['./wide,card.svg', '/asset/wide'],
      ]),
      cssUrl: new Map(),
    }).html;

    expect(rewritten).toContain('srcset="/asset/small 1x, /asset/large 2x"');
    expect(rewritten).toContain('srcset="/asset/plain, /asset/wide 1200w"');
  });

  it('captures and rewrites safe SVG image or use resources while keeping local fragments local', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<style><![CDATA[.tile{fill:url("./paint.svg#paint")}]]></style>',
      '<image id="image" href="./tile.svg?mode=one#tile"/>',
      '<image id="xlink-image" xlink:href="./tile-xlink.svg#tile"/>',
      '<use id="use" href="./symbols.svg#dot"/>',
      '<use id="xlink-use" xlink:href="./symbols-xlink.svg#dot"/>',
      '<use id="local" href="#local-dot"/>',
      '<a href="./not-a-resource.svg"><text>Navigation</text></a>',
      '</svg>',
    ].join('');

    expect(extractSvgAssetReferences(svg)).toEqual([
      { kind: 'css-url', sourceValue: './paint.svg#paint' },
      { kind: 'html-attribute', sourceValue: './tile.svg?mode=one#tile' },
      { kind: 'html-attribute', sourceValue: './tile-xlink.svg#tile' },
      { kind: 'html-attribute', sourceValue: './symbols.svg#dot' },
      { kind: 'html-attribute', sourceValue: './symbols-xlink.svg#dot' },
    ]);

    const rewritten = rewriteSvgAssetReferences(svg, {
      htmlAttribute: new Map([
        ['./tile.svg?mode=one#tile', '/asset/tile?mode=one#tile'],
        ['./tile-xlink.svg#tile', '/asset/tile-xlink#tile'],
        ['./symbols.svg#dot', '/asset/symbols#dot'],
        ['./symbols-xlink.svg#dot', '/asset/symbols-xlink#dot'],
      ]),
      htmlSrcset: new Map(),
      cssUrl: new Map([['./paint.svg#paint', '/asset/paint#paint']]),
    }).svg;

    expect(rewritten).toContain('url("/asset/paint#paint")');
    expect(rewritten).toContain('href="/asset/tile?mode=one#tile"');
    expect(rewritten).toContain('xlink:href="/asset/tile-xlink#tile"');
    expect(rewritten).toContain('href="/asset/symbols#dot"');
    expect(rewritten).toContain('xlink:href="/asset/symbols-xlink#dot"');
    expect(rewritten).toContain('href="#local-dot"');
    expect(rewritten).toContain('href="./not-a-resource.svg"');
  });

  it('captures and rewrites image or use resources inside inline HTML SVG', () => {
    const html = [
      '<main>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<image id="image" href="./tile.svg?mode=one#tile"/>',
      '<image id="xlink-image" xlink:href="./tile-xlink.svg#tile"/>',
      '<use id="use" href="./symbols.svg#dot"/>',
      '<use id="xlink-use" xlink:href="./symbols-xlink.svg#dot"/>',
      '<use id="local" href="#local-dot"/>',
      '</svg>',
      '</main>',
    ].join('');

    expect(extractHtmlAssetReferences(html)).toEqual([
      { kind: 'html-attribute', sourceValue: './tile.svg?mode=one#tile' },
      { kind: 'html-attribute', sourceValue: './tile-xlink.svg#tile' },
      { kind: 'html-attribute', sourceValue: './symbols.svg#dot' },
      { kind: 'html-attribute', sourceValue: './symbols-xlink.svg#dot' },
    ]);

    const rewritten = rewriteHtmlAssetReferences(html, {
      htmlAttribute: new Map([
        ['./tile.svg?mode=one#tile', '/asset/tile?mode=one#tile'],
        ['./tile-xlink.svg#tile', '/asset/tile-xlink#tile'],
        ['./symbols.svg#dot', '/asset/symbols#dot'],
        ['./symbols-xlink.svg#dot', '/asset/symbols-xlink#dot'],
      ]),
      htmlSrcset: new Map(),
      cssUrl: new Map(),
    }).html;

    expect(rewritten).toContain('href="/asset/tile?mode=one#tile"');
    expect(rewritten).toContain('xlink:href="/asset/tile-xlink#tile"');
    expect(rewritten).toContain('href="/asset/symbols#dot"');
    expect(rewritten).toContain('xlink:href="/asset/symbols-xlink#dot"');
    expect(rewritten).toContain('href="#local-dot"');
  });
});

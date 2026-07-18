import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { captureLocalCheckpointReviewAssets } from '../../src/app/checkpoints/local-review-assets.js';
import type { CheckpointReviewAssetGroup } from '../../src/schemas/checkpoint-review-assets.js';
import { snapshotCheckpointReviewAssetGroups } from '../../src/shared/checkpoint-review-assets.js';

type Fixture = {
  readonly scratch: string;
  readonly projectRoot: string;
  readonly runFolder: string;
};

const scratches: string[] = [];

function fixture(): Fixture {
  const scratch = mkdtempSync(join(tmpdir(), 'circuit-review-assets-'));
  const projectRoot = join(scratch, 'project');
  const runFolder = join(projectRoot, '.circuit', 'runs', 'run-1');
  mkdirSync(join(runFolder, 'reports'), { recursive: true });
  scratches.push(scratch);
  return { scratch, projectRoot, runFolder };
}

function write(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function previewTag(sourceUrl: string, embedded?: string, proof?: string): string {
  return `<iframe data-artifact-preview-src="${sourceUrl}"${
    embedded === undefined ? '' : ` data-artifact-preview-embedded="${embedded}"`
  }${proof === undefined ? '' : ` data-artifact-preview-proof="${proof}"`}></iframe>`;
}

function snapshotCheckpointReviewAssetGroup(input: {
  readonly projectRoot: string;
  readonly root: string;
  readonly entryPoints: readonly string[];
}): CheckpointReviewAssetGroup | undefined {
  return snapshotCheckpointReviewAssetGroups({
    projectRoot: input.projectRoot,
    groups: [{ root: input.root, entryPoints: input.entryPoints }],
  })[0];
}

function captureBound(
  input: Fixture,
  html: string,
  entryPoints: readonly string[],
): ReturnType<typeof captureLocalCheckpointReviewAssets> {
  const byRoot = new Map<string, string[]>();
  for (const entryPoint of entryPoints) {
    const root = entryPoint.slice(0, entryPoint.lastIndexOf('/'));
    const entries = byRoot.get(root) ?? [];
    entries.push(entryPoint);
    byRoot.set(root, entries);
  }
  const reviewAssets = snapshotCheckpointReviewAssetGroups({
    projectRoot: input.projectRoot,
    groups: Array.from(byRoot, ([root, entries]) => ({ root, entryPoints: entries })),
  });
  return captureLocalCheckpointReviewAssets({
    html,
    runFolder: input.runFolder,
    projectRoot: input.projectRoot,
    reviewAssets,
  });
}

afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { force: true, recursive: true });
});

describe('captureLocalCheckpointReviewAssets', () => {
  it('captures and de-duplicates a run-relative generated preview URL', () => {
    const input = fixture();
    const sourceUrl = '../prototype-files/variants/a/card.png';
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    write(join(input.runFolder, 'prototype-files', 'variants', 'a', 'card.png'), bytes);

    const assets = captureBound(input, `${previewTag(sourceUrl)}${previewTag(sourceUrl)}`, [
      '.circuit/runs/run-1/prototype-files/variants/a/card.png',
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: 'asset-0',
      pageReferences: [{ sourceUrl }],
      contentType: 'image/png',
    });
    expect(Buffer.from(assets[0]?.bytes ?? [])).toEqual(Buffer.from(bytes));
  });

  it('captures apostrophes in double-quoted or entity-encoded single-quoted preview URLs', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', "Pete's-card", 'index.html');
    const literalSourceUrl =
      "../prototype-files/Pete's-card/index.html?mode=owner's#reviewer's-details";
    const encodedSourceUrl =
      '../prototype-files/Pete&#39;s-card/index.html?mode=owner&#39;s#reviewer&#39;s-details';
    write(entryPath, '<main>Review card</main>');

    const assets = captureBound(
      input,
      [
        `<iframe data-artifact-preview-src="${literalSourceUrl}"></iframe>`,
        `<iframe data-artifact-preview-src='${encodedSourceUrl}'></iframe>`,
      ].join(''),
      [`.circuit/runs/run-1/prototype-files/Pete's-card/index.html`],
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]?.pageReferences).toEqual([
      { sourceUrl: literalSourceUrl },
      { sourceUrl: encodedSourceUrl },
    ]);
    expect(Buffer.from(assets[0]?.bytes ?? []).toString('utf8')).toBe('<main>Review card</main>');
  });

  it('captures a file URL only when it is bound to the checkpoint', () => {
    const input = fixture();
    const projectAsset = join(input.projectRoot, 'public', 'review.svg');
    write(projectAsset, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const sourceUrl = pathToFileURL(projectAsset).href;

    expect(() =>
      captureLocalCheckpointReviewAssets({
        html: previewTag(sourceUrl),
        runFolder: input.runFolder,
        reviewAssets: [],
      }),
    ).toThrow(/not bound to the checkpoint/i);

    const assets = captureBound(input, previewTag(sourceUrl), ['public/review.svg']);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: 'asset-0',
      pageReferences: [{ sourceUrl }],
      contentType: 'image/svg+xml',
    });
    expect(Buffer.from(assets[0]?.bytes ?? []).toString('utf8')).toContain('<svg');
  });

  it('rejects symlinked, missing, and unsupported preview entries without identities', () => {
    const input = fixture();
    const outside = join(input.scratch, 'outside.png');
    const escapePath = join(input.runFolder, 'prototype-files', 'escape.png');
    write(outside, 'private');
    mkdirSync(dirname(escapePath), { recursive: true });
    symlinkSync(outside, escapePath);
    write(join(input.runFolder, 'prototype-files', 'notes.txt'), 'not a preview');

    for (const sourceUrl of [
      '../prototype-files/escape.png',
      '../prototype-files/missing.webp',
      '../prototype-files/notes.txt',
    ]) {
      expect(() =>
        captureLocalCheckpointReviewAssets({
          html: previewTag(sourceUrl),
          runFolder: input.runFolder,
          projectRoot: input.projectRoot,
          reviewAssets: [],
        }),
      ).toThrow(/not bound to the checkpoint/i);
    }
  });

  it('captures an HTML preview and only its explicit HTML and CSS dependency graph', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'card', 'index.html');
    const sourceUrl = '../prototype-files/card/index.html';
    const source = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./styles/card.css">',
      '<script src="./scripts/card.js"></script>',
      '</head><body>',
      '<img src="./images/card.png">',
      '<img src="https://attacker.example/tracker.png">',
      '<a href="../../secret.txt">Do not capture</a>',
      '</body></html>',
    ].join('');
    write(entryPath, source);
    write(
      join(dirname(entryPath), 'styles', 'card.css'),
      '.card{background:url("../images/bg.png")}',
    );
    write(join(dirname(entryPath), 'scripts', 'card.js'), 'document.body.dataset.ready="true";');
    write(join(dirname(entryPath), 'images', 'card.png'), Uint8Array.from([1, 2, 3]));
    write(join(dirname(entryPath), 'images', 'bg.png'), Uint8Array.from([4, 5, 6]));
    write(
      join(input.runFolder, 'prototype-files', 'secret.txt'),
      'not part of the prototype graph',
    );

    const assets = captureBound(
      input,
      previewTag(sourceUrl, Buffer.from('trusted snapshot').toString('base64')),
      ['.circuit/runs/run-1/prototype-files/card/index.html'],
    );

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'text/html',
      'text/css',
      'image/png',
      'image/png',
    ]);
    expect(assets[0]).toMatchObject({
      id: 'asset-0',
      pageReferences: [{ sourceUrl }],
      references: [
        { kind: 'html-attribute', sourceValue: './styles/card.css', targetId: 'asset-1' },
        { kind: 'html-attribute', sourceValue: './images/card.png', targetId: 'asset-2' },
      ],
    });
    expect(assets[1]).toMatchObject({
      id: 'asset-1',
      references: [{ kind: 'css-url', sourceValue: '../images/bg.png', targetId: 'asset-3' }],
    });
    expect(JSON.stringify(assets)).not.toContain('card.js');
    expect(JSON.stringify(assets)).not.toContain('attacker.example');
    expect(JSON.stringify(assets)).not.toContain('secret.txt');
  });

  it('does not let disabled scripts crowd visible CSS and images out of the graph budget', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'card', 'index.html');
    const scripts = Array.from(
      { length: 31 },
      (_, index) => `<script src="./scripts/script-${index}.js"></script>`,
    ).join('');
    write(
      entryPath,
      `<html><head>${scripts}<link rel="stylesheet" href="./card.css"></head><body><img src="./card.png"></body></html>`,
    );
    for (let index = 0; index < 31; index += 1) {
      write(join(dirname(entryPath), 'scripts', `script-${index}.js`), `window.x=${index}`);
    }
    write(join(dirname(entryPath), 'card.css'), 'body{color:rgb(1,2,3)}');
    write(join(dirname(entryPath), 'card.png'), Uint8Array.from([1, 2, 3]));

    const assets = captureBound(input, previewTag('../prototype-files/card/index.html'), [
      '.circuit/runs/run-1/prototype-files/card/index.html',
    ]);

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'text/html',
      'text/css',
      'image/png',
    ]);
    expect(JSON.stringify(assets)).not.toContain('script-');
  });

  it('captures quoted CSS imports as visible stylesheet dependencies', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'card', 'index.html');
    write(entryPath, '<link rel="stylesheet" href="./base.css"><main>Preview</main>');
    write(
      join(dirname(entryPath), 'base.css'),
      '@import "./theme.css" screen; main{background:url("./background.png")}',
    );
    write(join(dirname(entryPath), 'theme.css'), 'main{color:rgb(1,2,3)}');
    write(join(dirname(entryPath), 'background.png'), Uint8Array.from([1, 2, 3]));

    const assets = captureBound(input, previewTag('../prototype-files/card/index.html'), [
      '.circuit/runs/run-1/prototype-files/card/index.html',
    ]);

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'text/html',
      'text/css',
      'text/css',
      'image/png',
    ]);
    expect(assets[1]).toMatchObject({
      references: [
        { kind: 'css-url', sourceValue: './theme.css', targetId: 'asset-2' },
        { kind: 'css-url', sourceValue: './background.png', targetId: 'asset-3' },
      ],
    });
  });

  it('captures responsive image candidates from img and source srcset attributes', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'card', 'index.html');
    write(
      entryPath,
      [
        '<picture>',
        '<source srcset="./wide.webp 1x, ./wider.webp 2x">',
        '<img src="./fallback.png" srcset="./small.png 480w, ./large.png 960w">',
        '</picture>',
      ].join(''),
    );
    for (const file of ['wide.webp', 'wider.webp', 'fallback.png', 'small.png', 'large.png']) {
      write(join(dirname(entryPath), file), file);
    }

    const assets = captureBound(input, previewTag('../prototype-files/card/index.html'), [
      '.circuit/runs/run-1/prototype-files/card/index.html',
    ]);

    expect(
      assets
        .slice(1)
        .map((asset) => Buffer.from(asset.bytes).toString('utf8'))
        .sort(),
    ).toEqual(['fallback.png', 'large.png', 'small.png', 'wide.webp', 'wider.webp']);
    expect(
      assets[0]?.references.filter((reference) => reference.kind === 'html-srcset'),
    ).toHaveLength(4);
  });

  it('captures every safe local dependency form and binds query or fragment references to the underlying file', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'reference-forms', 'index.html');
    write(
      entryPath,
      [
        '<link rel=stylesheet href=./styles/base.css?theme=dark#sheet>',
        '<img src="./images/quoted.svg?cache=1#quoted">',
        '<img src=./images/unquoted.svg#unquoted>',
        '<video poster=./images/poster.svg?frame=1#poster></video>',
        '<div style="background-image:url(\'./images/inline-quoted.svg?mode=1#quoted-style\')"></div>',
        '<div style=background-image:url(./images/inline-unquoted.svg?mode=2#unquoted-style)></div>',
        '<img srcset="./images/small.svg?size=1#small 1x, ./images/large.svg?size=2#large 2x">',
        '<img srcset=./images/single.svg?size=3#single>',
        '<style>',
        '@import "./styles/inline.css?layer=1#inline";',
        "@import url('./styles/url-import.css?layer=2#url-import') screen;",
        '.hero{background:url(./images/style.svg?paint=1#style)}',
        '</style>',
        '<img src="https://attacker.example/tracker.png">',
        '<img src="data:image/png;base64,AAAA">',
        '<img src="javascript:alert(1)">',
        '<style>.blocked{background:url(https://attacker.example/style.png)}.data{background:url(data:image/png;base64,AAAA)}</style>',
      ].join(''),
    );
    const relativeFiles = [
      'styles/base.css',
      'styles/inline.css',
      'styles/url-import.css',
      'images/quoted.svg',
      'images/unquoted.svg',
      'images/poster.svg',
      'images/inline-quoted.svg',
      'images/inline-unquoted.svg',
      'images/small.svg',
      'images/large.svg',
      'images/single.svg',
      'images/style.svg',
    ];
    for (const file of relativeFiles) write(join(dirname(entryPath), file), file);

    const assets = captureBound(
      input,
      previewTag('../prototype-files/reference-forms/index.html'),
      ['.circuit/runs/run-1/prototype-files/reference-forms/index.html'],
    );

    expect(
      assets
        .slice(1)
        .map((asset) => Buffer.from(asset.bytes).toString('utf8'))
        .sort(),
    ).toEqual([...relativeFiles].sort());
    expect(
      assets[0]?.references.map((reference) => [reference.kind, reference.sourceValue]),
    ).toEqual([
      ['html-attribute', './styles/base.css?theme=dark#sheet'],
      ['html-attribute', './images/quoted.svg?cache=1#quoted'],
      ['html-attribute', './images/unquoted.svg#unquoted'],
      ['html-attribute', './images/poster.svg?frame=1#poster'],
      ['css-url', './images/inline-quoted.svg?mode=1#quoted-style'],
      ['css-url', './images/inline-unquoted.svg?mode=2#unquoted-style'],
      ['html-srcset', './images/small.svg?size=1#small'],
      ['html-srcset', './images/large.svg?size=2#large'],
      ['html-srcset', './images/single.svg?size=3#single'],
      ['css-url', './styles/inline.css?layer=1#inline'],
      ['css-url', './styles/url-import.css?layer=2#url-import'],
      ['css-url', './images/style.svg?paint=1#style'],
    ]);
    expect(JSON.stringify(assets)).not.toContain('attacker.example');
    expect(JSON.stringify(assets)).not.toContain('data:image');
    expect(JSON.stringify(assets)).not.toContain('javascript:');
  });

  it('captures href and xlink:href dependencies from inline SVG in an HTML artifact', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'inline-svg', 'index.html');
    write(
      entryPath,
      [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
        '<image href="./tile.svg?mode=one#tile"/>',
        '<image xlink:href="./tile-xlink.svg#tile"/>',
        '<use href="./symbols.svg#dot"/>',
        '<use xlink:href="./symbols-xlink.svg#dot"/>',
        '<use href="#local-dot"/>',
        '</svg>',
      ].join(''),
    );
    const dependencies = ['tile.svg', 'tile-xlink.svg', 'symbols.svg', 'symbols-xlink.svg'];
    for (const dependency of dependencies) {
      write(
        join(dirname(entryPath), dependency),
        `<svg xmlns="http://www.w3.org/2000/svg"><rect id="${dependency}"/></svg>`,
      );
    }

    const assets = captureBound(input, previewTag('../prototype-files/inline-svg/index.html'), [
      '.circuit/runs/run-1/prototype-files/inline-svg/index.html',
    ]);

    expect(assets).toHaveLength(5);
    expect(assets[0]?.references).toEqual([
      { kind: 'html-attribute', sourceValue: './tile.svg?mode=one#tile', targetId: 'asset-1' },
      { kind: 'html-attribute', sourceValue: './tile-xlink.svg#tile', targetId: 'asset-2' },
      { kind: 'html-attribute', sourceValue: './symbols.svg#dot', targetId: 'asset-3' },
      {
        kind: 'html-attribute',
        sourceValue: './symbols-xlink.svg#dot',
        targetId: 'asset-4',
      },
    ]);
    expect(JSON.stringify(assets)).not.toContain('#local-dot');
  });

  it('fails visibly when a local dependency graph exceeds the safe asset count', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'gallery', 'index.html');
    const images = Array.from({ length: 40 }, (_, index) => `image-${index}.png`);
    write(entryPath, images.map((image) => `<img src="./${image}">`).join(''));
    for (const image of images) write(join(dirname(entryPath), image), image);

    expect(() =>
      captureBound(input, previewTag('../prototype-files/gallery/index.html'), [
        '.circuit/runs/run-1/prototype-files/gallery/index.html',
      ]),
    ).toThrow(/more than 32 supported files/i);
  });

  it('decodes rendered HTML entities for lookup while preserving the exact source URL', () => {
    const input = fixture();
    const projectAsset = join(input.projectRoot, 'public', 'a&b.png');
    write(projectAsset, 'png-bytes');
    const sourceUrl = pathToFileURL(projectAsset).href.replaceAll('&', '&amp;');

    const assets = captureBound(input, previewTag(sourceUrl), ['public/a&b.png']);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: 'asset-0',
      pageReferences: [{ sourceUrl }],
      contentType: 'image/png',
    });
    expect(Buffer.from(assets[0]?.bytes ?? []).toString('utf8')).toBe('png-bytes');
  });

  it('omits an HTML entry changed after the renderer created its preview proof', () => {
    const input = fixture();
    const sourceUrl = '../prototype-files/index.html';
    const entryPath = join(input.runFolder, 'prototype-files', 'index.html');
    const original = '<button>Original</button>';
    write(entryPath, original);
    const proof = createHash('sha256')
      .update(entryPath)
      .update('\0')
      .update(original)
      .digest('hex');
    write(entryPath, '<button>Changed after render</button>');

    expect(
      captureBound(input, previewTag(sourceUrl, Buffer.from(original).toString('base64'), proof), [
        '.circuit/runs/run-1/prototype-files/index.html',
      ]),
    ).toEqual([]);
  });

  it('captures a preview only when its entry and dependencies match the bound snapshot', () => {
    const input = fixture();
    const root = '.circuit/runs/run-1/prototype-files/card';
    const entryPoint = `${root}/index.html`;
    const entryPath = join(input.projectRoot, entryPoint);
    write(
      entryPath,
      '<link rel="stylesheet" href="./card.css"><main><img src="./card.png"></main>',
    );
    write(join(dirname(entryPath), 'card.css'), 'main{background:url("./background.png")}');
    write(join(dirname(entryPath), 'card.png'), 'card-image');
    write(join(dirname(entryPath), 'background.png'), 'background-image');
    const group = snapshotCheckpointReviewAssetGroup({
      projectRoot: input.projectRoot,
      root,
      entryPoints: [entryPoint],
    });
    expect(group).toBeDefined();

    const assets = captureLocalCheckpointReviewAssets({
      html: previewTag('../prototype-files/card/index.html'),
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
      reviewAssets: group === undefined ? [] : [group],
    });

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'text/html',
      'text/css',
      'image/png',
      'image/png',
    ]);
    expect(assets[0]?.references).toEqual([
      { kind: 'html-attribute', sourceValue: './card.css', targetId: 'asset-1' },
      { kind: 'html-attribute', sourceValue: './card.png', targetId: 'asset-2' },
    ]);
    expect(assets[1]?.references).toEqual([
      { kind: 'css-url', sourceValue: './background.png', targetId: 'asset-3' },
    ]);
  });

  it('rejects a bound dependency that changes after its identity was recorded', () => {
    const input = fixture();
    const root = '.circuit/runs/run-1/prototype-files/card';
    const entryPoint = `${root}/index.html`;
    const entryPath = join(input.projectRoot, entryPoint);
    const stylesheetPath = join(dirname(entryPath), 'card.css');
    write(entryPath, '<link rel="stylesheet" href="./card.css"><main>Preview</main>');
    write(stylesheetPath, 'main{color:rgb(1,2,3)}');
    const group = snapshotCheckpointReviewAssetGroup({
      projectRoot: input.projectRoot,
      root,
      entryPoints: [entryPoint],
    });
    expect(group).toBeDefined();
    write(stylesheetPath, 'main{color:rgb(4,5,6)}');

    expect(() =>
      captureLocalCheckpointReviewAssets({
        html: previewTag('../prototype-files/card/index.html'),
        runFolder: input.runFolder,
        projectRoot: input.projectRoot,
        reviewAssets: group === undefined ? [] : [group],
      }),
    ).toThrow(/changed after their identity was recorded/i);
  });

  it('omits a dependency that crosses into another bound asset group', () => {
    const input = fixture();
    const firstRoot = '.circuit/runs/run-1/prototype-files/first';
    const secondRoot = '.circuit/runs/run-1/prototype-files/second';
    const firstEntryPoint = `${firstRoot}/index.html`;
    const secondEntryPoint = `${secondRoot}/index.html`;
    write(
      join(input.projectRoot, firstEntryPoint),
      '<link rel="stylesheet" href="../second/theme.css"><main>First</main>',
    );
    write(join(input.projectRoot, secondEntryPoint), '<main>Second</main>');
    write(join(input.projectRoot, secondRoot, 'theme.css'), 'main{color:rgb(1,2,3)}');
    const firstGroup = snapshotCheckpointReviewAssetGroup({
      projectRoot: input.projectRoot,
      root: firstRoot,
      entryPoints: [firstEntryPoint],
    });
    const secondGroup = snapshotCheckpointReviewAssetGroup({
      projectRoot: input.projectRoot,
      root: secondRoot,
      entryPoints: [secondEntryPoint],
    });
    expect(firstGroup).toBeDefined();
    expect(secondGroup).toBeDefined();

    const assets = captureLocalCheckpointReviewAssets({
      html: previewTag('../prototype-files/first/index.html'),
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
      reviewAssets:
        firstGroup === undefined || secondGroup === undefined ? [] : [firstGroup, secondGroup],
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]?.contentType).toBe('text/html');
    expect(assets[0]?.references).toEqual([]);
  });

  it('keeps a strict entry but omits missing, unsafe, or unbound dependencies', () => {
    const input = fixture();
    const root = '.circuit/runs/run-1/prototype-files/card';
    const entryPoint = `${root}/index.html`;
    const entryPath = join(input.projectRoot, entryPoint);
    const outside = join(input.scratch, 'outside.png');
    write(
      entryPath,
      '<img src="./missing.png"><img src="./escape.png"><img src="./late.png"><main>Review remains usable</main>',
    );
    write(outside, 'outside');
    const group = snapshotCheckpointReviewAssetGroup({
      projectRoot: input.projectRoot,
      root,
      entryPoints: [entryPoint],
    });
    expect(group).toBeDefined();
    symlinkSync(outside, join(dirname(entryPath), 'escape.png'));
    write(join(dirname(entryPath), 'late.png'), 'created after the checkpoint identity');

    const assets = captureLocalCheckpointReviewAssets({
      html: previewTag('../prototype-files/card/index.html'),
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
      reviewAssets: group === undefined ? [] : [group],
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]?.pageReferences).toEqual([
      { sourceUrl: '../prototype-files/card/index.html' },
    ]);
    expect(assets[0]?.references).toEqual([]);
    expect(Buffer.from(assets[0]?.bytes ?? []).toString('utf8')).toContain('Review remains usable');
  });

  it('keeps captured bytes frozen when the source file changes later', () => {
    const input = fixture();
    const root = '.circuit/runs/run-1/prototype-files/card';
    const entryPoint = `${root}/index.html`;
    const entryPath = join(input.projectRoot, entryPoint);
    const imagePath = join(dirname(entryPath), 'card.png');
    write(entryPath, '<img src="./card.png">');
    write(imagePath, 'original-image');
    const group = snapshotCheckpointReviewAssetGroup({
      projectRoot: input.projectRoot,
      root,
      entryPoints: [entryPoint],
    });
    expect(group).toBeDefined();
    const assets = captureLocalCheckpointReviewAssets({
      html: previewTag('../prototype-files/card/index.html'),
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
      reviewAssets: group === undefined ? [] : [group],
    });

    write(imagePath, 'mutated-image');

    expect(Buffer.from(assets[1]?.bytes ?? []).toString('utf8')).toBe('original-image');
  });

  it('captures CSS dependencies from style attributes and blocks inside a standalone SVG', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'svg-card', 'card.svg');
    write(
      entryPath,
      [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        '<style>@import "./theme.css?mode=review#theme";.card{fill:url(\'./paint.svg#paint\')}</style>',
        '<rect class="card" style="stroke:url(&quot;./stroke.svg?weight=2#stroke&quot;)"/>',
        '</svg>',
      ].join(''),
    );
    write(join(dirname(entryPath), 'theme.css'), '.card{stroke-width:2}');
    write(join(dirname(entryPath), 'paint.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    write(join(dirname(entryPath), 'stroke.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const assets = captureBound(input, previewTag('../prototype-files/svg-card/card.svg'), [
      '.circuit/runs/run-1/prototype-files/svg-card/card.svg',
    ]);

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'image/svg+xml',
      'text/css',
      'image/svg+xml',
      'image/svg+xml',
    ]);
    expect(assets[0]?.references).toEqual([
      {
        kind: 'css-url',
        sourceValue: './theme.css?mode=review#theme',
        targetId: 'asset-1',
      },
      { kind: 'css-url', sourceValue: './paint.svg#paint', targetId: 'asset-2' },
      {
        kind: 'css-url',
        sourceValue: './stroke.svg?weight=2#stroke',
        targetId: 'asset-3',
      },
    ]);
  });

  it('decodes markup entities for paths but keeps raw CSS URL tokens literal', () => {
    const input = fixture();
    const entryPath = join(input.runFolder, 'prototype-files', 'entities', 'index.html');
    write(
      entryPath,
      [
        '<img id="markup" src="./a&amp;b.png">',
        '<style>.css{background-image:url("./a&amp;b.png")}</style>',
      ].join(''),
    );
    write(join(dirname(entryPath), 'a&b.png'), 'markup-entity-decoded');
    write(join(dirname(entryPath), 'a&amp;b.png'), 'raw-css-token');

    const assets = captureBound(input, previewTag('../prototype-files/entities/index.html'), [
      '.circuit/runs/run-1/prototype-files/entities/index.html',
    ]);

    expect(assets).toHaveLength(3);
    expect(assets[0]?.references).toEqual([
      { kind: 'html-attribute', sourceValue: './a&amp;b.png', targetId: 'asset-1' },
      { kind: 'css-url', sourceValue: './a&amp;b.png', targetId: 'asset-2' },
    ]);
    expect(Buffer.from(assets[1]?.bytes ?? []).toString('utf8')).toBe('markup-entity-decoded');
    expect(Buffer.from(assets[2]?.bytes ?? []).toString('utf8')).toBe('raw-css-token');
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import type { captureLocalCheckpointReviewAssets as CaptureAssets } from '../../src/app/checkpoints/local-review-assets.js';
import type { startLocalCheckpointReviewSession as StartSession } from '../../src/app/checkpoints/local-review-session.js';
import type { snapshotCheckpointReviewAssetGroups as SnapshotAssetGroups } from '../../src/shared/checkpoint-review-assets.js';
import type { previewForEntryPoints as PreviewForEntryPoints } from '../../src/shared/html/artifact-preview.js';
import type { renderCheckpointPage as RenderCheckpointPage } from '../../src/shared/html/checkpoint-page.js';

const assetsPath = '../../dist/app/checkpoints/local-review-assets.js';
const sessionPath = '../../dist/app/checkpoints/local-review-session.js';
const pagePath = '../../dist/shared/html/checkpoint-page.js';
const previewPath = '../../dist/shared/html/artifact-preview.js';
const reviewAssetsPath = '../../dist/shared/checkpoint-review-assets.js';

const { captureLocalCheckpointReviewAssets } = (await import(assetsPath)) as {
  captureLocalCheckpointReviewAssets: typeof CaptureAssets;
};
const { startLocalCheckpointReviewSession } = (await import(sessionPath)) as {
  startLocalCheckpointReviewSession: typeof StartSession;
};
const { renderCheckpointPage } = (await import(pagePath)) as {
  renderCheckpointPage: typeof RenderCheckpointPage;
};
const { previewForEntryPoints } = (await import(previewPath)) as {
  previewForEntryPoints: typeof PreviewForEntryPoints;
};
const { snapshotCheckpointReviewAssetGroups } = (await import(reviewAssetsPath)) as {
  snapshotCheckpointReviewAssetGroups: typeof SnapshotAssetGroups;
};

function captureBoundReviewAssets(input: {
  readonly html: string;
  readonly runFolder: string;
  readonly projectRoot: string;
  readonly groups: Parameters<typeof snapshotCheckpointReviewAssetGroups>[0]['groups'];
}): ReturnType<typeof captureLocalCheckpointReviewAssets> {
  return captureLocalCheckpointReviewAssets({
    html: input.html,
    runFolder: input.runFolder,
    projectRoot: input.projectRoot,
    reviewAssets: snapshotCheckpointReviewAssetGroups({
      projectRoot: input.projectRoot,
      groups: input.groups,
    }),
  });
}

function write(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test('keeps a captured multi-file prototype interactive without letting it reach another server', async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), 'circuit-local-review-browser-'));
  const runFolder = join(scratch, '.circuit', 'runs', '11111111-1111-4111-8111-111111111111');
  const artifactRoot = join(runFolder, 'prototype-files', 'card');
  mkdirSync(join(runFolder, 'reports'), { recursive: true });

  const beaconHits: string[] = [];
  const beacon = createServer((request, response) => {
    beaconHits.push(request.url ?? '/');
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    beacon.once('error', reject);
    beacon.listen(0, '127.0.0.1', () => resolve());
  });
  const beaconAddress = beacon.address();
  if (beaconAddress === null || typeof beaconAddress === 'string') {
    throw new Error('beacon did not bind to loopback');
  }
  const beaconOrigin = `http://127.0.0.1:${beaconAddress.port}`;

  let session: Awaited<ReturnType<typeof startLocalCheckpointReviewSession>> | undefined;
  try {
    write(
      join(artifactRoot, 'index.html'),
      `<!doctype html><html><head>
        <link rel=stylesheet href=./styles/card.css?theme=dark#sheet>
        <script src="./scripts/classic.js"></script>
        <script type="module" src="./scripts/module.mjs"></script>
        <meta http-equiv="refresh" content="0;url=${beaconOrigin}/refresh">
      </head><body>
        <main id="card"><h1>Captured review card</h1>
          <img id="logo" src="./images/logo.svg?cache=1#logo" alt="">
          <img id=unquoted-image src=./images/unquoted.svg#image alt="">
          <video id=poster poster=./images/poster.svg?frame=1#poster></video>
          <div id="inline-quoted" style="background-image:url('./images/inline-quoted.svg?mode=1#quoted')"></div>
          <div id=inline-unquoted style=background-image:url(./images/inline-unquoted.svg?mode=2#unquoted)></div>
          <picture><source srcset="./images/small.svg?size=1#small 1x, ./images/large.svg?size=2#large 2x"><img id=responsive srcset=./images/single.svg?size=3#single src=./images/single.svg alt=""></picture>
          <img id="comma-responsive" srcset="./images/comma,one.svg 1x, ./images/comma,two.svg 2x" alt="">
          <style>@import "./styles/inline.css?layer=1#inline";@import url('./styles/url-import.css?layer=2#url-import') screen;.style-reference{background:url(./images/style.svg?paint=1#style)}</style>
          <div id="imported-style" class="imported style-reference">Imported styles load.</div>
          <details><summary>Reveal details</summary><p>Native interaction works.</p></details>
          <a id="external-link" href="${beaconOrigin}/markup-link">External link</a>
          <a id="unquoted-link" href=${beaconOrigin}/unquoted-link>Unquoted link</a>
          <svg width="100" height="20"><style><![CDATA[#inline-svg-card{fill:rgb(31,41,59);background-image:url("./images/style.svg?inline-svg=1#paint")}]]></style><rect id="inline-svg-card" width="20" height="20"/><a id="svg-link" href="${beaconOrigin}/inline-svg-link"><text x="24" y="15">SVG link</text></a></svg>
          <img id="tracker" src="${beaconOrigin}/markup-image" alt="">
          <iframe src="${beaconOrigin}/markup-frame"></iframe>
          <form action="${beaconOrigin}/markup-form"><button type="submit">Submit</button></form>
        </main>
        <script>
          fetch(${JSON.stringify(`${beaconOrigin}/fetch`)}).catch(()=>{});
          const tracker=new Image();tracker.src=${JSON.stringify(`${beaconOrigin}/image`)};
          const frame=document.createElement('iframe');frame.src=${JSON.stringify(`${beaconOrigin}/frame`)};document.body.append(frame);
          const form=document.createElement('form');form.action=${JSON.stringify(`${beaconOrigin}/form`)};document.body.append(form);form.submit();
          const link=document.createElement('a');link.href=${JSON.stringify(`${beaconOrigin}/link`)};document.body.append(link);link.click();
          setTimeout(()=>{location.href=${JSON.stringify(`${beaconOrigin}/navigate`)}},250);
        </script>
      </body></html>`,
    );
    write(
      join(artifactRoot, 'styles', 'card.css'),
      '#card{border:3px solid rgb(12,34,56);background-image:url("../images/background.svg")}',
    );
    write(join(artifactRoot, 'styles', 'inline.css'), '.imported{color:rgb(7,8,9)}');
    write(join(artifactRoot, 'styles', 'url-import.css'), '.imported{padding-left:13px}');
    write(
      join(artifactRoot, 'scripts', 'classic.js'),
      'document.documentElement.dataset.classic="ready";',
    );
    write(
      join(artifactRoot, 'scripts', 'module.mjs'),
      'document.documentElement.dataset.module="ready";',
    );
    write(
      join(artifactRoot, 'images', 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>',
    );
    write(
      join(artifactRoot, 'images', 'background.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
    );
    for (const name of [
      'unquoted',
      'poster',
      'inline-quoted',
      'inline-unquoted',
      'small',
      'large',
      'single',
      'style',
      'comma,one',
      'comma,two',
    ]) {
      write(
        join(artifactRoot, 'images', `${name}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect id="${name}" width="8" height="8" fill="green"/></svg>`,
      );
    }

    const preview = previewForEntryPoints({
      entryPoints: ['prototype-files/card/index.html'],
      runFolder,
    });
    if (preview.status !== 'ready') throw new Error('HTML preview should be ready');
    const html = renderCheckpointPage({
      meta: {
        flowLabel: 'Prototype',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'review-card',
      },
      question: 'Keep this review card?',
      ribbon: ['Waiting for you'],
      options: [{ id: 'keep', label: 'Keep it', isDefault: true, isRecommended: true }],
      defaultChoice: { id: 'keep', label: 'Keep it' },
      artifact: { title: 'Review card', preview },
      resume: {
        runFolder,
        commandPrefix: 'circuit resume',
        attempt: 1,
        requestSha256: 'a'.repeat(64),
      },
    });
    const assets = captureBoundReviewAssets({
      html,
      runFolder,
      projectRoot: scratch,
      groups: [
        {
          root: '.circuit/runs/11111111-1111-4111-8111-111111111111/prototype-files/card',
          entryPoints: [
            '.circuit/runs/11111111-1111-4111-8111-111111111111/prototype-files/card/index.html',
          ],
        },
      ],
    });
    expect(assets).toHaveLength(16);
    expect(assets[0]?.contentType).toBe('text/html');
    expect(assets.filter((asset) => asset.contentType === 'text/css')).toHaveLength(3);
    expect(assets.filter((asset) => asset.contentType === 'image/svg+xml')).toHaveLength(12);

    session = await startLocalCheckpointReviewSession({
      html,
      identity: {
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'review-card',
        attempt: 1,
        requestSha256: 'a'.repeat(64),
      },
      allowedChoices: ['keep'],
      assets,
      onSubmit: async () => ({ status: 'accepted' }),
    });

    await page.goto(session.url);
    const previewShell = page.locator('[data-artifact-preview-shell]');
    await page.waitForTimeout(500);
    expect(
      beaconHits,
      `artifact frames: ${page
        .frames()
        .map((frame) => frame.url())
        .join(', ')}`,
    ).toEqual([]);
    await expect(previewShell).toHaveAttribute('data-artifact-preview-state', 'ready');
    const frame = page.frameLocator('[data-artifact-preview-frame]');
    await expect(frame.locator('html')).not.toHaveAttribute('data-classic', 'ready');
    expect(
      await frame.locator('html').evaluate((element) => element.ownerDocument.compatMode),
    ).toBe('CSS1Compat');
    await expect(frame.locator('html')).not.toHaveAttribute('data-module', 'ready');
    await expect(frame.locator('#card')).toHaveCSS('border-top-width', '3px');
    await expect(frame.locator('#logo')).toHaveJSProperty('complete', true);
    await expect(frame.locator('#unquoted-image')).toHaveJSProperty('complete', true);
    await expect(frame.locator('#poster')).toHaveAttribute(
      'poster',
      /\/asset\/[A-Za-z0-9_-]{32,}\?frame=1#poster$/,
    );
    await expect(frame.locator('#inline-quoted')).toHaveCSS(
      'background-image',
      /\/asset\/[A-Za-z0-9_-]{32,}\?mode=1#quoted/,
    );
    await expect(frame.locator('#inline-unquoted')).toHaveCSS(
      'background-image',
      /\/asset\/[A-Za-z0-9_-]{32,}\?mode=2#unquoted/,
    );
    await expect(frame.locator('#responsive')).toHaveAttribute(
      'srcset',
      /\/asset\/[A-Za-z0-9_-]{32,}\?size=3#single/,
    );
    await expect(frame.locator('source')).toHaveAttribute(
      'srcset',
      /\/asset\/[A-Za-z0-9_-]{32,}\?size=1#small 1x, http:\/\/127\.0\.0\.1:\d+\/[^/]+\/asset\/[A-Za-z0-9_-]{32,}\?size=2#large 2x/,
    );
    await expect
      .poll(() =>
        frame
          .locator('#comma-responsive')
          .evaluate((element: HTMLImageElement) => element.currentSrc),
      )
      .toMatch(/\/asset\/[A-Za-z0-9_-]{32,}$/);
    const commaCurrentSrc = await frame
      .locator('#comma-responsive')
      .evaluate((element: HTMLImageElement) => element.currentSrc);
    const commaCurrent = await page.request.get(commaCurrentSrc);
    expect(commaCurrent.ok()).toBe(true);
    expect(await commaCurrent.text()).toContain('id="comma,one"');
    await expect(frame.locator('#imported-style')).toHaveCSS('color', 'rgb(7, 8, 9)');
    await expect(frame.locator('#imported-style')).toHaveCSS('padding-left', '13px');
    await expect(frame.locator('#imported-style')).toHaveCSS(
      'background-image',
      /\/asset\/[A-Za-z0-9_-]{32,}\?paint=1#style/,
    );
    await expect(frame.locator('#inline-svg-card')).toHaveCSS('fill', 'rgb(31, 41, 59)');
    await expect(frame.locator('#inline-svg-card')).toHaveCSS(
      'background-image',
      /\/asset\/[A-Za-z0-9_-]{32,}\?inline-svg=1#paint/,
    );
    await frame.getByText('Reveal details').click();
    await expect(frame.getByText('Native interaction works.')).toBeVisible();
    await expect(frame.locator('#external-link')).not.toHaveAttribute('href', /.+/);
    await expect(frame.locator('#unquoted-link')).not.toHaveAttribute('href', /.+/);
    await expect(frame.locator('#svg-link')).not.toHaveAttribute('href', /.+/);
    await frame.locator('#external-link').click();
    await frame.locator('#unquoted-link').click();
    await frame.getByText('SVG link').click();
    await expect(frame.locator('meta[http-equiv="refresh"]')).toHaveCount(0);
    await expect(frame.locator('iframe')).toHaveCount(0);
    await expect(frame.locator('form')).toHaveCount(0);

    const fullSize = page.getByRole('link', { name: /Open full size/ });
    const fullSizeHref = await fullSize.getAttribute('href');
    expect(fullSizeHref).toMatch(`${new URL(session.url).origin}/`);
    const [popup] = await Promise.all([page.waitForEvent('popup'), fullSize.click()]);
    await expect(popup.getByRole('heading', { name: 'Captured review card' })).toBeVisible();
    await expect(popup.locator('html')).not.toHaveAttribute('data-classic', 'ready');
    expect(await popup.evaluate(() => document.compatMode)).toBe('CSS1Compat');
    await expect(popup.locator('#external-link')).not.toHaveAttribute('href', /.+/);
    await expect(popup.locator('#unquoted-link')).not.toHaveAttribute('href', /.+/);
    await expect(popup.locator('#svg-link')).not.toHaveAttribute('href', /.+/);
    await expect(popup.locator('#inline-svg-card')).toHaveCSS('fill', 'rgb(31, 41, 59)');
    await expect(popup.locator('#inline-svg-card')).toHaveCSS(
      'background-image',
      /\/asset\/[A-Za-z0-9_-]{32,}\?inline-svg=1#paint/,
    );
    await popup.locator('#external-link').click();
    await popup.locator('#unquoted-link').click();
    await popup.getByText('SVG link').click();

    await page.waitForTimeout(750);
    expect(beaconHits).toEqual([]);
    await expect(frame.getByRole('heading', { name: 'Captured review card' })).toBeVisible();
  } finally {
    await session?.close();
    await new Promise<void>((resolve) => beacon.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('keeps a strict review usable and completes Done when dependencies degraded after identity', async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), 'circuit-local-strict-review-browser-'));
  const runId = '33333333-3333-4333-8333-333333333333';
  const runFolder = join(scratch, '.circuit', 'runs', runId);
  const root = `.circuit/runs/${runId}/prototype-files/degraded`;
  const entryPoint = `${root}/index.html`;
  const artifactPath = join(scratch, entryPoint);
  const outsidePath = join(scratch, 'outside.png');
  mkdirSync(join(runFolder, 'reports'), { recursive: true });
  write(
    artifactPath,
    '<main><h1>Degraded review remains usable</h1><img id="missing" src="./missing.png"><img src="./escape.png"><img src="./late.png"></main>',
  );
  write(outsidePath, 'outside');

  let session: Awaited<ReturnType<typeof startLocalCheckpointReviewSession>> | undefined;
  try {
    const reviewAssets = snapshotCheckpointReviewAssetGroups({
      projectRoot: scratch,
      groups: [{ root, entryPoints: [entryPoint] }],
    })[0];
    if (reviewAssets === undefined) throw new Error('strict asset identity should be available');
    symlinkSync(outsidePath, join(dirname(artifactPath), 'escape.png'));
    write(join(dirname(artifactPath), 'late.png'), 'created after identity');

    const preview = previewForEntryPoints({
      entryPoints: ['prototype-files/degraded/index.html'],
      runFolder,
    });
    if (preview.status !== 'ready') throw new Error('strict preview should be ready');
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Prototype', runId, stepId: 'review-degraded' },
      question: 'Keep this degraded review?',
      ribbon: ['Waiting for you'],
      options: [{ id: 'keep', label: 'Keep it', isDefault: true, isRecommended: true }],
      defaultChoice: { id: 'keep', label: 'Keep it' },
      artifact: { title: 'Degraded preview', preview },
      resume: {
        runFolder,
        commandPrefix: 'circuit resume',
        attempt: 1,
        requestSha256: 'c'.repeat(64),
      },
    });
    const assets = captureLocalCheckpointReviewAssets({
      html,
      runFolder,
      projectRoot: scratch,
      reviewAssets: [reviewAssets],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]?.references).toEqual([]);

    session = await startLocalCheckpointReviewSession({
      html,
      identity: {
        runId,
        stepId: 'review-degraded',
        attempt: 1,
        requestSha256: 'c'.repeat(64),
      },
      allowedChoices: ['keep'],
      assets,
      onSubmit: async () => ({ status: 'accepted' }),
    });

    await page.goto(session.url);
    const frame = page.frameLocator('[data-artifact-preview-frame]');
    await expect(
      frame.getByRole('heading', { name: 'Degraded review remains usable' }),
    ).toBeVisible();
    await expect(frame.locator('#missing')).toHaveJSProperty('naturalWidth', 0);
    await page.getByRole('button', { name: 'Review decision' }).click();
    await page.locator('[data-cp-submit-decision]').click();
    const settlement = await session.settled;
    expect(settlement).toMatchObject({ status: 'accepted', response: { selection: 'keep' } });
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review saved. Circuit is continuing.',
    );
  } finally {
    await session?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('keeps standalone SVG navigation inert in both embedded and full-size review', async ({
  page,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), 'circuit-local-svg-review-browser-'));
  const runFolder = join(scratch, '.circuit', 'runs', '22222222-2222-4222-8222-222222222222');
  const artifactPath = join(runFolder, 'prototype-files', 'review.svg');
  mkdirSync(join(runFolder, 'reports'), { recursive: true });

  const beaconHits: string[] = [];
  const beacon = createServer((request, response) => {
    beaconHits.push(request.url ?? '/');
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    beacon.once('error', reject);
    beacon.listen(0, '127.0.0.1', () => resolve());
  });
  const address = beacon.address();
  if (address === null || typeof address === 'string') throw new Error('beacon did not bind');
  const beaconOrigin = `http://127.0.0.1:${address.port}`;
  let session: Awaited<ReturnType<typeof startLocalCheckpointReviewSession>> | undefined;

  try {
    write(
      artifactPath,
      `<?xml version="1.0"?><!DOCTYPE svg SYSTEM "${beaconOrigin}/evil.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:q="http://www.w3.org/1999/xlink" width="240" height="100"><style><![CDATA[@import "./review.css?mode=svg#sheet";#styled{background-image:url("./paint.svg#paint")}]]></style><defs><symbol id="dot"><circle cx="12" cy="12" r="10" fill="green"/></symbol></defs><use id="safe-use" href="#dot"/><image id="local-image" href="./tile.svg?mode=one#tile"/><image id="xlink-image" xlink:href="./tile-xlink.svg#tile"/><use id="external-use" href="./symbols.svg#dot"/><use id="xlink-use" xlink:href="./symbols-xlink.svg#dot"/><image id="missing-image" href="./missing.svg"/><use id="remote-use" xlink:href="${beaconOrigin}/remote-symbols.svg#dot"/><a id="svg-nav" q:href="${beaconOrigin}/svg-full"><rect id="styled" x="30" width="210" height="80"/><text x="45" y="45">Review SVG</text></a><script>fetch("${beaconOrigin}/svg-script")</script></svg>`,
    );
    write(join(dirname(artifactPath), 'review.css'), '#styled{fill:rgb(12,34,56)}');
    for (const name of ['paint', 'tile', 'tile-xlink', 'symbols', 'symbols-xlink']) {
      write(
        join(dirname(artifactPath), `${name}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="dot"><circle r="2"/></symbol><rect id="${name}" width="4" height="4"/></svg>`,
      );
    }
    const preview = previewForEntryPoints({
      entryPoints: ['prototype-files/review.svg'],
      runFolder,
    });
    if (preview.status !== 'ready') throw new Error('SVG preview should be ready');
    const html = renderCheckpointPage({
      meta: {
        flowLabel: 'Prototype',
        runId: '22222222-2222-4222-8222-222222222222',
        stepId: 'review-svg',
      },
      question: 'Keep this SVG?',
      ribbon: ['Waiting for you'],
      options: [{ id: 'keep', label: 'Keep it', isDefault: true, isRecommended: true }],
      defaultChoice: { id: 'keep', label: 'Keep it' },
      artifact: { title: 'SVG preview', preview },
      resume: {
        runFolder,
        commandPrefix: 'circuit resume',
        attempt: 1,
        requestSha256: 'b'.repeat(64),
      },
    });
    const assets = captureBoundReviewAssets({
      html,
      runFolder,
      projectRoot: scratch,
      groups: [
        {
          root: '.circuit/runs/22222222-2222-4222-8222-222222222222/prototype-files',
          entryPoints: [
            '.circuit/runs/22222222-2222-4222-8222-222222222222/prototype-files/review.svg',
          ],
        },
      ],
    });
    expect(assets.map((asset) => asset.contentType)).toEqual([
      'image/svg+xml',
      'text/css',
      'image/svg+xml',
      'image/svg+xml',
      'image/svg+xml',
      'image/svg+xml',
      'image/svg+xml',
    ]);
    session = await startLocalCheckpointReviewSession({
      html,
      identity: {
        runId: '22222222-2222-4222-8222-222222222222',
        stepId: 'review-svg',
        attempt: 1,
        requestSha256: 'b'.repeat(64),
      },
      allowedChoices: ['keep'],
      assets,
      onSubmit: async () => ({ status: 'accepted' }),
    });

    await page.goto(session.url);
    const frame = page.frameLocator('[data-artifact-preview-frame]');
    await expect(frame.getByText('Review SVG')).toBeVisible();
    await expect(frame.locator('#svg-nav')).not.toHaveAttribute('href', /.+/);
    await expect(frame.locator('#svg-nav')).not.toHaveAttribute('q:href', /.+/);
    await expect(frame.locator('#safe-use')).toHaveAttribute('href', '#dot');
    await expect(frame.locator('#local-image')).toHaveAttribute(
      'href',
      /\/asset\/[A-Za-z0-9_-]{32,}\?mode=one#tile$/,
    );
    await expect(frame.locator('#xlink-image')).toHaveAttribute(
      'xlink:href',
      /\/asset\/[A-Za-z0-9_-]{32,}#tile$/,
    );
    await expect(frame.locator('#external-use')).toHaveAttribute(
      'href',
      /\/asset\/[A-Za-z0-9_-]{32,}#dot$/,
    );
    await expect(frame.locator('#xlink-use')).toHaveAttribute(
      'xlink:href',
      /\/asset\/[A-Za-z0-9_-]{32,}#dot$/,
    );
    await expect(frame.locator('#missing-image')).not.toHaveAttribute('href', /.+/);
    await expect(frame.locator('#remote-use')).not.toHaveAttribute('xlink:href', /.+/);
    await expect(frame.locator('#styled')).toHaveCSS('fill', 'rgb(12, 34, 56)');
    await expect(frame.locator('style')).toContainText('background-image');
    await expect(frame.locator('script')).toHaveCount(0);
    await frame.getByText('Review SVG').click();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: /Open full size/ }).click(),
    ]);
    await expect(popup.getByText('Review SVG')).toBeVisible();
    await expect(popup.locator('#svg-nav')).not.toHaveAttribute('href', /.+/);
    await expect(popup.locator('#svg-nav')).not.toHaveAttribute('q:href', /.+/);
    await expect(popup.locator('#safe-use')).toHaveAttribute('href', '#dot');
    await expect(popup.locator('#local-image')).toHaveAttribute(
      'href',
      /\/asset\/[A-Za-z0-9_-]{32,}\?mode=one#tile$/,
    );
    await expect(popup.locator('#xlink-image')).toHaveAttribute(
      'xlink:href',
      /\/asset\/[A-Za-z0-9_-]{32,}#tile$/,
    );
    await expect(popup.locator('#external-use')).toHaveAttribute(
      'href',
      /\/asset\/[A-Za-z0-9_-]{32,}#dot$/,
    );
    await expect(popup.locator('#xlink-use')).toHaveAttribute(
      'xlink:href',
      /\/asset\/[A-Za-z0-9_-]{32,}#dot$/,
    );
    await expect(popup.locator('#missing-image')).not.toHaveAttribute('href', /.+/);
    await expect(popup.locator('#remote-use')).not.toHaveAttribute('xlink:href', /.+/);
    await expect(popup.locator('#styled')).toHaveCSS('fill', 'rgb(12, 34, 56)');
    await expect(popup.locator('style')).toContainText('background-image');
    await expect(popup.locator('script')).toHaveCount(0);
    await popup.getByText('Review SVG').click();
    await page.waitForTimeout(300);
    expect(beaconHits).toEqual([]);
  } finally {
    await session?.close();
    await new Promise<void>((resolve) => beacon.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});

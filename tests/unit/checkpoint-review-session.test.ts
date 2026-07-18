import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKPOINT_REVIEW_SESSION_HEADER,
  LOCAL_CHECKPOINT_REVIEW_REPLAY_WINDOW_MS,
  type LocalCheckpointReviewSession,
  startLocalCheckpointReviewSession,
} from '../../src/app/checkpoints/local-review-session.js';
import { MAX_CHECKPOINT_REVIEW_JSON_BYTES } from '../../src/schemas/checkpoint-review-response.js';

const IDENTITY = {
  runId: '11111111-1111-4111-8111-111111111111',
  stepId: 'choose-direction',
  attempt: 1,
  requestSha256: 'a'.repeat(64),
} as const;

const PAYLOAD = {
  schema: 'checkpoint.review-response@v1',
  run_id: IDENTITY.runId,
  step_id: IDENTITY.stepId,
  attempt: IDENTITY.attempt,
  request_sha256: IDENTITY.requestSha256,
  selection: 'second',
  comments: [
    { scope: 'choice', choice_id: 'second', body: 'Ship this one.' },
    { scope: 'overall', body: 'Keep the quieter transition.' },
  ],
} as const;

const ALLOWED_CHOICES = ['first', 'second'] as const;
const ACCEPTED = { status: 'accepted' } as const;
const LOCAL_ASSET_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/asset\/[A-Za-z0-9_-]+/g;

function capturedAssetUrls(html: string): readonly string[] {
  return Array.from(html.matchAll(LOCAL_ASSET_URL_PATTERN), (match) => match[0]);
}

type RawResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly bytes: Buffer;
};

function rawRequest(
  target: string,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<RawResponse> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: options.path ?? `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: bytes.toString('utf8'),
            bytes,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function createReviewFixture(): {
  readonly scratch: string;
  readonly summaryPath: string;
  readonly summaryHtml: string;
} {
  const scratch = mkdtempSync(join(tmpdir(), 'circuit-review-session-'));
  const summaryPath = join(scratch, 'run', 'reports', 'operator-summary.html');
  const summaryHtml =
    '<!doctype html><html><head><title>Review</title></head><body><main>Human review</main><script>window.pageReady=true</script></body></html>';
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, summaryHtml, 'utf8');
  writeFileSync(
    join(scratch, 'run', 'reports', 'preview.html'),
    '<!doctype html><button>Preview works</button>',
    'utf8',
  );
  return { scratch, summaryPath, summaryHtml };
}

function expectedOrigin(session: LocalCheckpointReviewSession): string {
  return new URL(session.url).origin;
}

function submissionHeaders(session: LocalCheckpointReviewSession): Record<string, string> {
  const origin = expectedOrigin(session);
  return {
    host: new URL(origin).host,
    origin,
    'content-type': 'application/json',
    [CHECKPOINT_REVIEW_SESSION_HEADER]: session.authorization,
  };
}

async function start(
  fixture = createReviewFixture(),
  onSubmit: Parameters<typeof startLocalCheckpointReviewSession>[0]['onSubmit'] = vi.fn(
    async () => ACCEPTED,
  ),
) {
  const session = await startLocalCheckpointReviewSession({
    html: fixture.summaryHtml,
    identity: IDENTITY,
    allowedChoices: ALLOWED_CHOICES,
    onSubmit,
  });
  sessions.push(session);
  return { fixture, session, onSubmit };
}

function parseBootstrap(html: string): unknown {
  const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
  if (match?.[1] === undefined) throw new Error('review session bootstrap was not found');
  return JSON.parse(match[1]) as unknown;
}

async function submit(
  session: LocalCheckpointReviewSession,
  payload: unknown = PAYLOAD,
): Promise<RawResponse> {
  const body = JSON.stringify(payload);
  return rawRequest(session.endpoint, {
    method: 'POST',
    headers: {
      ...submissionHeaders(session),
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
}

const sessions: LocalCheckpointReviewSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.close()));
});

describe('startLocalCheckpointReviewSession', () => {
  it('serves one loopback page with separate URL and header capabilities', async () => {
    const first = await start();
    const second = await start();
    const firstUrl = new URL(first.session.url);
    const secondUrl = new URL(second.session.url);

    expect(firstUrl.protocol).toBe('http:');
    expect(firstUrl.hostname).toBe('127.0.0.1');
    expect(Number(firstUrl.port)).toBeGreaterThan(0);
    expect(firstUrl.pathname).not.toBe(secondUrl.pathname);
    expect(firstUrl.pathname).toMatch(/^\/[A-Za-z0-9_-]{32,}\/review$/);
    expect(new URL(first.session.endpoint).origin).toBe(firstUrl.origin);
    expect(new URL(first.session.endpoint).pathname).not.toBe(firstUrl.pathname);
    expect(first.session.url).not.toContain(first.session.authorization);
    expect(first.session.endpoint).not.toContain(first.session.authorization);
    expect(first.session.authorization).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(first.session.authorization).not.toBe(second.session.authorization);
  });

  it('injects the exact in-memory bootstrap without changing the saved HTML', async () => {
    const fixture = createReviewFixture();
    const before = readFileSync(fixture.summaryPath, 'utf8');
    const { session } = await start(fixture);

    const response = await fetch(session.url);
    const servedHtml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline'");
    expect(response.headers.get('content-security-policy')).toContain(
      `connect-src ${new URL(session.url).origin}`,
    );
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(parseBootstrap(servedHtml)).toEqual({
      endpoint: session.endpoint,
      authorization: session.authorization,
      identity: IDENTITY,
    });
    expect(servedHtml.indexOf('window.__CIRCUIT_REVIEW_SESSION__')).toBeLessThan(
      servedHtml.indexOf('window.pageReady'),
    );
    expect(servedHtml).toContain('Human review');
    expect(readFileSync(fixture.summaryPath, 'utf8')).toBe(before);
    expect(before).toBe(fixture.summaryHtml);
    expect(before).not.toContain(session.authorization);
    expect(before).not.toContain(new URL(session.url).pathname);
  });

  it('serves only captured preview bytes and rewrites exact generated URL attributes', async () => {
    const sourceUrl = '../prototype-files/variants/a/review-card.png';
    const sourceBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const html = [
      '<!doctype html><html><head><title>Review</title></head><body>',
      `<a href="${sourceUrl}">Open artifact</a>`,
      `<iframe data-artifact-preview-src="${sourceUrl}" data-mv-preview-src="${sourceUrl}"></iframe>`,
      `<p>${sourceUrl}</p>`,
      `<div data-copy="${sourceUrl}" data-nearby="${sourceUrl}?other"></div>`,
      '</body></html>',
    ].join('');
    const session = await startLocalCheckpointReviewSession({
      html,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets: [
        {
          id: 'asset-0',
          pageReferences: [{ sourceUrl }],
          references: [],
          contentType: 'image/png',
          bytes: sourceBytes,
        },
      ],
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);
    sourceBytes[0] = 0;

    const page = await rawRequest(session.url);
    const assetUrl = capturedAssetUrls(page.body)[0];
    if (assetUrl === undefined) throw new Error('captured preview URL was not rewritten');
    const asset = await rawRequest(assetUrl);
    const head = await rawRequest(assetUrl, { method: 'HEAD' });
    const wrongMethod = await rawRequest(assetUrl, { method: 'POST' });

    expect(page.status).toBe(200);
    expect(
      page.body.match(new RegExp(assetUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')),
    ).toHaveLength(3);
    expect(page.body).toContain(`<p>${sourceUrl}</p>`);
    expect(page.body).toContain(`data-copy="${sourceUrl}"`);
    expect(page.body).toContain(`data-nearby="${sourceUrl}?other"`);
    expect(asset.status).toBe(200);
    expect(asset.bytes).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    expect(asset.headers['content-type']).toBe('image/png');
    expect(asset.headers['content-length']).toBe('6');
    expect(asset.headers['cache-control']).toContain('no-store');
    // The iframe has an opaque sandbox origin, so CORP same-origin would also
    // block its own captured CSS, scripts, and images. Capability routes and
    // CSP provide the boundary instead.
    expect(asset.headers['cross-origin-resource-policy']).toBeUndefined();
    expect(asset.headers['referrer-policy']).toBe('no-referrer');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect(asset.headers['x-dns-prefetch-control']).toBe('off');
    expect(asset.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(asset.headers['content-security-policy']).toContain("default-src 'none'");
    expect(asset.headers['content-security-policy']).toContain("script-src 'none'");
    expect(asset.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(asset.headers['content-security-policy']).toContain("form-action 'none'");
    expect(asset.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(asset.headers['content-security-policy']).not.toContain("frame-ancestors 'none'");
    expect(asset.headers['access-control-allow-origin']).toBeUndefined();
    expect(head.status).toBe(200);
    expect(head.bytes).toHaveLength(0);
    expect(head.headers['content-length']).toBe('6');
    expect(wrongMethod.status).toBe(405);
  });

  it('serves a closed multi-file HTML graph and rewrites only recorded dependencies', async () => {
    const sourceUrl = '../prototype-files/variants/a/index.html';
    const proof = 'c'.repeat(64);
    const html = [
      '<!doctype html><html><body>',
      `<a href="${sourceUrl}">Open full size</a>`,
      `<iframe data-artifact-preview-src="${sourceUrl}" data-mv-preview-src="${sourceUrl}" data-artifact-preview-embedded="unsafe-snapshot" data-artifact-preview-proof="${proof}"></iframe>`,
      '</body></html>',
    ].join('');
    const session = await startLocalCheckpointReviewSession({
      html,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets: [
        {
          id: 'entry',
          pageReferences: [{ sourceUrl, previewProof: proof }],
          contentType: 'text/html',
          bytes: Buffer.from(
            '<!doctype html><link rel="stylesheet" href="./card.css"><script src="./card.js"></script><img src="./card.png"><p>./not-a-reference.txt</p>',
          ),
          references: [
            { kind: 'html-attribute', sourceValue: './card.css', targetId: 'css' },
            { kind: 'html-attribute', sourceValue: './card.png', targetId: 'image' },
          ],
        },
        {
          id: 'css',
          pageReferences: [],
          contentType: 'text/css',
          bytes: Buffer.from('.card{background-image:url("./background.png")}'),
          references: [
            { kind: 'css-url', sourceValue: './background.png', targetId: 'background' },
          ],
        },
        {
          id: 'image',
          pageReferences: [],
          contentType: 'image/png',
          bytes: Uint8Array.from([1, 2, 3]),
          references: [],
        },
        {
          id: 'background',
          pageReferences: [],
          contentType: 'image/png',
          bytes: Uint8Array.from([4, 5, 6]),
          references: [],
        },
      ],
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const entryUrl = capturedAssetUrls(page.body)[0];
    if (entryUrl === undefined) throw new Error('HTML entry URL was not rewritten');
    const entry = await rawRequest(entryUrl);
    const assetUrls = capturedAssetUrls(entry.body);
    const cssUrl = assetUrls[0];
    if (cssUrl === undefined) throw new Error('CSS URL was not rewritten');
    const css = await rawRequest(cssUrl);

    expect(page.body).not.toContain('data-artifact-preview-embedded');
    expect(page.body).toContain(`data-artifact-preview-proof="${proof}"`);
    expect(entry.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(entry.body).not.toContain('<script');
    expect(entry.body).not.toContain('card.js');
    expect(assetUrls).toHaveLength(2);
    expect(entry.body).toContain('<p>./not-a-reference.txt</p>');
    expect(css.body).toMatch(
      /url\("http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/asset\/[A-Za-z0-9_-]+"\)/,
    );
    expect(entry.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(entry.headers['content-security-policy']).toContain("form-action 'none'");
    expect(entry.headers['content-security-policy']).toContain("frame-src 'none'");
    expect(entry.headers['content-security-policy']).toContain("script-src 'none'");
    expect(entry.headers['content-security-policy']).toContain('sandbox');
    expect(entry.headers['content-security-policy']).not.toContain('sandbox allow-');
  });

  it('rewrites apostrophe URLs, removes embedded snapshots, and activates both quote styles', async () => {
    const literalSourceUrl =
      "../prototype-files/Pete's-card/index.html?mode=owner's#reviewer's-details";
    const encodedSourceUrl =
      '../prototype-files/Pete&#39;s-card/index.html?mode=owner&#39;s#reviewer&#39;s-details';
    const html = [
      `<a id="literal-link" href="/old/Pete's-card" data-artifact-full-size-src="${literalSourceUrl}">Open literal</a>`,
      `<a id='encoded-link' href='/old/card' data-artifact-full-size-src='${encodedSourceUrl}'>Open encoded</a>`,
      `<iframe id="literal-frame" data-artifact-preview-src="${literalSourceUrl}" data-artifact-preview-embedded='literal-snapshot'></iframe>`,
      `<iframe id='encoded-frame' data-artifact-preview-src='${encodedSourceUrl}' data-artifact-preview-embedded="encoded-snapshot"></iframe>`,
    ].join('');
    const session = await startLocalCheckpointReviewSession({
      html,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets: [
        {
          id: 'entry',
          pageReferences: [{ sourceUrl: literalSourceUrl }, { sourceUrl: encodedSourceUrl }],
          contentType: 'text/html',
          bytes: Buffer.from('<main>Review card</main>'),
          references: [],
        },
      ],
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const routes = Array.from(
      page.body.matchAll(
        /href="(http:\/\/127\.0\.0\.1:\d+\/[^"?#]+\?mode=owner%27s#reviewer's-details)"/g,
      ),
      (match) => match[1],
    );

    expect(page.status).toBe(200);
    expect(page.body).not.toContain('data-artifact-preview-embedded');
    expect(page.body).not.toContain('/old/Pete');
    expect(page.body).not.toContain('/old/card');
    expect(routes).toHaveLength(2);
    expect(new Set(routes).size).toBe(1);
    expect(page.body).toContain("?mode=owner%27s#reviewer's-details");
    const loaded = await rawRequest(routes[0] ?? '');
    expect(loaded.status).toBe(200);
    expect(loaded.body).toContain('<main>Review card</main>');
  });

  it('does not let an unresolved relative URL alias another captured asset route', async () => {
    const sourceUrl = '../prototype-files/card/index.html';
    const session = await startLocalCheckpointReviewSession({
      html: `<iframe data-artifact-preview-src="${sourceUrl}"></iframe>`,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets: [
        {
          id: 'entry',
          pageReferences: [{ sourceUrl }],
          contentType: 'text/html',
          bytes: Buffer.from('<img id="uncaptured" src="1"><img id="captured" src="./known.png">'),
          references: [{ kind: 'html-attribute', sourceValue: './known.png', targetId: 'image' }],
        },
        {
          id: 'image',
          pageReferences: [],
          contentType: 'image/png',
          bytes: Uint8Array.from([1, 2, 3]),
          references: [],
        },
      ],
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const entryUrl = page.body.match(
      /data-artifact-preview-src="(http:\/\/127\.0\.0\.1:\d+\/[^"?#]+)"/,
    )?.[1];
    if (entryUrl === undefined) throw new Error('entry route was not rewritten');
    const entry = await rawRequest(entryUrl);
    const capturedUrl = entry.body.match(
      /id="captured" src="(http:\/\/127\.0\.0\.1:\d+\/[^"]+)"/,
    )?.[1];
    if (capturedUrl === undefined) throw new Error('captured dependency route was not rewritten');
    const unresolvedAlias = new URL('1', entryUrl).href;

    expect(await rawRequest(capturedUrl)).toMatchObject({
      status: 200,
      bytes: Buffer.from([1, 2, 3]),
    });
    expect(await rawRequest(unresolvedAlias)).toMatchObject({ status: 404 });
    expect(unresolvedAlias).not.toBe(capturedUrl);
    expect(new URL(entryUrl).pathname.split('/').at(-1)).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(new URL(capturedUrl).pathname.split('/').at(-1)).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(new URL(entryUrl).pathname).not.toBe(new URL(capturedUrl).pathname);
  });

  it('rewrites captured CSS imports and responsive image candidates onto opaque routes', async () => {
    const sourceUrl = '../prototype-files/card/index.html';
    const session = await startLocalCheckpointReviewSession({
      html: `<a data-artifact-full-size-src="${sourceUrl}">Open full size</a><iframe data-artifact-preview-src="${sourceUrl}"></iframe>`,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets: [
        {
          id: 'entry',
          pageReferences: [{ sourceUrl }],
          contentType: 'text/html',
          bytes: Buffer.from(
            '<link rel="stylesheet" href="./base.css"><img srcset="./small.png 1x, ./large.png 2x">',
          ),
          references: [
            { kind: 'html-attribute', sourceValue: './base.css', targetId: 'base' },
            { kind: 'html-srcset', sourceValue: './small.png', targetId: 'small' },
            { kind: 'html-srcset', sourceValue: './large.png', targetId: 'large' },
          ],
        },
        {
          id: 'base',
          pageReferences: [],
          contentType: 'text/css',
          bytes: Buffer.from('@import "./theme.css"; body{margin:0}'),
          references: [{ kind: 'css-url', sourceValue: './theme.css', targetId: 'theme' }],
        },
        {
          id: 'small',
          pageReferences: [],
          contentType: 'image/png',
          bytes: Uint8Array.from([1]),
          references: [],
        },
        {
          id: 'large',
          pageReferences: [],
          contentType: 'image/png',
          bytes: Uint8Array.from([2]),
          references: [],
        },
        {
          id: 'theme',
          pageReferences: [],
          contentType: 'text/css',
          bytes: Buffer.from('body{color:green}'),
          references: [],
        },
      ],
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const entryUrl = capturedAssetUrls(page.body)[0];
    if (entryUrl === undefined) throw new Error('entry route was not activated');
    const entry = await rawRequest(entryUrl);
    const baseUrl = capturedAssetUrls(entry.body)[0];
    if (baseUrl === undefined) throw new Error('base stylesheet route was not rewritten');
    const base = await rawRequest(baseUrl);

    expect(entry.body).toMatch(
      /srcset="http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/asset\/[A-Za-z0-9_-]+ 1x, http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/asset\/[A-Za-z0-9_-]+ 2x"/,
    );
    expect(base.body).toMatch(
      /@import "http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/asset\/[A-Za-z0-9_-]+"/,
    );
    expect(entry.body).not.toContain('./small.png');
    expect(base.body).not.toContain('./theme.css');
  });

  it('rewrites quoted and unquoted HTML or CSS references while preserving query and fragment suffixes', async () => {
    const sourceUrl =
      '../prototype-files/reference-forms/index.html?view=review&mode=full#reference-forms';
    const entrySource = [
      '<link rel=stylesheet href=./base.css?theme=dark#sheet>',
      '<img id=quoted src="./quoted.svg?cache=1#quoted">',
      '<img id=unquoted src=./unquoted.svg#unquoted>',
      '<video id=poster poster=./poster.svg?frame=1#poster></video>',
      '<div id=inline-quoted style="background:url(\'./inline-quoted.svg?mode=1#quoted-style\')"></div>',
      '<div id=inline-unquoted style=background:url(./inline-unquoted.svg?mode=2#unquoted-style)></div>',
      '<img id=set srcset="./small.svg?size=1#small 1x, ./large.svg?size=2#large 2x">',
      '<img id=single-set srcset=./single.svg?size=3#single>',
      '<style>',
      '@import "./inline.css?layer=1#inline";',
      "@import url('./url-import.css?layer=2#url-import') screen;",
      '.hero{background:url(./style.svg?paint=1#style)}',
      '</style>',
    ].join('');
    const sources = [
      './base.css?theme=dark#sheet',
      './quoted.svg?cache=1#quoted',
      './unquoted.svg#unquoted',
      './poster.svg?frame=1#poster',
      './inline-quoted.svg?mode=1#quoted-style',
      './inline-unquoted.svg?mode=2#unquoted-style',
      './small.svg?size=1#small',
      './large.svg?size=2#large',
      './single.svg?size=3#single',
      './inline.css?layer=1#inline',
      './url-import.css?layer=2#url-import',
      './style.svg?paint=1#style',
    ] as const;
    const kinds = [
      'html-attribute',
      'html-attribute',
      'html-attribute',
      'html-attribute',
      'css-url',
      'css-url',
      'html-srcset',
      'html-srcset',
      'html-srcset',
      'css-url',
      'css-url',
      'css-url',
    ] as const;
    const assets = [
      {
        id: 'entry',
        pageReferences: [{ sourceUrl }],
        contentType: 'text/html',
        bytes: Buffer.from(entrySource),
        references: sources.map((sourceValue, index) => ({
          kind: kinds[index] ?? 'css-url',
          sourceValue,
          targetId: `dependency-${index}`,
        })),
      },
      ...sources.map((_source, index) => ({
        id: `dependency-${index}`,
        pageReferences: [],
        contentType: index === 0 || index === 9 || index === 10 ? 'text/css' : 'image/svg+xml',
        bytes:
          index === 0 || index === 9 || index === 10
            ? Buffer.from(`.dependency-${index}{color:green}`)
            : Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg"><rect id="${index}" width="4" height="4"/></svg>`,
              ),
        references: [],
      })),
    ];
    const session = await startLocalCheckpointReviewSession({
      html: `<a data-artifact-full-size-src="${sourceUrl}">Open full size</a><iframe data-artifact-preview-src="${sourceUrl}"></iframe>`,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets,
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const entryUrl = capturedAssetUrls(page.body)[0];
    if (entryUrl === undefined) throw new Error('entry route was not activated');
    expect(page.body).toContain(`${entryUrl}?view=review&amp;mode=full#reference-forms`);
    const entry = await rawRequest(entryUrl);

    const dependencyRoutes = capturedAssetUrls(entry.body);
    expect(dependencyRoutes).toHaveLength(sources.length);
    for (const [index, source] of sources.entries()) {
      const parsed = new URL(source, 'file:///prototype/index.html');
      const route = dependencyRoutes[index];
      if (route === undefined) throw new Error(`dependency route ${index} was not rewritten`);
      const expected = `${route}${parsed.search}${parsed.hash}`;
      expect(entry.body, source).toContain(expected.replaceAll('&', '&amp;'));
      const loaded = await rawRequest(expected);
      expect(loaded.status, source).toBe(200);
    }
    expect(entry.body).not.toContain('./base.css');
    expect(entry.body).not.toContain('./inline-unquoted.svg');
    expect(entry.body).not.toContain('./inline.css');
  });

  it('serves sanitized inline SVG image or use dependencies from an HTML artifact', async () => {
    const sourceUrl = '../prototype-files/inline-svg/index.html';
    const entrySource = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<image id="image" href="./tile.svg?mode=one#tile"/>',
      '<image id="xlink-image" xlink:href="./tile-xlink.svg#tile"/>',
      '<use id="use" href="./symbols.svg#dot"/>',
      '<use id="xlink-use" xlink:href="./symbols-xlink.svg#dot"/>',
      '<use id="local" href="#local-dot"/>',
      '<image id="external-image" href="https://attacker.example/tile.svg"/>',
      '<use id="external-use" xlink:href="https://attacker.example/symbols.svg#dot"/>',
      '</svg>',
    ].join('');
    const sources = [
      './tile.svg?mode=one#tile',
      './tile-xlink.svg#tile',
      './symbols.svg#dot',
      './symbols-xlink.svg#dot',
    ] as const;
    const session = await startLocalCheckpointReviewSession({
      html: `<iframe data-artifact-preview-src="${sourceUrl}"></iframe>`,
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      assets: [
        {
          id: 'entry',
          pageReferences: [{ sourceUrl }],
          contentType: 'text/html',
          bytes: Buffer.from(entrySource),
          references: sources.map((sourceValue, index) => ({
            kind: 'html-attribute' as const,
            sourceValue,
            targetId: `dependency-${index}`,
          })),
        },
        ...sources.map((_source, index) => ({
          id: `dependency-${index}`,
          pageReferences: [],
          contentType: 'image/svg+xml',
          bytes: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg"><rect id="dependency-${index}"/></svg>`,
          ),
          references: [],
        })),
      ],
      onSubmit: vi.fn(async () => ACCEPTED),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const entryUrl = capturedAssetUrls(page.body)[0];
    if (entryUrl === undefined) throw new Error('entry route was not activated');
    const entry = await rawRequest(entryUrl);

    expect(entry.status).toBe(200);
    expect(entry.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(capturedAssetUrls(entry.body)).toHaveLength(4);
    for (const source of sources) {
      expect(entry.body).not.toContain(source);
    }
    expect(entry.body).toMatch(/<image id="image" href="http:\/\/127\.0\.0\.1:\d+\//);
    expect(entry.body).toMatch(/<image id="xlink-image" xlink:href="http:\/\/127\.0\.0\.1:\d+\//);
    expect(entry.body).toMatch(/<use id="use" href="http:\/\/127\.0\.0\.1:\d+\//);
    expect(entry.body).toMatch(/<use id="xlink-use" xlink:href="http:\/\/127\.0\.0\.1:\d+\//);
    expect(entry.body).toContain('<use id="local" href="#local-dot"/>');
    expect(entry.body).toContain('<image id="external-image"/>');
    expect(entry.body).toContain('<use id="external-use"/>');
    expect(entry.body).not.toContain('attacker.example');
  });

  it('rejects untrusted, duplicate, unreferenced, and excess preview assets before listening', async () => {
    const base = {
      html: '<!doctype html><a href="../preview.png">Preview</a>',
      identity: IDENTITY,
      allowedChoices: ALLOWED_CHOICES,
      onSubmit: vi.fn(async () => ACCEPTED),
    } as const;
    const asset = {
      id: 'asset',
      pageReferences: [{ sourceUrl: '../preview.png' }],
      references: [],
      contentType: 'image/png',
      bytes: new Uint8Array(),
    } as const;
    const tooMany = Array.from({ length: 33 }, (_, index) => ({
      id: `asset-${index}`,
      pageReferences: [{ sourceUrl: `../preview-${index}.png` }],
      references: [],
      contentType: 'image/png',
      bytes: new Uint8Array(),
    }));

    await expect(
      startLocalCheckpointReviewSession({
        ...base,
        assets: [
          {
            ...asset,
            pageReferences: [{ sourceUrl: 'https://attacker.example/preview.png' }],
          },
        ],
      }),
    ).rejects.toThrow('preview asset is invalid');
    await expect(
      startLocalCheckpointReviewSession({
        ...base,
        assets: [{ ...asset, contentType: 'text/plain' }],
      }),
    ).rejects.toThrow('preview asset is invalid');
    await expect(
      startLocalCheckpointReviewSession({ ...base, assets: [asset, asset] }),
    ).rejects.toThrow('preview asset is invalid');
    await expect(
      startLocalCheckpointReviewSession({
        ...base,
        assets: [
          {
            ...asset,
            pageReferences: [{ sourceUrl: '../not-in-the-page.png' }],
          },
        ],
      }),
    ).rejects.toThrow('not referenced by the HTML');
    await expect(startLocalCheckpointReviewSession({ ...base, assets: tooMany })).rejects.toThrow(
      'too many preview assets',
    );
  });

  it('does not expose arbitrary files, traversal paths, or escaping symlinks', async () => {
    const fixture = createReviewFixture();
    const outsidePath = join(fixture.scratch, 'outside-secret.txt');
    writeFileSync(outsidePath, 'do not serve this', 'utf8');
    symlinkSync(outsidePath, join(fixture.scratch, 'run', 'reports', 'escape.txt'));
    const { session } = await start(fixture);
    const pagePath = new URL(session.url).pathname;
    const prefix = pagePath.slice(0, pagePath.lastIndexOf('/'));

    const preview = await rawRequest(session.url, { path: `${prefix}/preview.html` });
    const traversal = await rawRequest(session.url, {
      path: `${prefix}/%2e%2e/%2e%2e/outside-secret.txt`,
    });
    const escapedSymlink = await rawRequest(session.url, { path: `${prefix}/escape.txt` });

    expect(preview.status).toBe(404);
    expect(preview.body).not.toContain('Preview works');
    expect(traversal.status).toBe(404);
    expect(traversal.body).not.toContain('do not serve this');
    expect(escapedSymlink.status).toBe(404);
    expect(escapedSymlink.body).not.toContain('do not serve this');
  });

  it('requires the exact Host, Origin, and independent header capability', async () => {
    const { session, onSubmit } = await start();
    const body = JSON.stringify(PAYLOAD);
    const headers = {
      ...submissionHeaders(session),
      'content-length': String(Buffer.byteLength(body)),
    };
    const attempts = await Promise.all([
      rawRequest(session.endpoint, {
        method: 'POST',
        headers: { ...headers, host: 'attacker.example' },
        body,
      }),
      rawRequest(session.endpoint, {
        method: 'POST',
        headers: { ...headers, origin: 'https://attacker.example' },
        body,
      }),
      rawRequest(session.endpoint, {
        method: 'POST',
        headers: Object.fromEntries(
          Object.entries(headers).filter(([name]) => name !== CHECKPOINT_REVIEW_SESSION_HEADER),
        ),
        body,
      }),
      rawRequest(session.endpoint, {
        method: 'POST',
        headers: { ...headers, [CHECKPOINT_REVIEW_SESSION_HEADER]: 'wrong-capability' },
        body,
      }),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 403, 403, 403]);
    for (const attempt of attempts) {
      expect(attempt.headers['access-control-allow-origin']).toBeUndefined();
      expect(attempt.body).not.toContain(session.authorization);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods, media types, and raw bodies above the limit', async () => {
    const { session, onSubmit } = await start();
    const body = JSON.stringify(PAYLOAD);
    const getSubmit = await rawRequest(session.endpoint);
    const postPage = await rawRequest(session.url, {
      method: 'POST',
      headers: submissionHeaders(session),
      body,
    });
    const wrongType = await rawRequest(session.endpoint, {
      method: 'POST',
      headers: {
        ...submissionHeaders(session),
        'content-type': 'text/plain',
      },
      body,
    });
    const oversizedBody = `${body}${' '.repeat(MAX_CHECKPOINT_REVIEW_JSON_BYTES + 1)}`;
    const oversized = await rawRequest(session.endpoint, {
      method: 'POST',
      headers: {
        ...submissionHeaders(session),
        'content-length': String(Buffer.byteLength(oversizedBody)),
      },
      body: oversizedBody,
    });

    expect(getSubmit.status).toBe(405);
    expect(postPage.status).toBe(405);
    expect(wrongType.status).toBe(415);
    expect(oversized.status).toBe(413);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects malformed, stale, and unavailable responses before the callback', async () => {
    const { session, onSubmit } = await start();
    const secretComment = 'PRIVATE REVIEW TEXT MUST NOT BE REFLECTED';
    const malformed = await rawRequest(session.endpoint, {
      method: 'POST',
      headers: submissionHeaders(session),
      body: '{ not json',
    });
    const invalid = await submit(session, {
      ...PAYLOAD,
      attempt: 0,
      comments: [{ scope: 'overall', body: secretComment }],
      unexpected: secretComment,
    });
    const stale = await submit(session, { ...PAYLOAD, request_sha256: 'b'.repeat(64) });
    const unavailableSelection = await submit(session, { ...PAYLOAD, selection: 'missing' });
    const unavailableComment = await submit(session, {
      ...PAYLOAD,
      comments: [{ scope: 'choice', choice_id: 'missing', body: secretComment }],
    });

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toContain('Invalid checkpoint review');
    expect(invalid.body).not.toContain(secretComment);
    expect(stale.status).toBe(409);
    expect(stale.body).toContain('stale');
    expect(unavailableSelection.status).toBe(409);
    expect(unavailableComment.status).toBe(409);
    expect(unavailableComment.body).not.toContain(secretComment);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sanitizes a typed rejection and permits a corrected retry', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'rejected',
        terminal: false,
        code: 'NOT A PUBLIC CODE',
        publicMessage: '  Reload\u0000 this checkpoint.  ',
      })
      .mockResolvedValueOnce(ACCEPTED);
    const { session } = await start(createReviewFixture(), onSubmit);

    const rejected = await submit(session);
    const unsettled = await Promise.race([
      session.settled.then(() => false),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 20)),
    ]);
    const accepted = await submit(session);

    expect(rejected.status).toBe(409);
    expect(JSON.parse(rejected.body)).toEqual({
      ok: false,
      code: 'review_rejected',
      message: 'Reload this checkpoint.',
      terminal: false,
    });
    expect(unsettled).toBe(true);
    expect(accepted.status).toBe(200);
    await expect(session.settled).resolves.toEqual({ status: 'accepted', response: PAYLOAD });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('settles after a terminal runtime rejection without accepting the review', async () => {
    const onSubmit = vi.fn(async () => ({
      status: 'rejected' as const,
      terminal: true,
      code: 'resume_rejected',
      publicMessage: 'This checkpoint was already resumed elsewhere.',
    }));
    const { session } = await start(createReviewFixture(), onSubmit);

    const rejected = await submit(session);

    expect(rejected.status).toBe(409);
    expect(JSON.parse(rejected.body)).toEqual({
      ok: false,
      code: 'resume_rejected',
      message: 'This checkpoint was already resumed elsewhere.',
      terminal: true,
    });
    await expect(session.settled).resolves.toEqual({
      status: 'rejected',
      response: PAYLOAD,
    });
    const replay = await submit(session);
    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.body)).toMatchObject({ ok: false, code: 'session_finished' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not leak a callback error and permits a safe retry', async () => {
    const secret = 'PRIVATE CONNECTOR FAILURE';
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce(ACCEPTED);
    const { session } = await start(createReviewFixture(), onSubmit);

    const failed = await submit(session);
    const accepted = await submit(session);

    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain(secret);
    expect(failed.body).toContain('could not be saved');
    expect(accepted.status).toBe(200);
    await expect(session.settled).resolves.toEqual({ status: 'accepted', response: PAYLOAD });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('joins an exact concurrent replay to the one in-flight submission and rejects a changed replay', async () => {
    let acceptSubmission: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      acceptSubmission = resolve;
    });
    const onSubmit = vi.fn(async () => {
      await gate;
      return ACCEPTED;
    });
    const { session } = await start(createReviewFixture(), onSubmit);

    const firstPromise = submit(session);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const concurrentPromise = submit(session);
    const concurrentStillWaiting = await Promise.race([
      concurrentPromise.then(() => false),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 20)),
    ]);
    const changedConcurrent = await submit(session, {
      ...PAYLOAD,
      comments: [{ scope: 'overall', body: 'A different in-flight decision body.' }],
    });
    acceptSubmission?.();
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    const replay = await submit(session);
    const changedReplay = await submit(session, {
      ...PAYLOAD,
      comments: [{ scope: 'overall', body: 'A different decision body.' }],
    });

    expect(concurrentStillWaiting).toBe(true);
    expect(changedConcurrent.status).toBe(409);
    expect(JSON.parse(changedConcurrent.body)).toMatchObject({
      ok: false,
      code: 'submission_in_progress',
      terminal: false,
    });
    expect(first.status).toBe(200);
    expect(concurrent.status).toBe(200);
    expect(concurrent.body).toBe(first.body);
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({
      ok: true,
      message: 'Review saved.',
      terminal: true,
    });
    expect(changedReplay.status).toBe(409);
    expect(JSON.parse(changedReplay.body)).toMatchObject({
      ok: false,
      code: 'already_submitted',
      terminal: true,
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await expect(session.settled).resolves.toEqual({ status: 'accepted', response: PAYLOAD });
  });

  it.each([
    {
      label: 'retryable rejection',
      decision: {
        status: 'rejected' as const,
        terminal: false,
        code: 'resume_in_progress',
        publicMessage: 'Another resume is still active.',
      },
    },
    {
      label: 'terminal rejection',
      decision: {
        status: 'rejected' as const,
        terminal: true,
        code: 'resume_rejected',
        publicMessage: 'This checkpoint already closed.',
      },
    },
  ])('returns the same $label to an exact concurrent replay', async ({ decision }) => {
    let releaseSubmission: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    const onSubmit = vi.fn(async () => {
      await gate;
      return decision;
    });
    const { session } = await start(createReviewFixture(), onSubmit);

    const firstPromise = submit(session);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const concurrentPromise = submit(session);
    const changed = await submit(session, {
      ...PAYLOAD,
      comments: [{ scope: 'overall', body: 'A changed concurrent review.' }],
    });
    releaseSubmission?.();
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);

    expect(changed.status).toBe(409);
    expect(JSON.parse(changed.body)).toMatchObject({ code: 'submission_in_progress' });
    expect(first.status).toBe(409);
    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toBe(first.body);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('reconciles durable acceptance only after an exact replay receives the cached reply', async () => {
    const { session, onSubmit } = await start();

    const accepted = await submit(session);
    let reconciled = false;
    const reconciliation = session.waitForAcceptedReplay().then(() => {
      reconciled = true;
    });
    await Promise.resolve();

    const changedReplay = await submit(session, {
      ...PAYLOAD,
      comments: [{ scope: 'overall', body: 'A different decision body.' }],
    });
    await Promise.resolve();

    expect(reconciled).toBe(false);
    expect(changedReplay.status).toBe(409);
    expect(JSON.parse(changedReplay.body)).toMatchObject({
      ok: false,
      code: 'already_submitted',
      terminal: true,
    });

    const replay = await submit(session);
    await reconciliation;

    expect(replay.status).toBe(200);
    expect(replay.body).toBe(accepted.body);
    expect(reconciled).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('bounds reconciliation when no accepted replay arrives', async () => {
    const { session } = await start();
    await submit(session);
    vi.useFakeTimers();
    try {
      let reconciled = false;
      const reconciliation = session.waitForAcceptedReplay().then(() => {
        reconciled = true;
      });

      await vi.advanceTimersByTimeAsync(LOCAL_CHECKPOINT_REVIEW_REPLAY_WINDOW_MS - 1);
      expect(reconciled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await reconciliation;
      expect(reconciled).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const url = session.url;
    await session.close();
    await expect(fetch(url)).rejects.toThrow();
  });

  it('accepts a durable review while reporting that continuation failed', async () => {
    const onSubmit = vi.fn(async () => ({
      status: 'accepted' as const,
      continuation: 'failed' as const,
    }));
    const { session } = await start(createReviewFixture(), onSubmit);

    const accepted = await submit(session);
    const replay = await submit(session);

    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({
      ok: true,
      code: 'resume_failed_after_save',
      message: 'Review saved, but Circuit could not finish continuing the run.',
      terminal: true,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toBe(accepted.body);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await expect(session.settled).resolves.toEqual({ status: 'accepted', response: PAYLOAD });
  });

  it('does not treat a response-shaped file as a human submission', async () => {
    const fixture = createReviewFixture();
    writeFileSync(join(fixture.scratch, 'checkpoint-review.json'), JSON.stringify(PAYLOAD), 'utf8');
    const { session, onSubmit } = await start(fixture);

    await fetch(session.url);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onSubmit).not.toHaveBeenCalled();
    const unsettled = await Promise.race([
      session.settled.then(() => false),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 25)),
    ]);
    expect(unsettled).toBe(true);
  });

  it('closes the listener and makes close idempotent', async () => {
    const { session } = await start();
    expect((await fetch(session.url)).status).toBe(200);

    await session.close();
    await session.close();

    await expect(fetch(session.url)).rejects.toThrow();
  });
});

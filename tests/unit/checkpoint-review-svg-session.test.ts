import { request } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type LocalCheckpointReviewSession,
  startLocalCheckpointReviewSession,
} from '../../src/app/checkpoints/local-review-session.js';

type RawResponse = {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
};

function rawRequest(target: string): Promise<RawResponse> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('local checkpoint review SVG assets', () => {
  const sessions: LocalCheckpointReviewSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it('rewrites captured SVG CSS dependencies while keeping scripts and navigation inert', async () => {
    const sourceUrl = '../prototype-files/svg-card/card.svg';
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<style>@import "./theme.css?mode=review#theme";.card{fill:url(\'./paint.svg#paint\')}</style>',
      '<rect class="card" style="stroke:url(&quot;./stroke.svg?weight=2#stroke&quot;)" onclick="fetch(\'https://attacker.example\')"/>',
      '<script>fetch("https://attacker.example/script")</script>',
      '<a href="https://attacker.example/navigation"><text>Card</text></a>',
      '</svg>',
    ].join('');
    const session = await startLocalCheckpointReviewSession({
      html: `<a data-artifact-full-size-src="${sourceUrl}">Open</a><iframe data-artifact-preview-src="${sourceUrl}"></iframe>`,
      identity: {
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'review-svg',
        attempt: 1,
        requestSha256: 'a'.repeat(64),
      },
      allowedChoices: ['keep'],
      assets: [
        {
          id: 'entry',
          pageReferences: [{ sourceUrl }],
          contentType: 'image/svg+xml',
          bytes: Buffer.from(svg),
          references: [
            {
              kind: 'css-url',
              sourceValue: './theme.css?mode=review#theme',
              targetId: 'theme',
            },
            { kind: 'css-url', sourceValue: './paint.svg#paint', targetId: 'paint' },
            {
              kind: 'css-url',
              sourceValue: './stroke.svg?weight=2#stroke',
              targetId: 'stroke',
            },
          ],
        },
        {
          id: 'theme',
          pageReferences: [],
          contentType: 'text/css',
          bytes: Buffer.from('.card{stroke-width:2}'),
          references: [],
        },
        {
          id: 'paint',
          pageReferences: [],
          contentType: 'image/svg+xml',
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          references: [],
        },
        {
          id: 'stroke',
          pageReferences: [],
          contentType: 'image/svg+xml',
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          references: [],
        },
      ],
      onSubmit: vi.fn(async () => ({ status: 'accepted' as const })),
    });
    sessions.push(session);

    const page = await rawRequest(session.url);
    const entryUrl = page.body.match(
      /href="(http:\/\/127\.0\.0\.1:\d+\/[^"#]+\/asset\/[^"?#]+)"/,
    )?.[1];
    if (entryUrl === undefined) throw new Error('captured SVG route was not activated');
    const entry = await rawRequest(entryUrl);

    expect(entry.status).toBe(200);
    expect(entry.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(entry.body).not.toContain('./theme.css');
    expect(entry.body).not.toContain('./paint.svg');
    expect(entry.body).not.toContain('./stroke.svg');
    expect(entry.body).not.toContain('<script');
    expect(entry.body).not.toContain('onclick');
    expect(entry.body).not.toContain('href="https://attacker.example');

    const dependencyUrls = Array.from(
      entry.body.matchAll(/http:\/\/127\.0\.0\.1:\d+\/[^&"'()\s]+\/asset\/[^&"'()\s]+/g),
      (match) => match[0]?.replaceAll('&amp;', '&'),
    ).filter((value): value is string => value !== undefined);
    expect(dependencyUrls).toHaveLength(3);
    expect(dependencyUrls.some((url) => url.endsWith('?mode=review#theme'))).toBe(true);
    expect(dependencyUrls.some((url) => url.endsWith('#paint'))).toBe(true);
    expect(dependencyUrls.some((url) => url.endsWith('?weight=2#stroke'))).toBe(true);
    for (const dependencyUrl of dependencyUrls) {
      expect((await rawRequest(dependencyUrl)).status).toBe(200);
    }
  });
});

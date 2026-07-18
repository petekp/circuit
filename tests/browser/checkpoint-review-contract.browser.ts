import { readFileSync } from 'node:fs';

import { type Locator, type Page, expect, test } from '@playwright/test';

import {
  type CheckpointBrowserFixtures,
  createCheckpointBrowserFixtures,
  removeCheckpointBrowserFixtures,
} from './checkpoint-fixtures.js';

type LocalReviewSessionModule = typeof import('../../src/app/checkpoints/local-review-session.js');
type StartLocalCheckpointReviewSession =
  LocalReviewSessionModule['startLocalCheckpointReviewSession'];
const localReviewSessionPath = '../../dist/app/checkpoints/local-review-session.js';
const { startLocalCheckpointReviewSession } = (await import(localReviewSessionPath)) as {
  startLocalCheckpointReviewSession: StartLocalCheckpointReviewSession;
};

type ReviewPayload = {
  readonly schema: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt: number;
  readonly request_sha256: string;
  readonly selection: string;
  readonly comments: readonly Record<string, string>[];
};

type CapturedSubmission = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReviewPayload;
};

type BrowserReviewIdentity = {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly requestSha256: string;
};

const GENERIC_REVIEW_IDENTITY: BrowserReviewIdentity = {
  runId: 'browser-generic-run',
  stepId: 'review-checkpoint',
  attempt: 2,
  requestSha256: 'a'.repeat(64),
};

const MULTI_REVIEW_IDENTITY: BrowserReviewIdentity = {
  runId: 'browser-multi-run',
  stepId: 'prototype-variant-checkpoint-step',
  attempt: 3,
  requestSha256: 'b'.repeat(64),
};

type Draft = {
  readonly schema: 'checkpoint.review-draft@v1';
  readonly selection: string;
  readonly notes: Readonly<Record<string, string>>;
  readonly overall: string;
  readonly visited: readonly string[];
};

let fixtures: CheckpointBrowserFixtures | undefined;

function checkpointFixtures(): CheckpointBrowserFixtures {
  if (fixtures === undefined) throw new Error('checkpoint browser fixtures are not ready');
  return fixtures;
}

test.beforeAll(() => {
  fixtures = createCheckpointBrowserFixtures();
});

test.afterAll(() => {
  if (fixtures !== undefined) removeCheckpointBrowserFixtures(fixtures);
});

async function storageKey(root: Locator): Promise<string> {
  const runId = await root.getAttribute('data-run-id');
  const stepId = await root.getAttribute('data-step-id');
  const attempt = await root.getAttribute('data-attempt');
  const requestSha256 = await root.getAttribute('data-request-sha256');
  return `circuit:checkpoint-review:${runId}:${stepId}:${attempt}:${requestSha256}`;
}

async function seedDraft(page: Page, root: Locator, draft: Draft): Promise<void> {
  const key = await storageKey(root);
  const serialized = JSON.stringify(draft);
  await page.evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(serialized)})`);
  await page.reload();
}

function decodeCommand(command: string): ReviewPayload {
  const token = command.match(/ckr1\.([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error('prepared command did not contain a ckr1 token');
  return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as ReviewPayload;
}

test.describe('checkpoint review safety contracts', () => {
  test('skip links move keyboard focus to the intended review landmarks', async ({ page }) => {
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('link', { name: 'Skip to choices' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#cp-options')).toBeFocused();
    await page.getByRole('link', { name: 'Skip to review note' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#cp-comment')).toBeFocused();

    await page.goto(checkpointFixtures().multiUrl);
    await page.getByRole('link', { name: 'Skip to artifact' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mv-artifact')).toBeFocused();
    await page.getByRole('link', { name: 'Skip to comments' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mv-comment')).toBeFocused();
  });

  test('summarizes the draft, preserves dialog edits, and isolates a newer request', async ({
    page,
  }) => {
    await page.goto(checkpointFixtures().genericUrl);
    const comment = page.getByLabel('Review note for this choice (optional)');
    const finish = page.getByRole('button', { name: 'Review decision' });

    await comment.fill('Focused note');
    await page.locator('.cp-option').nth(1).click();
    await comment.fill('Broader note');
    await finish.click();

    const summary = page.locator('[data-cp-confirm-summary]');
    await expect(summary).toHaveText('2 option comments · No overall note · 1 option unvisited');
    const overall = page.getByLabel('Note for the run record (optional)');
    await overall.fill('Overall context');
    await expect(summary).toHaveText('2 option comments · Overall note added · 1 option unvisited');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(finish).toBeFocused();
    await finish.click();
    await expect(overall).toHaveValue('Overall context');
    await page.getByRole('button', { name: 'Keep reviewing' }).click();
    await expect(finish).toBeFocused();
    await expect(comment).toHaveValue('Broader note');

    await page.goto(checkpointFixtures().genericNewIdentityUrl);
    await expect(page.locator('[data-cp-option]').nth(0)).toBeChecked();
    await expect(page.getByLabel('Review note for this choice (optional)')).toHaveValue('');
  });

  test('invalidates stale commands and keeps manual copy available after clipboard rejection', async ({
    page,
  }) => {
    await page.addInitScript(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('blocked'))}})",
    );
    await page.goto(checkpointFixtures().genericUrl);

    const finish = page.getByRole('button', { name: 'Review decision' });
    const command = page.locator('[data-cp-command]');
    const prepare = page.getByRole('button', { name: 'Copy decision command' });
    await finish.click();
    await prepare.click();
    await expect(command).toBeVisible();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Decision prepared — copy the command shown above.',
    );

    await page.getByLabel('Note for the run record (optional)').fill('Changed after preparation');
    await expect(command).toBeHidden();
    await prepare.click();
    await expect(command).toBeVisible();
    await page.getByRole('button', { name: 'Keep reviewing' }).click();
    await page.locator('.cp-option').nth(1).click();
    await finish.click();
    await expect(command).toBeHidden();
  });

  test('copies and exports the exact trimmed review payload', async ({ page }) => {
    await page.addInitScript(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.resolve()}})",
    );
    await page.goto(checkpointFixtures().multiUrl);

    const comment = page.getByLabel('Comment on this option');
    await comment.fill('  Working note ✓  ');
    await page.getByRole('tab', { name: /Missing artifact/ }).click();
    await comment.fill('  Missing note\n  ');
    await page.getByRole('tab', { name: /Working artifact/ }).click();
    await page.getByRole('button', { name: 'Choose this option' }).click();
    await page.getByLabel('Note for the run record (optional)').fill('  Overall note  ');
    await page.getByRole('button', { name: 'Copy decision command' }).click();

    const payload = decodeCommand(await page.locator('[data-mv-command]').innerText());
    expect(payload).toEqual({
      schema: 'checkpoint.review-response@v1',
      run_id: 'browser-multi-run',
      step_id: 'prototype-variant-checkpoint-step',
      attempt: 3,
      request_sha256: 'b'.repeat(64),
      selection: 'working',
      comments: [
        { scope: 'choice', choice_id: 'working', body: 'Working note ✓' },
        { scope: 'choice', choice_id: 'missing', body: 'Missing note' },
        { scope: 'overall', body: 'Overall note' },
      ],
    });
    await expect(page.locator('[data-mv-stage-title]')).toHaveText('Working artifact');

    const downloadStarted = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export review JSON' }).click();
    const download = await downloadStarted;
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (downloadPath === null) return;
    expect(JSON.parse(readFileSync(downloadPath, 'utf8'))).toEqual(payload);
  });

  test('refuses too many comments and oversized UTF-8 reviews', async ({ page }) => {
    await page.goto(checkpointFixtures().limitsUrl);
    const root = page.locator('[data-cp-workspace]');
    const choiceIds = Array.from({ length: 25 }, (_, index) => `choice-${index + 1}`);

    await seedDraft(page, root, {
      schema: 'checkpoint.review-draft@v1',
      selection: 'choice-1',
      notes: Object.fromEntries(choiceIds.map((id) => [id, 'note'])),
      overall: '',
      visited: choiceIds,
    });
    await page.getByRole('button', { name: 'Review decision' }).click();
    await page.getByRole('button', { name: 'Copy decision command' }).click();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Too many comments. Keep notes on at most 24 choices, including the overall note.',
    );
    await expect(page.locator('[data-cp-command]')).toBeHidden();

    const largeChoiceIds = choiceIds.slice(0, 24);
    await seedDraft(page, root, {
      schema: 'checkpoint.review-draft@v1',
      selection: 'choice-1',
      notes: Object.fromEntries(largeChoiceIds.map((id) => [id, '🎨'.repeat(1_000)])),
      overall: '',
      visited: largeChoiceIds,
    });
    await page.getByRole('button', { name: 'Review decision' }).click();
    await page.getByRole('button', { name: 'Copy decision command' }).click();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review notes are too large. Shorten them before preparing the decision.',
    );
    await expect(page.locator('[data-cp-command]')).toBeHidden();
  });

  test('stays usable when browser storage is blocked', async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(
      "Storage.prototype.getItem=function(){throw new Error('blocked')};Storage.prototype.setItem=function(){throw new Error('blocked')};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('blocked'))}})",
    );
    const page = await context.newPage();
    try {
      await page.goto(checkpointFixtures().genericUrl);
      await expect(page.locator('[data-cp-save-state]')).toHaveText('Draft won’t survive reload');
      await page.locator('.cp-option').nth(1).click();
      await page.getByLabel('Review note for this choice (optional)').fill('Still usable');
      await expect(page.locator('[data-cp-option]').nth(1)).toBeChecked();
      await page.getByRole('button', { name: 'Review decision' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Copy decision command' }).click();
      await expect(page.locator('[data-cp-command]')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('trusted Done sends the exact visible, trimmed review payload', async ({ page }) => {
    const endpoint = 'checkpoint-review/submit';
    const authorization = 'browser-session-secret';
    await page.addInitScript(
      ({ endpoint, authorization, identity }) => {
        const state = window as unknown as {
          __CIRCUIT_REVIEW_SESSION__: {
            readonly endpoint: string;
            readonly authorization: string;
            readonly identity: BrowserReviewIdentity;
          };
          __checkpointSubmissions: Array<{
            readonly url: string;
            readonly method: string;
            readonly headers: Readonly<Record<string, string>>;
            readonly body: unknown;
          }>;
        };
        state.__CIRCUIT_REVIEW_SESSION__ = { endpoint, authorization, identity };
        state.__checkpointSubmissions = [];
        window.fetch = async (input, init) => {
          const headers: Record<string, string> = {};
          new Headers(init?.headers).forEach((value, key) => {
            headers[key] = value;
          });
          state.__checkpointSubmissions.push({
            url: String(input),
            method: init?.method ?? 'GET',
            headers,
            body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown,
          });
          return new Response(JSON.stringify({ status: 'accepted' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      },
      { endpoint, authorization, identity: MULTI_REVIEW_IDENTITY },
    );
    await page.goto(checkpointFixtures().multiUrl);

    const comment = page.getByLabel('Comment on this option');
    await comment.fill('  Working note ✓  ');
    await page.getByRole('tab', { name: /Missing artifact/ }).click();
    await comment.fill('   \n  ');
    await page.getByRole('tab', { name: /Evidence only/ }).click();
    await comment.fill('  Evidence note\nwith a second line  ');
    await page.getByRole('tab', { name: /Missing artifact/ }).click();
    await page.getByRole('button', { name: 'Choose this option' }).click();
    await page
      .getByLabel('Note for the run record (optional)')
      .fill('  Overall context\nfor the run  ');

    await expect(page.getByRole('button', { name: 'Copy decision command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export review JSON' })).toBeVisible();
    const done = page.locator('[data-mv-submit-decision]');
    await done.click();
    await expect(page.locator('[data-mv-command-state]')).toHaveText(
      'Review saved. Circuit is continuing.',
    );
    await expect(page.locator('[data-mv-previous]')).toHaveCount(2);
    await expect(page.locator('[data-mv-previous]:disabled')).toHaveCount(2);
    await expect(page.locator('[data-mv-next]')).toHaveCount(2);
    await expect(page.locator('[data-mv-next]:disabled')).toHaveCount(2);

    const submissions = await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __checkpointSubmissions: readonly CapturedSubmission[];
          }
        ).__checkpointSubmissions,
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual({
      url: new URL(endpoint, page.url()).href,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-circuit-review-session': authorization,
      },
      body: {
        schema: 'checkpoint.review-response@v1',
        run_id: 'browser-multi-run',
        step_id: 'prototype-variant-checkpoint-step',
        attempt: 3,
        request_sha256: 'b'.repeat(64),
        selection: 'missing',
        comments: [
          { scope: 'choice', choice_id: 'working', body: 'Working note ✓' },
          {
            scope: 'choice',
            choice_id: 'unavailable',
            body: 'Evidence note\nwith a second line',
          },
          { scope: 'overall', body: 'Overall context\nfor the run' },
        ],
      },
    });
    expect(submissions[1]).toEqual(submissions[0]);
  });

  test('trusted Done automatically replays the exact payload when the accepted response is lost', async ({
    page,
  }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
        __checkpointSerializedSubmissions: string[];
        __checkpointResponseReadCount: number;
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'checkpoint-review/submit',
        authorization: 'lost-accepted-response-secret',
        identity,
      };
      state.__checkpointSerializedSubmissions = [];
      state.__checkpointResponseReadCount = 0;
      window.fetch = async (_input, init) => {
        state.__checkpointSerializedSubmissions.push(String(init?.body));
        const response = new Response(
          JSON.stringify({ ok: true, message: 'Review saved.', terminal: true }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
        const originalText = response.text.bind(response);
        const submissionNumber = state.__checkpointSerializedSubmissions.length;
        Object.defineProperty(response, 'text', {
          value: () => {
            state.__checkpointResponseReadCount += 1;
            return submissionNumber === 1
              ? Promise.reject(new TypeError('accepted response body was lost'))
              : originalText();
          },
        });
        return response;
      };
    }, GENERIC_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    const done = page.locator('[data-cp-submit-decision]');
    await done.click();

    await expect(done).toBeDisabled();
    await expect(done).toHaveText('Review saved');
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review saved. Circuit is continuing.',
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                readonly __checkpointSerializedSubmissions: readonly string[];
              }
            ).__checkpointSerializedSubmissions.length,
        ),
      )
      .toBe(2);
    const serialized = await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __checkpointSerializedSubmissions: readonly string[];
          }
        ).__checkpointSerializedSubmissions,
    );
    expect(new Set(serialized).size).toBe(1);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointResponseReadCount: number;
            }
          ).__checkpointResponseReadCount,
      ),
    ).toBe(2);
  });

  test('trusted Done joins an in-flight save when its first browser connection is lost', async ({
    page,
  }) => {
    const identity = {
      ...GENERIC_REVIEW_IDENTITY,
      runId: '33333333-3333-4333-8333-333333333333',
    };
    let releaseDecision: (() => void) | undefined;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    let markSubmissionStarted: (() => void) | undefined;
    const submissionStarted = new Promise<void>((resolve) => {
      markSubmissionStarted = resolve;
    });
    let submissionCount = 0;
    const genericHtml = readFileSync(new URL(checkpointFixtures().genericUrl), 'utf8');
    const session = await startLocalCheckpointReviewSession({
      html: genericHtml.replaceAll(GENERIC_REVIEW_IDENTITY.runId, identity.runId),
      identity,
      allowedChoices: ['focused', 'broader', 'park'],
      onSubmit: async () => {
        submissionCount += 1;
        markSubmissionStarted?.();
        await decisionGate;
        return { status: 'accepted' };
      },
    });
    let markRetrySeen: (() => void) | undefined;
    const retrySeen = new Promise<void>((resolve) => {
      markRetrySeen = resolve;
    });
    let mirroredFirstRequest: Promise<Response> | undefined;
    const origin = new URL(session.url).origin;

    await page.route(session.endpoint, async (route) => {
      if (mirroredFirstRequest === undefined) {
        mirroredFirstRequest = fetch(session.endpoint, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'X-Circuit-Review-Session': session.authorization,
          },
          body: route.request().postData(),
        });
        await submissionStarted;
        await route.abort('connectionfailed');
        return;
      }
      markRetrySeen?.();
      await route.continue();
    });

    try {
      await page.goto(session.url);
      await page.getByRole('button', { name: 'Review decision' }).click();
      const done = page.locator('[data-cp-submit-decision]');
      await done.click();

      await submissionStarted;
      await retrySeen;
      expect(submissionCount).toBe(1);
      await expect(done).toHaveText('Saving…');
      releaseDecision?.();

      await expect(done).toHaveText('Review saved');
      await expect(page.locator('[data-cp-command-state]')).toHaveText(
        'Review saved. Circuit is continuing.',
      );
      expect(submissionCount).toBe(1);
      const firstRequest = mirroredFirstRequest;
      if (firstRequest === undefined) throw new Error('first submission was not mirrored');
      expect((await firstRequest).status).toBe(200);
      await expect(session.settled).resolves.toMatchObject({
        status: 'accepted',
        response: { selection: 'focused' },
      });
      await session.waitForAcceptedReplay();
    } finally {
      releaseDecision?.();
      await page.unroute(session.endpoint);
      await session.close();
    }
  });

  test('trusted Done clearly moves from saving to success', async ({ page }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
        __resolveCheckpointSubmission?: () => void;
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'checkpoint-review/submit',
        authorization: 'saving-state-secret',
        identity,
      };
      window.fetch = () =>
        new Promise<Response>((resolve) => {
          state.__resolveCheckpointSubmission = () => {
            resolve(
              new Response(JSON.stringify({ status: 'accepted' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          };
        });
    }, GENERIC_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    await expect(page.getByRole('button', { name: 'Copy decision command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export review JSON' })).toBeVisible();
    const done = page.locator('[data-cp-submit-decision]');
    await done.click();
    await expect(done).toBeDisabled();
    await expect(done).toHaveText('Saving…');
    await expect(page.locator('[data-cp-command-state]')).toHaveText('Saving your review…');

    await page.evaluate(() => {
      (
        window as unknown as {
          readonly __resolveCheckpointSubmission?: () => void;
        }
      ).__resolveCheckpointSubmission?.();
    });
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review saved. Circuit is continuing.',
    );
    await expect(done).toBeDisabled();
    await expect(done).toHaveText('Review saved');
    await expect(page.locator('[data-cp-option]').first()).toBeDisabled();
    await expect(page.getByLabel('Review note for this choice (optional)')).toBeDisabled();
    await expect(page.getByLabel('Note for the run record (optional)')).toBeDisabled();
  });

  test('trusted Done reports safe retryable failures and lets the reviewer retry', async ({
    page,
  }) => {
    const reflectedSecret = 'PRIVATE SERVER DETAIL MUST NOT BE SHOWN';
    await page.addInitScript(
      ({ reflectedSecret, identity }) => {
        const state = window as unknown as {
          __CIRCUIT_REVIEW_SESSION__: {
            readonly endpoint: string;
            readonly authorization: string;
            readonly identity: BrowserReviewIdentity;
          };
          __checkpointSubmissionCount: number;
        };
        state.__CIRCUIT_REVIEW_SESSION__ = {
          endpoint: 'checkpoint-review/submit',
          authorization: 'retry-state-secret',
          identity,
        };
        state.__checkpointSubmissionCount = 0;
        window.fetch = async () => {
          state.__checkpointSubmissionCount += 1;
          if (state.__checkpointSubmissionCount === 1) {
            return new Response(
              JSON.stringify({
                code: 'private_server_code',
                message: reflectedSecret,
                terminal: false,
              }),
              {
                status: 409,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          if (state.__checkpointSubmissionCount === 2) {
            return new Response(
              JSON.stringify({
                code: 'resume_failed',
                message: reflectedSecret,
                terminal: false,
              }),
              {
                status: 409,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          return new Response(JSON.stringify({ status: 'accepted' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      },
      { reflectedSecret, identity: GENERIC_REVIEW_IDENTITY },
    );
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    const done = page.locator('[data-cp-submit-decision]');
    await done.click();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'This review is no longer waiting. Refresh the page or use the manual fallback below.',
    );
    await expect(page.locator('[data-cp-command-state]')).not.toContainText(reflectedSecret);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Note for the run record (optional)')).toBeEditable();
    await expect(done).toBeEnabled();
    await expect(done).toHaveText('Try again');
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointSubmissionCount: number;
            }
          ).__checkpointSubmissionCount,
      ),
    ).toBe(1);

    await done.click();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Circuit couldn’t continue the run. Try again, or use the manual fallback below.',
    );
    await expect(page.locator('[data-cp-command-state]')).not.toContainText(reflectedSecret);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointSubmissionCount: number;
            }
          ).__checkpointSubmissionCount,
      ),
    ).toBe(2);

    await done.click();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review saved. Circuit is continuing.',
    );
    const submissionCount = await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __checkpointSubmissionCount: number;
          }
        ).__checkpointSubmissionCount,
    );
    expect(submissionCount).toBe(4);
  });

  test('trusted Done keeps manual recovery available after a terminal save failure', async ({
    page,
  }) => {
    const reflectedSecret = 'PRIVATE SERVER DETAIL MUST NOT BE SHOWN';
    await page.addInitScript(
      ({ reflectedSecret, identity }) => {
        const state = window as unknown as {
          __CIRCUIT_REVIEW_SESSION__: {
            readonly endpoint: string;
            readonly authorization: string;
            readonly identity: BrowserReviewIdentity;
          };
        };
        state.__CIRCUIT_REVIEW_SESSION__ = {
          endpoint: 'checkpoint-review/submit',
          authorization: 'terminal-state-secret',
          identity,
        };
        window.fetch = async () =>
          new Response(
            JSON.stringify({
              code: 'checkpoint_review_not_persisted',
              message: reflectedSecret,
              terminal: true,
            }),
            {
              status: 409,
              headers: { 'content-type': 'application/json' },
            },
          );
      },
      { reflectedSecret, identity: GENERIC_REVIEW_IDENTITY },
    );
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    const done = page.locator('[data-cp-submit-decision]');
    await done.click();
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Circuit couldn’t prove the review reached the run record. Inspect the run, then use the manual fallback below.',
    );
    await expect(page.locator('[data-cp-command-state]')).not.toContainText(reflectedSecret);
    await expect(done).toBeDisabled();
    await expect(done).toHaveText('Review not saved');
    await expect(page.locator('[data-cp-copy-decision]')).toBeEnabled();
    await expect(page.locator('[data-cp-export]')).toBeEnabled();
    await expect(page.getByLabel('Note for the run record (optional)')).toBeEditable();
  });

  test('trusted Done obeys a terminal resume rejection from the active server', async ({
    page,
  }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'checkpoint-review/submit',
        authorization: 'resume-rejected-secret',
        identity,
      };
      window.fetch = async () =>
        new Response(
          JSON.stringify({
            code: 'resume_rejected',
            message: 'private detail',
            terminal: true,
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        );
    }, GENERIC_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    const done = page.locator('[data-cp-submit-decision]');
    await done.click();

    await expect(done).toBeDisabled();
    await expect(done).toHaveText('Review not saved');
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'This review is no longer waiting. Refresh the page or use the manual fallback below.',
    );
  });

  test('trusted Done locks as saved when continuation fails after durable acceptance', async ({
    page,
  }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'checkpoint-review/submit',
        authorization: 'saved-continuation-failed-secret',
        identity,
      };
      window.fetch = async () =>
        new Response(
          JSON.stringify({
            ok: true,
            code: 'resume_failed_after_save',
            message: 'Review saved, but Circuit could not finish continuing the run.',
            terminal: true,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
    }, GENERIC_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    const done = page.locator('[data-cp-submit-decision]');
    await done.click();

    await expect(done).toBeDisabled();
    await expect(done).toHaveText('Review saved');
    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review saved, but Circuit could not finish continuing the run. Inspect the run status.',
    );
  });

  test('trusted Done accepts only one submission while a request is in flight', async ({
    page,
  }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
        __checkpointSubmissionCount: number;
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'checkpoint-review/submit',
        authorization: 'one-submit-secret',
        identity,
      };
      state.__checkpointSubmissionCount = 0;
      window.fetch = () => {
        state.__checkpointSubmissionCount += 1;
        return new Promise<Response>(() => undefined);
      };
    }, MULTI_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().multiUrl);
    await page.getByRole('button', { name: 'Choose this option' }).click();
    const done = page.locator('[data-mv-submit-decision]');

    await done.evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(done).toBeDisabled();
    const submissionCount = await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __checkpointSubmissionCount: number;
          }
        ).__checkpointSubmissionCount,
    );
    expect(submissionCount).toBe(1);
  });

  test('trusted Done can be completed with keyboard activation alone', async ({ page }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
        __checkpointSubmissionCount: number;
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'checkpoint-review/submit',
        authorization: 'keyboard-secret',
        identity,
      };
      state.__checkpointSubmissionCount = 0;
      window.fetch = async () => {
        state.__checkpointSubmissionCount += 1;
        return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 });
      };
    }, GENERIC_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().genericUrl);

    const review = page.getByRole('button', { name: 'Review decision' });
    await review.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    const done = page.locator('[data-cp-submit-decision]');
    await done.focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-cp-command-state]')).toHaveText(
      'Review saved. Circuit is continuing.',
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointSubmissionCount: number;
            }
          ).__checkpointSubmissionCount,
      ),
    ).toBe(2);
  });

  test('does not trust a session for a different checkpoint identity', async ({ page }) => {
    await page.addInitScript(
      (identity) => {
        const state = window as unknown as {
          __CIRCUIT_REVIEW_SESSION__: {
            readonly endpoint: string;
            readonly authorization: string;
            readonly identity: BrowserReviewIdentity;
          };
          __checkpointSubmissionCount: number;
        };
        state.__CIRCUIT_REVIEW_SESSION__ = {
          endpoint: 'checkpoint-review/submit',
          authorization: 'wrong-identity-secret',
          identity,
        };
        state.__checkpointSubmissionCount = 0;
        window.fetch = async () => {
          state.__checkpointSubmissionCount += 1;
          return new Response(null, { status: 200 });
        };
      },
      { ...GENERIC_REVIEW_IDENTITY, attempt: GENERIC_REVIEW_IDENTITY.attempt + 1 },
    );
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Copy decision command' })).toBeVisible();
    await page.getByRole('button', { name: 'Copy decision command' }).click();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointSubmissionCount: number;
            }
          ).__checkpointSubmissionCount,
      ),
    ).toBe(0);
  });

  test('does not send the review to a cross-origin session endpoint', async ({ page }) => {
    await page.addInitScript((identity) => {
      const state = window as unknown as {
        __CIRCUIT_REVIEW_SESSION__: {
          readonly endpoint: string;
          readonly authorization: string;
          readonly identity: BrowserReviewIdentity;
        };
        __checkpointSubmissionCount: number;
      };
      state.__CIRCUIT_REVIEW_SESSION__ = {
        endpoint: 'https://attacker.example/checkpoint-review/submit',
        authorization: 'must-not-leave-this-origin',
        identity,
      };
      state.__checkpointSubmissionCount = 0;
      window.fetch = async () => {
        state.__checkpointSubmissionCount += 1;
        return new Response(null, { status: 200 });
      };
    }, GENERIC_REVIEW_IDENTITY);
    await page.goto(checkpointFixtures().genericUrl);
    await page.getByRole('button', { name: 'Review decision' }).click();

    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Copy decision command' })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointSubmissionCount: number;
            }
          ).__checkpointSubmissionCount,
      ),
    ).toBe(0);
  });

  test('without a trusted session, manual copy and export remain available', async ({ page }) => {
    await page.addInitScript(() => {
      const state = window as unknown as { __checkpointSubmissionCount: number };
      state.__checkpointSubmissionCount = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
      window.fetch = async () => {
        state.__checkpointSubmissionCount += 1;
        return new Response(null, { status: 500 });
      };
    });
    await page.goto(checkpointFixtures().multiUrl);
    await page.getByRole('button', { name: 'Choose this option' }).click();

    await expect(page.getByRole('button', { name: 'Copy decision command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export review JSON' })).toBeVisible();
    await page.getByRole('button', { name: 'Copy decision command' }).click();
    await expect(page.locator('[data-mv-command]')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readonly __checkpointSubmissionCount: number;
            }
          ).__checkpointSubmissionCount,
      ),
    ).toBe(0);
  });
});

import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

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

const artifactPreviewPath = '../../dist/shared/html/artifact-preview.js';
const { ARTIFACT_PREVIEW_SCRIPT } = (await import(artifactPreviewPath)) as {
  ARTIFACT_PREVIEW_SCRIPT: string;
};

const GENERIC_REVIEW_IDENTITY = {
  runId: 'browser-generic-run',
  stepId: 'review-checkpoint',
  attempt: 2,
  requestSha256: 'a'.repeat(64),
} as const;

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

function genericSessionHtml(runId: string): string {
  return readFileSync(new URL(checkpointFixtures().genericUrl), 'utf8').replaceAll(
    GENERIC_REVIEW_IDENTITY.runId,
    runId,
  );
}

test.describe('checkpoint review session lifecycle', () => {
  test('a second open copy flips to saved when the review is saved in another window', async ({
    page,
  }) => {
    const identity = {
      ...GENERIC_REVIEW_IDENTITY,
      runId: '44444444-4444-4444-8444-444444444444',
    };
    const session = await startLocalCheckpointReviewSession({
      html: genericSessionHtml(identity.runId),
      identity,
      allowedChoices: ['focused', 'broader', 'park'],
      onSubmit: async () => ({ status: 'accepted' }),
    });
    const second = await page.context().newPage();
    try {
      await page.goto(session.url);
      await second.goto(session.url);
      await second.getByLabel('Review note for this choice (optional)').fill('Second window note');

      await page.getByRole('button', { name: 'Review decision' }).click();
      await page.locator('[data-cp-submit-decision]').click();
      await expect(page.locator('[data-cp-command-state]')).toHaveText(
        'Review saved. Circuit is continuing.',
      );

      const notice = second.locator('[data-cp-session-notice]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Review saved in another window');
      const done = second.locator('[data-cp-submit-decision]');
      await expect(done).toBeDisabled();
      await expect(done).toHaveText('Review saved');
      await expect(second.locator('[data-cp-option]').first()).toBeDisabled();
      await expect(second.locator('[data-cp-open-link], [data-mv-open]')).toHaveCount(0);
    } finally {
      await second.close();
      await session.close();
    }
  });

  test('refocusing a page after the session ends shows the ended notice with a restart command', async ({
    page,
  }) => {
    const identity = {
      ...GENERIC_REVIEW_IDENTITY,
      runId: '55555555-5555-4555-8555-555555555555',
    };
    const session = await startLocalCheckpointReviewSession({
      html: genericSessionHtml(identity.runId),
      identity,
      allowedChoices: ['focused', 'broader', 'park'],
      onSubmit: async () => ({ status: 'accepted' }),
    });
    await page.goto(session.url);
    await page.getByLabel('Review note for this choice (optional)').fill('Keep this note');
    await session.close();

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    const notice = page.locator('[data-cp-session-notice]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('review session is no longer running');
    await expect(notice.locator('code')).toContainText('--checkpoint-review');

    // The page falls back to the manual presentation: Done is gone, manual
    // copy is primary again, and the draft survives untouched.
    await expect(page.locator('[data-cp-submit-decision]')).toBeHidden();
    await expect(page.getByLabel('Review note for this choice (optional)')).toHaveValue(
      'Keep this note',
    );
    await page.getByRole('button', { name: 'Review decision' }).click();
    await expect(page.getByRole('button', { name: 'Copy decision command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export review JSON' })).toBeEnabled();
  });

  test('Done against a dead session reports the ended session instead of a generic failure', async ({
    page,
  }) => {
    const identity = {
      ...GENERIC_REVIEW_IDENTITY,
      runId: '66666666-6666-4666-8666-666666666666',
    };
    const session = await startLocalCheckpointReviewSession({
      html: genericSessionHtml(identity.runId),
      identity,
      allowedChoices: ['focused', 'broader', 'park'],
      onSubmit: async () => ({ status: 'accepted' }),
    });
    await page.goto(session.url);
    await page.getByLabel('Review note for this choice (optional)').fill('Preserved note');
    await session.close();

    await page.getByRole('button', { name: 'Review decision' }).click();
    await page.locator('[data-cp-submit-decision]').click();

    await expect(page.locator('[data-cp-command-state]')).toContainText(
      'review session is no longer running',
    );
    await expect(page.locator('[data-cp-submit-decision]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Export review JSON' })).toBeEnabled();
    await page.getByRole('button', { name: 'Keep reviewing' }).click();
    await expect(page.getByLabel('Review note for this choice (optional)')).toHaveValue(
      'Preserved note',
    );
  });

  test('a static file copy never probes and never shows the ended notice', async ({ page }) => {
    await page.addInitScript(() => {
      const state = window as unknown as { __probeCount: number };
      state.__probeCount = 0;
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        (window as unknown as { __probeCount: number }).__probeCount += 1;
        return original(input, init);
      };
    });
    await page.goto(checkpointFixtures().genericUrl);
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('[data-cp-session-notice]')).toBeHidden();
    expect(
      await page.evaluate(() => (window as unknown as { __probeCount: number }).__probeCount),
    ).toBe(0);
  });

  test('served artifact previews go quiet with the session instead of showing a browser error', async ({
    page,
  }) => {
    const identity = {
      ...GENERIC_REVIEW_IDENTITY,
      runId: '77777777-7777-4777-8777-777777777777',
    };
    const shellFragment = [
      '<div data-artifact-preview-panel="">',
      '<div class="ap-shell" data-artifact-preview-shell="">',
      '<iframe title="preview" data-artifact-preview-frame="" data-artifact-preview-src="preview-asset"></iframe>',
      '<div class="ap-status"><span data-artifact-preview-message=""></span>',
      '<span data-artifact-preview-detail=""></span>',
      '<button type="button" data-artifact-preview-retry="" hidden>Retry preview</button></div>',
      '</div></div>',
      `<script>${ARTIFACT_PREVIEW_SCRIPT}</script>`,
    ].join('');
    const html = genericSessionHtml(identity.runId).replace('</body>', `${shellFragment}</body>`);
    const session = await startLocalCheckpointReviewSession({
      html,
      identity,
      allowedChoices: ['focused', 'broader', 'park'],
      onSubmit: async () => ({ status: 'accepted' }),
    });
    await page.goto(session.url);
    const shell = page.locator('[data-artifact-preview-shell]');
    await expect(shell).toHaveAttribute('data-artifact-preview-state', /loading|ready|failed/);

    await session.close();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await expect(shell).toHaveAttribute('data-artifact-preview-state', 'failed');
    await expect(shell).toContainText('This preview ended with the review session.');
    await expect(shell.locator('[data-artifact-preview-retry]')).toBeHidden();
  });
});

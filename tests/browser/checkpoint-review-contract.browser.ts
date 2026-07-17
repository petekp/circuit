import { readFileSync } from 'node:fs';

import { type Locator, type Page, expect, test } from '@playwright/test';

import {
  type CheckpointBrowserFixtures,
  createCheckpointBrowserFixtures,
  removeCheckpointBrowserFixtures,
} from './checkpoint-fixtures.js';

type ReviewPayload = {
  readonly schema: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt: number;
  readonly request_sha256: string;
  readonly selection: string;
  readonly comments: readonly Record<string, string>[];
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
});

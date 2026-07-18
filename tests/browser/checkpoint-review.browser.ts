import { existsSync } from 'node:fs';

import { type Locator, type Page, expect, test } from '@playwright/test';

import {
  type CheckpointBrowserFixtures,
  createCheckpointBrowserFixtures,
  removeCheckpointBrowserFixtures,
} from './checkpoint-fixtures.js';

const VIEWPORTS = [
  { name: 'wide desktop', width: 1440, height: 900 },
  { name: 'compact desktop', width: 1024, height: 768 },
  { name: 'portrait tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const SINGLE_ARTIFACT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

type BrowserErrors = {
  readonly messages: string[];
};

function collectBrowserErrors(page: Page): BrowserErrors {
  const messages: string[] = [];
  page.on('pageerror', (error) => messages.push(`page: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    const expectedSafePreviewBlock =
      text.startsWith("Blocked script execution in 'about:blank'") ||
      text.startsWith("Blocked script execution in 'about:srcdoc'");
    if (message.type() === 'error' && !expectedSafePreviewBlock) {
      messages.push(`console: ${text}`);
    }
  });
  return { messages };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate<{ clientWidth: number; scrollWidth: number }>(
    '({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})',
  );
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function expectFullyInViewport(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) return;

  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectContainedDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expectFullyInViewport(page, dialog);

  const box = await dialog.boundingBox();
  const clientWidth = await page.evaluate<number>('document.documentElement.clientWidth');
  if (box === null) return;

  if (clientWidth > 600) {
    const dialogCenter = box.x + box.width / 2;
    expect(Math.abs(dialogCenter - clientWidth / 2)).toBeLessThanOrEqual(2);
  }
  expect(box.x).toBeGreaterThan(0);
  expect(box.y).toBeGreaterThan(0);
}

async function expectFooterClearOfPageEnd(page: Page): Promise<void> {
  await page.evaluate('window.scrollTo(0,document.documentElement.scrollHeight)');
  const footer = page.locator('.cp-footer');
  const pageEnd = page.locator('.cp-meta');
  await expect(footer).toBeVisible();
  await expect(pageEnd).toBeVisible();
  const footerBox = await footer.boundingBox();
  const pageEndBox = await pageEnd.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(pageEndBox).not.toBeNull();
  if (footerBox === null || pageEndBox === null) return;
  expect(pageEndBox.y + pageEndBox.height).toBeLessThanOrEqual(footerBox.y + 1);
}

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

test.describe('generic checkpoint review', () => {
  test('restores every note and the active non-default choice after reload', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(checkpointFixtures().genericUrl);

    const choices = page.locator('[data-cp-option]');
    const choiceRows = page.locator('.cp-option');
    const comment = page.getByLabel('Review note for this choice (optional)');

    await expect(choices.nth(0)).toBeChecked();
    await comment.fill("Focused note — punctuation, Unicode ✓, and Pete's apostrophe.");
    await choiceRows.nth(1).click();
    await comment.fill('Broader note\nwith a second line.');

    await page.reload();

    await expect(choices.nth(1)).toBeChecked();
    await expect(comment).toHaveValue('Broader note\nwith a second line.');
    await choiceRows.nth(0).click();
    await expect(comment).toHaveValue(
      "Focused note — punctuation, Unicode ✓, and Pete's apostrophe.",
    );
    expect(browserErrors.messages).toEqual([]);
  });

  test('supports a keyboard-only decision journey', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(checkpointFixtures().genericUrl);

    const choices = page.locator('[data-cp-option]');
    await choices.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(choices.nth(1)).toBeChecked();
    await page.keyboard.press('End');
    await expect(choices.nth(2)).toBeChecked();
    await page.keyboard.press('Home');
    await expect(choices.nth(0)).toBeChecked();

    const finish = page.getByRole('button', { name: 'Review decision' });
    await finish.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await finish.focus();
    await page.keyboard.press('Enter');
    const overall = page.getByLabel('Note for the run record (optional)');
    await overall.focus();
    await page.keyboard.type('Keyboard-only overall note.');
    const prepare = page.getByRole('button', { name: 'Copy decision command' });
    await prepare.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-cp-command]')).toBeVisible();
    expect(browserErrors.messages).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`fits all controls and the finish dialog at ${viewport.name}`, async ({ page }) => {
      const browserErrors = collectBrowserErrors(page);
      await page.setViewportSize(viewport);
      await page.goto(checkpointFixtures().genericUrl);

      await expectNoHorizontalOverflow(page);
      const finish = page.getByRole('button', { name: 'Review decision' });
      await expectFullyInViewport(page, finish);
      await finish.click();
      await expectContainedDialog(page);
      await expectFullyInViewport(page, page.getByRole('button', { name: 'Keep reviewing' }));
      await expectFullyInViewport(
        page,
        page.getByRole('button', { name: 'Copy decision command' }),
      );
      expect(browserErrors.messages).toEqual([]);
    });
  }

  test('becomes a readable standalone fallback when JavaScript is disabled', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await page.goto(checkpointFixtures().genericUrl);
      await expect(
        page.getByRole('heading', { name: /Choose the safest direction/ }),
      ).toBeVisible();
      await expect(page.getByText(/JavaScript is off/)).toBeVisible();
      await expect(
        page
          .locator('.cp-noscript')
          .getByText('Keep the current scope and verify the browser behavior.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review decision' })).toBeHidden();
      await expect(page.locator('.cp-noscript code').first()).toContainText('--checkpoint-choice');
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });
});

test.describe('single-artifact checkpoint review', () => {
  for (const viewport of SINGLE_ARTIFACT_VIEWPORTS) {
    test(`keeps the artifact and review controls usable without overlap on ${viewport.name}`, async ({
      page,
    }) => {
      const browserErrors = collectBrowserErrors(page);
      await page.setViewportSize(viewport);
      await page.goto(checkpointFixtures().singleArtifactUrl);

      await expectNoHorizontalOverflow(page);
      const openFullSize = page.locator('.cp-open-link');
      await expect(openFullSize).toBeHidden();
      await expect(openFullSize).not.toHaveAttribute('href', /.+/);
      await expect(openFullSize).toHaveAttribute(
        'data-artifact-full-size-src',
        /single-artifact\.html$/,
      );

      const previewShell = page.locator('[data-artifact-preview-shell]');
      await expect(previewShell).toHaveAttribute('data-artifact-preview-state', 'ready');
      const activeFrame = page.frameLocator('[data-artifact-preview-panel] iframe');
      const showDetails = activeFrame.getByText('Show single details');
      await expect(showDetails).toBeVisible();
      await showDetails.scrollIntoViewIfNeeded();
      await showDetails.click();
      await expect(
        activeFrame.getByText('The single artifact native interaction works.'),
      ).toBeVisible();

      await page.locator('.cp-option').nth(1).click();
      await expect(page.locator('[data-cp-option]').nth(1)).toBeChecked();
      const comment = page.getByLabel('Review note for this choice (optional)');
      await comment.scrollIntoViewIfNeeded();
      await comment.fill('The artifact and review controls are both reachable.');
      await expect(comment).toHaveValue('The artifact and review controls are both reachable.');

      const finish = page.getByRole('button', { name: 'Review decision' });
      await expectFullyInViewport(page, finish);
      await expectFooterClearOfPageEnd(page);
      await expectNoHorizontalOverflow(page);
      expect(browserErrors.messages).toEqual([]);
    });
  }
});

test.describe('multi-variant checkpoint review', () => {
  test('preview timeout guidance remains true when full-size viewing is unavailable', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) =>
        nativeSetTimeout(
          handler,
          timeout === 8_000 ? 0 : timeout,
          ...arguments_,
        )) as typeof setTimeout;
    });
    await page.goto(checkpointFixtures().multiUrl);

    const previewShell = page.locator('[data-mv-panel]:not([hidden]) [data-mv-preview-shell]');
    await expect(previewShell).toHaveAttribute('data-mv-preview-state', 'failed');
    await expect(previewShell.locator('[data-artifact-preview-message]')).toHaveText(
      'Preview took too long to load',
    );
    await expect(previewShell.locator('[data-artifact-preview-detail]')).toHaveText(
      'You can retry the preview or continue reviewing without it.',
    );
    await expect(previewShell.locator('[data-artifact-preview-retry]')).toBeVisible();
    await expect(page.locator('[data-mv-open]')).toBeHidden();
  });

  test('restores every note and the active non-recommended variant after reload', async ({
    page,
  }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(checkpointFixtures().multiUrl);

    const tabs = page.getByRole('tab');
    const comment = page.getByLabel('Comment on this option');

    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await comment.fill('Working artifact note ✓');
    await tabs.nth(1).click();
    await comment.fill('Missing artifact note\nwith context.');

    await page.reload();

    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(comment).toHaveValue('Missing artifact note\nwith context.');
    await tabs.nth(0).click();
    await expect(comment).toHaveValue('Working artifact note ✓');
    expect(browserErrors.messages).toEqual([]);
  });

  test('keeps a working artifact interactive and explains a known missing artifact', async ({
    page,
  }) => {
    const browserErrors = collectBrowserErrors(page);
    expect(existsSync(checkpointFixtures().deletedPreviewSourcePath)).toBe(false);
    await page.goto(checkpointFixtures().multiUrl);

    const previewShell = page.locator('[data-mv-panel]:not([hidden]) [data-mv-preview-shell]');
    await expect(previewShell).toHaveAttribute('data-mv-preview-state', 'ready');
    const activeFrame = page.frameLocator('[data-mv-panel]:not([hidden]) iframe');
    const revealDetails = activeFrame.getByText('Reveal details');
    await expect(revealDetails).toBeVisible();
    await revealDetails.scrollIntoViewIfNeeded();
    await revealDetails.click();
    await expect(activeFrame.getByText('The artifact native interaction works.')).toBeVisible();
    await expect(previewShell).toHaveAttribute('data-mv-preview-state', 'ready');

    await page.getByRole('tab', { name: /Missing artifact/ }).click();
    const activePanel = page.locator('[data-mv-panel]:not([hidden])');
    await expect(activePanel).toContainText(/missing|could not be found|no longer exists/i);
    await expect(activePanel.locator('iframe')).toHaveCount(0);
    const openFullSize = page.locator('[data-mv-open]');
    await expect(openFullSize).toBeHidden();
    await expect(openFullSize).not.toHaveAttribute('href', /.+/);
    expect(browserErrors.messages).toEqual([]);
  });

  test('supports tab arrows, Home, End, and keyboard-only completion', async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await page.goto(checkpointFixtures().multiUrl);

    const tabs = page.getByRole('tab');
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

    const finish = page.getByRole('button', { name: 'Choose this option' });
    await finish.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await finish.focus();
    await page.keyboard.press('Enter');
    const prepare = page.getByRole('button', { name: 'Copy decision command' });
    await prepare.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-mv-command]')).toBeVisible();
    expect(browserErrors.messages).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`fits previews, controls, and the finish dialog at ${viewport.name}`, async ({ page }) => {
      const browserErrors = collectBrowserErrors(page);
      await page.setViewportSize(viewport);
      await page.goto(checkpointFixtures().multiUrl);

      await expectNoHorizontalOverflow(page);
      const finish = page.getByRole('button', { name: 'Choose this option' });
      await expectFullyInViewport(page, finish);
      await finish.click();
      await expectContainedDialog(page);
      await expectFullyInViewport(page, page.getByRole('button', { name: 'Keep reviewing' }));
      await expectFullyInViewport(page, page.getByRole('button', { name: 'Export review JSON' }));
      await expectFullyInViewport(
        page,
        page.getByRole('button', { name: 'Copy decision command' }),
      );
      expect(browserErrors.messages).toEqual([]);
    });
  }

  test('keeps artifacts and legacy commands usable when JavaScript is disabled', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await page.goto(checkpointFixtures().multiUrl);
      await expect(
        page.getByRole('heading', { name: /Choose the strongest prototype/ }),
      ).toBeVisible();
      await expect(page.getByText(/JavaScript is off/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose this option' })).toBeHidden();
      await expect(page.locator('.mv-noscript')).toContainText(
        'Artifact preview available in the live review',
      );
      await expect(page.locator('.mv-noscript code').first()).toContainText(
        '--checkpoint-choice working',
      );
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });
});

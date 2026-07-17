import { defineConfig } from '@playwright/test';

const localChrome = process.env.CI === undefined ? { channel: 'chrome' as const } : {};

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.ts',
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI === undefined ? 0 : 1,
  workers: process.env.CI === undefined ? 1 : 2,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? '/tmp/circuit-playwright-results',
  reporter: [['line']],
  use: {
    browserName: 'chromium',
    ...localChrome,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright covers a FEW high-value journeys, not every button. The financial
 * correctness work lives in fast unit tests against the framework-free domain
 * core; end-to-end tests exist to prove the pieces are wired together.
 *
 * The three journeys (from the plan, arriving M5-M9):
 *   1. Sign in -> upload fake CSVs -> preview -> review -> commit -> grid updates
 *   2. Re-upload the same file -> zero new transactions
 *   3. Import the Excel baseline -> reconciliation shows zero deltas
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  // Spread rather than assigning `undefined`: `exactOptionalPropertyTypes` is
  // on, so "absent" and "present but undefined" are different types. Omitting
  // the key lets Playwright apply its own default (CPUs / 2) locally.
  ...(process.env.CI ? { workers: 1 } : {}),

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

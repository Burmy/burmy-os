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

  /**
   * SERIAL, and it has to be.
   *
   * Every spec drives ONE dev server against ONE development database, and each
   * truncates the auth and finance tables to get a known starting state. Run in
   * parallel, one spec wipes another's session mid-test and the failure looks like
   * a flaky passkey ceremony rather than what it is. Learned the hard way in M3.
   *
   * Spinning up a database per worker would be the alternative; for twelve tests
   * that finish in under a minute it is not worth the machinery.
   */
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',

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

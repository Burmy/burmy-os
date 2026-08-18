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
   * SERIAL — because of SHARED DATABASE STATE, which is TECHNICAL DEBT.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * Every spec drives one dev server against ONE development database, and each
   * truncates the auth and finance tables to reach a known starting state. Run in
   * parallel, one spec truncating `user` mid-test wipes another spec's owner row
   * and the failure presents as an unexplained bounce to /access-denied rather
   * than as the isolation bug it is. Learned the hard way in M3.
   *
   * `workers: 1` is a WORKAROUND, not the intended end state. It is acceptable
   * while the suite is small (14 tests, ~35s), and it stops being acceptable when
   * the suite grows — M5's import journeys and M8's grid journeys will both want
   * to run alongside these.
   *
   * The real fix, when the wall-clock cost justifies it: give each worker its own
   * database. The integration suite already proves the pattern works
   * (Testcontainers in tests/integration/global-setup.ts) — an E2E equivalent
   * would provision a database per worker and pass `DATABASE_URL` through to a
   * per-worker dev server, at which point `fullyParallel` can go back to true.
   *
   * Tracked in docs/ROADMAP.md under "Carried forward". Do not assume serial
   * execution is a design decision; it is a bill that has not come due yet.
   * ───────────────────────────────────────────────────────────────────────────
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

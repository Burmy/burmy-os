import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * The M3 app shell and categories — through a real browser. Accounts is
 * gone entirely as user-facing UI (round-2 UX pass) — see finance-accounts.test.ts
 * for `resolveHiddenAccount()`'s own coverage.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS ON TOP OF THE COMPONENT AND INTEGRATION SUITES
 *
 * Because M3 introduced Radix, and Radix is the reason the CSP gained
 * `style-src-attr 'unsafe-inline'`. A dialog and a select that never open would
 * pass every mocked component test and every database test while being completely
 * broken in a browser. Opening them for real is the only way to know the
 * relaxation was both necessary and sufficient.
 *
 * It also covers the interaction the unit tests deliberately mock out: a Server
 * Action round trip that ends in a revalidated page.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://burmy:burmy@localhost:5432/burmy';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'dev@example.invalid';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function resetAll(): Promise<void> {
  await withDb(async (sql) => {
    // The M5 import tables (finance_import_rows/files/imports) are listed
    // explicitly even though `user cascade` already reaches them transitively
    // — same reasoning as tests/integration/harness.ts: a future table that
    // stops being cascade-linked should not silently start leaking between
    // specs instead of failing loudly here.
    await sql.unsafe(
      'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", ' +
        '"account", "finance_transactions", "finance_import_rows", "finance_import_files", ' +
        '"finance_imports", "finance_categories", "finance_accounts", "user" cascade',
    );
  });
}

/**
 * Provision the owner row directly — the test-time equivalent of
 * `node scripts/provision-owner.mjs` — and land in the app.
 *
 * There is no sign-in ceremony to drive anymore: Cloudflare Access with Google
 * is the sole authentication mechanism, verified entirely outside this
 * application, and `pnpm dev` runs with `NODE_ENV=development`, which is
 * exactly the dev-bypass production also has (see
 * `src/server/auth/access.ts`'s `resolveAccessMode`). Once the owner row
 * exists, navigating anywhere private lands directly on `/finance/monthly`.
 */
async function signIntoApp(page: Page): Promise<void> {
  await withDb(async (sql) => {
    const email = OWNER_EMAIL.toLowerCase();
    await sql`
      insert into "user" ("id", "name", "email", "email_verified")
      values (${randomUUID()}, ${email}, ${email}, true)
    `;
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/finance\/monthly$/);
}

test.describe.configure({ mode: 'serial' });

test.describe('app shell', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('navigates between Finance and Settings', async ({ page }) => {
    await signIntoApp(page);

    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    // Settings is a real landing page, grouped by section — Finance today,
    // with room for more sections as more of the app grows (round-3 UX pass).
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
    // General holds preferences that apply everywhere, not to one module —
    // Theme today, the same control the sidebar footer already exposes.
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByText('Theme')).toBeVisible();

    await page.getByRole('link', { name: 'Categories' }).click();
    await expect(page).toHaveURL(/\/settings\/finance\/categories$/);
    await expect(page.getByRole('heading', { name: 'Categories' })).toBeVisible();

    await page.getByRole('link', { name: '← Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.getByRole('link', { name: 'Finance' }).click();
    await expect(page).toHaveURL(/\/finance\/monthly$/);
  });

  test('the theme cookie survives a reload with no flash script', async ({ page }) => {
    await signIntoApp(page);

    // No inline script is what makes this CSP-safe; the class is server-rendered.
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await page.getByRole('menuitem', { name: 'Dark' }).click();

    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.reload();
    // Present in the very first byte of HTML, not applied by script afterwards.
    await expect(page.locator('html')).toHaveClass(/dark/);

    const cookies = await page.context().cookies();
    const theme = cookies.find((cookie) => cookie.name === 'burmy.theme');
    expect(theme?.value).toBe('dark');
    // Host-only, like every cookie Burmy sets.
    expect(theme?.domain).toBe('localhost');
  });

  test('navigates between Monthly, Transactions, and Review via the Finance SubNav', async ({ page }) => {
    await signIntoApp(page);

    // Fixes a real discoverability gap: before this pass, Review was reachable
    // only via a conditional banner that disappeared once nothing needed
    // review, and Transactions only via a toolbar button. Both are now
    // always-visible tabs.
    await expect(page.getByRole('navigation', { name: 'Section' })).toBeVisible();

    await page.getByRole('link', { name: 'Transactions', exact: true }).click();
    await expect(page).toHaveURL(/\/finance\/transactions$/);
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible();

    await page.getByRole('link', { name: 'Review', exact: false }).click();
    await expect(page).toHaveURL(/\/finance\/review$/);
    await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();

    await page.getByRole('link', { name: 'Monthly' }).click();
    await expect(page).toHaveURL(/\/finance\/monthly$/);
  });

  test('collapses and expands the sidebar, and the choice persists across reload', async ({ page }) => {
    await signIntoApp(page);

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Finance' })).toBeVisible();

    // The toggle itself is instant client state now (round-2 perf pass) —
    // persistence to the cookie is a fire-and-forget background write, so
    // the visible-immediately assertions below prove nothing about whether
    // that write has landed yet. Wait for its own network response before
    // reloading, same reasoning CLAUDE.md documents for the M5 import flow:
    // an assertion right after a mutation can pass on optimistic state alone.
    const persisted = page.waitForResponse((response) => response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    // The visible text label disappears in icon-rail mode, but the link
    // itself is still there and still reachable by role — its accessible
    // name now comes from the `title` attribute (an ARIA fallback) instead
    // of visible text content, which is exactly what makes it screen-reader
    // and hover-tooltip accessible despite having no rendered label.
    await expect(nav.getByText('Finance', { exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Finance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await persisted;

    await page.reload();
    // Server-rendered from the cookie, same no-flash reasoning as the theme
    // cookie test above — present on the very first render, not applied after.
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    const cookies = await page.context().cookies();
    const collapsed = cookies.find((cookie) => cookie.name === 'burmy.sidebar-collapsed');
    expect(collapsed?.value).toBe('1');

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(nav.getByRole('link', { name: 'Finance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  });

  test('navigates via the mobile Sheet at a phone-width viewport', async ({ page }) => {
    // The desktop Sidebar is `hidden` below `md`; the hamburger + Sheet is
    // the only way in at this width, and it is a real assertion, not just a
    // CSS class check — a component that fails to mount would fail here.
    await page.setViewportSize({ width: 390, height: 844 });
    await signIntoApp(page);

    // The desktop sidebar's own Nav is not part of the accessibility tree at
    // this width (display: none), so it does not collide with the Sheet's copy.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const sheet = page.getByRole('dialog', { name: 'Burmy' });
    await expect(sheet).toBeVisible();

    await sheet.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // The Sheet closes itself on navigation rather than lingering open.
    await expect(sheet).not.toBeVisible();
  });
});

test.describe('categories', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('a Radix dialog opens under the real CSP and creates a category', async ({ page }) => {
    // THE test that justifies `style-src-attr 'unsafe-inline'`. If the relaxation
    // were missing, the dialog would not position and this would fail.
    const violations: string[] = [];
    await page.addInitScript(() => {
      const record: string[] = [];
      (window as unknown as { __v: string[] }).__v = record;
      document.addEventListener('securitypolicyviolation', (event) => {
        record.push(`${event.effectiveDirective}|${event.sourceFile ?? ''}`);
      });
    });

    await signIntoApp(page);
    await page.goto('/settings/finance/categories');

    await page.getByRole('button', { name: 'Add category' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Name').fill('Velvet Taco');

    // A Radix Select — a popover, positioned with inline styles.
    await dialog.getByLabel('Kind').click();
    await page.getByRole('option', { name: 'Spending' }).click();

    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Velvet Taco')).toBeVisible();

    // It really persisted, and the monthly placeholder reads the same taxonomy.
    await page.goto('/finance/monthly');
    await expect(page.getByText('Velvet Taco')).toBeVisible();

    violations.push(
      ...(await page.evaluate(() => (window as unknown as { __v: string[] }).__v)),
    );
    // Scripts must never be blocked, and nothing from application code either.
    expect(violations.filter((v) => v.startsWith('script-src'))).toEqual([]);
    expect(violations.filter((v) => !v.includes('next-devtools'))).toEqual([]);
  });

  test('rejects a duplicate name with a field error, not a crash', async ({ page }) => {
    await signIntoApp(page);
    await page.goto('/settings/finance/categories');

    for (const attempt of [1, 2]) {
      await page.getByRole('button', { name: 'Add category' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill('Groceries');
      await dialog.getByRole('button', { name: 'Save' }).click();

      if (attempt === 1) {
        await expect(page.getByText('Groceries')).toBeVisible();
      }
    }

    // The second attempt stays in the dialog and explains itself.
    await expect(page.getByRole('alert')).toContainText('already exists');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('reorders with keyboard-accessible buttons and persists', async ({ page }) => {
    await signIntoApp(page);
    await page.goto('/settings/finance/categories');

    for (const name of ['Mortgage', 'Gas']) {
      await page.getByRole('button', { name: 'Add category' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(name)).toBeVisible();
    }

    // Reachable by keyboard, which is the reason drag-and-drop was rejected.
    //
    // The button disables IMMEDIATELY on click via `useOptimistic` — before
    // `reorderCategoriesAction` has actually round-tripped to the server. A
    // `page.reload()` right after that optimistic update races the real
    // persistence: under a quiet dev server the write reliably lands first, but
    // under load (e.g. a heavier spec running immediately before this one) the
    // reload can win, and the fetched page reflects the PRE-reorder order. The
    // listener is created before the keypress so it cannot miss the response.
    const reorderPersisted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/settings/finance/categories') &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: 'Move Gas up' }).focus();
    await page.keyboard.press('Enter');
    await reorderPersisted;

    await expect(page.getByRole('button', { name: 'Move Gas up' })).toBeDisabled();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Move Gas up' })).toBeDisabled();
  });
});

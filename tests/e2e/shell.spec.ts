import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

import {
  GRANT_TTL_SECONDS,
  encodeGrantPayload,
  generateGrantToken,
  grantIdentifier,
} from '../../scripts/auth-grant.mjs';

/**
 * The M3 app shell, accounts and categories — through a real browser.
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
    await sql.unsafe(
      'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", ' +
        '"account", "finance_transactions", "finance_categories", "finance_accounts", "user" cascade',
    );
  });
}

/** Bootstrap, enrol two passkeys, and land in the app. */
async function signIntoApp(page: Page): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable', { enableUI: false });

  const addDevice = async (transport: 'internal' | 'usb'): Promise<void> => {
    await client.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport,
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  };

  const token = generateGrantToken();
  await withDb(async (sql) => {
    await sql`
      insert into "verification" ("id", "identifier", "value", "expires_at")
      values (
        ${randomUUID()},
        ${grantIdentifier(token)},
        ${encodeGrantPayload({
          kind: 'bootstrap',
          email: OWNER_EMAIL.toLowerCase(),
          issuedAt: new Date().toISOString(),
        })},
        ${new Date(Date.now() + GRANT_TTL_SECONDS * 1000)}
      )
    `;
  });

  await addDevice('internal');

  await page.goto('/recovery');
  await page.getByRole('radio', { name: 'bootstrap' }).check();
  await page.getByLabel('Token').fill(token);
  await page.getByRole('button', { name: 'Redeem' }).click();
  await expect(page).toHaveURL(/\/onboarding\/passkeys$/);

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('1 of 2 enrolled')).toBeVisible();

  // Chrome permits only one `internal` authenticator, so the second device is a
  // security key — which is also the pairing the onboarding copy asks for.
  await addDevice('usb');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('2 of 2 enrolled')).toBeVisible();

  await page.getByRole('button', { name: 'Continue to Burmy' }).click();
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

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/accounts$/);
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();

    await page.getByRole('link', { name: 'Categories' }).click();
    await expect(page).toHaveURL(/\/settings\/categories$/);

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
    await page.goto('/settings/categories');

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
    await page.goto('/settings/categories');

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
    await page.goto('/settings/categories');

    for (const name of ['Mortgage', 'Gas']) {
      await page.getByRole('button', { name: 'Add category' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(name)).toBeVisible();
    }

    // Reachable by keyboard, which is the reason drag-and-drop was rejected.
    await page.getByRole('button', { name: 'Move Gas up' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Move Gas up' })).toBeDisabled();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Move Gas up' })).toBeDisabled();
  });
});

test.describe('accounts', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('refuses a full card number rather than truncating it', async ({ page }) => {
    // Storing the last four of a pasted 16-digit number would mean the full
    // number was accepted by the application, silently.
    await signIntoApp(page);
    await page.goto('/settings/accounts');

    await page.getByRole('button', { name: 'Add account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('BoA Checking');

    // `maxLength` stops typing, so bypass it the way a paste would.
    await dialog.getByLabel('Last 4 digits').evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '4111111111111111';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('alert')).toContainText('exactly 4 digits');

    const stored = await withDb(async (sql) => {
      const rows = await sql<{ n: string }[]>`select count(*)::text as n from "finance_accounts"`;
      return Number(rows[0]?.n ?? '0');
    });
    expect(stored).toBe(0);
  });

  test('creates an account with only the last four stored', async ({ page }) => {
    await signIntoApp(page);
    await page.goto('/settings/accounts');

    await page.getByRole('button', { name: 'Add account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('BoA Checking');
    await dialog.getByLabel('Institution').fill('Bank of America');
    await dialog.getByLabel('Last 4 digits').fill('1234');
    await dialog.getByRole('button', { name: 'Save' }).click();

    // `exact` matters: the actions cell's accessible name also contains the
    // account name ("Edit BoA Checking Deactivate"), so a loose match is ambiguous.
    await expect(page.getByRole('cell', { name: 'BoA Checking', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1234', exact: true })).toBeVisible();
  });

  test('does not offer a cash account type', async ({ page }) => {
    // `cash` exists in the database enum from M1, but cash spending is explicitly
    // not tracked in V1 — offering it would invite data the importer cannot make.
    await signIntoApp(page);
    await page.goto('/settings/accounts');

    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByRole('dialog').getByLabel('Type').click();

    await expect(page.getByRole('option', { name: 'Checking' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Brokerage' })).toBeVisible();
    await expect(page.getByRole('option', { name: /cash/i })).toHaveCount(0);
  });
});

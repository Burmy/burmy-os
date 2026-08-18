import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

import { normalizeMerchant } from '../../src/server/finance/merchant';

/**
 * M5's golden path through a real browser, now via the Import Sheet: open →
 * drop/select a CSV (parsing starts immediately, no separate Upload click) →
 * a concise ready/duplicate/needs-attention summary → fix only the
 * exceptions → commit → the Sheet closes and Monthly refreshes. Also covers
 * the idempotency property that makes re-uploading the same statement safe.
 *
 * `signIntoApp` and `resetAll` are duplicated from shell.spec.ts rather than
 * shared — there is no shared e2e helper module yet, matching that file's own
 * existing pattern.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://burmy:burmy@localhost:5432/burmy';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'dev@example.invalid';

const DEPOSIT_FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/finance/boa-deposit-2026-05.csv');
const CARD_FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/finance/boa-card-2026-05.csv');

/**
 * How many transaction rows `boa-deposit-2026-05.csv` yields: 12 data rows
 * after the preamble and the one beginning-balance pseudo-row (empty amount,
 * skipped) are excluded. Verified against the same fixture in
 * tests/unit/parse-boa.test.ts.
 */
const DEPOSIT_TRANSACTION_COUNT = 12;

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

async function addAccount(page: Page, name: string): Promise<void> {
  await page.goto('/settings/finance/accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
}

async function addCategory(page: Page, name: string): Promise<void> {
  await page.goto('/settings/finance/categories');
  await page.getByRole('button', { name: 'Add category' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(name)).toBeVisible();
}

/**
 * Open the Import Sheet from Finance and select a file — with one active
 * account already provisioned by `addAccount`, no account picker appears;
 * choosing the file starts parsing immediately, matching the "no separate
 * Upload click" requirement.
 */
async function openSheetAndSelectFile(page: Page, fixture: string): Promise<void> {
  await page.goto('/finance/monthly');
  await page.getByRole('button', { name: 'Import statement' }).click();
  await expect(page.getByRole('dialog', { name: 'Import statement' })).toBeVisible();
  await page.getByLabel('Statement file').setInputFiles(fixture);
}

async function getOwnerId(): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`select "id" from "user" where "email" = ${OWNER_EMAIL.toLowerCase()}`;
    const row = rows[0];
    if (!row) throw new Error('owner not found');
    return row.id;
  });
}

async function getCategoryId(ownerId: string, name: string): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      select "id" from "finance_categories" where "owner_id" = ${ownerId} and "name" = ${name}
    `;
    const row = rows[0];
    if (!row) throw new Error(`category "${name}" not found`);
    return row.id;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('import', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('upload, categorize, commit — and a repeat upload adds nothing new', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');
    await addCategory(page, 'Groceries');

    await openSheetAndSelectFile(page, DEPOSIT_FIXTURE);

    const sheet = page.getByRole('dialog', { name: 'Import statement' });
    await expect(sheet.getByRole('heading', { name: 'Needs attention' })).toBeVisible();

    // Merchant memory has nothing for LARSEN'S yet, so that row lands in
    // "Needs attention" — visible without expanding "Show all rows" — which
    // is the whole point: only the exception demands a look.
    await expect(sheet.getByText("LARSEN'S #0366", { exact: false })).toBeVisible();
    const larsensRow = sheet.getByRole('row', { name: /LARSEN'S/ });
    await larsensRow.getByLabel(/^Category for/).click();
    await page.getByRole('option', { name: 'Groceries' }).click();

    await sheet.getByRole('button', { name: `Import ${DEPOSIT_TRANSACTION_COUNT} transactions` }).click();
    await expect(sheet.getByText('Import complete')).toBeVisible();
    await expect(sheet.getByText(`${DEPOSIT_TRANSACTION_COUNT} transactions added`)).toBeVisible();
    await expect(sheet.getByText('0 skipped as already imported')).toBeVisible();

    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).not.toBeVisible();
    await expect(page).toHaveURL(/\/finance\/monthly$/);

    const committedCategory = await withDb(async (sql) => {
      const rows = await sql<{ name: string | null }[]>`
        select c."name" from "finance_transactions" t
        join "finance_categories" c on c."id" = t."category_id"
        where t."original_description" like '%LARSEN%'
      `;
      return rows[0]?.name ?? null;
    });
    expect(committedCategory).toBe('Groceries');

    // Re-upload the SAME file: every row must show as already imported, and
    // committing must add zero new transactions — the idempotency property.
    await openSheetAndSelectFile(page, DEPOSIT_FIXTURE);
    await expect(sheet.getByRole('status')).toContainText('You already imported this exact file');

    const settledToggle = sheet.getByRole('button', {
      name: new RegExp(`${DEPOSIT_TRANSACTION_COUNT} more already understood`),
    });
    await expect(settledToggle).toBeVisible();
    await settledToggle.click();
    await expect(sheet.getByText('Already imported').first()).toBeVisible();

    const commitButton = sheet.getByRole('button', { name: /^Import \d+ transaction/ });
    await expect(commitButton).toHaveText('Import 0 transactions');
    await expect(commitButton).toBeDisabled();

    const totalCount = await withDb(async (sql) => {
      const rows = await sql<{ n: string }[]>`select count(*)::text as n from "finance_transactions"`;
      return Number(rows[0]?.n ?? '0');
    });
    expect(totalCount).toBe(DEPOSIT_TRANSACTION_COUNT);
  });

  test('a merchant confirmed before pre-fills its category automatically', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');
    await addCategory(page, 'Dining');

    // Seed the memory a real M6 commit would have written last month —
    // computed via the real normalizer so the key matches exactly what
    // staging will look up, not a guessed string.
    const ownerId = await getOwnerId();
    const categoryId = await getCategoryId(ownerId, 'Dining');
    const { merchantKey } = normalizeMerchant("LARSEN'S #0366 2 05/26 PURCHASE SPRINGFIELD TX");
    await withDb(async (sql) => {
      await sql`
        insert into "finance_merchant_memory" ("owner_id", "merchant_key", "category_id")
        values (${ownerId}, ${merchantKey}, ${categoryId})
      `;
    });

    await openSheetAndSelectFile(page, DEPOSIT_FIXTURE);
    const sheet = page.getByRole('dialog', { name: 'Import statement' });

    // Only LARSEN'S has memory — the other 11 merchants in a real statement
    // are all different, so they legitimately still need attention. LARSEN'S
    // itself is "Ready" — pre-filled, the owner never touches its category
    // select — which is exactly the point: memory narrows the exception list
    // by one row at a time as it learns, not all-or-nothing.
    await expect(sheet.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    const showAll = sheet.getByRole('button', { name: /more already understood/ });
    await expect(showAll).toHaveText(/^1 more already understood/);
    await showAll.click();

    const larsensRow = sheet.getByRole('row', { name: /LARSEN'S/ });
    await expect(larsensRow.getByLabel(/^Category for/)).toHaveText('Dining');

    await sheet.getByRole('button', { name: `Import ${DEPOSIT_TRANSACTION_COUNT} transactions` }).click();
    await expect(sheet.getByText('Import complete')).toBeVisible();
    await expect(sheet.getByText(/categorized or classified automatically/)).toBeVisible();

    const committed = await withDb(async (sql) => {
      const rows = await sql<{ name: string | null; review_status: string }[]>`
        select c."name", t."review_status" from "finance_transactions" t
        join "finance_categories" c on c."id" = t."category_id"
        where t."original_description" like '%LARSEN%'
      `;
      return rows[0];
    });
    expect(committed?.name).toBe('Dining');
    expect(committed?.review_status).toBe('auto');
  });

  test('refuses to stage a credit card export against a checking account', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');

    await openSheetAndSelectFile(page, CARD_FIXTURE);
    const sheet = page.getByRole('dialog', { name: 'Import statement' });

    await expect(sheet.getByRole('alert')).toContainText('credit card export');
    // No import was staged — the Sheet stays open on its opening state, and
    // Finance never navigated anywhere.
    await expect(sheet.getByRole('heading', { name: 'Needs attention' })).not.toBeVisible();
    await expect(page).toHaveURL(/\/finance\/monthly$/);
  });
});

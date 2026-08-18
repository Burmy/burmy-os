import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

import { normalizeMerchant } from '../../src/server/finance/merchant';

/**
 * M5's golden path through a real browser: upload → preview → categorize →
 * commit, and the idempotency property that makes re-uploading the same
 * statement safe.
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
  await page.goto('/settings/accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
}

async function selectAccount(page: Page, name: string): Promise<void> {
  await page.getByLabel('Account').click();
  await page.getByRole('option', { name }).click();
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

    await page.goto('/settings/categories');
    await page.getByRole('button', { name: 'Add category' }).click();
    const categoryDialog = page.getByRole('dialog');
    await categoryDialog.getByLabel('Name').fill('Groceries');
    await categoryDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Groceries')).toBeVisible();

    await page.goto('/finance/import');
    await selectAccount(page, 'BoA Checking');
    await page.getByLabel('Statement (.csv)').setInputFiles(DEPOSIT_FIXTURE);
    await page.getByRole('button', { name: 'Upload' }).click();

    await expect(page).toHaveURL(/\/finance\/import\/[0-9a-f-]+$/);
    await expect(page.getByText(`${DEPOSIT_TRANSACTION_COUNT} new`)).toBeVisible();
    await expect(page.getByText(`${DEPOSIT_TRANSACTION_COUNT} will import`)).toBeVisible();

    // Categorize one row from the ACTUAL statement text, which the preview
    // shows verbatim beneath the normalized merchant.
    await expect(page.getByText("LARSEN'S #0366", { exact: false })).toBeVisible();
    const larsensRow = page.getByRole('row', { name: /LARSEN'S/ });
    await larsensRow.getByLabel(/^Category for/).click();
    await page.getByRole('option', { name: 'Groceries' }).click();

    await page
      .getByRole('button', { name: `Import ${DEPOSIT_TRANSACTION_COUNT} transactions` })
      .click();
    await expect(page.getByText('Import complete.')).toBeVisible();
    await expect(page.getByText(`${DEPOSIT_TRANSACTION_COUNT} transactions added`)).toBeVisible();
    await expect(page.getByText('0 skipped as already imported')).toBeVisible();

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
    await page.goto('/finance/import');
    await selectAccount(page, 'BoA Checking');
    await page.getByLabel('Statement (.csv)').setInputFiles(DEPOSIT_FIXTURE);
    await page.getByRole('button', { name: 'Upload' }).click();

    await expect(page).toHaveURL(/\/finance\/import\/[0-9a-f-]+$/);
    await expect(page.getByText('You already imported this exact file')).toBeVisible();
    await expect(page.getByText(`${DEPOSIT_TRANSACTION_COUNT} already imported`)).toBeVisible();
    await expect(page.getByText('0 will import')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Import \d+ transaction/ })).toBeDisabled();

    const totalCount = await withDb(async (sql) => {
      const rows = await sql<{ n: string }[]>`select count(*)::text as n from "finance_transactions"`;
      return Number(rows[0]?.n ?? '0');
    });
    expect(totalCount).toBe(DEPOSIT_TRANSACTION_COUNT);
  });

  test('a merchant confirmed before pre-fills its category automatically', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');

    await page.goto('/settings/categories');
    await page.getByRole('button', { name: 'Add category' }).click();
    const categoryDialog = page.getByRole('dialog');
    await categoryDialog.getByLabel('Name').fill('Dining');
    await categoryDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Dining')).toBeVisible();

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

    await page.goto('/finance/import');
    await selectAccount(page, 'BoA Checking');
    await page.getByLabel('Statement (.csv)').setInputFiles(DEPOSIT_FIXTURE);
    await page.getByRole('button', { name: 'Upload' }).click();

    await expect(page).toHaveURL(/\/finance\/import\/[0-9a-f-]+$/);

    // Pre-filled — the owner never touches this row's category select.
    const larsensRow = page.getByRole('row', { name: /LARSEN'S/ });
    await expect(larsensRow.getByLabel(/^Category for/)).toHaveText('Dining');

    await page
      .getByRole('button', { name: `Import ${DEPOSIT_TRANSACTION_COUNT} transactions` })
      .click();
    await expect(page.getByText('Import complete.')).toBeVisible();
    await expect(page.getByText(/categorized or classified automatically/)).toBeVisible();

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

    await page.goto('/finance/import');
    await selectAccount(page, 'BoA Checking');
    await page.getByLabel('Statement (.csv)').setInputFiles(CARD_FIXTURE);
    await page.getByRole('button', { name: 'Upload' }).click();

    // Scoped to a `<p>` because Next's route announcer also carries
    // `role="alert"` (an empty `<div>`, mounted once a client-side navigation
    // has occurred) and `page.getByRole('alert')` matches both.
    await expect(page.locator('p[role="alert"]')).toContainText('credit card export');
    // No import was staged — the owner is still on the upload form.
    await expect(page).toHaveURL(/\/finance\/import$/);
  });
});

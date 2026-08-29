import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * M9's transactions ledger through a real browser: reaching it from Finance
 * (a Finance subpage, not a third sidebar destination — see nav.tsx),
 * filtering/searching, correcting a historical transaction and watching the
 * change land on Monthly, and exporting a CSV that reflects the filter on
 * screen.
 *
 * `signIntoApp` / `resetAll` / `addCategory` are duplicated from
 * monthly.spec.ts / review.spec.ts rather than shared, matching those files'
 * own pattern. `seedAccount` inserts directly via SQL — there is no
 * account-management UI left to drive (round-2 UX pass).
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
        '"account", "finance_transactions", "finance_import_rows", "finance_import_files", ' +
        '"finance_imports", "finance_merchant_memory", "finance_categories", "finance_accounts", ' +
        '"user" cascade',
    );
  });
}

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

/**
 * No account-management UI exists anymore (round-2 UX pass) — accounts are
 * auto-provisioned from an upload's detected format, never created by hand.
 * These specs still need a real account row to attach seeded transactions
 * to, so this inserts one directly, matching `seedTransaction`'s own
 * direct-SQL convention below.
 */
async function seedAccount(ownerId: string, type: 'checking' | 'credit_card' = 'checking'): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      insert into "finance_accounts" ("owner_id", "name", "type", "is_active", "sort_order")
      values (${ownerId}, ${type === 'checking' ? 'Checking' : 'Credit Card'}, ${type}, true, 0)
      returning "id"
    `;
    return rows[0]!.id;
  });
}

async function addCategory(page: Page, name: string): Promise<void> {
  await page.goto('/settings/finance/categories');
  await page.getByRole('button', { name: 'Add category' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(name)).toBeVisible();
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

interface SeedTxn {
  readonly ownerId: string;
  readonly accountId: string;
  readonly date: string;
  readonly amountCents: number;
  readonly transactionType?: string;
  readonly reviewStatus?: string;
  readonly categoryId?: string | null;
  readonly description?: string;
  readonly normalizedMerchant?: string;
}

async function seedTransaction(options: SeedTxn): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      insert into "finance_transactions"
        ("owner_id", "account_id", "transaction_date", "original_description", "normalized_merchant",
         "amount_cents", "transaction_type", "type_source", "review_status", "category_id", "dedupe_key")
      values
        (${options.ownerId}, ${options.accountId}, ${options.date},
         ${options.description ?? 'TEST TRANSACTION'}, ${options.normalizedMerchant ?? 'TEST TRANSACTION'},
         ${options.amountCents}, ${options.transactionType ?? 'expense'}, 'default',
         ${options.reviewStatus ?? 'confirmed'}, ${options.categoryId ?? null}, ${randomUUID()})
      returning "id"
    `;
    return rows[0]!.id;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('transactions ledger', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('reached from Finance as a subpage, filters and searches the ledger', async ({ page }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');
    await addCategory(page, 'Dining');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    const groceries = await getCategoryId(ownerId, 'Groceries');
    const dining = await getCategoryId(ownerId, 'Dining');

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-03',
      amountCents: 2500,
      categoryId: groceries,
      description: "LARSEN'S #0366 PURCHASE",
      normalizedMerchant: "LARSEN'S",
    });
    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-10',
      amountCents: 1800,
      categoryId: dining,
      description: 'VIA 313 PURCHASE',
      normalizedMerchant: 'VIA 313',
    });

    await page.goto('/finance/monthly');
    // Transactions is not a sidebar destination — it is reached from within
    // Finance. That intent used to be expressed as "the sidebar has exactly 2
    // links", which broke the moment Games was added (3), even though nothing
    // about Transactions had changed. Asserting the actual set says what is
    // meant, fails with a readable message, and still catches an accidental
    // addition — a new module is expected to update this line.
    const mainNav = page.getByRole('navigation', { name: 'Main' });
    await expect(mainNav.getByRole('link')).toHaveText(['Finance', 'Games', 'Anime', 'Settings']);
    await expect(mainNav.getByRole('link', { name: 'Transactions' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Transactions' }).click();
    await expect(page).toHaveURL(/\/finance\/transactions$/);
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible();

    await expect(page.getByText('2 transactions', { exact: true })).toBeVisible();
    await expect(page.getByText("LARSEN'S #0366 PURCHASE")).toBeVisible();
    await expect(page.getByText('VIA 313 PURCHASE')).toBeVisible();
    // Human-readable, not the raw "2026-05-03" the row was seeded with.
    await expect(page.getByText('May 3, 2026')).toBeVisible();

    // Filter by category — a shareable URL, same convention as Review.
    await page.getByRole('combobox', { name: 'Category', exact: true }).click();
    await page.getByRole('option', { name: 'Dining' }).click();
    await expect(page).toHaveURL(/category=/);
    await expect(page.getByText('VIA 313 PURCHASE')).toBeVisible();
    await expect(page.getByText("LARSEN'S #0366 PURCHASE")).not.toBeVisible();
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    // Clear the category filter, then search by merchant instead.
    await page.getByRole('combobox', { name: 'Category', exact: true }).click();
    await page.getByRole('option', { name: 'All categories' }).click();
    await expect(page.getByText('2 transactions', { exact: true })).toBeVisible();

    await page.getByLabel('Search merchant or description').fill("LARSEN'S");
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/q=/);
    await expect(page.getByText("LARSEN'S #0366 PURCHASE")).toBeVisible();
    await expect(page.getByText('VIA 313 PURCHASE')).not.toBeVisible();

    // The page's own back-link was removed once Transactions became a
    // SubNav tab (see the (tabs) route group's layout) — "Monthly" is now
    // the way back.
    await page.getByRole('link', { name: 'Monthly' }).click();
    await expect(page).toHaveURL(/\/finance\/monthly$/);
  });

  test('correcting a historical category immediately changes Monthly’s total', async ({ page }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-14',
      amountCents: 4500,
      categoryId: null,
      reviewStatus: 'needs_review',
      description: 'UNRESOLVED CHARGE',
    });

    await page.goto('/finance/monthly?year=2026');
    // No Groceries cell has any amount yet — the transaction is needs_review.
    const mayRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'May', exact: true }) });
    await expect(mayRow.getByRole('cell').nth(1).getByRole('button')).toHaveCount(0);

    await page.goto('/finance/transactions?year=2026');
    const row = page.getByRole('row', { name: /UNRESOLVED CHARGE/ });
    await expect(row.getByText('Needs review')).toBeVisible();
    await row.getByLabel(/^Category for/).click();
    await page.getByRole('option', { name: 'Groceries' }).click();
    await expect(row.getByText('Confirmed')).toBeVisible();

    await page.goto('/finance/monthly?year=2026');
    const mayRowAfter = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'May', exact: true }) });
    await expect(mayRowAfter.getByRole('cell').nth(1).getByRole('button')).toHaveText('$45.00');
  });

  test('exports a CSV that reflects the current filter, ignoring on-screen pagination', async ({ page }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');
    await addCategory(page, 'Dining');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    const groceries = await getCategoryId(ownerId, 'Groceries');
    const dining = await getCategoryId(ownerId, 'Dining');

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-03',
      amountCents: 2500,
      categoryId: groceries,
      description: "LARSEN'S #0366 PURCHASE",
      normalizedMerchant: "LARSEN'S",
    });
    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-10',
      amountCents: 1800,
      categoryId: dining,
      description: 'VIA 313 PURCHASE',
      normalizedMerchant: 'VIA 313',
    });

    await page.goto('/finance/transactions?year=2026');
    await page.getByRole('combobox', { name: 'Category', exact: true }).click();
    await page.getByRole('option', { name: 'Groceries' }).click();
    await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();

    // The control is named just "Export" now. It used to be a link in the meta
    // row labelled "Export N transactions", whose name did double duty — it
    // located the control AND asserted the filtered count. That link was
    // replaced by a header action (see the page's own comment: "not the 23px
    // underlined link buried in the meta row it used to be"), so the name no
    // longer carries a count. The count assertion above already covers it.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export', exact: true }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('burmy-transactions-2026.csv');
    const path = await download.path();
    if (!path) throw new Error('download did not save to a path');
    const content = await readFile(path, 'utf8');

    const lines = content.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Amount (USD, + = outflow)');
    expect(lines[1]).toContain("LARSEN'S #0366 PURCHASE");
    expect(lines[1]).toContain('25.00');
    expect(lines[1]).not.toContain('VIA 313');
  });

  test('merchant and note are plain text until clicked, then edit inline', async ({ page }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    const groceries = await getCategoryId(ownerId, 'Groceries');

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-08',
      amountCents: 1500,
      categoryId: groceries,
      description: "LARSEN'S #0366 PURCHASE",
      normalizedMerchant: "LARSEN'S",
    });

    await page.goto('/finance/transactions?year=2026');
    const row = page.getByRole('row', { name: /LARSEN'S/ });

    // Not an input by default — clicking reveals one.
    await expect(row.getByRole('textbox', { name: /^Merchant for/ })).toHaveCount(0);
    await row.getByRole('button', { name: /^Merchant for/ }).click();
    const merchantInput = row.getByRole('textbox', { name: /^Merchant for/ });
    await merchantInput.fill('RENAMED MARKET');
    await merchantInput.blur();
    await expect(row.getByRole('button', { name: /^Merchant for/ })).toHaveText('RENAMED MARKET');

    // Note starts as a muted placeholder, not an empty bordered box.
    await expect(row.getByRole('button', { name: /^Note for/ })).toHaveText('Add note');
    await row.getByRole('button', { name: /^Note for/ }).click();
    const noteInput = row.getByRole('textbox', { name: /^Note for/ });
    await noteInput.fill('Weekly groceries');
    await noteInput.blur();
    await expect(row.getByRole('button', { name: /^Note for/ })).toHaveText('Weekly groceries');

    // The optimistic UI assertions above prove the local state updated, not
    // that the Server Action's write landed — `saveMerchant`/`saveNote` fire
    // it via `startTransition` without the blur handler awaiting it, so a
    // plain one-shot read right after can race ahead of the actual write.
    // `expect.poll` retries instead of trusting a single snapshot.
    await expect
      .poll(async () =>
        withDb(async (sql) => {
          const rows = await sql<{ normalized_merchant: string | null; notes: string | null }[]>`
            select "normalized_merchant", "notes" from "finance_transactions" where "owner_id" = ${ownerId}
          `;
          return rows[0];
        }),
      )
      .toEqual({ normalized_merchant: 'RENAMED MARKET', notes: 'Weekly groceries' });
  });
});

import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * M8's /finance/monthly grid through a real browser: a category cell's
 * displayed total, clicking it open, and the drill-down dialog's transaction
 * list and total matching what the grid showed. Every other formula
 * (Total Expenditure/Income/Gross Savings, the unreconciled bucket, column
 * ordering) is exhaustively covered in tests/unit/grid.test.ts and
 * tests/integration/finance-grid.test.ts against real Postgres — this file
 * only proves the browser round trip works.
 *
 * `signIntoApp` and `resetAll` are duplicated from review.spec.ts / shell.spec.ts
 * / import.spec.ts rather than shared, matching those files' own pattern.
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

/**
 * No account-management UI exists anymore (round-2 UX pass) — accounts are
 * auto-provisioned from an upload's detected format, never created by hand.
 * These specs still need a real account row to attach seeded transactions
 * to, so this inserts one directly, named the same way
 * `resolveHiddenAccount()` would.
 */
async function seedAccount(ownerId: string): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      insert into "finance_accounts" ("owner_id", "name", "type", "is_active", "sort_order")
      values (${ownerId}, 'Checking', 'checking', true, 0)
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

test.describe('monthly grid', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('a category cell shows the transactions-summed total, and its drill-down agrees exactly', async ({
    page,
  }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    const categoryId = await getCategoryId(ownerId, 'Groceries');

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-03',
      amountCents: 2500,
      categoryId,
      description: "LARSEN'S #0366 PURCHASE",
      normalizedMerchant: "LARSEN'S",
    });
    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-15',
      amountCents: 1700,
      categoryId,
      description: 'CORNER MARKET #12 PURCHASE',
      normalizedMerchant: 'CORNER MARKET',
    });
    // A needs_review transaction in the same month/category must not inflate the cell.
    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-05-20',
      amountCents: 9999,
      categoryId,
      reviewStatus: 'needs_review',
      description: 'UNREVIEWED CHARGE',
    });

    await page.goto('/finance/monthly?year=2026');

    // Column order is Month, Groceries (the only category added), Total
    // Expenditure, Income, Gross Savings — Groceries and Total Expenditure
    // both read $42.00 here (it is the only spending this month), so the
    // cells are addressed by position rather than by their shared amount text.
    const mayRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'May', exact: true }) });
    const groceriesCell = mayRow.getByRole('cell').nth(1);
    const cellButton = groceriesCell.getByRole('button');
    await expect(cellButton).toHaveText('$42.00');

    await cellButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Groceries — May 2026')).toBeVisible();
    await expect(dialog.getByText("LARSEN'S #0366 PURCHASE")).toBeVisible();
    await expect(dialog.getByText('CORNER MARKET #12 PURCHASE')).toBeVisible();
    await expect(dialog.getByText('UNREVIEWED CHARGE')).not.toBeVisible();
    await expect(dialog.getByText('Total: $42.00')).toBeVisible();
  });

  test('a confirmed transaction with no category is counted in Total Expenditure and surfaces the reconciliation warning', async ({
    page,
  }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-06-10',
      amountCents: 4200,
      categoryId: null,
      description: 'MYSTERY CHARGE',
    });

    await page.goto('/finance/monthly?year=2026');

    // `getByRole('alert')` alone also matches Next.js's own route-announcer
    // live region, present on every page — filter to the banner's own text.
    const banner = page.getByRole('alert').filter({ hasText: 'confirmed transaction' });
    await expect(banner).toContainText('1 confirmed transaction ($42.00)');

    // Same column order as above; the uncategorized charge has no Groceries
    // cell at all (nothing to click at index 1), only a Total Expenditure
    // cell at index 2.
    const juneRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Jun', exact: true }) });
    const totalExpenditureCell = juneRow.getByRole('cell').nth(2);
    await expect(totalExpenditureCell.getByRole('button')).toHaveText('$42.00');
    await totalExpenditureCell.getByRole('button').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Total Expenditure — Jun 2026')).toBeVisible();
    // MYSTERY CHARGE is the raw description, still plain text below the
    // (now-editable) merchant input — see monthly-grid-table.tsx.
    await expect(dialog.getByText('MYSTERY CHARGE')).toBeVisible();
    await expect(dialog.getByText('Uncategorized')).toBeVisible();
    await expect(dialog.getByText('Total: $42.00')).toBeVisible();
  });

  test('the drill-down dialog supports full inline editing: merchant, note, category, and type', async ({
    page,
  }) => {
    await signIntoApp(page);
    await addCategory(page, 'Groceries');
    await addCategory(page, 'Dining');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    const groceries = await getCategoryId(ownerId, 'Groceries');

    await seedTransaction({
      ownerId,
      accountId,
      date: '2026-07-05',
      amountCents: 3000,
      categoryId: groceries,
      description: 'CORNER MARKET #4 PURCHASE',
      normalizedMerchant: 'CORNER MARKET',
    });

    await page.goto('/finance/monthly?year=2026');
    // Column order: Month, Groceries (cell 1), Dining (cell 2), Total
    // Expenditure, ... — the seeded transaction is in Groceries.
    const julyRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Jul', exact: true }) });
    await julyRow.getByRole('cell').nth(1).getByRole('button').click();

    const dialog = page.getByRole('dialog');
    // Merchant/note are plain text until clicked (round-3 UX pass) — click
    // reveals the input, blur/Enter commits and reverts to text.
    await dialog.getByRole('button', { name: /^Merchant for/ }).click();
    const merchantInput = dialog.getByRole('textbox', { name: /^Merchant for/ });
    await expect(merchantInput).toHaveValue('CORNER MARKET');
    await merchantInput.fill('RENAMED MARKET');
    await merchantInput.blur();
    await expect(dialog.getByRole('button', { name: /^Merchant for/ })).toHaveText('RENAMED MARKET');

    await dialog.getByRole('button', { name: /^Note for/ }).click();
    const noteInput = dialog.getByRole('textbox', { name: /^Note for/ });
    await noteInput.fill('Weekly groceries');
    await noteInput.blur();
    await expect(dialog.getByRole('button', { name: /^Note for/ })).toHaveText('Weekly groceries');

    await dialog.getByLabel(/^Category for/).click();
    await page.getByRole('option', { name: 'Dining' }).click();
    await expect(dialog.getByLabel(/^Category for/)).toHaveText('Dining');

    await dialog.getByLabel(/^Type for/).click();
    await page.getByRole('option', { name: 'Refund', exact: true }).click();
    await expect(dialog.getByLabel(/^Type for/)).toHaveText('Refund');

    // Close and reopen the same cell's drill-down — since the category
    // changed away from Groceries, this exercises the "no live re-filtering"
    // behavior the plan calls for: the total already moved (SQL computed at
    // read time), so re-opening from the SAME Groceries cell now finds
    // nothing there, proving the edit truly landed rather than just looking
    // right in a stale local copy.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.reload();

    const julyRowAfter = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Jul', exact: true }) });
    await expect(julyRowAfter.getByRole('cell').nth(1).getByRole('button')).toHaveCount(0);

    // Merchant/note save fire-and-forget on blur (`startTransition`, not
    // awaited by the handler), so a one-shot read right after can race ahead
    // of the actual write landing — `expect.poll` retries instead of
    // trusting a single snapshot. See transactions.spec.ts's own version of
    // this same fix for the longer version of this reasoning.
    await expect
      .poll(async () =>
        withDb(async (sql) => {
          const rows = await sql<{ normalized_merchant: string | null; notes: string | null; transaction_type: string }[]>`
            select "normalized_merchant", "notes", "transaction_type" from "finance_transactions"
            where "owner_id" = ${ownerId}
          `;
          return rows[0];
        }),
      )
      .toEqual({ normalized_merchant: 'RENAMED MARKET', notes: 'Weekly groceries', transaction_type: 'refund' });
  });
});

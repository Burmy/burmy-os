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

  await addDevice('usb');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('2 of 2 enrolled')).toBeVisible();

  await page.getByRole('button', { name: 'Continue to Burmy' }).click();
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

async function addCategory(page: Page, name: string): Promise<void> {
  await page.goto('/settings/categories');
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

async function getAccountId(ownerId: string, name: string): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      select "id" from "finance_accounts" where "owner_id" = ${ownerId} and "name" = ${name}
    `;
    const row = rows[0];
    if (!row) throw new Error(`account "${name}" not found`);
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
    await addAccount(page, 'BoA Checking');
    await addCategory(page, 'Groceries');

    const ownerId = await getOwnerId();
    const accountId = await getAccountId(ownerId, 'BoA Checking');
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
    await addAccount(page, 'BoA Checking');
    await addCategory(page, 'Groceries');

    const ownerId = await getOwnerId();
    const accountId = await getAccountId(ownerId, 'BoA Checking');

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
    await expect(dialog.getByText('MYSTERY CHARGE')).toBeVisible();
    await expect(dialog.getByText('Uncategorized')).toBeVisible();
    await expect(dialog.getByText('Total: $42.00')).toBeVisible();
  });
});

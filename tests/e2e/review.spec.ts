import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * M7's review queue through a real browser: resolving a needs_review
 * transaction, and the counterpart-unlink when correcting a matched pair.
 *
 * Transactions are seeded directly via SQL rather than through a real import
 * — `import.spec.ts` already covers the upload-to-commit path; this file is
 * about what the review queue does with an already-committed transaction.
 *
 * `signIntoApp` and `resetAll` are duplicated from shell.spec.ts /
 * import.spec.ts rather than shared, matching those files' own pattern.
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

async function addAccount(page: Page, name: string, type: 'Checking' | 'Credit card' = 'Checking'): Promise<void> {
  await page.goto('/settings/finance/accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  if (type !== 'Checking') {
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: type }).click();
  }
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

interface SeedTxn {
  readonly ownerId: string;
  readonly accountId: string;
  readonly amountCents?: number;
  readonly description?: string;
  readonly normalizedMerchant?: string;
  readonly transactionType?: string;
  readonly typeSource?: string;
  readonly reviewStatus?: string;
  readonly counterpartTransactionId?: string | null;
}

async function seedTransaction(options: SeedTxn): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      insert into "finance_transactions"
        ("owner_id", "account_id", "transaction_date", "original_description", "normalized_merchant",
         "amount_cents", "transaction_type", "type_source", "review_status", "counterpart_transaction_id",
         "dedupe_key")
      values
        (${options.ownerId}, ${options.accountId}, '2026-05-15',
         ${options.description ?? 'TEST TRANSACTION'}, ${options.normalizedMerchant ?? 'TEST TRANSACTION'},
         ${options.amountCents ?? 4200}, ${options.transactionType ?? 'expense'},
         ${options.typeSource ?? 'default'}, ${options.reviewStatus ?? 'needs_review'},
         ${options.counterpartTransactionId ?? null}, ${randomUUID()})
      returning "id"
    `;
    return rows[0]!.id;
  });
}

async function linkCounterparts(aId: string, bId: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`update "finance_transactions" set "counterpart_transaction_id" = ${bId} where "id" = ${aId}`;
    await sql`update "finance_transactions" set "counterpart_transaction_id" = ${aId} where "id" = ${bId}`;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('review queue', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('assigning a category resolves a needs_review transaction and it leaves the queue', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');
    await addCategory(page, 'Restaurants');

    const ownerId = await getOwnerId();
    const accountId = await getAccountId(ownerId, 'BoA Checking');
    await seedTransaction({
      ownerId,
      accountId,
      description: "LARSEN'S #0366 PURCHASE",
      normalizedMerchant: "LARSEN'S",
    });

    // The real journey: Finance -> the exception banner -> Review -> fix ->
    // back to Finance via the SubNav's Monthly tab (Review is also always
    // reachable as its own tab now, but the banner is the more direct path
    // when there's actually something to review).
    await page.goto('/finance/monthly');
    const banner = page.getByRole('status').filter({ hasText: 'need attention' });
    await expect(banner).toContainText('1 transaction');
    await banner.getByRole('link', { name: 'Review' }).click();
    await expect(page).toHaveURL(/\/finance\/review$/);

    await expect(page.getByText("LARSEN'S #0366 PURCHASE")).toBeVisible();

    const row = page.getByRole('row', { name: /LARSEN'S/ });
    await row.getByLabel(/^Category for/).click();
    await page.getByRole('option', { name: 'Restaurants' }).click();

    await expect(page.getByText('Nothing here')).toBeVisible();

    // And the banner is gone once back on Finance — the exception queue
    // really is empty now, not just the page we happened to be looking at.
    await page.getByRole('link', { name: 'Monthly' }).click();
    await expect(page).toHaveURL(/\/finance\/monthly$/);
    await expect(page.getByRole('status').filter({ hasText: 'need attention' })).toHaveCount(0);

    const committed = await withDb(async (sql) => {
      const rows = await sql<{ review_status: string; categorization_source: string | null }[]>`
        select "review_status", "categorization_source" from "finance_transactions"
        where "original_description" = ${"LARSEN'S #0366 PURCHASE"}
      `;
      return rows[0];
    });
    expect(committed?.review_status).toBe('confirmed');
    expect(committed?.categorization_source).toBe('manual');
  });

  test('correcting one leg of a matched pair unlinks both sides', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');
    await addAccount(page, 'BoA Card', 'Credit card');

    const ownerId = await getOwnerId();
    const checkingId = await getAccountId(ownerId, 'BoA Checking');
    const cardId = await getAccountId(ownerId, 'BoA Card');

    const checkingLeg = await seedTransaction({
      ownerId,
      accountId: checkingId,
      description: 'Online Banking payment to CRD 9903',
      normalizedMerchant: 'ONLINE BANKING PAYMENT',
      amountCents: 5000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    const cardLeg = await seedTransaction({
      ownerId,
      accountId: cardId,
      description: 'PAYMENT FROM CHK 2288',
      normalizedMerchant: 'PAYMENT FROM CHK',
      amountCents: -5000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    await linkCounterparts(checkingLeg, cardLeg);

    await page.goto('/finance/review?status=all');
    await expect(page.getByText('Online Banking payment to CRD 9903')).toBeVisible();

    const row = page.getByRole('row', { name: /Online Banking payment/ });
    await expect(row.getByText(/Linked to BoA Card/)).toBeVisible();

    await row.getByLabel(/^Type for/).click();
    await page.getByRole('option', { name: 'Expense', exact: true }).click();

    await expect(page.getByText(/unlinked and reset/)).toBeVisible();

    const both = await withDb(async (sql) => {
      const rows = await sql<
        { id: string; transaction_type: string; type_source: string; counterpart_transaction_id: string | null }[]
      >`
        select "id", "transaction_type", "type_source", "counterpart_transaction_id"
        from "finance_transactions" where "id" in (${checkingLeg}, ${cardLeg})
      `;
      return rows;
    });

    const corrected = both.find((r) => r.id === checkingLeg);
    const former = both.find((r) => r.id === cardLeg);

    expect(corrected?.transaction_type).toBe('expense');
    expect(corrected?.type_source).toBe('manual_confirmation');
    expect(corrected?.counterpart_transaction_id).toBeNull();

    // -5000 in Burmy's convention (positive = outflow) is an inflow -> income.
    expect(former?.transaction_type).toBe('income');
    expect(former?.type_source).toBe('default');
    expect(former?.counterpart_transaction_id).toBeNull();
  });

  test('filters stay collapsed by default and expand on request', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');

    const ownerId = await getOwnerId();
    const accountId = await getAccountId(ownerId, 'BoA Checking');
    await seedTransaction({ ownerId, accountId, description: 'ONE THING TO REVIEW' });

    await page.goto('/finance/review');
    await expect(page.getByText('ONE THING TO REVIEW')).toBeVisible();

    // Plain status=needs_review, no other filter active -> the toolbar starts
    // closed, so the common (one- or two-row) case has nothing to look past.
    const toggle = page.getByRole('button', { name: 'Filters' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('combobox', { name: 'Account', exact: true })).not.toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Type', exact: true })).toBeVisible();
  });

  test('a non-default filter in the URL opens the toolbar automatically', async ({ page }) => {
    await signIntoApp(page);
    await addAccount(page, 'BoA Checking');

    const ownerId = await getOwnerId();
    const accountId = await getAccountId(ownerId, 'BoA Checking');
    await seedTransaction({ ownerId, accountId, reviewStatus: 'confirmed', description: 'ALREADY CONFIRMED' });

    // status=all differs from the needs_review default -> the toolbar should
    // already be open, so the active filter is never hidden from view.
    await page.goto('/finance/review?status=all');
    await expect(page.getByText('ALREADY CONFIRMED')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toBeVisible();
  });
});

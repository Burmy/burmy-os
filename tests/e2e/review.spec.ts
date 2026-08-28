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

/**
 * No account-management UI exists anymore (round-2 UX pass) — accounts are
 * auto-provisioned from an upload's detected format, never created by hand.
 * These specs still need a real account row to attach seeded transactions
 * to, so this inserts one directly, named the same way
 * `resolveHiddenAccount()` would.
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
    await addCategory(page, 'Restaurants');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
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

    const ownerId = await getOwnerId();
    const checkingId = await seedAccount(ownerId, 'checking');
    const cardId = await seedAccount(ownerId, 'credit_card');

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
    await expect(row.getByText(/Linked to Credit Card/)).toBeVisible();

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

  // Rewritten, not deleted. This pair used to assert a collapsible "Filters"
  // disclosure — closed by default, opened by a click or by a non-default URL
  // filter. That disclosure was removed on purpose (see `filter-bar.tsx`: "a
  // click to reveal three controls that fit on one line"), and status moved
  // from a select to chips at the same time. Both tests kept asserting the old
  // shape and nothing caught it, because CI had never run them.
  //
  // What is still worth testing is the contract underneath: every filter
  // control is reachable, and a filter in the URL really is applied.
  test('shows every filter control immediately, with no disclosure to open', async ({ page }) => {
    await signIntoApp(page);

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    await seedTransaction({ ownerId, accountId, description: 'ONE THING TO REVIEW' });

    await page.goto('/finance/review');
    await expect(page.getByText('ONE THING TO REVIEW')).toBeVisible();

    // The disclosure is gone — asserted directly, so re-introducing one fails
    // here rather than silently changing the page's behaviour.
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toHaveCount(0);

    // `exact` matters: a second "Category for selected transactions" select
    // appears for bulk assignment, and a substring match would find both.
    await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Type', exact: true })).toBeVisible();
    // Status is chips now, not a select. Anchored so it cannot match another
    // control whose name merely contains the word.
    await expect(page.getByRole('button', { name: /^Needs review/ })).toBeVisible();
  });

  test('a non-default filter in the URL is applied and shown as active', async ({ page }) => {
    await signIntoApp(page);

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    await seedTransaction({ ownerId, accountId, reviewStatus: 'confirmed', description: 'ALREADY CONFIRMED' });

    // status=all differs from the needs_review default, so a confirmed row is
    // visible AND the chip for that status reads as the active one.
    await page.goto('/finance/review?status=all');
    await expect(page.getByText('ALREADY CONFIRMED')).toBeVisible();
    await expect(page.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /^Needs review/ })).toHaveAttribute('aria-pressed', 'false');
  });

  test('bulk category assignment with "remember" writes merchant memory for every distinct merchant selected', async ({
    page,
  }) => {
    await signIntoApp(page);
    await addCategory(page, 'Shopping');

    const ownerId = await getOwnerId();
    const accountId = await seedAccount(ownerId);
    await seedTransaction({ ownerId, accountId, description: 'ACME STORE #1', normalizedMerchant: 'ACME STORE' });
    await seedTransaction({ ownerId, accountId, description: 'ACME STORE #2', normalizedMerchant: 'ACME STORE' });
    await seedTransaction({ ownerId, accountId, description: 'WIDGET CO', normalizedMerchant: 'WIDGET CO' });

    await page.goto('/finance/review');
    await page.getByRole('checkbox', { name: 'Select all' }).check();
    await expect(page.getByText('3 selected')).toBeVisible();

    await page.getByRole('combobox', { name: 'Category for selected transactions' }).click();
    await page.getByRole('option', { name: 'Shopping' }).click();
    await page.getByRole('checkbox', { name: 'Remember these merchants' }).check();
    await page.getByRole('button', { name: 'Set category for 3' }).click();

    await expect(page.getByText('3 transactions updated')).toBeVisible();

    const memory = await withDb(async (sql) => {
      const rows = await sql<{ merchant_key: string }[]>`
        select "merchant_key" from "finance_merchant_memory" where "owner_id" = ${ownerId} order by "merchant_key"
      `;
      return rows.map((r) => r.merchant_key);
    });
    // Two distinct merchants selected (ACME STORE appears twice) -> exactly
    // two memory rows, not three — proves the bulk write dedupes by merchant
    // rather than writing (and re-writing) once per selected row.
    expect(memory).toEqual(['ACMESTORE', 'WIDGETCO']);
  });
});

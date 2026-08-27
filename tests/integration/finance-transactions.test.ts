import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * M9's transactions ledger, against real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Transactions are seeded directly via SQL, same convention as
 * finance-review.test.ts — this suite is about the ledger's own listing,
 * summary and export functions, and about proving M7's mutation functions
 * behave IDENTICALLY when called from this new path (no second correction
 * system). M5/M6's own suites already cover how a transaction gets committed
 * and matched in the first place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Accounts = typeof import('@/server/db/finance/accounts');
type Categories = typeof import('@/server/db/finance/categories');
type Transactions = typeof import('@/server/db/finance/transactions');
type Grid = typeof import('@/server/db/finance/grid');
type CsvExport = typeof import('@/server/finance/export/csv');

let accounts: Accounts;
let categories: Categories;
let transactions: Transactions;
let grid: Grid;
let csvExport: CsvExport;

beforeAll(async () => {
  await harness();
  [accounts, categories, transactions, grid, csvExport] = await Promise.all([
    import('@/server/db/finance/accounts'),
    import('@/server/db/finance/categories'),
    import('@/server/db/finance/transactions'),
    import('@/server/db/finance/grid'),
    import('@/server/finance/export/csv'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
});

async function makeOwner(email: string): Promise<string> {
  const { sql } = await harness();
  const id = randomUUID();
  await sql`insert into "user" ("id", "name", "email", "email_verified") values (${id}, ${email}, ${email}, true)`;
  return id;
}

async function makeAccountId(
  ownerId: string,
  type: 'checking' | 'savings' | 'credit_card' | 'brokerage' = 'checking',
  name?: string,
): Promise<string> {
  const account = await accounts.createAccount(ownerId, {
    name: name ?? `Test account ${randomUUID().slice(0, 8)}`,
    type,
    institution: null,
    lastFour: null,
  });
  return account.id;
}

interface SeedTxn {
  readonly ownerId: string;
  readonly accountId: string;
  readonly amountCents?: number;
  readonly date?: string;
  readonly description?: string;
  readonly normalizedMerchant?: string | null;
  readonly transactionType?: string;
  readonly typeSource?: string;
  readonly reviewStatus?: string;
  readonly categoryId?: string | null;
  readonly categorizationSource?: string | null;
  readonly counterpartTransactionId?: string | null;
}

async function seedTransaction(options: SeedTxn): Promise<string> {
  const { sql } = await harness();
  const dedupeKey = randomUUID();
  const rows = await sql<{ id: string }[]>`
    insert into "finance_transactions"
      ("owner_id", "account_id", "transaction_date", "original_description", "normalized_merchant",
       "amount_cents", "transaction_type", "type_source", "review_status", "category_id",
       "categorization_source", "counterpart_transaction_id", "dedupe_key")
    values
      (${options.ownerId}, ${options.accountId}, ${options.date ?? '2026-05-15'},
       ${options.description ?? 'TEST MERCHANT'}, ${options.normalizedMerchant ?? 'TEST MERCHANT'},
       ${options.amountCents ?? 1000}, ${options.transactionType ?? 'expense'},
       ${options.typeSource ?? 'default'}, ${options.reviewStatus ?? 'confirmed'},
       ${options.categoryId ?? null}, ${options.categorizationSource ?? null},
       ${options.counterpartTransactionId ?? null}, ${dedupeKey})
    returning "id"
  `;
  return rows[0]!.id;
}

async function linkCounterparts(aId: string, bId: string): Promise<void> {
  const { sql } = await harness();
  await sql`update "finance_transactions" set "counterpart_transaction_id" = ${bId} where "id" = ${aId}`;
  await sql`update "finance_transactions" set "counterpart_transaction_id" = ${aId} where "id" = ${bId}`;
}

/** Bulk-inserts via `generate_series` so pagination/export-cap tests run against real Postgres without a slow per-row loop. */
async function bulkSeedTransactions(ownerId: string, accountId: string, count: number, year = 2026): Promise<void> {
  const { sql } = await harness();
  await sql`
    insert into "finance_transactions"
      ("owner_id", "account_id", "transaction_date", "original_description", "normalized_merchant",
       "amount_cents", "transaction_type", "type_source", "review_status", "dedupe_key")
    select
      ${ownerId}, ${accountId},
      (${`${year}-01-01`}::date + (n % 28) * interval '1 day')::date,
      'BULK ' || n,
      'BULK MERCHANT',
      1000 + n,
      'expense', 'default', 'confirmed',
      'bulk-' || n || '-' || ${accountId}
    from generate_series(1, ${count}) as n
  `;
}

describe('listTransactionsLedger', () => {
  it('defaults to ALL review statuses and types, unlike Review', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'confirmed' });
    await seedTransaction({ ownerId: owner, accountId, transactionType: 'transfer', reviewStatus: 'auto' });

    const page = await transactions.listTransactionsLedger(owner, { year: 2026 }, 1);
    expect(page.rows).toHaveLength(3);
    expect(page.totalCount).toBe(3);
  });

  it('filters by year, month, category, type, and status composed together', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    const match = await seedTransaction({
      ownerId: owner,
      accountId,
      date: '2026-03-10',
      transactionType: 'expense',
      categoryId: category.id,
      reviewStatus: 'confirmed',
    });
    await seedTransaction({
      ownerId: owner,
      accountId,
      date: '2026-04-10', // wrong month
      transactionType: 'expense',
      categoryId: category.id,
      reviewStatus: 'confirmed',
    });

    const page = await transactions.listTransactionsLedger(
      owner,
      {
        year: 2026,
        month: 3,
        categoryId: category.id,
        transactionType: 'expense',
        reviewStatus: 'confirmed',
      },
      1,
    );
    expect(page.rows.map((r) => r.id)).toEqual([match]);
  });

  it('"uncategorized" filters to category_id IS NULL', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const uncategorized = await seedTransaction({ ownerId: owner, accountId, categoryId: null });
    await seedTransaction({ ownerId: owner, accountId, categoryId: category.id });

    const page = await transactions.listTransactionsLedger(owner, { year: 2026, categoryId: 'uncategorized' }, 1);
    expect(page.rows.map((r) => r.id)).toEqual([uncategorized]);
  });

  it('searches both normalized merchant and raw description, case-insensitively', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const byMerchant = await seedTransaction({
      ownerId: owner,
      accountId,
      normalizedMerchant: 'Planet Fitness',
      description: 'PLANET FIT 4815',
    });
    const byDescription = await seedTransaction({
      ownerId: owner,
      accountId,
      normalizedMerchant: 'H-E-B',
      description: 'HEB PLANET FOODS #12',
    });
    await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'Amazon', description: 'AMZN MKTP' });

    const page = await transactions.listTransactionsLedger(owner, { year: 2026, search: 'planet' }, 1);
    expect(page.rows.map((r) => r.id).sort()).toEqual([byDescription, byMerchant].sort());
  });

  it('paginates with a stable newest-first order across pages', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await bulkSeedTransactions(owner, accountId, 150);

    const pageOne = await transactions.listTransactionsLedger(owner, { year: 2026 }, 1);
    const pageTwo = await transactions.listTransactionsLedger(owner, { year: 2026 }, 2);

    expect(pageOne.totalCount).toBe(150);
    expect(pageOne.rows).toHaveLength(100);
    expect(pageTwo.rows).toHaveLength(50);
    const pageOneIds = new Set(pageOne.rows.map((r) => r.id));
    for (const row of pageTwo.rows) expect(pageOneIds.has(row.id)).toBe(false);
  });

  it('owner isolation — never returns another owner’s rows', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const bobAccount = await makeAccountId(bob);
    await seedTransaction({ ownerId: alice, accountId: aliceAccount });
    await seedTransaction({ ownerId: bob, accountId: bobAccount });

    const alicePage = await transactions.listTransactionsLedger(alice, { year: 2026 }, 1);
    expect(alicePage.totalCount).toBe(1);
    expect(alicePage.rows[0]?.accountId).toBe(aliceAccount);
  });

  it('archived categories still resolve a name, not a broken join', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Old Travel', slug: 'old-travel', kind: 'spending' });
    await seedTransaction({ ownerId: owner, accountId, categoryId: category.id });
    await categories.archiveCategory(owner, category.id);

    const page = await transactions.listTransactionsLedger(owner, { year: 2026 }, 1);
    expect(page.rows[0]?.categoryName).toBe('Old Travel');
  });
});

describe('getLedgerSummary', () => {
  it('counts needs-review within the current filter', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'confirmed' });

    const summary = await transactions.getLedgerSummary(owner, { year: 2026 });
    expect(summary.totalCount).toBe(3);
    expect(summary.needsReviewCount).toBe(2);
  });

  /**
   * Replaces a test that asserted `getLedgerSummary().excludedCount === 2` for
   * exactly this fixture. That field is gone — the Transactions meta line that
   * rendered it ("N transfer/card payment transactions excluded from Monthly")
   * was removed as noise, and keeping the column would have left dead SQL.
   *
   * What is worth guarding survives: both legs of a linked pair are real,
   * separate rows, and `totalCount` counts them as two. Anything that later
   * wants a DOLLAR figure for excluded rows starts here and must read
   * `getLedgerSummary`'s doc comment first — a signed `SUM` over this fixture
   * is $0 and `SUM(ABS(...))` is $400, and neither is the $200 that actually
   * moved.
   */
  it('counts both legs of a linked pair as separate rows', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');
    await seedTransaction({
      ownerId: owner,
      accountId: checkingId,
      amountCents: 20000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    await seedTransaction({
      ownerId: owner,
      accountId: cardId,
      amountCents: -20000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });

    const summary = await transactions.getLedgerSummary(owner, { year: 2026 });
    expect(summary.totalCount).toBe(2);
  });

});

describe('historical category correction, via the exact M7 mutation function', () => {
  it('assigning a category on an old, already-committed transaction confirms it — same rule M7 uses', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      date: '2024-01-05', // long-committed history, not a recent import
      reviewStatus: 'needs_review',
      categoryId: null,
    });

    await transactions.updateTransactionCategory(owner, id, category.id, false);

    const page = await transactions.listTransactionsLedger(owner, { year: 2024 }, 1);
    const row = page.rows.find((r) => r.id === id);
    expect(row?.categoryId).toBe(category.id);
    expect(row?.reviewStatus).toBe('confirmed');
  });

  it('does not silently update merchant memory unless rememberMerchant is explicitly true', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Dining', slug: 'dining', kind: 'spending' });
    const id = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'VIA 313', categoryId: null });

    await transactions.updateTransactionCategory(owner, id, category.id, false);

    const { sql } = await harness();
    const memory = await sql`select * from "finance_merchant_memory" where "owner_id" = ${owner}`;
    expect(memory).toHaveLength(0);
  });
});

describe('updateTransactionMerchant / updateTransactionNote — post-commit editing (round-2 UX pass)', () => {
  async function getMerchantAndNotes(id: string): Promise<{ merchant: string | null; notes: string | null }> {
    const { sql } = await harness();
    const [row] = await sql<{ normalized_merchant: string | null; notes: string | null }[]>`
      select "normalized_merchant", "notes" from "finance_transactions" where "id" = ${id}
    `;
    return { merchant: row?.normalized_merchant ?? null, notes: row?.notes ?? null };
  }

  it('corrects the display name without touching dedupe identity or merchant memory', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const id = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'ORIGINAL NAME' });

    await transactions.updateTransactionMerchant(owner, id, 'RENAMED MERCHANT');

    expect((await getMerchantAndNotes(id)).merchant).toBe('RENAMED MERCHANT');
    const { sql } = await harness();
    const memory = await sql`select * from "finance_merchant_memory" where "owner_id" = ${owner}`;
    expect(memory).toHaveLength(0);
  });

  it('sets and clears a note', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const id = await seedTransaction({ ownerId: owner, accountId });

    await transactions.updateTransactionNote(owner, id, 'Split with roommate');
    expect((await getMerchantAndNotes(id)).notes).toBe('Split with roommate');

    await transactions.updateTransactionNote(owner, id, null);
    expect((await getMerchantAndNotes(id)).notes).toBeNull();
  });

  it('refuses to edit a transaction owned by someone else', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const id = await seedTransaction({ ownerId: alice, accountId: aliceAccount, normalizedMerchant: 'ALICE MERCHANT' });

    await expect(transactions.updateTransactionMerchant(bob, id, 'HIJACKED')).rejects.toThrow();
    await expect(transactions.updateTransactionNote(bob, id, 'hijacked note')).rejects.toThrow();
    expect((await getMerchantAndNotes(id)).merchant).toBe('ALICE MERCHANT');
  });
});

describe('historical type correction and counterpart unlink, via the exact M7 mutation function', () => {
  it('correcting one leg of an old linked pair unlinks BOTH sides, exactly as M7’s own suite proves', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    const a = await seedTransaction({
      ownerId: owner,
      accountId: checkingId,
      date: '2024-06-01',
      amountCents: 20000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    const b = await seedTransaction({
      ownerId: owner,
      accountId: cardId,
      date: '2024-06-02',
      amountCents: -20000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
      categoryId: category.id,
      categorizationSource: 'merchant_memory',
    });
    await linkCounterparts(a, b);

    await transactions.updateTransactionType(owner, a, 'expense');

    const { sql } = await harness();
    const [rowA] = await sql<{ type_source: string; counterpart_transaction_id: string | null }[]>`
      select "type_source", "counterpart_transaction_id" from "finance_transactions" where "id" = ${a}
    `;
    const [rowB] = await sql<{
      transaction_type: string;
      type_source: string;
      counterpart_transaction_id: string | null;
      category_id: string | null;
    }[]>`
      select "transaction_type", "type_source", "counterpart_transaction_id", "category_id"
      from "finance_transactions" where "id" = ${b}
    `;

    expect(rowA?.type_source).toBe('manual_confirmation');
    expect(rowA?.counterpart_transaction_id).toBeNull();
    // The freed leg reverts to its M5 default by sign (negative => income) and
    // its category is left untouched — the same both-sides guarantee M7's own
    // suite proves, now exercised through the Transactions path instead.
    expect(rowB?.transaction_type).toBe('income');
    expect(rowB?.type_source).toBe('default');
    expect(rowB?.counterpart_transaction_id).toBeNull();
    expect(rowB?.category_id).toBe(category.id);
  });
});

describe('a Transactions edit is immediately reflected in M8 aggregation', () => {
  it('assigning a category to a needs_review transaction moves it into the grid total', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      date: '2026-07-10',
      amountCents: 4500,
      reviewStatus: 'needs_review',
      categoryId: null,
    });

    const before = await grid.getMonthlyGridAggregates(owner, 2026);
    expect(before.find((r) => r.categoryId === category.id)).toBeUndefined();

    await transactions.updateTransactionCategory(owner, id, category.id, false);

    const after = await grid.getMonthlyGridAggregates(owner, 2026);
    const row = after.find((r) => r.categoryId === category.id && r.month === 7);
    expect(row?.totalCents).toBe(4500);
  });
});

describe('needs-review and exclusionary types appear in the ledger, unlike Monthly', () => {
  it('a needs_review row and a transfer row both show up by default', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const needsReview = await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });
    const transfer = await seedTransaction({ ownerId: owner, accountId, transactionType: 'transfer' });

    const page = await transactions.listTransactionsLedger(owner, { year: 2026 }, 1);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(needsReview);
    expect(ids).toContain(transfer);

    // Contrast: M8's own grid excludes both, by design — proving the ledger
    // isn't just a copy of the same filter under a different name.
    const aggregates = await grid.getMonthlyGridAggregates(owner, 2026);
    const gridTotal = aggregates.reduce((sum, row) => sum + row.txnCount, 0);
    expect(gridTotal).toBe(0);
  });
});

describe('listTransactionsForExport', () => {
  it('respects the same filters as the listing', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const match = await seedTransaction({ ownerId: owner, accountId, categoryId: category.id });
    await seedTransaction({ ownerId: owner, accountId, categoryId: null });

    const result = await transactions.listTransactionsForExport(owner, { year: 2026, categoryId: category.id });
    expect(result.exceedsLimit).toBe(false);
    expect(result.rows.map((r) => r.id)).toEqual([match]);
  });

  it('row count and summed amount match a direct SQL sum for the same filter — CSV round trip', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, amountCents: 5914, description: 'HEB #1' });
    await seedTransaction({ ownerId: owner, accountId, amountCents: 2019, description: 'MORTGAGE' });
    await seedTransaction({ ownerId: owner, accountId, amountCents: -3000, description: 'REFUND' });

    const { sql } = await harness();
    const [expected] = await sql<{ n: string; total: string }[]>`
      select count(*)::text as n, sum("amount_cents")::text as total
      from "finance_transactions" where "owner_id" = ${owner}
    `;

    const { rows, exceedsLimit } = await transactions.listTransactionsForExport(owner, { year: 2026 });
    expect(exceedsLimit).toBe(false);
    expect(rows).toHaveLength(Number(expected?.n));
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(Number(expected?.total));

    // And the CSV text itself parses back to the same row count and total —
    // proving the export module renders exactly what the DB returned.
    const csv = csvExport.buildTransactionsCsv(
      rows.map((r) => ({
        transactionDate: r.transactionDate,
        normalizedMerchant: r.normalizedMerchant,
        originalDescription: r.originalDescription,
        amountCents: r.amountCents,
        categoryName: r.categoryName,
        transactionTypeLabel: r.transactionType,
        reviewStatusLabel: r.reviewStatus,
        categorizationSourceLabel: r.categorizationSource,
        typeSourceLabel: r.typeSource,
      })),
    );
    const dataLines = csv.split('\r\n').filter(Boolean).slice(1);
    expect(dataLines).toHaveLength(Number(expected?.n));
    const csvTotalCents = dataLines.reduce((sum, line) => {
      const amountField = Number(line.split(',')[3]) * 100;
      return sum + Math.round(amountField);
    }, 0);
    expect(csvTotalCents).toBe(Number(expected?.total));
  });

  it('fails visibly — never silently truncates — past the export row cap', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await bulkSeedTransactions(owner, accountId, transactions.LEDGER_EXPORT_ROW_LIMIT + 1);

    const result = await transactions.listTransactionsForExport(owner, { year: 2026 });
    expect(result.exceedsLimit).toBe(true);
    expect(result.rows).toHaveLength(transactions.LEDGER_EXPORT_ROW_LIMIT);
  }, 30_000);

  it('owner isolation — export never crosses owners', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const bobAccount = await makeAccountId(bob);
    await seedTransaction({ ownerId: alice, accountId: aliceAccount });
    await seedTransaction({ ownerId: bob, accountId: bobAccount });

    const { rows } = await transactions.listTransactionsForExport(alice, { year: 2026 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(aliceAccount);
  });
});

import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * M8's aggregate and drill-down queries, against real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MOST IMPORTANT TEST IN THIS FILE
 *
 * "the drill-down total must mathematically equal the grid cell" is not
 * asserted by reading the code — `gridBaseConditions()` being shared is what
 * makes it TRUE, but only a test that runs both queries and compares real
 * numbers proves it stays true. See "drill-down mathematically agrees with
 * the aggregate" below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Accounts = typeof import('@/server/db/finance/accounts');
type Categories = typeof import('@/server/db/finance/categories');
type Grid = typeof import('@/server/db/finance/grid');

let accounts: Accounts;
let categories: Categories;
let grid: Grid;

beforeAll(async () => {
  await harness();
  [accounts, categories, grid] = await Promise.all([
    import('@/server/db/finance/accounts'),
    import('@/server/db/finance/categories'),
    import('@/server/db/finance/grid'),
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

async function makeAccountId(ownerId: string, name = 'Checking'): Promise<string> {
  const account = await accounts.createAccount(ownerId, {
    name: `${name} ${randomUUID().slice(0, 8)}`,
    type: 'checking',
    institution: null,
    lastFour: null,
  });
  return account.id;
}

interface SeedTxn {
  readonly ownerId: string;
  readonly accountId: string;
  readonly date: string;
  readonly amountCents?: number;
  readonly transactionType?: string;
  readonly reviewStatus?: string;
  readonly categoryId?: string | null;
  readonly description?: string;
  readonly merchant?: string;
}

async function seedTransaction(options: SeedTxn): Promise<string> {
  const { sql } = await harness();
  const rows = await sql<{ id: string }[]>`
    insert into "finance_transactions"
      ("owner_id", "account_id", "transaction_date", "original_description", "normalized_merchant",
       "amount_cents", "transaction_type", "type_source", "review_status", "category_id", "dedupe_key")
    values
      (${options.ownerId}, ${options.accountId}, ${options.date},
       ${options.description ?? 'TEST TRANSACTION'}, ${options.merchant ?? 'TEST TRANSACTION'},
       ${options.amountCents ?? 1000}, ${options.transactionType ?? 'expense'}, 'default',
       ${options.reviewStatus ?? 'confirmed'}, ${options.categoryId ?? null}, ${randomUUID()})
    returning "id"
  `;
  return rows[0]!.id;
}

describe('getMonthlyGridAggregates — the base filter', () => {
  it('excludes needs_review entirely', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-10', categoryId: category.id, reviewStatus: 'needs_review' });

    const rows = await grid.getMonthlyGridAggregates(owner, 2026);
    expect(rows).toHaveLength(0);
  });

  it('includes both confirmed and auto', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-10', categoryId: category.id, reviewStatus: 'confirmed', amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-11', categoryId: category.id, reviewStatus: 'auto', amountCents: 2000 });

    const rows = await grid.getMonthlyGridAggregates(owner, 2026);
    const total = rows.reduce((sum, r) => sum + r.totalCents, 0);
    expect(total).toBe(3000);
  });

  it('excludes transfer and credit_card_payment even when categorized', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Misc', slug: 'misc', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-10', categoryId: category.id, transactionType: 'transfer', amountCents: 50000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-10', categoryId: category.id, transactionType: 'credit_card_payment', amountCents: 20000 });

    const rows = await grid.getMonthlyGridAggregates(owner, 2026);
    expect(rows).toHaveLength(0);
  });

  it('includes investment (present in the grid, unlike transfer/credit_card_payment)', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Stocks', slug: 'stocks', kind: 'investment' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-10', categoryId: category.id, transactionType: 'investment', amountCents: 80000 });

    const rows = await grid.getMonthlyGridAggregates(owner, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transactionType).toBe('investment');
  });

  it('respects the year boundary — Dec 31 counts, the next Jan 1 does not', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-12-31', categoryId: category.id, amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2027-01-01', categoryId: category.id, amountCents: 2000 });

    const rows2026 = await grid.getMonthlyGridAggregates(owner, 2026);
    expect(rows2026.reduce((sum, r) => sum + r.totalCents, 0)).toBe(1000);

    const rows2027 = await grid.getMonthlyGridAggregates(owner, 2027);
    expect(rows2027.reduce((sum, r) => sum + r.totalCents, 0)).toBe(2000);
  });

  it('a refund nets against its category via plain SUM, no special case', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Food', slug: 'food', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-01', categoryId: category.id, amountCents: 6000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-05', categoryId: category.id, transactionType: 'refund', amountCents: -3000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-10', categoryId: category.id, amountCents: 5914 });

    const rows = await grid.getMonthlyGridAggregates(owner, 2026);
    const total = rows.reduce((sum, r) => sum + r.totalCents, 0);
    expect(total).toBe(8914);
  });

  it('never crosses owners', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const bobAccount = await makeAccountId(bob);
    const aliceCategory = await categories.createCategory(alice, { name: 'Gas', slug: 'gas', kind: 'spending' });

    await seedTransaction({ ownerId: alice, accountId: aliceAccount, date: '2026-03-10', categoryId: aliceCategory.id, amountCents: 1000 });
    await seedTransaction({ ownerId: bob, accountId: bobAccount, date: '2026-03-10', categoryId: null, amountCents: 2000 });

    const aliceRows = await grid.getMonthlyGridAggregates(alice, 2026);
    expect(aliceRows.reduce((sum, r) => sum + r.totalCents, 0)).toBe(1000);
  });
});

describe('drill-down mathematically agrees with the aggregate', () => {
  it('a category cell', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Groceries', slug: 'groceries', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-03', categoryId: category.id, amountCents: 4200 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-15', categoryId: category.id, amountCents: 3100 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-06-01', categoryId: category.id, amountCents: 9999 });
    // A different category, same month — must not leak into the cell.
    const other = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-20', categoryId: other.id, amountCents: 5000 });

    const aggregateRows = await grid.getMonthlyGridAggregates(owner, 2026);
    const mayGroceries = aggregateRows.filter((r) => r.month === 5 && r.categoryId === category.id);
    const aggregateCents = mayGroceries.reduce((sum, r) => sum + r.totalCents, 0);

    const drillDown = await grid.getCellTransactions(owner, 2026, 5, { kind: 'category', categoryId: category.id });
    const drillDownCents = drillDown.reduce((sum, t) => sum + t.amountCents, 0);

    expect(drillDownCents).toBe(aggregateCents);
    expect(drillDownCents).toBe(7300);
    expect(drillDown).toHaveLength(2);
  });

  it('the Total Expenditure cell', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const spending = await categories.createCategory(owner, { name: 'Groceries', slug: 'groceries', kind: 'spending' });
    const investment = await categories.createCategory(owner, { name: 'Stocks', slug: 'stocks', kind: 'investment' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-01', categoryId: spending.id, amountCents: 4183_00 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-02', categoryId: investment.id, transactionType: 'investment', amountCents: 800_00 });
    // income must be excluded from this one.
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-03', categoryId: null, transactionType: 'income', amountCents: -640000 });

    const aggregateRows = await grid.getMonthlyGridAggregates(owner, 2026);
    const julyExpenditure = aggregateRows
      .filter((r) => r.month === 7 && r.transactionType !== 'income')
      .reduce((sum, r) => sum + r.totalCents, 0);

    const drillDown = await grid.getCellTransactions(owner, 2026, 7, { kind: 'expenditure' });
    const drillDownCents = drillDown.reduce((sum, t) => sum + t.amountCents, 0);

    expect(drillDownCents).toBe(julyExpenditure);
    expect(drillDownCents).toBe(4983_00);
    expect(drillDown.every((t) => t.transactionType !== 'income')).toBe(true);
  });

  it('the Income cell', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Salary', slug: 'salary', kind: 'income' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-04-01', categoryId: category.id, transactionType: 'income', amountCents: -640000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-04-15', categoryId: null, transactionType: 'income', amountCents: -50000 });

    const aggregateRows = await grid.getMonthlyGridAggregates(owner, 2026);
    const aprilIncome = -aggregateRows
      .filter((r) => r.month === 4 && r.transactionType === 'income')
      .reduce((sum, r) => sum + r.totalCents, 0);

    const drillDown = await grid.getCellTransactions(owner, 2026, 4, { kind: 'income' });
    // Drill-down returns raw signed amounts; the UI flips for display.
    const drillDownCents = -drillDown.reduce((sum, t) => sum + t.amountCents, 0);

    expect(drillDownCents).toBe(aprilIncome);
    expect(drillDownCents).toBe(690000);
  });

  it('the year Total row (month: null)', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-01-05', categoryId: category.id, amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-11-20', categoryId: category.id, amountCents: 2000 });

    const aggregateRows = await grid.getMonthlyGridAggregates(owner, 2026);
    const yearTotal = aggregateRows
      .filter((r) => r.categoryId === category.id)
      .reduce((sum, r) => sum + r.totalCents, 0);

    const drillDown = await grid.getCellTransactions(owner, 2026, null, { kind: 'category', categoryId: category.id });
    const drillDownCents = drillDown.reduce((sum, t) => sum + t.amountCents, 0);

    expect(drillDownCents).toBe(yearTotal);
    expect(drillDownCents).toBe(3000);
    expect(drillDown).toHaveLength(2);
  });

  it('drill-down carries the raw description alongside the normalized merchant', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Food', slug: 'food', kind: 'spending' });

    await seedTransaction({
      ownerId: owner,
      accountId,
      date: '2026-05-26',
      categoryId: category.id,
      description: "LARSEN'S #0366 2 05/26 PURCHASE SPRINGFIELD TX",
      merchant: "LARSEN'S",
    });

    const [transaction] = await grid.getCellTransactions(owner, 2026, 5, { kind: 'category', categoryId: category.id });
    expect(transaction?.normalizedMerchant).toBe("LARSEN'S");
    expect(transaction?.originalDescription).toBe("LARSEN'S #0366 2 05/26 PURCHASE SPRINGFIELD TX");
  });

  it('the invariant-violation case: a confirmed, uncategorized expense shows up in the Total Expenditure drill-down', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    const id = await seedTransaction({ ownerId: owner, accountId, date: '2026-09-10', categoryId: null, amountCents: 4200 });

    const drillDown = await grid.getCellTransactions(owner, 2026, 9, { kind: 'expenditure' });
    expect(drillDown.map((t) => t.id)).toEqual([id]);
    expect(drillDown[0]?.categoryName).toBeNull();
  });
});

describe('listTransactionYears', () => {
  it('lists every distinct year, most recent first, regardless of review status or type', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    await seedTransaction({ ownerId: owner, accountId, date: '2024-06-01', reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-01-01', transactionType: 'transfer' });

    expect(await grid.listTransactionYears(owner)).toEqual([2026, 2024]);
  });

  it('is empty for an owner with no transactions', async () => {
    const owner = await makeOwner('owner@burmy.test');
    expect(await grid.listTransactionYears(owner)).toEqual([]);
  });
});

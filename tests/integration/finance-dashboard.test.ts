import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The dashboard's own aggregate queries (M11), against real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MOST IMPORTANT TEST IN THIS FILE
 *
 * "sum of category totals for one month equals that month's expense total"
 * is not asserted by reading the code — both queries sharing
 * `dashboardBaseConditions()` and the same non-income filter is what makes it
 * TRUE, but only a test that runs both queries against the same real rows and
 * compares real numbers proves it stays true. See "reconciliation" below.
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

describe('getMonthlyTotalsAllTime', () => {
  it('sign-flips income to a positive display figure, like the grid’s own Income column', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    await seedTransaction({ ownerId: owner, accountId, date: '2026-04-01', transactionType: 'income', amountCents: -640000 });

    const rows = await grid.getMonthlyTotalsAllTime(owner);
    expect(rows).toEqual([expect.objectContaining({ year: 2026, month: 4, incomeCents: 640000, expenseCents: 0 })]);
  });

  it('a month with no income at all reports incomeCents 0, not -0', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-04-01', amountCents: 1000 });

    const rows = await grid.getMonthlyTotalsAllTime(owner);
    expect(Object.is(rows[0]!.incomeCents, -0)).toBe(false);
    expect(rows[0]!.incomeCents).toBe(0);
  });

  it('expenseCents includes investment, excludes transfer/credit_card_payment/income', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-01', amountCents: 418300 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-02', transactionType: 'investment', amountCents: 80000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-03', transactionType: 'transfer', amountCents: 50000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-04', transactionType: 'credit_card_payment', amountCents: 20000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-05', transactionType: 'income', amountCents: -640000 });

    const rows = await grid.getMonthlyTotalsAllTime(owner);
    expect(rows).toEqual([expect.objectContaining({ expenseCents: 498300, incomeCents: 640000 })]);
  });

  it('excludes needs_review from every figure', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-03-10', reviewStatus: 'needs_review', amountCents: 5000 });

    const rows = await grid.getMonthlyTotalsAllTime(owner);
    expect(rows).toEqual([]);
  });

  it('groups by (year, month) across the owner’s entire history, ascending', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2025-01-15', amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-01-15', amountCents: 2000 });

    const rows = await grid.getMonthlyTotalsAllTime(owner);
    expect(rows.map((r) => `${r.year}-${r.month}`)).toEqual(['2025-1', '2026-1']);
  });

  it('never crosses owners', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    await seedTransaction({ ownerId: alice, accountId: await makeAccountId(alice), date: '2026-03-10', amountCents: 1000 });
    await seedTransaction({ ownerId: bob, accountId: await makeAccountId(bob), date: '2026-03-10', amountCents: 99900 });

    const rows = await grid.getMonthlyTotalsAllTime(alice);
    expect(rows).toEqual([expect.objectContaining({ expenseCents: 1000 })]);
  });

  it('three identical-amount transactions sum to exactly three times, not more (no join fanout)', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-01', amountCents: 1500 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-02', amountCents: 1500 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-03', amountCents: 1500 });

    const rows = await grid.getMonthlyTotalsAllTime(owner);
    expect(rows).toEqual([expect.objectContaining({ expenseCents: 4500, transactionCount: 3 })]);
  });
});

describe('getCategoryTotalsForWindow', () => {
  it('excludes income, includes an uncategorized (null) bucket', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Groceries', slug: 'groceries', kind: 'spending' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-06-05', categoryId: category.id, amountCents: 6000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-06-06', categoryId: null, amountCents: 4000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-06-07', transactionType: 'income', amountCents: -500000 });

    const rows = await grid.getCategoryTotalsForWindow(owner, '2026-06-01', '2026-07-01');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.categoryId === category.id)?.amountCents).toBe(6000);
    expect(rows.find((r) => r.categoryId === null)?.amountCents).toBe(4000);
  });

  it('respects the window bounds — start inclusive, end exclusive', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-05-31', amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-06-01', amountCents: 2000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-07-01', amountCents: 4000 });

    const rows = await grid.getCategoryTotalsForWindow(owner, '2026-06-01', '2026-07-01');
    const total = rows.reduce((sum, r) => sum + r.amountCents, 0);
    expect(total).toBe(2000);
  });

  it('reconciles exactly with getMonthlyTotalsAllTime’s expenseCents for the same month', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const groceries = await categories.createCategory(owner, { name: 'Groceries', slug: 'groceries', kind: 'spending' });
    const gas = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const stocks = await categories.createCategory(owner, { name: 'Stocks', slug: 'stocks', kind: 'investment' });

    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-01', categoryId: groceries.id, amountCents: 6000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-05', categoryId: gas.id, amountCents: 3500 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-08', categoryId: stocks.id, transactionType: 'investment', amountCents: 80000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-10', categoryId: null, amountCents: 1250 });
    // Excluded from both sides identically — must not break the reconciliation.
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-12', categoryId: null, transactionType: 'transfer', amountCents: 50000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-15', categoryId: null, transactionType: 'income', amountCents: -640000 });

    const [monthlyTotals, categoryTotals] = await Promise.all([
      grid.getMonthlyTotalsAllTime(owner),
      grid.getCategoryTotalsForWindow(owner, '2026-08-01', '2026-09-01'),
    ]);

    const augustExpense = monthlyTotals.find((r) => r.year === 2026 && r.month === 8)!.expenseCents;
    const categorySum = categoryTotals.reduce((sum, r) => sum + r.amountCents, 0);

    expect(categorySum).toBe(augustExpense);
    expect(categorySum).toBe(90750);
  });
});

describe('getDailyTotalsForMonth', () => {
  it('groups spending by day of month, excluding income', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-09-01', amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-09-01', amountCents: 500 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-09-14', amountCents: 9000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-09-14', transactionType: 'income', amountCents: -640000 });

    const rows = await grid.getDailyTotalsForMonth(owner, 2026, 9);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day: 1, amountCents: 1500 }),
        expect.objectContaining({ day: 14, amountCents: 9000 }),
      ]),
    );
  });

  it('is scoped to exactly one month', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-08-31', amountCents: 1000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-09-01', amountCents: 2000 });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-10-01', amountCents: 4000 });

    const rows = await grid.getDailyTotalsForMonth(owner, 2026, 9);
    expect(rows).toEqual([expect.objectContaining({ day: 1, amountCents: 2000 })]);
  });
});

describe('getTopExpensesForMonth', () => {
  it('orders by amount descending and respects the limit', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, date: '2026-10-01', amountCents: 1000, merchant: 'Small' });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-10-02', amountCents: 9000, merchant: 'Big' });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-10-03', amountCents: 5000, merchant: 'Medium' });

    const rows = await grid.getTopExpensesForMonth(owner, 2026, 10, 2);
    expect(rows.map((r) => r.normalizedMerchant)).toEqual(['Big', 'Medium']);
  });

  it('excludes income and carries the category name via the join', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Groceries', slug: 'groceries', kind: 'spending' });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-10-01', categoryId: category.id, amountCents: 6000, merchant: 'H-E-B' });
    await seedTransaction({ ownerId: owner, accountId, date: '2026-10-02', transactionType: 'income', amountCents: -640000, merchant: 'Payroll' });

    const rows = await grid.getTopExpensesForMonth(owner, 2026, 10, 10);
    expect(rows).toEqual([expect.objectContaining({ normalizedMerchant: 'H-E-B', categoryName: 'Groceries', amountCents: 6000 })]);
  });

  it('an empty month returns an empty list, not fabricated rows', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const rows = await grid.getTopExpensesForMonth(owner, 2026, 10, 10);
    expect(rows).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { type GridAggregateRow, type GridCategoryMeta, buildMonthlyGrid } from '@/server/finance/grid';

function row(overrides: Partial<GridAggregateRow>): GridAggregateRow {
  return {
    month: 1,
    categoryId: 'cat-1',
    transactionType: 'expense',
    totalCents: 1000,
    txnCount: 1,
    ...overrides,
  };
}

function category(overrides: Partial<GridCategoryMeta>): GridCategoryMeta {
  return {
    id: 'cat-1',
    name: 'Groceries',
    kind: 'spending',
    sortOrder: 0,
    archived: false,
    ...overrides,
  };
}

describe('buildMonthlyGrid — category cells', () => {
  it('sums multiple rows sharing a month and category', () => {
    const grid = buildMonthlyGrid(
      [
        row({ month: 3, categoryId: 'cat-1', totalCents: 2000, txnCount: 1 }),
        row({ month: 3, categoryId: 'cat-1', transactionType: 'refund', totalCents: -500, txnCount: 1 }),
      ],
      [category({})],
    );

    const march = grid.rows[2]!;
    expect(march.cells['cat-1']).toEqual({ amountCents: 1500, txnCount: 2 });
  });

  it('a category with zero contributing transactions has no cell entry — the "—" case', () => {
    const grid = buildMonthlyGrid([row({ month: 3 })], [category({}), category({ id: 'cat-2', name: 'Gas' })]);
    expect(grid.rows[2]!.cells['cat-2']).toBeUndefined();
  });

  it('a category whose transactions net to exactly zero still has a cell — stays drillable, not "—"', () => {
    const grid = buildMonthlyGrid(
      [
        row({ month: 1, totalCents: 2000, txnCount: 1 }),
        row({ month: 1, transactionType: 'refund', totalCents: -2000, txnCount: 1 }),
      ],
      [category({})],
    );
    expect(grid.rows[0]!.cells['cat-1']).toEqual({ amountCents: 0, txnCount: 2 });
  });
});

describe('buildMonthlyGrid — column order (owner sort_order is authoritative)', () => {
  it('preserves sort_order across kinds — never regroups spending/investment/income into blocks', () => {
    const categories = [
      category({ id: 'a', name: 'Salary', kind: 'income', sortOrder: 0 }),
      category({ id: 'b', name: 'Groceries', kind: 'spending', sortOrder: 1 }),
      category({ id: 'c', name: 'Stocks', kind: 'investment', sortOrder: 2 }),
      category({ id: 'd', name: 'Gas', kind: 'spending', sortOrder: 3 }),
    ];
    const grid = buildMonthlyGrid([], categories);
    expect(grid.columns.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('archived categories WITH history in the year get a column, appended after live ones', () => {
    const categories = [
      category({ id: 'live', sortOrder: 5 }),
      category({ id: 'archived-with-history', name: 'Old Rent', sortOrder: 0, archived: true }),
    ];
    const grid = buildMonthlyGrid([row({ categoryId: 'archived-with-history' })], categories);
    expect(grid.columns.map((c) => c.id)).toEqual(['live', 'archived-with-history']);
    expect(grid.columns[1]!.archived).toBe(true);
  });

  it('archived categories WITHOUT history in the year get no column at all', () => {
    const categories = [category({ id: 'live' }), category({ id: 'archived-empty', archived: true })];
    const grid = buildMonthlyGrid([row({ categoryId: 'live' })], categories);
    expect(grid.columns.map((c) => c.id)).toEqual(['live']);
  });

  it('a live category with zero activity all year is still a column', () => {
    const grid = buildMonthlyGrid([], [category({})]);
    expect(grid.columns).toHaveLength(1);
  });
});

describe('buildMonthlyGrid — Total Expenditure, Income, Gross Savings', () => {
  it('Total Expenditure includes expense/refund/fee/adjustment/investment, excludes income', () => {
    const rows = [
      row({ month: 1, transactionType: 'expense', totalCents: 5000, categoryId: null }),
      row({ month: 1, transactionType: 'refund', totalCents: -1000, categoryId: null }),
      row({ month: 1, transactionType: 'fee', totalCents: 300, categoryId: null }),
      row({ month: 1, transactionType: 'adjustment', totalCents: 200, categoryId: null }),
      row({ month: 1, transactionType: 'investment', totalCents: 8000, categoryId: null }),
      row({ month: 1, transactionType: 'income', totalCents: -640000, categoryId: null }),
    ];
    const january = buildMonthlyGrid(rows, []).rows[0]!;
    expect(january.totalExpenditureCents).toBe(5000 - 1000 + 300 + 200 + 8000);
  });

  it('Income is the negated sum of income-typed rows only', () => {
    const rows = [
      row({ month: 1, transactionType: 'income', totalCents: -640000, categoryId: null }),
      row({ month: 1, transactionType: 'income', totalCents: -50000, categoryId: null }),
      row({ month: 1, transactionType: 'expense', totalCents: 1000, categoryId: null }),
    ];
    const january = buildMonthlyGrid(rows, []).rows[0]!;
    expect(january.incomeCents).toBe(690000);
  });

  it('Gross Savings = Income - Total Expenditure, and can go negative (spent more than earned)', () => {
    const rows = [
      row({ month: 1, transactionType: 'income', totalCents: -100000, categoryId: null }),
      row({ month: 1, transactionType: 'expense', totalCents: 150000, categoryId: null }),
    ];
    const january = buildMonthlyGrid(rows, []).rows[0]!;
    expect(january.incomeCents).toBe(100000);
    expect(january.totalExpenditureCents).toBe(150000);
    expect(january.grossSavingsCents).toBe(100000 - 150000);
    expect(january.grossSavingsCents).toBeLessThan(0);
  });

  it('an empty month (no transactions at all) computes to all zeros, not an error', () => {
    const january = buildMonthlyGrid([], [category({})]).rows[0]!;
    expect(january.totalExpenditureCents).toBe(0);
    expect(january.incomeCents).toBe(0);
    expect(january.grossSavingsCents).toBe(0);
    expect(Object.keys(january.cells)).toHaveLength(0);
  });
});

describe('buildMonthlyGrid — the invariant-violation (unreconciled) bucket', () => {
  it('a confirmed/auto non-exclusionary transaction with no category is still counted in the totals', () => {
    const rows = [row({ month: 1, categoryId: null, transactionType: 'expense', totalCents: 4200, txnCount: 1 })];
    const january = buildMonthlyGrid(rows, []).rows[0]!;
    expect(january.totalExpenditureCents).toBe(4200);
  });

  it('...but appears in NO category cell, and is captured in unreconciledCount/unreconciledCents', () => {
    const rows = [row({ month: 1, categoryId: null, transactionType: 'expense', totalCents: 4200, txnCount: 1 })];
    const grid = buildMonthlyGrid(rows, [category({})]);
    expect(grid.rows[0]!.cells['cat-1']).toBeUndefined();
    expect(grid.rows[0]!.unreconciledCount).toBe(1);
    expect(grid.rows[0]!.unreconciledCents).toBe(4200);
    expect(grid.unreconciled).toEqual({ count: 1, totalCents: 4200 });
  });

  it('is zero when every confirmed/auto transaction has a category — the normal, expected case', () => {
    const grid = buildMonthlyGrid([row({ categoryId: 'cat-1' })], [category({})]);
    expect(grid.unreconciled).toEqual({ count: 0, totalCents: 0 });
  });

  it('never counts income with no category — income does not need one', () => {
    const rows = [row({ month: 1, categoryId: null, transactionType: 'income', totalCents: -50000, txnCount: 1 })];
    const grid = buildMonthlyGrid(rows, [category({})]);
    expect(grid.rows[0]!.incomeCents).toBe(50000);
    expect(grid.unreconciled).toEqual({ count: 0, totalCents: 0 });
  });
});

describe('buildMonthlyGrid — the year Total row', () => {
  it('sums every month, and reconciles exactly with the per-month rows', () => {
    const rows = [
      row({ month: 1, categoryId: 'cat-1', totalCents: 1000, txnCount: 1 }),
      row({ month: 6, categoryId: 'cat-1', totalCents: 2000, txnCount: 1 }),
      row({ month: 12, categoryId: 'cat-1', transactionType: 'income', totalCents: -50000, txnCount: 1 }),
    ];
    const grid = buildMonthlyGrid(rows, [category({})]);

    const expectedExpenditure = grid.rows.reduce((sum, r) => sum + r.totalExpenditureCents, 0);
    const expectedIncome = grid.rows.reduce((sum, r) => sum + r.incomeCents, 0);
    const expectedCell = grid.rows.reduce((sum, r) => sum + (r.cells['cat-1']?.amountCents ?? 0), 0);

    expect(grid.yearTotal.totalExpenditureCents).toBe(expectedExpenditure);
    expect(grid.yearTotal.incomeCents).toBe(expectedIncome);
    expect(grid.yearTotal.cells['cat-1']?.amountCents).toBe(expectedCell);
    expect(grid.yearTotal.grossSavingsCents).toBe(expectedIncome - expectedExpenditure);
  });
});

describe('buildMonthlyGrid — exclusionary types are the caller\'s job, not this function\'s', () => {
  it('does not special-case transfer/credit_card_payment — the SQL layer excludes them before this runs', () => {
    // This function trusts its input; the exclusion is `db/finance/grid.ts`'s
    // `gridBaseConditions()`, verified in the integration suite. Included here
    // only to document that a transfer ROW, if it somehow reached this
    // function, would be counted like anything else — a reason the SQL-level
    // exclusion matters, not a redundant safety net.
    const rows = [row({ month: 1, transactionType: 'transfer', totalCents: 99999, categoryId: null })];
    const january = buildMonthlyGrid(rows, []).rows[0]!;
    expect(january.totalExpenditureCents).toBe(99999);
  });
});

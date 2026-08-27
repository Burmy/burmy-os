import { describe, expect, it } from 'vitest';

import {
  buildAnnualCategoryBreakdown,
  buildCategoryBreakdown,
  buildCategoryTrend,
  buildTrend,
  buildYearlyBreakdown,
  compareToBaseline,
  compareToPreviousMonth,
  type MonthSummary,
  computeAverageDailySpending,
  computeSavingsRate,
  computeYtdSummary,
  daysInMonth,
  findBiggestSpendingDay,
  findExtremeMonth,
  monthRange,
  previousMonth,
  toMonthSummary,
  type CategoryMeta,
} from '@/server/finance/dashboard';
import type { CategoryMonthlyTotal, MonthlyTotal } from '@/server/db/finance/grid';

function total(overrides: Partial<MonthlyTotal>): MonthlyTotal {
  return { year: 2026, month: 1, incomeCents: 0, expenseCents: 0, transactionCount: 0, ...overrides };
}

function catRow(overrides: Partial<CategoryMonthlyTotal>): CategoryMonthlyTotal {
  return { year: 2026, month: 1, categoryId: 'cat-1', amountCents: 1000, txnCount: 1, ...overrides };
}

const CATEGORIES: CategoryMeta[] = [
  { id: 'cat-1', name: 'Groceries' },
  { id: 'cat-2', name: 'Gas' },
  { id: null, name: 'Uncategorized' },
];

describe('date math', () => {
  it('daysInMonth handles a leap February', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('monthRange gives an exclusive end that rolls into the next year at December', () => {
    expect(monthRange(2026, 12)).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01' });
  });

  it('previousMonth crosses the year boundary at January', () => {
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(previousMonth(2026, 6)).toEqual({ year: 2026, month: 5 });
  });
});

describe('toMonthSummary — income, expenses, net', () => {
  it('net is income minus expenses', () => {
    const summary = toMonthSummary(total({ incomeCents: 500000, expenseCents: 320000, transactionCount: 42 }));
    expect(summary.incomeCents).toBe(500000);
    expect(summary.expenseCents).toBe(320000);
    expect(summary.netCents).toBe(180000);
    expect(summary.transactionCount).toBe(42);
  });

  it('an empty month is all zeros, not fabricated', () => {
    const summary = toMonthSummary(total({}));
    expect(summary).toMatchObject({ incomeCents: 0, expenseCents: 0, netCents: 0, transactionCount: 0 });
  });

  it('never produces a negative-zero net for a zero/zero month', () => {
    const summary = toMonthSummary(total({ incomeCents: 0, expenseCents: 0 }));
    expect(Object.is(summary.netCents, -0)).toBe(false);
  });
});

describe('computeSavingsRate', () => {
  it('is (income - expense) / income * 100', () => {
    expect(computeSavingsRate(500000, 320000)).toBeCloseTo(36, 5);
  });

  it('is null for a zero-income month, never 0%', () => {
    expect(computeSavingsRate(0, 40000)).toBeNull();
  });

  it('can be negative when expenses exceed income', () => {
    expect(computeSavingsRate(100000, 150000)).toBeCloseTo(-50, 5);
  });
});

describe('computeAverageDailySpending', () => {
  it('divides expenses by the supplied divisor', () => {
    expect(computeAverageDailySpending(310000, 31)).toBeCloseTo(10000, 5);
  });

  it('a non-positive divisor is treated as no data, not a divide-by-zero crash', () => {
    expect(computeAverageDailySpending(50000, 0)).toBe(0);
  });
});

describe('compareToPreviousMonth', () => {
  it('null previous month yields no comparison at all', () => {
    expect(compareToPreviousMonth(toMonthSummary(total({})), null)).toBeNull();
  });

  it('lower expenses this month is favorable', () => {
    const current = toMonthSummary(total({ expenseCents: 30000 }));
    const previous = toMonthSummary(total({ expenseCents: 40000 }));
    const cmp = compareToPreviousMonth(current, previous)!;
    expect(cmp.expense.deltaCents).toBe(-10000);
    expect(cmp.expense.direction).toBe('favorable');
  });

  it('higher expenses this month is unfavorable', () => {
    const current = toMonthSummary(total({ expenseCents: 50000 }));
    const previous = toMonthSummary(total({ expenseCents: 40000 }));
    expect(compareToPreviousMonth(current, previous)!.expense.direction).toBe('unfavorable');
  });

  it('higher income this month is favorable, lower income is unfavorable', () => {
    const current = toMonthSummary(total({ incomeCents: 600000 }));
    const previous = toMonthSummary(total({ incomeCents: 500000 }));
    expect(compareToPreviousMonth(current, previous)!.income.direction).toBe('favorable');
    expect(compareToPreviousMonth(previous, current)!.income.direction).toBe('unfavorable');
  });

  it('higher net is favorable, lower net is unfavorable', () => {
    const current = toMonthSummary(total({ incomeCents: 500000, expenseCents: 100000 }));
    const previous = toMonthSummary(total({ incomeCents: 500000, expenseCents: 300000 }));
    expect(compareToPreviousMonth(current, previous)!.net.direction).toBe('favorable');
    expect(compareToPreviousMonth(previous, current)!.net.direction).toBe('unfavorable');
  });

  it('no change is neutral, not favorable or unfavorable', () => {
    const same = toMonthSummary(total({ incomeCents: 500000, expenseCents: 300000 }));
    const cmp = compareToPreviousMonth(same, same)!;
    expect(cmp.income.direction).toBe('neutral');
    expect(cmp.expense.direction).toBe('neutral');
    expect(cmp.net.direction).toBe('neutral');
  });

  it('a previous value of zero yields a null percent change, not Infinity', () => {
    const current = toMonthSummary(total({ incomeCents: 100000 }));
    const previous = toMonthSummary(total({ incomeCents: 0 }));
    expect(compareToPreviousMonth(current, previous)!.income.deltaPercent).toBeNull();
  });
});

describe('buildTrend', () => {
  it('zero-fills months with no data but never extends before the earliest real month', () => {
    const totals = [total({ year: 2026, month: 3, incomeCents: 100000, expenseCents: 50000 })];
    const points = buildTrend(totals, 2026, 5, 12);
    expect(points.map((p) => `${p.year}-${p.month}`)).toEqual(['2026-3', '2026-4', '2026-5']);
    expect(points[0]!.incomeCents).toBe(100000);
    expect(points[1]!.incomeCents).toBe(0);
  });

  it('empty history returns an empty trend, not a fabricated one', () => {
    expect(buildTrend([], 2026, 6, 12)).toEqual([]);
  });
});

describe('findExtremeMonth', () => {
  const totals = [
    total({ year: 2026, month: 1, incomeCents: 400000, expenseCents: 300000 }),
    total({ year: 2026, month: 2, incomeCents: 900000, expenseCents: 850000 }),
    total({ year: 2026, month: 3, incomeCents: 500000, expenseCents: 100000 }),
  ];

  it('highest income month', () => {
    expect(findExtremeMonth(totals, 'income')).toMatchObject({ month: 2, incomeCents: 900000 });
  });

  it('highest spending month', () => {
    expect(findExtremeMonth(totals, 'expense')).toMatchObject({ month: 2, expenseCents: 850000 });
  });

  it('best net month is the highest income-minus-expense, not the highest income', () => {
    expect(findExtremeMonth(totals, 'net')).toMatchObject({ month: 3 });
  });

  it('no data at all returns null', () => {
    expect(findExtremeMonth([], 'income')).toBeNull();
  });
});

describe('buildCategoryBreakdown', () => {
  it('sorts largest first and computes percent of the month total', () => {
    const rows = [
      catRow({ categoryId: 'cat-2', amountCents: 3000 }),
      catRow({ categoryId: 'cat-1', amountCents: 7000 }),
    ];
    const breakdown = buildCategoryBreakdown(rows, 2026, 1, CATEGORIES);
    expect(breakdown.map((b) => b.categoryId)).toEqual(['cat-1', 'cat-2']);
    expect(breakdown[0]!.percentOfExpenses).toBeCloseTo(70, 5);
    expect(breakdown[1]!.percentOfExpenses).toBeCloseTo(30, 5);
  });

  it('an uncategorized (null) bucket is never dropped, and reconciles into the total', () => {
    const rows = [catRow({ categoryId: 'cat-1', amountCents: 6000 }), catRow({ categoryId: null, amountCents: 4000 })];
    const breakdown = buildCategoryBreakdown(rows, 2026, 1, CATEGORIES);
    const sum = breakdown.reduce((acc, b) => acc + b.amountCents, 0);
    expect(sum).toBe(10000);
    expect(breakdown.find((b) => b.categoryId === null)?.name).toBe('Uncategorized');
  });

  it('an empty month has no spending at all — 0%, not NaN or a crash', () => {
    expect(buildCategoryBreakdown([], 2026, 1, CATEGORIES)).toEqual([]);
  });

  it('only rows for the requested (year, month) are included', () => {
    const rows = [catRow({ year: 2026, month: 1, amountCents: 5000 }), catRow({ year: 2026, month: 2, amountCents: 9000 })];
    const breakdown = buildCategoryBreakdown(rows, 2026, 1, CATEGORIES);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]!.amountCents).toBe(5000);
  });
});

describe('buildCategoryTrend', () => {
  const window = [
    { year: 2026, month: 1, label: 'Jan 2026' },
    { year: 2026, month: 2, label: 'Feb 2026' },
  ];

  it('picks the top categories by total spend across the whole window, not per-month', () => {
    const rows = [
      catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 1000 }),
      catRow({ year: 2026, month: 2, categoryId: 'cat-1', amountCents: 1000 }),
      catRow({ year: 2026, month: 1, categoryId: 'cat-2', amountCents: 5000 }),
    ];
    const trend = buildCategoryTrend(rows, CATEGORIES, window, 1);
    expect(trend).toHaveLength(1);
    expect(trend[0]!.categoryId).toBe('cat-2');
  });

  it('zero-fills months a category had no activity, keyed the same across every series', () => {
    const rows = [catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 4000 })];
    const trend = buildCategoryTrend(rows, CATEGORIES, window, 5);
    const series = trend.find((s) => s.categoryId === 'cat-1')!;
    expect(series.points).toEqual([
      { label: 'Jan 2026', amountCents: 4000 },
      { label: 'Feb 2026', amountCents: 0 },
    ]);
  });
});

describe('findBiggestSpendingDay', () => {
  it('picks the highest-spend day', () => {
    const day = findBiggestSpendingDay([
      { day: 1, amountCents: 2000 },
      { day: 14, amountCents: 9000 },
      { day: 20, amountCents: 500 },
    ]);
    expect(day).toEqual({ day: 14, amountCents: 9000 });
  });

  it('an empty month has no biggest spending day, not a fabricated "day 1"', () => {
    expect(findBiggestSpendingDay([])).toBeNull();
  });
});

describe('computeYtdSummary', () => {
  const rows = [
    { month: 1, incomeCents: 500000, expenseCents: 300000 },
    { month: 2, incomeCents: 500000, expenseCents: 900000 },
    { month: 3, incomeCents: 500000, expenseCents: 100000 },
    { month: 4, incomeCents: 999999, expenseCents: 999999 }, // beyond monthsElapsed — must be ignored
  ];

  it('only sums the elapsed months, not the whole array', () => {
    const summary = computeYtdSummary(rows, 2026, 3);
    expect(summary.incomeCents).toBe(1500000);
    expect(summary.expenseCents).toBe(1300000);
    expect(summary.netCents).toBe(200000);
  });

  it('average monthly expense divides by months elapsed', () => {
    const summary = computeYtdSummary(rows, 2026, 3);
    expect(summary.averageMonthlyExpenseCents).toBeCloseTo(1300000 / 3, 5);
  });

  it('savings rate is null when YTD income is zero', () => {
    const summary = computeYtdSummary([{ month: 1, incomeCents: 0, expenseCents: 5000 }], 2026, 1);
    expect(summary.savingsRatePercent).toBeNull();
  });

  it('finds the highest-spending month within the elapsed window', () => {
    const summary = computeYtdSummary(rows, 2026, 3);
    expect(summary.highestSpendingMonth).toMatchObject({ month: 2, expenseCents: 900000 });
  });

  it('zero elapsed months is an empty, not fabricated, summary', () => {
    const summary = computeYtdSummary(rows, 2026, 0);
    expect(summary).toMatchObject({ incomeCents: 0, expenseCents: 0, netCents: 0, highestSpendingMonth: null });
  });

  it('a completed historical year (monthsElapsed = 12) sums the whole year, same code path as YTD', () => {
    const fullYear = [
      { month: 1, incomeCents: 100000, expenseCents: 50000 },
      { month: 6, incomeCents: 100000, expenseCents: 50000 },
      { month: 12, incomeCents: 100000, expenseCents: 50000 },
    ];
    const summary = computeYtdSummary(fullYear, 2025, 12);
    expect(summary.incomeCents).toBe(300000);
    expect(summary.expenseCents).toBe(150000);
  });
});

describe('buildAnnualCategoryBreakdown', () => {
  it('sums a category across every month of the year, sorted largest first', () => {
    const rows = [
      catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 3000 }),
      catRow({ year: 2026, month: 6, categoryId: 'cat-1', amountCents: 4000 }),
      catRow({ year: 2026, month: 3, categoryId: 'cat-2', amountCents: 9000 }),
    ];
    const breakdown = buildAnnualCategoryBreakdown(rows, 2026, CATEGORIES);
    expect(breakdown.map((b) => b.categoryId)).toEqual(['cat-2', 'cat-1']);
    expect(breakdown.find((b) => b.categoryId === 'cat-1')?.amountCents).toBe(7000);
  });

  it('excludes rows from a different year', () => {
    const rows = [
      catRow({ year: 2025, month: 12, categoryId: 'cat-1', amountCents: 5000 }),
      catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 2000 }),
    ];
    const breakdown = buildAnnualCategoryBreakdown(rows, 2026, CATEGORIES);
    expect(breakdown).toEqual([expect.objectContaining({ categoryId: 'cat-1', amountCents: 2000 })]);
  });

  it('percent of expenses is computed against the ANNUAL total, not any one month', () => {
    const rows = [
      catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 3000 }),
      catRow({ year: 2026, month: 2, categoryId: 'cat-2', amountCents: 1000 }),
    ];
    const breakdown = buildAnnualCategoryBreakdown(rows, 2026, CATEGORIES);
    expect(breakdown.find((b) => b.categoryId === 'cat-1')?.percentOfExpenses).toBeCloseTo(75, 5);
  });

  it('a year with no spending returns an empty list, not NaN percentages', () => {
    expect(buildAnnualCategoryBreakdown([], 2026, CATEGORIES)).toEqual([]);
  });
});

describe('buildYearlyBreakdown', () => {
  it('always returns all 12 months, Jan through Dec, zero-filled', () => {
    const rows = [catRow({ year: 2026, month: 3, categoryId: 'cat-1', amountCents: 5000 })];
    const breakdown = buildYearlyBreakdown(rows, 2026, CATEGORIES, 6);
    expect(breakdown.months).toHaveLength(12);
    expect(breakdown.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(breakdown.months[0]!.totalCents).toBe(0);
    expect(breakdown.months[2]!.totalCents).toBe(5000);
  });

  it('keeps the top (maxSeries - 1) categories by ANNUAL total as their own series, folds the rest into Other', () => {
    const rows = [
      catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 9000 }),
      catRow({ year: 2026, month: 1, categoryId: 'cat-2', amountCents: 100 }),
      catRow({ year: 2026, month: 1, categoryId: null, amountCents: 50 }),
    ];
    const breakdown = buildYearlyBreakdown(rows, 2026, CATEGORIES, 2);
    expect(breakdown.series).toEqual([
      { key: 'cat-1', name: 'Groceries' },
      { key: '__other__', name: 'Other categories' },
    ]);
    const jan = breakdown.months[0]!;
    expect(jan.segments['cat-1']).toBe(9000);
    expect(jan.segments['__other__']).toBe(150);
    expect(jan.totalCents).toBe(9150);
  });

  it('no "Other" series at all when every category fits within maxSeries', () => {
    const rows = [catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 100 })];
    const breakdown = buildYearlyBreakdown(rows, 2026, CATEGORIES, 6);
    expect(breakdown.series.some((s) => s.key === '__other__')).toBe(false);
  });

  it('the SAME series set applies to every month — a category not present in an early month still has its own key later', () => {
    const rows = [
      catRow({ year: 2026, month: 1, categoryId: 'cat-1', amountCents: 9000 }),
      catRow({ year: 2026, month: 6, categoryId: 'cat-2', amountCents: 100 }),
    ];
    const breakdown = buildYearlyBreakdown(rows, 2026, CATEGORIES, 6);
    const june = breakdown.months[5]!;
    expect(june.segments['cat-2']).toBe(100);
    expect(breakdown.series.map((s) => s.key)).toContain('cat-2');
  });

  it('an empty year is still 12 zero-filled months with an empty series list', () => {
    const breakdown = buildYearlyBreakdown([], 2026, CATEGORIES, 6);
    expect(breakdown.months).toHaveLength(12);
    expect(breakdown.months.every((m) => m.totalCents === 0)).toBe(true);
    expect(breakdown.series).toEqual([]);
  });
});

/**
 * The comparison someone actually wants when they open Finance twice a month
 * and ask "is this normal?" — one arbitrary prior month cannot answer that,
 * and with 32 months of history sitting in the database it does not have to.
 */
describe('compareToBaseline', () => {
  function month(year: number, m: number, income: number, expense: number, count = 10): MonthSummary {
    return { year, month: m, incomeCents: income, expenseCents: expense, netCents: income - expense, transactionCount: count };
  }

  it('compares against the mean of the trailing 12 months', () => {
    // Three prior months averaging 3000 in expenses; this month is 4000.
    const history = [month(2026, 1, 5000, 2000), month(2026, 2, 5000, 3000), month(2026, 3, 5000, 4000)];
    const current = month(2026, 4, 5000, 4000);

    const result = compareToBaseline(current, [...history, current], 2026, 4);

    expect(result?.expense.deltaCents).toBe(1000);
    // More expense than usual is unfavorable, whichever direction the number moved.
    expect(result?.expense.direction).toBe('unfavorable');
    expect(result?.income.direction).toBe('neutral');
  });

  it('never counts the current month in its own baseline', () => {
    const current = month(2026, 4, 5000, 9999);
    const result = compareToBaseline(current, [month(2026, 3, 5000, 1000), current], 2026, 4);

    // Baseline is March alone (1000), so the delta is the full difference.
    expect(result?.expense.deltaCents).toBe(8999);
  });

  it('ignores months after the selected one, so an old month is judged against its own past', () => {
    const history = [month(2026, 1, 5000, 1000), month(2026, 2, 5000, 2000), month(2026, 3, 5000, 9000)];
    const result = compareToBaseline(month(2026, 2, 5000, 2000), history, 2026, 2);

    // Only January counts; March is in the future relative to the selection.
    expect(result?.expense.deltaCents).toBe(1000);
  });

  /**
   * A month with no imports is a GAP, not a month of zero spending. Averaging
   * it in would drag the baseline down and make every real month look
   * extravagant by comparison.
   */
  it('excludes months with no data at all rather than averaging in zeros', () => {
    const history = [month(2026, 1, 4000, 4000), month(2026, 2, 0, 0, 0), month(2026, 3, 4000, 4000)];
    const result = compareToBaseline(month(2026, 4, 4000, 4000), history, 2026, 4);

    // Baseline is 4000 from the two real months, not 2667 from three.
    expect(result?.expense.deltaCents).toBe(0);
  });

  /** `null`, never a baseline of zero — "nothing to compare against" is a real state. */
  it('returns null when there is no prior history at all', () => {
    const current = month(2026, 1, 5000, 2000);
    expect(compareToBaseline(current, [current], 2026, 1)).toBeNull();
  });

  it('drops months older than the 12-month window', () => {
    const old = month(2024, 1, 5000, 100_000);
    const recent = month(2026, 3, 5000, 3000);
    const result = compareToBaseline(month(2026, 4, 5000, 3000), [old, recent], 2026, 4);

    // The 2024 outlier is outside the window; only March counts.
    expect(result?.expense.deltaCents).toBe(0);
  });
});

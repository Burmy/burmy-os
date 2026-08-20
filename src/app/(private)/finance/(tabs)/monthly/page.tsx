import type { Metadata } from 'next';
import Link from 'next/link';

import { FinanceDashboard } from '@/features/finance/dashboard/finance-dashboard';
import { ImportSheet } from '@/features/finance/import/import-sheet';
import { MonthlyGridTable } from '@/features/finance/monthly/monthly-grid-table';
import { requireOwner } from '@/server/auth/owner';
import { listCategories } from '@/server/db/finance/categories';
import {
  getCategoryTotalsForWindow,
  getDailyTotalsForMonth,
  getMonthlyGridAggregates,
  getMonthlyTotalsAllTime,
  getTopExpensesForMonth,
  listTransactionYears,
} from '@/server/db/finance/grid';
import { listInProgressImports } from '@/server/db/finance/imports';
import { getNeedsReviewCount } from '@/server/db/finance/transactions';
import { readHiddenGridColumns } from '@/server/security/grid-columns';
import {
  buildAnnualCategoryBreakdown,
  buildCategoryBreakdown,
  buildCategoryTrend,
  buildTrend,
  buildYearlyBreakdown,
  compareToPreviousMonth,
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
  type TrendPoint,
} from '@/server/finance/dashboard';
import { buildMonthlyGrid, MONTH_ABBREVIATIONS, type GridCategoryMeta } from '@/server/finance/grid';
import { cents, format } from '@/server/finance/money';

export const metadata: Metadata = { title: 'Finance — Burmy' };

function readYear(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : fallback;
}

function readMonth(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 12 ? parsed : fallback;
}

/**
 * The trailing `count` (year, month) pairs ending at (`year`, `month`)
 * inclusive — the date range `getCategoryTotalsForWindow` queries, and the
 * shared x-axis the category trend chart's series are zero-filled against.
 */
function trailingMonths(year: number, month: number, count: number): { readonly year: number; readonly month: number }[] {
  const result: { year: number; month: number }[] = [];
  let y = year;
  let m = month;
  for (let i = 0; i < count; i += 1) {
    result.unshift({ year: y, month: m });
    const prev = previousMonth(y, m);
    y = prev.year;
    m = prev.month;
  }
  return result;
}

/**
 * The product: month x category totals, computed from `finance_transactions`
 * at read time, every cell drilling down to the exact rows behind it. No
 * total is ever stored — see CLAUDE.md invariant 1 and `server/finance/grid.ts`.
 *
 * Also Finance's home and only persistent landing point — there is no
 * Monthly/Import/Review tab row anymore. Importing happens through the Sheet
 * mounted here; Review is reached only through the banner below, when there
 * is something in it to reach. The dashboard (M11) sits above the year grid:
 * headline numbers, trend charts and insights for one selected month, all
 * computed from the SAME base filter (`dashboardBaseConditions`, a deliberate
 * near-duplicate of the grid's own `gridBaseConditions` — see `db/finance/grid.ts`).
 */
export default async function MonthlyPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const params = await searchParams;

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  const year = readYear(params.year, currentYear);
  const isCurrentYearSelected = year === currentYear;
  const month = readMonth(params.month, isCurrentYearSelected ? currentMonth : 12);
  const isCurrentMonth = isCurrentYearSelected && month === currentMonth;

  const recentMonths = trailingMonths(year, month, 6);
  const categoryWindowStart = monthRange(recentMonths[0]!.year, recentMonths[0]!.month).start;
  const categoryWindowEnd = monthRange(year, month).endExclusive;

  const [
    years,
    categories,
    aggregateRows,
    needsReviewCount,
    inProgressImports,
    monthlyTotals,
    categoryTotals,
    dailyTotals,
    topExpenses,
    yearCategoryTotals,
    hiddenGridColumnIds,
  ] = await Promise.all([
    listTransactionYears(owner.userId),
    listCategories(owner.userId, { includeArchived: true }),
    getMonthlyGridAggregates(owner.userId, year),
    getNeedsReviewCount(owner.userId),
    listInProgressImports(owner.userId),
    getMonthlyTotalsAllTime(owner.userId),
    getCategoryTotalsForWindow(owner.userId, categoryWindowStart, categoryWindowEnd),
    getDailyTotalsForMonth(owner.userId, year, month),
    getTopExpensesForMonth(owner.userId, year, month, 8),
    // Same query as `categoryTotals` above, just parameterized with the FULL
    // calendar year instead of a trailing 6-month window — the Year Overview's
    // annual category breakdown and Yearly Breakdown chart both read this.
    getCategoryTotalsForWindow(owner.userId, `${year}-01-01`, `${year + 1}-01-01`),
    readHiddenGridColumns(),
  ]);

  const categoryMeta: GridCategoryMeta[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    kind: category.kind,
    sortOrder: category.sortOrder,
    archived: category.archivedAt !== null,
  }));

  const grid = buildMonthlyGrid(aggregateRows, categoryMeta);

  // ── Dashboard numbers — pure functions from `server/finance/dashboard.ts` only, same DB-free boundary `buildMonthlyGrid` already crosses. ──

  const selectedTotal = monthlyTotals.find((row) => row.year === year && row.month === month) ?? {
    year,
    month,
    incomeCents: 0,
    expenseCents: 0,
    transactionCount: 0,
  };
  const summary = toMonthSummary(selectedTotal);

  const previous = previousMonth(year, month);
  const previousTotal = monthlyTotals.find((row) => row.year === previous.year && row.month === previous.month);
  const previousSummary = previousTotal ? toMonthSummary(previousTotal) : null;
  const comparison = compareToPreviousMonth(summary, previousSummary);
  const previousMonthLabel = MONTH_ABBREVIATIONS[previous.month - 1] ?? '';

  const savingsRatePercent = computeSavingsRate(summary.incomeCents, summary.expenseCents);
  const dailyDivisor = isCurrentMonth ? now.getUTCDate() : daysInMonth(year, month);
  const avgDailySpendingCents = computeAverageDailySpending(summary.expenseCents, dailyDivisor);

  const selectedGridRow = grid.rows[month - 1];
  const expenseTxnCount = selectedGridRow?.totalExpenditureTxnCount ?? 0;
  const avgTransactionCents = expenseTxnCount > 0 ? summary.expenseCents / expenseTxnCount : null;

  const latestMonthWithData = monthlyTotals.at(-1);
  const trend: TrendPoint[] = latestMonthWithData
    ? buildTrend(monthlyTotals, latestMonthWithData.year, latestMonthWithData.month, 12)
    : [];

  const categoryMetaForBreakdown: CategoryMeta[] = [
    ...categories.map((category) => ({ id: category.id, name: category.name })),
    { id: null, name: 'Uncategorized' },
  ];

  const categoryBreakdown = buildCategoryBreakdown(categoryTotals, year, month, categoryMetaForBreakdown);
  const recentMonthLabels = recentMonths.map((m) => ({
    year: m.year,
    month: m.month,
    label: `${MONTH_ABBREVIATIONS[m.month - 1] ?? ''} ${m.year}`,
  }));
  const categoryTrend = buildCategoryTrend(categoryTotals, categoryMetaForBreakdown, recentMonthLabels, 5);
  const biggestSpendingDay = findBiggestSpendingDay(dailyTotals);

  const insights = {
    largestExpense: topExpenses[0] ?? null,
    topCategory: categoryBreakdown[0] ?? null,
    biggestSpendingDay,
    highestIncomeMonth: findExtremeMonth(monthlyTotals, 'income'),
    highestSpendingMonth: findExtremeMonth(monthlyTotals, 'expense'),
    bestNetMonth: findExtremeMonth(monthlyTotals, 'net'),
  };

  const ytdMonthsElapsed = isCurrentYearSelected ? currentMonth : 12;
  const ytdRows = grid.rows.map((row) => ({
    month: row.month,
    incomeCents: row.incomeCents,
    expenseCents: row.totalExpenditureCents,
  }));
  const ytdSummary = computeYtdSummary(ytdRows, year, ytdMonthsElapsed);
  const ytdTrend: TrendPoint[] = grid.rows.slice(0, ytdMonthsElapsed).map((row) => ({
    year,
    month: row.month,
    label: `${MONTH_ABBREVIATIONS[row.month - 1] ?? ''} ${year}`,
    incomeCents: row.incomeCents,
    expenseCents: row.totalExpenditureCents,
    netCents: row.grossSavingsCents,
  }));

  const annualCategories = buildAnnualCategoryBreakdown(yearCategoryTotals, year, categoryMetaForBreakdown);
  // Every real category gets its own series — `+ 2` covers an uncategorized
  // bucket too, so the "Other categories" catch-all never actually triggers
  // for a normal category list. The 16-color chart palette is sized to
  // match; past that many simultaneous categories, colors start repeating.
  const yearlyBreakdown = buildYearlyBreakdown(
    yearCategoryTotals,
    year,
    categoryMetaForBreakdown,
    categoryMetaForBreakdown.length + 2,
  );

  // The "Transactions" toolbar button was removed once Transactions became
  // a SubNav tab (see the (tabs) route group's layout) — a second way to
  // reach the same page would be redundant, not extra convenience.
  const actions = <ImportSheet inProgressImports={inProgressImports} />;

  return (
    <div>
      {categories.length === 0 ? (
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-semibold">Finance</h1>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : null}

      {needsReviewCount > 0 ? (
        <div role="status" className="bg-muted/50 mt-3 rounded-md border px-3 py-2 text-sm">
          {needsReviewCount} transaction{needsReviewCount === 1 ? '' : 's'} need attention —{' '}
          <Link href="/finance/review" className="font-medium underline underline-offset-2">
            Review
          </Link>
        </div>
      ) : null}

      {grid.unreconciled.count > 0 ? (
        <div role="alert" className="border-destructive/50 text-destructive mt-3 rounded-md border px-3 py-2 text-sm">
          {grid.unreconciled.count} confirmed transaction{grid.unreconciled.count === 1 ? '' : 's'} (
          {format(cents(Math.abs(grid.unreconciled.totalCents)))}) {grid.unreconciled.count === 1 ? 'has' : 'have'}{' '}
          no category and {grid.unreconciled.count === 1 ? "doesn't" : "don't"} appear in any column below —{' '}
          <Link href="/finance/review?status=all&category=uncategorized" className="font-medium underline underline-offset-2">
            Review now
          </Link>
        </div>
      ) : null}

      {categories.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-sm">
          No categories yet. Add them under Settings → Finance → Categories.
        </p>
      ) : (
        <>
          <FinanceDashboard
            year={year}
            month={month}
            years={years}
            isCurrentMonth={isCurrentMonth}
            previousMonthLabel={previousMonthLabel}
            actions={actions}
            summary={summary}
            comparison={comparison}
            savingsRatePercent={savingsRatePercent}
            avgDailySpendingCents={avgDailySpendingCents}
            avgTransactionCents={avgTransactionCents}
            trend={trend}
            categoryBreakdown={categoryBreakdown}
            categoryTrend={categoryTrend}
            topExpenses={topExpenses}
            insights={insights}
            ytd={{ summary: ytdSummary, trend: ytdTrend, annualCategories, yearlyBreakdown }}
          />

          <div className="mt-8">
            <h2 className="text-muted-foreground mb-2 text-sm font-medium">Full year grid</h2>
            <MonthlyGridTable
              grid={grid}
              year={year}
              years={years}
              categories={categories.filter((category) => category.archivedAt === null)}
              initialHiddenColumnIds={hiddenGridColumnIds}
            />
          </div>
        </>
      )}
    </div>
  );
}

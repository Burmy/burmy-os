import type { Metadata } from 'next';
import Link from 'next/link';

import { FinanceDashboard } from '@/features/finance/dashboard/finance-dashboard';
import { ImportSheet } from '@/features/finance/import/import-sheet';
import { MonthlyGridTable } from '@/features/finance/monthly/monthly-grid-table';
import { requireOwner } from '@/server/auth/owner';
import { listCategories } from '@/server/db/finance/categories';
import {
  getAccountCoverage,
  getCategoryTotalsForWindow,
  getDailyTotalsForMonth,
  getMonthlyGridAggregates,
  getMonthlyTotalsAllTime,
  getTopExpensesForMonth,
  listTransactionYears,
} from '@/server/db/finance/grid';
import { listCommittedImports, listInProgressImports } from '@/server/db/finance/imports';
import { getNeedsReviewCount } from '@/server/db/finance/transactions';
import { readHiddenGridColumns } from '@/server/security/grid-columns';
import {
  buildAnnualCategoryBreakdown,
  buildCategoryBreakdown,
  buildCategoryTrend,
  buildTrend,
  buildYearlyBreakdown,
  compareToBaseline,
  dropUncoveredTail,
  isMonthCovered,
  lastDayOfMonth,
  latestCoveredMonth,
  partitionCoverage,
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

  // ───────────────────────────────────────────────────────────────────────────
  // THE PAGE LANDS ON LAST MONTH, NOT THIS ONE.
  //
  // The current month is never finished — the owner's card statement closes
  // around the 27th and checking around the 15th — so opening Finance used to
  // mean looking at two weeks of data presented as a month, complete with a
  // savings rate and a "vs last month" comparison. Last month is the most
  // recent month that can be whole, so it is where the page starts.
  //
  // A plain month − 1, deliberately, rather than "the newest month the data
  // actually covers": the default is where you LAND, and it should be
  // predictable and the same every time you open the app. Whether the month
  // has everything in it is a separate question, answered by `isMonthCovered`
  // below, which can say so on screen. Rolling the default around based on
  // import state would move the page under the owner for reasons invisible
  // from the URL.
  //
  // January rolls the year back with it — hence `previousMonth` rather than
  // arithmetic on `currentMonth` alone.
  // ───────────────────────────────────────────────────────────────────────────
  const defaultPeriod = previousMonth(currentYear, currentMonth);

  const year = readYear(params.year, defaultPeriod.year);
  // A year picked WITHOUT a month still lands on December, as it always has —
  // browsing to 2024 means the whole of 2024, not whichever month today is.
  const month = readMonth(params.month, year === defaultPeriod.year ? defaultPeriod.month : 12);

  const recentMonths = trailingMonths(year, month, 6);
  const categoryWindowStart = monthRange(recentMonths[0]!.year, recentMonths[0]!.month).start;
  const categoryWindowEnd = monthRange(year, month).endExclusive;

  const [
    years,
    categories,
    aggregateRows,
    needsReviewCount,
    inProgressImports,
    committedImports,
    monthlyTotals,
    coverage,
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
    listCommittedImports(owner.userId),
    getMonthlyTotalsAllTime(owner.userId),
    getAccountCoverage(owner.userId),
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

  // The second, more useful comparison: this month against the owner's own
  // trailing average rather than one arbitrary prior month. `monthlyTotals` is
  // already the full history — no extra query.
  const baseline = compareToBaseline(summary, monthlyTotals.map(toMonthSummary), year, month);

  const savingsRatePercent = computeSavingsRate(summary.incomeCents, summary.expenseCents);
  // Always the WHOLE month. This used to divide by the elapsed day for the
  // current month and label the result "So far this month" — a partial figure
  // dressed up as an average. The stat cards now render only for a covered
  // month (see `monthIsCovered` below), so there is no partial case left to
  // special-case, and no divisor that changes meaning depending on the date.
  const avgDailySpendingCents = computeAverageDailySpending(summary.expenseCents, daysInMonth(year, month));

  const selectedGridRow = grid.rows[month - 1];
  const expenseTxnCount = selectedGridRow?.totalExpenditureTxnCount ?? 0;
  const avgTransactionCents = expenseTxnCount > 0 ? summary.expenseCents / expenseTxnCount : null;

  // ── Statement coverage ──────────────────────────────────────────────────
  // See `AccountCoverage` in `server/finance/dashboard.ts` for the rule and
  // why it is derived from the transactions rather than configured.
  const monthIsCovered = isMonthCovered(coverage, year, month);
  const lastCovered = latestCoveredMonth(coverage);
  // Split here rather than inside the component so the "isn't ready" panel can
  // say which accounts it is actually waiting on and which it has written off —
  // the split is a domain decision, not a presentation one.
  const { reporting: reportingAccounts, dormant: dormantAccounts } = partitionCoverage(coverage);

  // The trend is anchored at the last COVERED month, not the last month with
  // any data at all. Anchoring at the latter put a half-imported month at the
  // right-hand end of every line, where it read as a collapse in income and
  // spending rather than as an artifact of the statement cycle. Anchoring
  // rather than filtering afterwards keeps a full 12 points on the chart.
  const trendAnchor = lastCovered ?? monthlyTotals.at(-1) ?? null;
  const trend: TrendPoint[] = trendAnchor
    ? buildTrend(monthlyTotals, trendAnchor.year, trendAnchor.month, 12)
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
  // Same reason as `trend` above — the trailing window is anchored on the
  // SELECTED month, so browsing to an uncovered month would otherwise end
  // every category line on a partial column.
  const categoryTrend = buildCategoryTrend(
    categoryTotals,
    categoryMetaForBreakdown,
    dropUncoveredTail(recentMonthLabels, coverage),
    5,
  );
  const biggestSpendingDay = findBiggestSpendingDay(dailyTotals);

  const insights = {
    largestExpense: topExpenses[0] ?? null,
    topCategory: categoryBreakdown[0] ?? null,
    biggestSpendingDay,
    highestIncomeMonth: findExtremeMonth(monthlyTotals, 'income'),
    highestSpendingMonth: findExtremeMonth(monthlyTotals, 'expense'),
    bestNetMonth: findExtremeMonth(monthlyTotals, 'net'),
  };

  // Year Overview reports on COVERED months only, for the same reason the
  // month view does — "year to date" that silently includes half of the
  // current month is not a figure anything can be compared against. A past
  // year fully behind the coverage line reads as all 12.
  //
  // The final `: 0` is a year entirely AHEAD of the coverage line (browsing to
  // 2027 in January 2027, before the December statements land). Zero covered
  // months is the honest answer, but a row of $0.00 stat cards is not the way
  // to say it — `YearNotReady` renders instead, exactly like the month view's
  // own gate. This is what put an empty Year Overview above a grid full of real
  // 2026 numbers in production: the arithmetic was right and the screen lied.
  const ytdMonthsElapsed =
    lastCovered === null ? 0 : lastCovered.year > year ? 12 : lastCovered.year === year ? lastCovered.month : 0;
  // Both annual views read from this rather than the raw year, so the donut
  // and the stacked bars agree with the YTD cards above them.
  const coveredYearCategoryTotals = yearCategoryTotals.filter((row) => row.month <= ytdMonthsElapsed);
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

  const annualCategories = buildAnnualCategoryBreakdown(coveredYearCategoryTotals, year, categoryMetaForBreakdown);
  // Every real category gets its own series — `+ 2` covers an uncategorized
  // bucket too, so the "Other categories" catch-all never actually triggers
  // for a normal category list. The 16-color chart palette is sized to
  // match; past that many simultaneous categories, colors start repeating.
  const yearlyBreakdown = buildYearlyBreakdown(
    coveredYearCategoryTotals,
    year,
    categoryMetaForBreakdown,
    categoryMetaForBreakdown.length + 2,
  );

  // The "Transactions" toolbar button was removed once Transactions became
  // a SubNav tab (see the (tabs) route group's layout) — a second way to
  // reach the same page would be redundant, not extra convenience.
  const actions = (
    <ImportSheet inProgressImports={inProgressImports} committedImports={committedImports} />
  );

  return (
    <div>
      {categories.length === 0 ? (
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-semibold">Finance</h1>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : null}

      {needsReviewCount > 0 ? (
        <div role="status" className="bg-muted/50 mt-3 rounded-md px-3 py-2 text-sm">
          {needsReviewCount} transaction{needsReviewCount === 1 ? '' : 's'} need attention —{' '}
          <Link href="/finance/review" className="font-medium underline underline-offset-2">
            Review
          </Link>
        </div>
      ) : null}

      {grid.unreconciled.count > 0 ? (
        <div role="alert" className="bg-destructive/10 text-destructive mt-3 rounded-md px-3 py-2 text-sm">
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
            coverage={{
              covered: monthIsCovered,
              monthEnd: lastDayOfMonth(year, month),
              accounts: reportingAccounts.map((account) => ({
                name: account.accountName,
                latestDate: account.latestDate,
              })),
              dormant: dormantAccounts.map((account) => ({
                name: account.accountName,
                latestDate: account.latestDate,
              })),
            }}
            previousMonthLabel={previousMonthLabel}
            actions={actions}
            summary={summary}
            comparison={comparison}
        baseline={baseline}
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

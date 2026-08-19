/**
 * Finance dashboard — stats, comparisons, trends, and insights on
 * `/finance/monthly`. Pure — no DB, no React — mirroring `grid.ts`'s own
 * boundary: the SQL in `db/finance/grid.ts` groups and sums; everything here
 * combines those already-summed numbers into what the dashboard shows.
 *
 * Every money figure in and out of this file follows the app-wide
 * convention: positive = outflow. `incomeCents` on `MonthlyTotal` is the one
 * deliberate exception — it is sign-flipped for display at the DB boundary,
 * exactly like M8's own Income column, so every function here can treat it
 * as an ordinary positive number without re-deriving that flip.
 */

import type { CategoryMonthlyTotal, MonthlyTotal } from '@/server/db/finance/grid';
import { MONTH_ABBREVIATIONS } from './grid';

// ─────────────────────────────────────────────────────────────────────────────
// Date math
// ─────────────────────────────────────────────────────────────────────────────

/** Days in a given (year, month) — pure calendar math, no timezone involved since callers only ever compare it against `date`-mode columns. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** `'YYYY-MM-DD'` boundaries for one calendar month — `endExclusive` is the first day of the FOLLOWING month, so callers use `lt`, never an inclusive `lte` that would need to know how many days the month has. */
export function monthRange(year: number, month: number): { readonly start: string; readonly endExclusive: string } {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${year}-${pad(month)}-01`,
    endExclusive: `${nextYear}-${pad(nextMonth)}-01`,
  };
}

/** The (year, month) immediately before this one — crosses the year boundary at January. */
export function previousMonth(year: number, month: number): { readonly year: number; readonly month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// This month's headline numbers
// ─────────────────────────────────────────────────────────────────────────────

export interface MonthSummary {
  readonly year: number;
  readonly month: number;
  readonly incomeCents: number;
  readonly expenseCents: number;
  readonly netCents: number;
  readonly transactionCount: number;
}

/** Plain subtraction of two non-negative integers never produces `-0` in JS (unlike negation) — no zero-guard needed here, unlike `grid.ts`'s own `-incomeCentsRaw`. */
export function toMonthSummary(row: MonthlyTotal): MonthSummary {
  return {
    year: row.year,
    month: row.month,
    incomeCents: row.incomeCents,
    expenseCents: row.expenseCents,
    netCents: row.incomeCents - row.expenseCents,
    transactionCount: row.transactionCount,
  };
}

/** `null` for a zero-income month — dividing by zero is undefined, not "0% saved" (a $0-income month with $500 of expenses did not save "0%", the question doesn't have a rate-shaped answer). Callers render `null` as "—" or similar, never as `0%`. */
export function computeSavingsRate(incomeCents: number, expenseCents: number): number | null {
  if (incomeCents === 0) return null;
  return ((incomeCents - expenseCents) / incomeCents) * 100;
}

/**
 * `divisor` is supplied by the caller, not computed here, so this stays a
 * one-line division with no notion of "today" baked into a pure function:
 * the CURRENT month divides by days elapsed so far; a COMPLETED historical
 * month divides by the full day count. Both are just `daysInMonth()` or a
 * caller-computed elapsed-day count fed in as `divisor`.
 */
export function computeAverageDailySpending(expenseCents: number, divisor: number): number {
  if (divisor <= 0) return 0;
  return expenseCents / divisor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Month-over-month comparison
// ─────────────────────────────────────────────────────────────────────────────

export type ComparisonDirection = 'favorable' | 'unfavorable' | 'neutral';

export interface MetricComparison {
  readonly deltaCents: number;
  /** `null` when the previous month's value was 0 — a percent change from zero is undefined, not infinite or 0. */
  readonly deltaPercent: number | null;
  readonly direction: ComparisonDirection;
}

export interface MonthComparison {
  readonly income: MetricComparison;
  readonly expense: MetricComparison;
  readonly net: MetricComparison;
}

function compareMetric(current: number, previous: number, higherIsFavorable: boolean): MetricComparison {
  const deltaCents = current - previous;
  const deltaPercent = previous === 0 ? null : (deltaCents / Math.abs(previous)) * 100;
  const direction: ComparisonDirection =
    deltaCents === 0 ? 'neutral' : (deltaCents > 0) === higherIsFavorable ? 'favorable' : 'unfavorable';
  return { deltaCents, deltaPercent, direction };
}

/**
 * Direction is metric-specific, not "up = good" — stated explicitly per
 * metric so a reviewer never has to infer it: more income is favorable, more
 * expense is UNfavorable, more net (savings) is favorable. `previous: null`
 * (no prior month has any data — e.g. the very first imported month) returns
 * `null`: there is nothing to compare against, not a manufactured "0% change".
 */
export function compareToPreviousMonth(current: MonthSummary, previous: MonthSummary | null): MonthComparison | null {
  if (!previous) return null;
  return {
    income: compareMetric(current.incomeCents, previous.incomeCents, true),
    expense: compareMetric(current.expenseCents, previous.expenseCents, false),
    net: compareMetric(current.netCents, previous.netCents, true),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trend charts (income vs expense, net cash flow)
// ─────────────────────────────────────────────────────────────────────────────

export interface TrendPoint {
  readonly year: number;
  readonly month: number;
  /** Short label for the chart axis, e.g. `"Jan 2026"`. */
  readonly label: string;
  readonly incomeCents: number;
  readonly expenseCents: number;
  readonly netCents: number;
}

/**
 * The trailing `monthsBack` months ending at (`endYear`, `endMonth`)
 * inclusive, built from `getMonthlyTotalsAllTime()`'s full history — months
 * with genuinely no data are still included as zero-filled points (a real
 * gap in the trend, not hidden), but the window never extends further back
 * than the owner's actual first month of data, so an owner with 3 months of
 * history sees a 3-point chart, not 9 fabricated leading zeros.
 */
export function buildTrend(
  monthlyTotals: readonly MonthlyTotal[],
  endYear: number,
  endMonth: number,
  monthsBack: number,
): TrendPoint[] {
  if (monthlyTotals.length === 0) return [];

  const byKey = new Map(monthlyTotals.map((row) => [`${row.year}-${row.month}`, row]));
  const earliest = monthlyTotals[0]!;

  const points: TrendPoint[] = [];
  let year = endYear;
  let month = endMonth;
  for (let i = 0; i < monthsBack; i += 1) {
    if (year < earliest.year || (year === earliest.year && month < earliest.month)) break;

    const row = byKey.get(`${year}-${month}`);
    points.push({
      year,
      month,
      label: `${MONTH_ABBREVIATIONS[month - 1]} ${year}`,
      incomeCents: row?.incomeCents ?? 0,
      expenseCents: row?.expenseCents ?? 0,
      netCents: (row?.incomeCents ?? 0) - (row?.expenseCents ?? 0),
    });

    const prev = previousMonth(year, month);
    year = prev.year;
    month = prev.month;
  }

  return points.reverse();
}

/** The single highest/lowest month by one metric, across all-time data — `null` when there is no data at all. */
export function findExtremeMonth(
  monthlyTotals: readonly MonthlyTotal[],
  metric: 'income' | 'expense' | 'net',
): MonthSummary | null {
  if (monthlyTotals.length === 0) return null;

  const value = (row: MonthlyTotal): number =>
    metric === 'income' ? row.incomeCents : metric === 'expense' ? row.expenseCents : row.incomeCents - row.expenseCents;

  const best = monthlyTotals.reduce((max, row) => (value(row) > value(max) ? row : max), monthlyTotals[0]!);
  return toMonthSummary(best);
}

// ─────────────────────────────────────────────────────────────────────────────
// Category breakdown and trend
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryMeta {
  readonly id: string | null;
  readonly name: string;
}

export interface CategoryAmount {
  readonly categoryId: string | null;
  readonly name: string;
  readonly amountCents: number;
  readonly txnCount: number;
  /** Share of the month's total expenses, 0–100. `0` when the month has no spending at all (never divides by zero). */
  readonly percentOfExpenses: number;
}

/**
 * One month's spending broken down by category, sorted largest first —
 * the donut/bar chart and the "top spending category" insight both read
 * this directly. `categories` maps every category id (including
 * archived ones) to its name, plus a sentinel `null -> 'Uncategorized'`
 * entry the caller supplies, so an old or buggy uncategorized row still
 * renders with a real label instead of disappearing.
 */
export function buildCategoryBreakdown(
  categoryTotals: readonly CategoryMonthlyTotal[],
  year: number,
  month: number,
  categories: readonly CategoryMeta[],
): CategoryAmount[] {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const rowsForMonth = categoryTotals.filter((row) => row.year === year && row.month === month);
  const totalExpenseCents = rowsForMonth.reduce((sum, row) => sum + row.amountCents, 0);

  return rowsForMonth
    .map((row) => ({
      categoryId: row.categoryId,
      name: nameById.get(row.categoryId) ?? 'Uncategorized',
      amountCents: row.amountCents,
      txnCount: row.txnCount,
      percentOfExpenses: totalExpenseCents === 0 ? 0 : (row.amountCents / totalExpenseCents) * 100,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

export interface CategoryTrendSeries {
  readonly categoryId: string | null;
  readonly name: string;
  readonly points: readonly { readonly label: string; readonly amountCents: number }[];
}

/**
 * The top `limit` categories BY TOTAL SPEND ACROSS THE WHOLE WINDOW (not
 * per-month, which could pick a different top-N each month and make the
 * chart's own legend a moving target), each as its own monthly series —
 * zero-filled for months a category had no activity, same reasoning as
 * `buildTrend()`. Every month in `monthlyWindow` appears in every series, in
 * order, so they can share one chart's x-axis directly.
 */
export function buildCategoryTrend(
  categoryTotals: readonly CategoryMonthlyTotal[],
  categories: readonly CategoryMeta[],
  monthlyWindow: readonly { readonly year: number; readonly month: number; readonly label: string }[],
  limit: number,
): CategoryTrendSeries[] {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const totalByCategory = new Map<string | null, number>();
  for (const row of categoryTotals) {
    totalByCategory.set(row.categoryId, (totalByCategory.get(row.categoryId) ?? 0) + row.amountCents);
  }

  const topCategoryIds = [...totalByCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([categoryId]) => categoryId);

  const byMonthAndCategory = new Map(categoryTotals.map((row) => [`${row.year}-${row.month}-${row.categoryId}`, row]));

  return topCategoryIds.map((categoryId) => ({
    categoryId,
    name: nameById.get(categoryId) ?? 'Uncategorized',
    points: monthlyWindow.map((m) => ({
      label: m.label,
      amountCents: byMonthAndCategory.get(`${m.year}-${m.month}-${categoryId}`)?.amountCents ?? 0,
    })),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily spending
// ─────────────────────────────────────────────────────────────────────────────

export interface BiggestSpendingDay {
  readonly day: number;
  readonly amountCents: number;
}

/** `null` when the month has no spending at all — never a fabricated "day 1, $0". */
export function findBiggestSpendingDay(
  dailyTotals: readonly { readonly day: number; readonly amountCents: number }[],
): BiggestSpendingDay | null {
  if (dailyTotals.length === 0) return null;
  return dailyTotals.reduce((max, row) => (row.amountCents > max.amountCents ? row : max), dailyTotals[0]!);
}

// ─────────────────────────────────────────────────────────────────────────────
// This Year / YTD — deliberately reuses whatever the caller already has
// (the same `grid.rows` `/finance/monthly` fetches for its table) rather
// than a new query: a structural row shape, not `GridMonthRow` itself, so
// this file stays DB-free. "YTD" falls out for free — for the current
// calendar year, `monthsElapsed` is the current month and rows beyond it
// are simply absent; for a completed past year, `monthsElapsed` is 12 and
// this is just that year's full-year summary.
// ─────────────────────────────────────────────────────────────────────────────

export interface YtdMonthRow {
  readonly month: number;
  readonly incomeCents: number;
  readonly expenseCents: number;
}

export interface YtdSummary {
  readonly year: number;
  readonly monthsElapsed: number;
  readonly incomeCents: number;
  readonly expenseCents: number;
  readonly netCents: number;
  readonly averageMonthlyExpenseCents: number;
  readonly savingsRatePercent: number | null;
  /** Highest-spending month within the elapsed window — `null` only when nothing has been spent yet. */
  readonly highestSpendingMonth: YtdMonthRow | null;
}

export function computeYtdSummary(monthRows: readonly YtdMonthRow[], year: number, monthsElapsed: number): YtdSummary {
  const rows = monthRows.slice(0, monthsElapsed);
  const incomeCents = rows.reduce((sum, row) => sum + row.incomeCents, 0);
  const expenseCents = rows.reduce((sum, row) => sum + row.expenseCents, 0);

  const spendingRows = rows.filter((row) => row.expenseCents > 0);
  const highestSpendingMonth =
    spendingRows.length === 0
      ? null
      : spendingRows.reduce((max, row) => (row.expenseCents > max.expenseCents ? row : max), spendingRows[0]!);

  return {
    year,
    monthsElapsed,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    averageMonthlyExpenseCents: monthsElapsed > 0 ? expenseCents / monthsElapsed : 0,
    savingsRatePercent: computeSavingsRate(incomeCents, expenseCents),
    highestSpendingMonth,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Year Overview — annual category breakdown and the Yearly Breakdown chart
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every category's spend across the WHOLE year, sorted largest first — the
 * annual counterpart to `buildCategoryBreakdown` (one month). Takes the same
 * `getCategoryTotalsForWindow` rows that function does, just queried with a
 * full-calendar-year window instead of one month's — no separate query.
 */
export function buildAnnualCategoryBreakdown(
  categoryTotals: readonly CategoryMonthlyTotal[],
  year: number,
  categories: readonly CategoryMeta[],
): CategoryAmount[] {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const rowsForYear = categoryTotals.filter((row) => row.year === year);

  const byCategory = new Map<string | null, { amountCents: number; txnCount: number }>();
  for (const row of rowsForYear) {
    const existing = byCategory.get(row.categoryId) ?? { amountCents: 0, txnCount: 0 };
    byCategory.set(row.categoryId, {
      amountCents: existing.amountCents + row.amountCents,
      txnCount: existing.txnCount + row.txnCount,
    });
  }

  const totalCents = [...byCategory.values()].reduce((sum, v) => sum + v.amountCents, 0);

  return [...byCategory.entries()]
    .map(([categoryId, v]) => ({
      categoryId,
      name: nameById.get(categoryId) ?? 'Uncategorized',
      amountCents: v.amountCents,
      txnCount: v.txnCount,
      percentOfExpenses: totalCents === 0 ? 0 : (v.amountCents / totalCents) * 100,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

/** Chart-display-only stack key for everything past the top series — never written back to a real category. */
const OTHER_SERIES_KEY = '__other__';

interface YearlyBreakdownMonth {
  readonly month: number;
  readonly label: string;
  readonly totalCents: number;
  /** `series[i].key -> amountCents`, 0/absent when that series had no spend this month. */
  readonly segments: Readonly<Record<string, number>>;
}

interface YearlyBreakdownSeries {
  readonly key: string;
  readonly name: string;
}

export interface YearlyBreakdown {
  /** Always all 12 months, Jan → Dec, zero-filled — mirrors the Full year grid's own row set. */
  readonly months: readonly YearlyBreakdownMonth[];
  /** Fixed for the whole year (ranked by ANNUAL total, not recomputed per month) so a category keeps the same stack segment across every bar. */
  readonly series: readonly YearlyBreakdownSeries[];
}

/**
 * One stacked-bar row per calendar month — the Yearly Breakdown chart's data,
 * modeled on the "why was this month more expensive" horizontal stacked bar
 * from the owner's old spreadsheet. Only the top `maxSeries - 1` categories
 * (by annual total) get their own segment; everything else folds into a
 * single "Other" segment PER MONTH, purely for this chart's readability —
 * `buildAnnualCategoryBreakdown`'s real per-category rows are what the
 * annual distribution chart and the yearly matrix use, untouched by this.
 */
export function buildYearlyBreakdown(
  categoryTotals: readonly CategoryMonthlyTotal[],
  year: number,
  categories: readonly CategoryMeta[],
  maxSeries: number,
): YearlyBreakdown {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const rowsForYear = categoryTotals.filter((row) => row.year === year);

  const totalByCategory = new Map<string | null, number>();
  for (const row of rowsForYear) {
    totalByCategory.set(row.categoryId, (totalByCategory.get(row.categoryId) ?? 0) + row.amountCents);
  }

  const rankedCategoryIds = [...totalByCategory.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const topCategoryIds = rankedCategoryIds.slice(0, Math.max(0, maxSeries - 1));
  const topSet = new Set(topCategoryIds);
  const hasOther = rankedCategoryIds.length > topCategoryIds.length;

  const series: YearlyBreakdownSeries[] = topCategoryIds.map((id) => ({
    key: id ?? 'uncategorized',
    name: nameById.get(id) ?? 'Uncategorized',
  }));
  if (hasOther) series.push({ key: OTHER_SERIES_KEY, name: 'Other' });

  const months: YearlyBreakdownMonth[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const segments: Record<string, number> = {};
    let totalCents = 0;
    for (const row of rowsForYear.filter((r) => r.month === month)) {
      totalCents += row.amountCents;
      const key = topSet.has(row.categoryId) ? (row.categoryId ?? 'uncategorized') : OTHER_SERIES_KEY;
      segments[key] = (segments[key] ?? 0) + row.amountCents;
    }
    months.push({ month, label: MONTH_ABBREVIATIONS[month - 1] ?? '', totalCents, segments });
  }

  return { months, series };
}

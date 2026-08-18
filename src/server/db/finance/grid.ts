/**
 * Owner-scoped reads for `/finance/monthly`: the grid's aggregate query and
 * its drill-down query.
 *
 * `gridBaseConditions()` is the ONE thing that makes "drill-down can never
 * disagree with the grid" a structural guarantee rather than a hope: both
 * `getMonthlyGridAggregates` and `getCellTransactions` build their `WHERE`
 * from the exact same function, so there is no second copy of the filter that
 * could quietly drift from the first.
 */

import { and, asc, desc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { financeAccounts, financeCategories, financeTransactions } from '@/server/db/schema';
import { monthRange } from '@/server/finance/dashboard';
import type { GridAggregateRow } from '@/server/finance/grid';

/**
 * `confirmed`/`auto` only — `needs_review` is excluded from EVERY grid number,
 * not just hidden visually, so an unreviewed transaction can never make a
 * total look smaller than it should without the owner knowing why (the page
 * shows a count of what this excludes). `transfer`/`credit_card_payment` are
 * excluded everywhere, even from a category cell, regardless of whether one
 * happens to be assigned — see FINANCE.md "Transaction types". `investment`
 * is NOT excluded here; it counts toward Total Expenditure and gets its own
 * category column, per the same table.
 */
function gridBaseConditions(ownerId: string, year: number) {
  return [
    eq(financeTransactions.ownerId, ownerId),
    inArray(financeTransactions.reviewStatus, ['confirmed', 'auto']),
    ne(financeTransactions.transactionType, 'transfer'),
    ne(financeTransactions.transactionType, 'credit_card_payment'),
    gte(financeTransactions.transactionDate, `${year}-01-01`),
    lte(financeTransactions.transactionDate, `${year}-12-31`),
  ];
}

/**
 * One row per (month, category, type) group, `SUM`/`COUNT` already computed
 * by Postgres. `buildMonthlyGrid()` (pure) turns this into the grid's cells,
 * its three summary columns, and the invariant-violation bucket — see that
 * file for why a `categoryId: null` group is not a bug in this query.
 */
export async function getMonthlyGridAggregates(
  ownerId: string,
  year: number,
): Promise<GridAggregateRow[]> {
  const monthExpr = sql`extract(month from ${financeTransactions.transactionDate})`;

  const rows = await getDb()
    .select({
      month: sql<number>`${monthExpr}::int`,
      categoryId: financeTransactions.categoryId,
      transactionType: financeTransactions.transactionType,
      totalCents: sql<number>`sum(${financeTransactions.amountCents})::int`,
      txnCount: sql<number>`count(*)::int`,
    })
    .from(financeTransactions)
    .where(and(...gridBaseConditions(ownerId, year)))
    .groupBy(monthExpr, financeTransactions.categoryId, financeTransactions.transactionType);

  return rows;
}

/** Every calendar year the owner has ANY transaction in, most recent first — deliberately not filtered by the grid's own review-status/type rules, so a year with only unreviewed data is still selectable. */
export async function listTransactionYears(ownerId: string): Promise<number[]> {
  const yearExpr = sql`extract(year from ${financeTransactions.transactionDate})`;

  const rows = await getDb()
    .select({ year: sql<number>`${yearExpr}::int` })
    .from(financeTransactions)
    .where(eq(financeTransactions.ownerId, ownerId))
    .groupBy(yearExpr)
    .orderBy(desc(yearExpr));

  return rows.map((row) => row.year);
}

export type DrillDownSelector =
  | { readonly kind: 'category'; readonly categoryId: string }
  | { readonly kind: 'expenditure' }
  | { readonly kind: 'income' };

export interface DrillDownTransaction {
  readonly id: string;
  readonly transactionDate: string;
  readonly accountName: string;
  readonly normalizedMerchant: string | null;
  readonly originalDescription: string;
  readonly amountCents: number;
  readonly categoryName: string | null;
  readonly transactionType: string;
}

/**
 * `month: null` means the whole year — the Total row's cells are drillable
 * too, the same query with one less condition, not a special case.
 */
export async function getCellTransactions(
  ownerId: string,
  year: number,
  month: number | null,
  selector: DrillDownSelector,
): Promise<DrillDownTransaction[]> {
  const conditions = [...gridBaseConditions(ownerId, year)];

  if (month !== null) {
    conditions.push(sql`extract(month from ${financeTransactions.transactionDate}) = ${month}`);
  }
  if (selector.kind === 'category') conditions.push(eq(financeTransactions.categoryId, selector.categoryId));
  else if (selector.kind === 'income') conditions.push(eq(financeTransactions.transactionType, 'income'));
  else conditions.push(ne(financeTransactions.transactionType, 'income'));

  const rows = await getDb()
    .select({
      id: financeTransactions.id,
      transactionDate: financeTransactions.transactionDate,
      accountName: financeAccounts.name,
      normalizedMerchant: financeTransactions.normalizedMerchant,
      originalDescription: financeTransactions.originalDescription,
      amountCents: financeTransactions.amountCents,
      categoryName: financeCategories.name,
      transactionType: financeTransactions.transactionType,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeTransactions.accountId))
    .leftJoin(financeCategories, eq(financeCategories.id, financeTransactions.categoryId))
    .where(and(...conditions))
    .orderBy(asc(financeTransactions.transactionDate))
    .limit(500);

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finance dashboard — stats, trends, and insights on `/finance/monthly`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same exclusion rule as `gridBaseConditions()` (`confirmed`/`auto` only,
 * `transfer`/`credit_card_payment` excluded everywhere) but WITHOUT a year
 * bound — the dashboard's own queries scope by an explicit date range
 * instead, since a trailing trend window or an all-time scan can span more
 * than one calendar year. Deliberately NOT `gridBaseConditions()` itself,
 * which stays scoped to exactly one year for M8's own table — a second copy
 * of the same three conditions here, not a shared parameter, matching how
 * `ledgerConditions()` in `db/finance/transactions.ts` already made the
 * identical call for M9 rather than coupling two independently-evolving
 * queries together.
 */
function dashboardBaseConditions(ownerId: string) {
  return [
    eq(financeTransactions.ownerId, ownerId),
    inArray(financeTransactions.reviewStatus, ['confirmed', 'auto']),
    ne(financeTransactions.transactionType, 'transfer'),
    ne(financeTransactions.transactionType, 'credit_card_payment'),
  ];
}

export interface MonthlyTotal {
  readonly year: number;
  readonly month: number;
  /** Sign-flipped for display, exactly like M8's own Income column — stored income is negative. */
  readonly incomeCents: number;
  /** Every non-income type in scope — expense, refund, fee, adjustment, investment. Identical definition to M8's "Total Expenditure". */
  readonly expenseCents: number;
  readonly transactionCount: number;
}

/**
 * ONE row per (year, month) that has any activity, across the owner's ENTIRE
 * history — no category breakdown, so this stays cheap (at most a couple of
 * rows per month the owner has ever used Burmy) regardless of how many years
 * of data exist. Reused for the income/expense trend chart, the net cash-flow
 * chart, month-over-month comparison, and the all-time "highest income/
 * spending month" / "best net month" insights — one query, four call sites,
 * rather than four separate ones.
 */
export async function getMonthlyTotalsAllTime(ownerId: string): Promise<MonthlyTotal[]> {
  const yearExpr = sql`extract(year from ${financeTransactions.transactionDate})`;
  const monthExpr = sql`extract(month from ${financeTransactions.transactionDate})`;

  const rows = await getDb()
    .select({
      year: sql<number>`${yearExpr}::int`,
      month: sql<number>`${monthExpr}::int`,
      incomeCentsRaw: sql<number>`coalesce(sum(${financeTransactions.amountCents}) filter (where ${financeTransactions.transactionType} = 'income'), 0)::int`,
      expenseCents: sql<number>`coalesce(sum(${financeTransactions.amountCents}) filter (where ${financeTransactions.transactionType} != 'income'), 0)::int`,
      transactionCount: sql<number>`count(*)::int`,
    })
    .from(financeTransactions)
    .where(and(...dashboardBaseConditions(ownerId)))
    .groupBy(yearExpr, monthExpr)
    .orderBy(yearExpr, monthExpr);

  // Sign-flip income here (DB boundary), not in the pure layer — `withNet()`
  // and everything downstream expects an already-positive incomeCents, the
  // same convention `formatInflow`/M8's Income column already use.
  return rows.map((row) => ({
    year: row.year,
    month: row.month,
    incomeCents: row.incomeCentsRaw === 0 ? 0 : -row.incomeCentsRaw,
    expenseCents: row.expenseCents,
    transactionCount: row.transactionCount,
  }));
}

export interface CategoryMonthlyTotal {
  readonly year: number;
  readonly month: number;
  /** `null` is the same invariant-violation "unreconciled" bucket M8's grid surfaces — never dropped, never silently folded into another category. */
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly txnCount: number;
}

/**
 * Category-level monthly totals for a trailing window, spending-kind types
 * only (income excluded — this answers "where did the money go", not
 * "how much came in"). Reused for both the selected month's category
 * breakdown (donut/bar chart — the window's LAST month) and the category
 * trend chart (the whole window). Scoped to a window, not all-time, since
 * per-category-per-month granularity is the one shape here that actually
 * grows with history; `getMonthlyTotalsAllTime` above stays all-time because
 * it never breaks down by category.
 *
 * Summing every row for one month (including the `categoryId: null` bucket)
 * equals that month's `expenseCents` from `getMonthlyTotalsAllTime` exactly
 * — both queries share `dashboardBaseConditions()` and the same non-income
 * filter. Proven directly in `tests/integration/finance-dashboard.test.ts`.
 */
export async function getCategoryTotalsForWindow(
  ownerId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<CategoryMonthlyTotal[]> {
  const yearExpr = sql`extract(year from ${financeTransactions.transactionDate})`;
  const monthExpr = sql`extract(month from ${financeTransactions.transactionDate})`;

  const rows = await getDb()
    .select({
      year: sql<number>`${yearExpr}::int`,
      month: sql<number>`${monthExpr}::int`,
      categoryId: financeTransactions.categoryId,
      amountCents: sql<number>`sum(${financeTransactions.amountCents})::int`,
      txnCount: sql<number>`count(*)::int`,
    })
    .from(financeTransactions)
    .where(
      and(
        ...dashboardBaseConditions(ownerId),
        ne(financeTransactions.transactionType, 'income'),
        gte(financeTransactions.transactionDate, startDate),
        lt(financeTransactions.transactionDate, endDateExclusive),
      ),
    )
    .groupBy(yearExpr, monthExpr, financeTransactions.categoryId);

  return rows;
}

export interface DailyTotal {
  readonly day: number;
  readonly amountCents: number;
}

/** Spending-kind totals grouped by day-of-month, for the "biggest spending day" insight. Scoped to one month — cheap, no reason to widen it. */
export async function getDailyTotalsForMonth(
  ownerId: string,
  year: number,
  month: number,
): Promise<DailyTotal[]> {
  const dayExpr = sql`extract(day from ${financeTransactions.transactionDate})`;
  const { start, endExclusive } = monthRange(year, month);

  const rows = await getDb()
    .select({
      day: sql<number>`${dayExpr}::int`,
      amountCents: sql<number>`sum(${financeTransactions.amountCents})::int`,
    })
    .from(financeTransactions)
    .where(
      and(
        ...dashboardBaseConditions(ownerId),
        ne(financeTransactions.transactionType, 'income'),
        gte(financeTransactions.transactionDate, start),
        lt(financeTransactions.transactionDate, endExclusive),
      ),
    )
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  return rows;
}

export interface TopExpenseRow {
  readonly id: string;
  readonly transactionDate: string;
  readonly normalizedMerchant: string | null;
  readonly originalDescription: string;
  readonly categoryName: string | null;
  readonly amountCents: number;
}

/**
 * The `limit` largest spending-kind transactions (expense/refund/fee/
 * adjustment/investment — the same pool "Expenses" sums, so an investment
 * genuinely can be "the largest expense" and this list won't mysteriously
 * disagree with the total) for one month, ordered by amount descending.
 */
export async function getTopExpensesForMonth(
  ownerId: string,
  year: number,
  month: number,
  limit: number,
): Promise<TopExpenseRow[]> {
  const { start, endExclusive } = monthRange(year, month);

  const rows = await getDb()
    .select({
      id: financeTransactions.id,
      transactionDate: financeTransactions.transactionDate,
      normalizedMerchant: financeTransactions.normalizedMerchant,
      originalDescription: financeTransactions.originalDescription,
      categoryName: financeCategories.name,
      amountCents: financeTransactions.amountCents,
    })
    .from(financeTransactions)
    .leftJoin(financeCategories, eq(financeCategories.id, financeTransactions.categoryId))
    .where(
      and(
        ...dashboardBaseConditions(ownerId),
        ne(financeTransactions.transactionType, 'income'),
        gte(financeTransactions.transactionDate, start),
        lt(financeTransactions.transactionDate, endExclusive),
      ),
    )
    .orderBy(desc(financeTransactions.amountCents))
    .limit(limit);

  return rows;
}

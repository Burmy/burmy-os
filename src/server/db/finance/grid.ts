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

import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { financeAccounts, financeCategories, financeTransactions } from '@/server/db/schema';
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

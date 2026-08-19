/**
 * M8's whole job: pivot pre-aggregated SQL rows into the shape `/finance/monthly`
 * renders. Pure — no DB, no React — so the arithmetic that decides what the
 * owner's numbers mean is testable without a database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE DOES NOT COMPUTE A SUM OVER RAW TRANSACTIONS. `SUM(amount_cents)`
 * already happened in SQL (`db/finance/grid.ts`), grouped by
 * (month, category_id, transaction_type). What happens here is combining
 * ALREADY-SQL-COMPUTED sums into the grid's cells and its three summary
 * columns — the same kind of arithmetic as "Expenses $4,183 + Investments
 * $800 = Total Outflow $4,983" in FINANCE.md, not a second aggregation pass.
 * "Never store a total" is about persistence, not about where a `+` sign is
 * allowed to run.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface GridCategoryMeta {
  readonly id: string;
  readonly name: string;
  readonly kind: 'spending' | 'income' | 'investment';
  readonly sortOrder: number;
  readonly archived: boolean;
}

/** One (month, category, type) group, as SQL already summed it. `categoryId: null` is the invariant-violation bucket — see below. */
export interface GridAggregateRow {
  readonly month: number;
  readonly categoryId: string | null;
  readonly transactionType: string;
  readonly totalCents: number;
  readonly txnCount: number;
}

interface GridCell {
  readonly amountCents: number;
  readonly txnCount: number;
}

export interface GridColumn {
  readonly id: string;
  readonly name: string;
  readonly kind: 'spending' | 'income' | 'investment';
  readonly archived: boolean;
}

/** Shared by a month row and the year-total row — everything except which month it is. */
export interface GridRowTotals {
  /** `categoryId -> cell`. A category absent here had zero contributing transactions this scope — the "—" case. */
  readonly cells: Readonly<Record<string, GridCell>>;
  readonly totalExpenditureCents: number;
  readonly totalExpenditureTxnCount: number;
  /** Already sign-flipped to a positive figure — never re-negate this. */
  readonly incomeCents: number;
  readonly incomeTxnCount: number;
  readonly grossSavingsCents: number;
  /** This scope's slice of the invariant-violation bucket — see `UnreconciledSummary`. */
  readonly unreconciledCount: number;
  readonly unreconciledCents: number;
}

interface GridMonthRow extends GridRowTotals {
  readonly month: number;
}

/**
 * `confirmed`/`auto`, non-exclusionary transactions with NO category should be
 * impossible under M7's invariant — but if one exists anyway (old data, a
 * future bug, a manual edit), the money is never dropped: it is already
 * counted in `totalExpenditureCents`/`incomeCents` above (grouped by TYPE, not
 * by category-cell membership), just absent from every category column since
 * there is no column to place it in. This is the count/amount that number
 * represents, so the UI can say so rather than let the totals and the visible
 * columns silently disagree.
 */
interface UnreconciledSummary {
  readonly count: number;
  readonly totalCents: number;
}

export interface MonthlyGrid {
  /** Column order is `sort_order` for live categories, then archived-with-history categories — NEVER regrouped by kind. */
  readonly columns: readonly GridColumn[];
  readonly rows: readonly GridMonthRow[];
  readonly yearTotal: GridRowTotals;
  readonly unreconciled: UnreconciledSummary;
}

function computeRowTotals(rowsInScope: readonly GridAggregateRow[]): GridRowTotals {
  const cells: Record<string, GridCell> = {};
  let totalExpenditureCents = 0;
  let totalExpenditureTxnCount = 0;
  let incomeCentsRaw = 0;
  let incomeTxnCount = 0;
  let unreconciledCount = 0;
  let unreconciledCents = 0;

  for (const row of rowsInScope) {
    if (row.categoryId !== null) {
      const existing = cells[row.categoryId] ?? { amountCents: 0, txnCount: 0 };
      cells[row.categoryId] = {
        amountCents: existing.amountCents + row.totalCents,
        txnCount: existing.txnCount + row.txnCount,
      };
    } else {
      unreconciledCount += row.txnCount;
      unreconciledCents += row.totalCents;
    }

    if (row.transactionType === 'income') {
      incomeCentsRaw += row.totalCents;
      incomeTxnCount += row.txnCount;
    } else {
      totalExpenditureCents += row.totalCents;
      totalExpenditureTxnCount += row.txnCount;
    }
  }

  // `-0` when there is no income at all — the exact negative-zero failure
  // mode `money.ts` was built to prevent in M1, recurring here because this
  // module works in plain numbers rather than the branded `Cents` type. `-0
  // === 0` is true, but `Object.is`/serialization distinguish them, and
  // "negative zero dollars of income" is meaningless. Normalized at the
  // source, same fix M1 used.
  const incomeCents = incomeCentsRaw === 0 ? 0 : -incomeCentsRaw;

  return {
    cells,
    totalExpenditureCents,
    totalExpenditureTxnCount,
    incomeCents,
    incomeTxnCount,
    grossSavingsCents: incomeCents - totalExpenditureCents,
    unreconciledCount,
    unreconciledCents,
  };
}

/**
 * `aggregateRows` come from ONE SQL query (`db/finance/grid.ts`'s
 * `getMonthlyGridAggregates`), already filtered to the exact base condition
 * `getCellTransactions` uses for drill-down — that shared filter, not
 * anything in this function, is what guarantees a drill-down total can never
 * disagree with its cell.
 *
 * `categories` is the owner's FULL list (`listCategories(ownerId, { includeArchived: true })`)
 * — live and archived alike; this function decides which archived ones earn a
 * column (had at least one transaction in `aggregateRows`) and preserves
 * `sort_order` for the live ones exactly, per CLAUDE.md: column order is
 * authoritative and is never regrouped by `kind`.
 */
export function buildMonthlyGrid(
  aggregateRows: readonly GridAggregateRow[],
  categories: readonly GridCategoryMeta[],
): MonthlyGrid {
  const categoryIdsWithActivity = new Set(
    aggregateRows.map((row) => row.categoryId).filter((id): id is string => id !== null),
  );

  const byOrder = (a: GridCategoryMeta, b: GridCategoryMeta): number =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

  const liveColumns = categories
    .filter((category) => !category.archived)
    .sort(byOrder)
    .map((category) => ({ id: category.id, name: category.name, kind: category.kind, archived: false }));

  const archivedColumns = categories
    .filter((category) => category.archived && categoryIdsWithActivity.has(category.id))
    .sort(byOrder)
    .map((category) => ({ id: category.id, name: category.name, kind: category.kind, archived: true }));

  const rows: GridMonthRow[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const rowsForMonth = aggregateRows.filter((row) => row.month === month);
    rows.push({ month, ...computeRowTotals(rowsForMonth) });
  }

  const yearTotal = computeRowTotals(aggregateRows);

  return {
    columns: [...liveColumns, ...archivedColumns],
    rows,
    yearTotal,
    unreconciled: { count: yearTotal.unreconciledCount, totalCents: yearTotal.unreconciledCents },
  };
}

export const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

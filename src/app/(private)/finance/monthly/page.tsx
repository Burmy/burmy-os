import type { Metadata } from 'next';
import Link from 'next/link';

import { MonthlyGridTable } from '@/features/finance/monthly/monthly-grid-table';
import { requireOwner } from '@/server/auth/owner';
import { listCategories } from '@/server/db/finance/categories';
import { getMonthlyGridAggregates, listTransactionYears } from '@/server/db/finance/grid';
import { getNeedsReviewCount } from '@/server/db/finance/transactions';
import { buildMonthlyGrid, type GridCategoryMeta } from '@/server/finance/grid';
import { cents, format } from '@/server/finance/money';

export const metadata: Metadata = { title: 'Monthly — Burmy' };

function readYear(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : fallback;
}

/**
 * The product: month x category totals, computed from `finance_transactions`
 * at read time, every cell drilling down to the exact rows behind it. No
 * total is ever stored — see CLAUDE.md invariant 1 and `server/finance/grid.ts`.
 */
export default async function MonthlyPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const params = await searchParams;
  const currentYear = new Date().getUTCFullYear();
  const year = readYear(params.year, currentYear);

  const [years, categories, aggregateRows, needsReviewCount] = await Promise.all([
    listTransactionYears(owner.userId),
    listCategories(owner.userId, { includeArchived: true }),
    getMonthlyGridAggregates(owner.userId, year),
    getNeedsReviewCount(owner.userId),
  ]);

  const categoryMeta: GridCategoryMeta[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    kind: category.kind,
    sortOrder: category.sortOrder,
    archived: category.archivedAt !== null,
  }));

  const grid = buildMonthlyGrid(aggregateRows, categoryMeta);

  return (
    <div>
      <h1 className="text-xl font-semibold">Monthly</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Every number is computed from your transactions, live — click any amount to see exactly what&apos;s
        behind it.
      </p>

      {needsReviewCount > 0 ? (
        <div role="status" className="bg-muted/50 mt-4 rounded-md border p-3 text-sm">
          {needsReviewCount} transaction{needsReviewCount === 1 ? '' : 's'} need review and{' '}
          {needsReviewCount === 1 ? 'is' : 'are'} not included above.{' '}
          <Link href="/finance/review" className="underline underline-offset-2">
            Review now
          </Link>
        </div>
      ) : null}

      {grid.unreconciled.count > 0 ? (
        <div role="alert" className="border-destructive/50 text-destructive mt-4 rounded-md border p-3 text-sm">
          {grid.unreconciled.count} confirmed transaction{grid.unreconciled.count === 1 ? '' : 's'} (
          {format(cents(Math.abs(grid.unreconciled.totalCents)))}) {grid.unreconciled.count === 1 ? 'has' : 'have'}{' '}
          no category and {grid.unreconciled.count === 1 ? "doesn't" : "don't"} appear in any column above —
          they&apos;re still counted in Total Expenditure/Income.{' '}
          <Link href="/finance/review?status=all&category=uncategorized" className="underline underline-offset-2">
            Review now
          </Link>
        </div>
      ) : null}

      {categories.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-sm">
          No categories yet. Add them under Settings → Categories.
        </p>
      ) : (
        <MonthlyGridTable grid={grid} year={year} years={years} />
      )}
    </div>
  );
}

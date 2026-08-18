import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { ImportSheet } from '@/features/finance/import/import-sheet';
import { MonthlyGridTable } from '@/features/finance/monthly/monthly-grid-table';
import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';
import { listCategories } from '@/server/db/finance/categories';
import { getMonthlyGridAggregates, listTransactionYears } from '@/server/db/finance/grid';
import { listInProgressImports } from '@/server/db/finance/imports';
import { getNeedsReviewCount } from '@/server/db/finance/transactions';
import { buildMonthlyGrid, type GridCategoryMeta } from '@/server/finance/grid';
import { cents, format } from '@/server/finance/money';

export const metadata: Metadata = { title: 'Finance — Burmy' };

function readYear(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : fallback;
}

/**
 * The product: month x category totals, computed from `finance_transactions`
 * at read time, every cell drilling down to the exact rows behind it. No
 * total is ever stored — see CLAUDE.md invariant 1 and `server/finance/grid.ts`.
 *
 * Also Finance's home and only persistent landing point — there is no
 * Monthly/Import/Review tab row anymore. Importing happens through the Sheet
 * mounted here; Review is reached only through the banner below, when there
 * is something in it to reach.
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

  const [years, categories, aggregateRows, needsReviewCount, accounts, inProgressImports] = await Promise.all([
    listTransactionYears(owner.userId),
    listCategories(owner.userId, { includeArchived: true }),
    getMonthlyGridAggregates(owner.userId, year),
    getNeedsReviewCount(owner.userId),
    listAccounts(owner.userId),
    listInProgressImports(owner.userId),
  ]);

  const categoryMeta: GridCategoryMeta[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    kind: category.kind,
    sortOrder: category.sortOrder,
    archived: category.archivedAt !== null,
  }));

  const grid = buildMonthlyGrid(aggregateRows, categoryMeta);
  const liveCategories = categories.filter((category) => category.archivedAt === null);

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-xl font-semibold">Finance</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/finance/transactions">Transactions</Link>
          </Button>
          <ImportSheet accounts={accounts} categories={liveCategories} inProgressImports={inProgressImports} />
        </div>
      </div>

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
        <MonthlyGridTable grid={grid} year={year} years={years} />
      )}
    </div>
  );
}

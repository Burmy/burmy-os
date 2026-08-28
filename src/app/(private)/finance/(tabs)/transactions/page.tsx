import type { Metadata } from 'next';
import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { TransactionsTable } from '@/features/finance/transactions/transactions-table';
import { parseLedgerFilters } from '@/features/finance/transactions/filters';
import { requireOwner } from '@/server/auth/owner';
import { listCategories } from '@/server/db/finance/categories';
import { listTransactionYears } from '@/server/db/finance/grid';
import {
  LEDGER_PAGE_SIZE,
  getLedgerSummary,
  listTransactionsLedger,
} from '@/server/db/finance/transactions';

export const metadata: Metadata = { title: 'Transactions — Burmy' };

function readParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The full historical ledger — every committed transaction, filterable and
 * searchable, unlike `/finance/review` (only what needs attention) and
 * unlike Monthly's drill-down (scoped to one cell, capped at 500 rows by
 * design). A Finance subpage, not a third top-level destination — see
 * `monthly/page.tsx` for the one link that reaches it.
 *
 * Filters live in the URL, same reasoning as Review: a filtered view is
 * shareable and survives a refresh, and the export link below reuses this
 * exact query string, so "export the current filter" needs no separate
 * state to stay in sync with.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const params = await searchParams;

  const years = await listTransactionYears(owner.userId);
  const fallbackYear = years[0] ?? new Date().getUTCFullYear();

  // Built with `if` guards on a MUTABLE local shape (not the exported
  // `readonly` `RawLedgerParams` itself) rather than an object literal —
  // `exactOptionalPropertyTypes` rejects assigning a `string | undefined`
  // expression straight into an optional `string` property even inside a
  // literal, and a `readonly` field cannot be assigned to afterward either.
  // See CLAUDE.md; review/page.tsx uses the same pattern for the same reason.
  const raw: {
    year?: string;
    month?: string;
    category?: string;
    type?: string;
    status?: string;
    q?: string;
    page?: string;
  } = {};
  const yearParam = readParam(params.year);
  if (yearParam) raw.year = yearParam;
  const monthParam = readParam(params.month);
  if (monthParam) raw.month = monthParam;
  const categoryParam = readParam(params.category);
  if (categoryParam) raw.category = categoryParam;
  const typeParam = readParam(params.type);
  if (typeParam) raw.type = typeParam;
  const statusParam = readParam(params.status);
  if (statusParam) raw.status = statusParam;
  const qParam = readParam(params.q);
  if (qParam) raw.q = qParam;
  const pageParam = readParam(params.page);
  if (pageParam) raw.page = pageParam;

  const { filters, page } = parseLedgerFilters(raw, fallbackYear);

  const [ledgerPage, summary, categories] = await Promise.all([
    listTransactionsLedger(owner.userId, filters, page),
    getLedgerSummary(owner.userId, filters),
    listCategories(owner.userId, { includeArchived: true }),
  ]);

  const yearOptions = years.length > 0 ? years : [filters.year];

  // Computed here, not in the client table: `LEDGER_PAGE_SIZE` is a runtime
  // value from the DAL, and importing it into a client component pulls
  // `postgres` into the browser bundle and fails the build. See the note in
  // `transactions-table.tsx`.
  const totalPages = Math.max(1, Math.ceil(ledgerPage.totalCount / LEDGER_PAGE_SIZE));

  const exportParams = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'page' && value) exportParams.set(key, value);
  }
  const exportHref = `/finance/transactions/export?${exportParams.toString()}`;

  return (
    <div className="space-y-8">
      {/* Export is a PAGE ACTION, so it belongs in the header beside the
          title like Add game and Import statement — not the 23px underlined
          link buried in the meta row it used to be. Built here rather than
          in the client table because this Server Component already holds
          every raw search param the export needs. `page` is dropped: the
          export always reflects the whole current filter, never the
          on-screen page (see `listTransactionsForExport`). */}
      <PageHeader
        title="Transactions"
        // Rendered here rather than in the client table because this Server
        // Component already awaits `summary` (above) — the table receives the
        // same object, so neither placement costs a query, and the header
        // belongs to the page.
        meta={
          <>
            <span>
              {summary.totalCount} transaction{summary.totalCount === 1 ? '' : 's'}
            </span>
            {summary.needsReviewCount > 0 ? <span>{summary.needsReviewCount} need review</span> : null}
          </>
        }
        actions={
          // Default (solid) variant, matching Add game and Import statement
          // — it's this page's one primary action, so it gets the same
          // weight theirs do rather than the quieter `outline` fill.
          <Button asChild>
            <a href={exportHref}>
              <Download className="size-4" />
              Export
            </a>
          </Button>
        }
      />

      <TransactionsTable
        page={ledgerPage}
        currentPage={page}
        totalPages={totalPages}
        categories={categories}
        years={yearOptions}
        filters={filters}
        summary={summary}
      />
    </div>
  );
}

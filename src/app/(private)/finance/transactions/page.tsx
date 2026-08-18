import type { Metadata } from 'next';
import Link from 'next/link';

import { TransactionsTable } from '@/features/finance/transactions/transactions-table';
import { parseLedgerFilters } from '@/features/finance/transactions/filters';
import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';
import { listCategories } from '@/server/db/finance/categories';
import { listTransactionYears } from '@/server/db/finance/grid';
import {
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
    account?: string;
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
  const accountParam = readParam(params.account);
  if (accountParam) raw.account = accountParam;
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

  const [ledgerPage, summary, accounts, categories] = await Promise.all([
    listTransactionsLedger(owner.userId, filters, page),
    getLedgerSummary(owner.userId, filters),
    listAccounts(owner.userId),
    listCategories(owner.userId, { includeArchived: true }),
  ]);

  const yearOptions = years.length > 0 ? years : [filters.year];

  return (
    <div>
      <Link href="/finance/monthly" className="text-muted-foreground hover:text-foreground text-sm">
        ← Finance
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Transactions</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        The complete transaction ledger behind the monthly grid — search, filter, correct history, and
        export.
      </p>

      <TransactionsTable
        page={ledgerPage}
        accounts={accounts}
        categories={categories}
        years={yearOptions}
        filters={filters}
        summary={summary}
      />
    </div>
  );
}
